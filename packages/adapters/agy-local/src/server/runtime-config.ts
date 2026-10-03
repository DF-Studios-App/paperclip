import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

type PreparedAgyRuntimeConfig = {
  serverNames: string[];
  cleanup: () => Promise<void>;
};

const LOCK_WAIT_MS = 100;
const LOCK_TIMEOUT_MS = 120_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error("Antigravity MCP config must be a JSON object.");
  return parsed;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const owner = JSON.stringify({ pid: process.pid, nonce: `${Date.now()}-${Math.random()}` });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(owner, "utf8");
      await handle.close();
      return async () => {
        try {
          if ((await fs.readFile(lockPath, "utf8")) === owner) await fs.unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const current = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown };
        if (typeof current.pid === "number" && !processIsAlive(current.pid)) {
          const stalePath = `${lockPath}.${process.pid}.${Date.now()}.stale`;
          try {
            await fs.rename(lockPath, stalePath);
            await fs.unlink(stalePath);
            continue;
          } catch (staleError) {
            const staleCode = (staleError as NodeJS.ErrnoException).code;
            if (staleCode === "ENOENT" || staleCode === "EEXIST") continue;
            throw staleError;
          }
        }
      } catch (readError) {
        const readCode = (readError as NodeJS.ErrnoException).code;
        if (readCode !== "ENOENT" && !(readError instanceof SyntaxError)) throw readError;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  throw new Error("Timed out waiting for the workspace Antigravity MCP config lock.");
}

function uniqueServerName(name: string, connectionId: string, used: Set<string>): string {
  const base = name.trim().replace(/[^A-Za-z0-9_.-]+/g, "-") || "paperclip-mcp";
  if (!used.has(base)) return base;
  const suffix = connectionId.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 24) || "connection";
  let candidate = `${base}-${suffix}`;
  let index = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix}-${index++}`;
  return candidate;
}

/** Add run-scoped Paperclip MCP servers to AGY's workspace config and restore it after the run. */
export async function prepareAgyRuntimeMcpConfig(
  cwd: string,
  servers: readonly AdapterRuntimeMcpServer[],
): Promise<PreparedAgyRuntimeConfig> {
  if (servers.length === 0) return { serverNames: [], cleanup: async () => {} };

  const agentsDir = path.join(cwd, ".agents");
  const configPath = path.join(agentsDir, "mcp_config.json");
  const lockPath = path.join(agentsDir, ".paperclip-mcp-config.lock");
  await fs.mkdir(agentsDir, { recursive: true });
  const releaseLock = await acquireLock(lockPath);
  let original: Buffer | null = null;
  let originalMode = 0o600;
  try {
    try {
      const stat = await fs.stat(configPath);
      original = await fs.readFile(configPath);
      originalMode = stat.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const existing = original ? parseConfig(original.toString("utf8")) : {};
    if (existing.mcpServers !== undefined && !isObject(existing.mcpServers)) {
      throw new Error("Antigravity MCP config property `mcpServers` must be a JSON object.");
    }
    const existingServers = isObject(existing.mcpServers) ? existing.mcpServers : {};
    const mcpServers: Record<string, unknown> = { ...existingServers };
    const names: string[] = [];
    for (const server of servers) {
      const name = uniqueServerName(server.name, server.connectionId, new Set(Object.keys(mcpServers)));
      names.push(name);
      mcpServers[name] = {
        serverUrl: server.url,
        headers: { Authorization: `Bearer ${server.token}` },
      };
    }
    const injectedContent = `${JSON.stringify({ ...existing, mcpServers }, null, 2)}\n`;
    await fs.writeFile(configPath, injectedContent, {
      encoding: "utf8",
      mode: 0o600,
    });

    return {
      serverNames: names,
      cleanup: async () => {
        try {
          const current = await fs.readFile(configPath, "utf8");
          if (current === injectedContent && original) {
            await fs.writeFile(configPath, original, { mode: originalMode });
          } else if (current === injectedContent) {
            await fs.unlink(configPath);
          } else {
            const active = parseConfig(current);
            const activeServers = isObject(active.mcpServers) ? active.mcpServers : {};
            for (const name of names) delete activeServers[name];
            const restoredServers = { ...activeServers };
            if (original) {
              const baseline = parseConfig(original.toString("utf8"));
              const baselineServers = isObject(baseline.mcpServers) ? baseline.mcpServers : {};
              active.mcpServers = { ...baselineServers, ...restoredServers };
              await fs.writeFile(configPath, `${JSON.stringify(active, null, 2)}\n`, {
                encoding: "utf8",
                mode: originalMode,
              });
            } else if (Object.keys(restoredServers).length > 0 || Object.keys(active).length > 1) {
              active.mcpServers = restoredServers;
              await fs.writeFile(configPath, `${JSON.stringify(active, null, 2)}\n`, "utf8");
            } else {
              await fs.unlink(configPath);
            }
          }
        } finally {
          await releaseLock();
        }
      },
    };
  } catch (error) {
    await releaseLock();
    throw error;
  }
}
