import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

type PreparedAgyRuntimeConfig = {
  serverNames: string[];
  cleanup: () => Promise<void>;
};

const LOCK_WAIT_MS = 100;
const execFileAsync = promisify(execFile);

type RecoveryJournal = {
  schemaVersion: 1;
  injectedContent: string;
  injectedServers: Record<string, unknown>;
  originalBase64: string | null;
  originalMode: number;
};

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

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Antigravity MCP config path resolves outside the workspace.");
  }
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return { stdout: result.stdout, stderr: "", status: 0 };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "number") {
      const stdout = (error as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "";
      const stderr = (error as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "";
      return { stdout, stderr, status: code };
    }
    if (code === "ENOENT") return { stdout: "", stderr: "", status: 127 };
    throw error;
  }
}

function escapeGitIgnorePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/").replace(/[\\*?\[\]#!]/g, "\\$&");
}

async function ensurePrivateGitPaths(input: {
  cwd: string;
  agentsDir: string;
  configPath: string;
  lockPath: string;
  recoveryPath: string;
}): Promise<void> {
  const repoResult = await runGit(input.cwd, ["rev-parse", "--show-toplevel"]);
  if (repoResult.status === 127) return;
  if (repoResult.status === 128 && /not a git repository/i.test(repoResult.stderr)) return;
  if (repoResult.status !== 0) throw new Error("Could not inspect the workspace Git repository.");

  const repoRoot = await fs.realpath(repoResult.stdout.trim());
  const agentsRelative = path.relative(repoRoot, input.agentsDir);
  assertContained(repoRoot, input.agentsDir);
  const protectedPaths = [input.configPath, input.lockPath, input.recoveryPath];
  const relativePaths = protectedPaths.map((candidate) => {
    assertContained(repoRoot, candidate);
    return path.relative(repoRoot, candidate).split(path.sep).join("/");
  });

  for (const relativePath of relativePaths) {
    const tracked = await runGit(repoRoot, ["ls-files", "--error-unmatch", "--", relativePath]);
    if (tracked.status === 0) {
      throw new Error(`Refusing to write run-scoped MCP secrets to tracked file ${relativePath}.`);
    }
    if (tracked.status !== 1) throw new Error("Could not verify whether the AGY MCP config is tracked by Git.");
  }

  const rules = [
    `/${escapeGitIgnorePath(relativePaths[0]!)}`,
    `/${escapeGitIgnorePath(relativePaths[1]!)}*`,
    `/${escapeGitIgnorePath(relativePaths[2]!)}*`,
    `/${escapeGitIgnorePath(path.relative(repoRoot, input.agentsDir).split(path.sep).join("/"))}/.paperclip-mcp-*.tmp`,
  ];
  const missingRules: string[] = [];
  for (const [index, relativePath] of relativePaths.entries()) {
    const ignored = await runGit(repoRoot, ["check-ignore", "--quiet", "--no-index", "--", relativePath]);
    if (ignored.status === 0) continue;
    if (ignored.status !== 1) throw new Error("Could not verify Git ignore rules for AGY MCP runtime files.");
    missingRules.push(rules[index]!);
  }

  const temporaryProbe = path.join(agentsRelative, `.paperclip-mcp-${randomUUID()}.tmp`)
    .split(path.sep)
    .join("/");
  const temporaryIgnored = await runGit(repoRoot, ["check-ignore", "--quiet", "--no-index", "--", temporaryProbe]);
  if (temporaryIgnored.status === 1) missingRules.push(rules[3]!);
  else if (temporaryIgnored.status !== 0) throw new Error("Could not verify Git ignore rules for AGY MCP temporary files.");
  if (missingRules.length === 0) return;

  const excludeResult = await runGit(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (excludeResult.status !== 0) throw new Error("Could not locate the workspace's local Git exclude file.");
  const excludePath = path.resolve(repoRoot, excludeResult.stdout.trim());
  let prefix = "";
  try {
    const stat = await fs.lstat(excludePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Workspace Git exclude path must be a regular file, not a symlink.");
    }
    prefix = (await fs.readFile(excludePath, "utf8")).endsWith("\n") ? "" : "\n";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await fs.open(excludePath, "a", 0o600);
  try {
    await handle.writeFile(`${prefix}# Paperclip run-scoped AGY MCP files\n${missingRules.join("\n")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function validateConfigPaths(input: {
  root: string;
  agentsDir: string;
  configPath: string;
  lockPath: string;
  recoveryPath: string;
}): Promise<void> {
  const agents = await fs.lstat(input.agentsDir);
  if (!agents.isDirectory() || agents.isSymbolicLink()) {
    throw new Error("Antigravity workspace `.agents` must be a real directory, not a symlink.");
  }
  assertContained(input.root, await fs.realpath(input.agentsDir));

  for (const filePath of [input.configPath, input.lockPath, input.recoveryPath]) {
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Antigravity MCP config and lock paths must be regular files, not symlinks.");
      }
      assertContained(input.root, await fs.realpath(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function atomicWriteFile(
  agentsDir: string,
  filePath: string,
  content: string | Buffer,
  mode: number,
  validate: () => Promise<void>,
): Promise<void> {
  const temporaryPath = path.join(agentsDir, `.paperclip-mcp-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let renamed = false;
  try {
    handle = await fs.open(temporaryPath, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await validate();
    await fs.rename(temporaryPath, filePath);
    renamed = true;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    throw error;
  } finally {
    if (!renamed) await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function acquireLock(
  lockPath: string,
  validate: () => Promise<void>,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const owner = JSON.stringify({ pid: process.pid, nonce: `${Date.now()}-${Math.random()}` });
  while (true) {
    signal?.throwIfAborted();
    await validate();
    try {
      const temporaryPath = `${lockPath}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(temporaryPath, "wx", 0o600);
        await handle.writeFile(owner, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await validate();
        // Linking a complete temp file makes the lock visible in one step.
        // A crashed writer cannot leave an empty lock that blocks later runs.
        await fs.link(temporaryPath, lockPath);
      } finally {
        if (handle) await handle.close().catch(() => undefined);
        await fs.unlink(temporaryPath).catch(() => undefined);
      }
      return async () => {
        try {
          await validate();
          if ((await fs.readFile(lockPath, "utf8")) === owner) await fs.unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let stale = false;
      try {
        await validate();
        const raw = await fs.readFile(lockPath, "utf8");
        let current: unknown;
        try {
          current = JSON.parse(raw);
        } catch {
          // Atomic lock creation prevents a live owner from exposing partial
          // JSON. A malformed record therefore belongs to a crashed/old run.
          stale = true;
        }
        if (isObject(current) && typeof current.pid === "number" && !processIsAlive(current.pid)) {
          stale = true;
        } else if (!isObject(current) || typeof current.pid !== "number") {
          stale = true;
        }
      } catch (readError) {
        const readCode = (readError as NodeJS.ErrnoException).code;
        if (readCode === "ENOENT") continue;
        throw readError;
      }
      if (stale) {
        const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
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
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}

async function restoreRecoveryJournal(input: {
  agentsDir: string;
  configPath: string;
  recoveryPath: string;
  validate: () => Promise<void>;
}): Promise<void> {
  let journalText: string;
  try {
    await input.validate();
    journalText = await fs.readFile(input.recoveryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const parsed: unknown = JSON.parse(journalText);
  if (
    !isObject(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.injectedContent !== "string" ||
    !isObject(parsed.injectedServers) ||
    !(parsed.originalBase64 === null || typeof parsed.originalBase64 === "string") ||
    typeof parsed.originalMode !== "number"
  ) {
    throw new Error("Antigravity MCP recovery journal is invalid; refusing to overwrite workspace config.");
  }
  const journal = parsed as RecoveryJournal;
  const original = journal.originalBase64 === null ? null : Buffer.from(journal.originalBase64, "base64");
  let current: Buffer | null = null;
  try {
    await input.validate();
    current = await fs.readFile(input.configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (current?.toString("utf8") === journal.injectedContent) {
    if (original) {
      await atomicWriteFile(input.agentsDir, input.configPath, original, journal.originalMode, input.validate);
    } else {
      await fs.unlink(input.configPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  } else if (current) {
    const active = parseConfig(current.toString("utf8"));
    const activeServers = isObject(active.mcpServers) ? active.mcpServers : {};
    for (const [name, injected] of Object.entries(journal.injectedServers)) {
      if (isDeepStrictEqual(activeServers[name], injected)) delete activeServers[name];
    }

    if (original) {
      const baseline = parseConfig(original.toString("utf8"));
      const baselineServers = isObject(baseline.mcpServers) ? baseline.mcpServers : {};
      active.mcpServers = { ...baselineServers, ...activeServers };
    } else if (Object.keys(activeServers).length > 0) {
      active.mcpServers = activeServers;
    } else {
      delete active.mcpServers;
    }

    if (Object.keys(active).length === 0) {
      await fs.unlink(input.configPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } else {
      const mode = original ? journal.originalMode : 0o600;
      await atomicWriteFile(
        input.agentsDir,
        input.configPath,
        `${JSON.stringify(active, null, 2)}\n`,
        mode,
        input.validate,
      );
    }
  } else if (original) {
    await atomicWriteFile(input.agentsDir, input.configPath, original, journal.originalMode, input.validate);
  }

  await input.validate();
  await fs.unlink(input.recoveryPath);
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
  signal?: AbortSignal,
): Promise<PreparedAgyRuntimeConfig> {
  if (servers.length === 0) return { serverNames: [], cleanup: async () => {} };

  const agentsDir = path.join(cwd, ".agents");
  const configPath = path.join(agentsDir, "mcp_config.json");
  const lockPath = path.join(agentsDir, ".paperclip-mcp-config.lock");
  const recoveryPath = path.join(agentsDir, ".paperclip-mcp-config.recovery.json");
  const root = await fs.realpath(cwd);
  await fs.mkdir(agentsDir, { recursive: true });
  const validate = () => validateConfigPaths({ root, agentsDir, configPath, lockPath, recoveryPath });
  await validate();
  const releaseLock = await acquireLock(lockPath, validate, signal);
  try {
    await ensurePrivateGitPaths({ cwd, agentsDir, configPath, lockPath, recoveryPath });
    await restoreRecoveryJournal({ agentsDir, configPath, recoveryPath, validate });

    let original: Buffer | null = null;
    let originalMode = 0o600;
    try {
      const stat = await fs.lstat(configPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Antigravity MCP config must be a regular file, not a symlink.");
      }
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
    const injectedServers: Record<string, unknown> = {};
    for (const server of servers) {
      const name = uniqueServerName(server.name, server.connectionId, new Set(Object.keys(mcpServers)));
      names.push(name);
      const injected = {
        serverUrl: server.url,
        headers: { Authorization: `Bearer ${server.token}` },
      };
      mcpServers[name] = injected;
      injectedServers[name] = injected;
    }
    const injectedContent = `${JSON.stringify({ ...existing, mcpServers }, null, 2)}\n`;
    const journal: RecoveryJournal = {
      schemaVersion: 1,
      injectedContent,
      injectedServers,
      originalBase64: original?.toString("base64") ?? null,
      originalMode,
    };
    await atomicWriteFile(agentsDir, recoveryPath, JSON.stringify(journal), 0o600, validate);
    await atomicWriteFile(agentsDir, configPath, injectedContent, 0o600, validate);

    return {
      serverNames: names,
      cleanup: async () => {
        try {
          await restoreRecoveryJournal({ agentsDir, configPath, recoveryPath, validate });
        } finally {
          await releaseLock();
        }
      },
    };
  } catch (error) {
    let recoveryError: unknown;
    try {
      await restoreRecoveryJournal({ agentsDir, configPath, recoveryPath, validate });
    } catch (caught) {
      recoveryError = caught;
    }
    await releaseLock();
    if (recoveryError) throw new AggregateError([error, recoveryError], "AGY MCP config setup failed and recovery is still required.");
    throw error;
  }
}
