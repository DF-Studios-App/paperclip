import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAgyRuntimeMcpConfig } from "@paperclipai/adapter-agy-local/server";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-runtime-mcp-test-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("prepareAgyRuntimeMcpConfig", () => {
  it("writes Paperclip servers using Antigravity's remote MCP schema and removes run tokens", async () => {
    const cwd = await makeWorkspace();
    const prepared = await prepareAgyRuntimeMcpConfig(cwd, [
      { name: "GitHub", url: "http://127.0.0.1:3100/api/mcp/runtime-tools", token: "run-token", connectionId: "conn-1" },
    ]);

    expect(prepared.serverNames).toEqual(["GitHub"]);
    const configPath = path.join(cwd, ".agents", "mcp_config.json");
    const active = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      mcpServers: Record<string, { serverUrl: string; headers: { Authorization: string } }>;
    };
    expect(active.mcpServers.GitHub).toEqual({
      serverUrl: "http://127.0.0.1:3100/api/mcp/runtime-tools",
      headers: { Authorization: "Bearer run-token" },
    });

    await prepared.cleanup();
    await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(cwd, ".agents", ".paperclip-mcp-config.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves user servers and adds a suffix on a name collision", async () => {
    const cwd = await makeWorkspace();
    const agentsDir = path.join(cwd, ".agents");
    await fs.mkdir(agentsDir);
    const configPath = path.join(agentsDir, "mcp_config.json");
    const userConfigText = '{\n  "mcpServers": {"GitHub":{"serverUrl":"https://user.example/mcp"},"local":{"command":"server"}},\n  "custom": true\n}\n';
    await fs.writeFile(configPath, userConfigText);

    const prepared = await prepareAgyRuntimeMcpConfig(cwd, [
      { name: "GitHub", url: "http://127.0.0.1:3100/runtime", token: "run-token", connectionId: "paperclip-connection" },
    ]);
    expect(prepared.serverNames).toEqual(["GitHub-paperclip-connection"]);
    await prepared.cleanup();

    expect(await fs.readFile(configPath, "utf8")).toBe(userConfigText);
  });

  it("does not create configuration when there are no runtime servers", async () => {
    const cwd = await makeWorkspace();
    const prepared = await prepareAgyRuntimeMcpConfig(cwd, []);
    expect(prepared.serverNames).toEqual([]);
    await expect(fs.access(path.join(cwd, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    await prepared.cleanup();
  });

  it("rejects a symlinked workspace MCP directory before writing the run token", async () => {
    const cwd = await makeWorkspace();
    const externalDir = await makeWorkspace();
    await fs.symlink(externalDir, path.join(cwd, ".agents"), "junction");

    await expect(
      prepareAgyRuntimeMcpConfig(cwd, [
        { name: "GitHub", url: "http://127.0.0.1:3100/runtime", token: "test-run-token", connectionId: "github" },
      ]),
    ).rejects.toThrow(/must be a real directory/);
    await expect(fs.access(path.join(externalDir, "mcp_config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for another run's config lease and proceeds after the first run cleans up", async () => {
    const cwd = await makeWorkspace();
    const first = await prepareAgyRuntimeMcpConfig(cwd, [
      { name: "First", url: "http://127.0.0.1:3100/first", token: "first-token", connectionId: "first" },
    ]);
    let secondSettled = false;
    const secondPromise = prepareAgyRuntimeMcpConfig(cwd, [
      { name: "Second", url: "http://127.0.0.1:3100/second", token: "second-token", connectionId: "second" },
    ]).then((prepared) => {
      secondSettled = true;
      return prepared;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondSettled).toBe(false);
    await first.cleanup();
    const second = await secondPromise;
    expect(second.serverNames).toEqual(["Second"]);
    await second.cleanup();
  });

  it("preserves a user-edited injected server during cleanup", async () => {
    const cwd = await makeWorkspace();
    const configPath = path.join(cwd, ".agents", "mcp_config.json");
    const prepared = await prepareAgyRuntimeMcpConfig(cwd, [
      { name: "GitHub", url: "http://127.0.0.1:3100/runtime", token: "run-token", connectionId: "github" },
    ]);
    const edited = JSON.parse(await fs.readFile(configPath, "utf8"));
    edited.mcpServers.GitHub = { serverUrl: "https://user-edited.example/mcp" };
    await fs.writeFile(configPath, JSON.stringify(edited, null, 2));

    await prepared.cleanup();

    const restored = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(restored.mcpServers.GitHub).toEqual({ serverUrl: "https://user-edited.example/mcp" });
    expect(JSON.stringify(restored)).not.toContain("run-token");
  });

  it("recovers an interrupted run before injecting a new runtime token", async () => {
    const cwd = await makeWorkspace();
    const agentsDir = path.join(cwd, ".agents");
    await fs.mkdir(agentsDir);
    const configPath = path.join(agentsDir, "mcp_config.json");
    const injected = {
      mcpServers: {
        GitHub: { serverUrl: "http://127.0.0.1:3100/old", headers: { Authorization: "Bearer old-run-token" } },
      },
    };
    await fs.writeFile(configPath, `${JSON.stringify(injected, null, 2)}\n`);
    await fs.writeFile(path.join(agentsDir, ".paperclip-mcp-config.recovery.json"), JSON.stringify({
      schemaVersion: 1,
      injectedContent: `${JSON.stringify(injected, null, 2)}\n`,
      injectedServers: { GitHub: injected.mcpServers.GitHub },
      originalBase64: null,
      originalMode: 0o600,
    }));
    await fs.writeFile(path.join(agentsDir, ".paperclip-mcp-config.lock"), "{");

    const prepared = await prepareAgyRuntimeMcpConfig(cwd, [
      { name: "GitHub", url: "http://127.0.0.1:3100/new", token: "new-run-token", connectionId: "github" },
    ]);

    const active = await fs.readFile(configPath, "utf8");
    expect(active).not.toContain("old-run-token");
    expect(active).toContain("new-run-token");
    await prepared.cleanup();
    await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adds run-scoped MCP files to the repository-local Git exclude", async () => {
    const cwd = await makeWorkspace();
    execFileSync("git", ["init", "--quiet"], { cwd });
    const prepared = await prepareAgyRuntimeMcpConfig(cwd, [
      { name: "GitHub", url: "http://127.0.0.1:3100/runtime", token: "run-token", connectionId: "github" },
    ]);
    const configPath = path.join(cwd, ".agents", "mcp_config.json");
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", "--", path.relative(cwd, configPath)], {
      cwd,
      stdio: "ignore",
    });
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", "--", ".agents/.paperclip-mcp-config.recovery.json"], {
      cwd,
      stdio: "ignore",
    });
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", "--", ".agents/.paperclip-mcp-config.lock.123.stale"], {
      cwd,
      stdio: "ignore",
    });
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", "--", ".agents/.paperclip-mcp-test.tmp"], {
      cwd,
      stdio: "ignore",
    });
    await prepared.cleanup();
  });

  it("refuses to inject run tokens into a tracked Antigravity config", async () => {
    const cwd = await makeWorkspace();
    const agentsDir = path.join(cwd, ".agents");
    await fs.mkdir(agentsDir);
    const configPath = path.join(agentsDir, "mcp_config.json");
    await fs.writeFile(configPath, '{"mcpServers":{}}\n');
    execFileSync("git", ["init", "--quiet"], { cwd });
    execFileSync("git", ["add", "--", ".agents/mcp_config.json"], { cwd });

    await expect(
      prepareAgyRuntimeMcpConfig(cwd, [
        { name: "GitHub", url: "http://127.0.0.1:3100/runtime", token: "run-token", connectionId: "github" },
      ]),
    ).rejects.toThrow(/Refusing to write run-scoped MCP secrets to tracked file/);
    expect(await fs.readFile(configPath, "utf8")).toBe('{"mcpServers":{}}\n');
  });
});
