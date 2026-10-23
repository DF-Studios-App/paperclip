import fs from "node:fs/promises";
import path from "node:path";
import { readAgyUsage, type AgyUsageGroup } from "./usage.js";

/**
 * Multi-account support for the AGY CLI.
 *
 * AGY keeps its sign-in under `$HOME/.gemini` (a file on Linux hosts, where no
 * OS secret service exists), so each account is a separate HOME directory. An
 * account without `home` uses the HOME the adapter would use anyway.
 *
 * Quota state lives next to the account's sign-in, so every agent that lists
 * the same account sees the same exhaustion window.
 */
export interface AgyAccount {
  id: string;
  home: string | null;
}

export interface AgyAccountQuotaState {
  exhaustedUntil: string | null;
  resetHint: string | null;
  updatedAt: string;
}

export interface AgyAccountCandidate {
  account: AgyAccount;
  home: string;
  state: AgyAccountQuotaState | null;
}

/** Used when AGY reports exhausted quota without a "Resets in" duration. */
export const AGY_DEFAULT_QUOTA_WINDOW_MS = 5 * 60 * 60 * 1000;

/** The id of the sign-in in the Paperclip host's own HOME. */
export const AGY_DEFAULT_ACCOUNT_ID = "default";

const AGY_ACCOUNT_STATE_FILE = ".paperclip-agy-quota.json";
const AGY_ACCOUNT_RECORD_FILE = "account.json";
const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMPANY_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface AgyCompanyAccountRecord {
  id: string;
  label: string;
  home: string;
  createdAt: string;
}

/** `<instanceRoot>/companies/<companyId>/agy-accounts`; each child directory is one account HOME. */
export function resolveAgyCompanyAccountsDir(instanceRoot: string, companyId: string): string {
  if (!COMPANY_ID_RE.test(companyId)) throw new Error(`Invalid company id '${companyId}'.`);
  return path.resolve(instanceRoot, "companies", companyId, "agy-accounts");
}

/** AGY's sign-in file on Linux. Other platforms keep the sign-in in the OS credential store. */
export function agySignInFile(home: string): string {
  return path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

/** Whether `home` holds an AGY sign-in. Returns true off Linux, where the sign-in is not a file. */
export async function isAgyHomeSignedIn(home: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== "linux") return true;
  return pathExists(agySignInFile(home));
}

/** Company accounts in creation order. Directories without a valid record are ignored. */
export async function listAgyCompanyAccounts(accountsDir: string): Promise<AgyCompanyAccountRecord[]> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(accountsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && ACCOUNT_ID_RE.test(entry.name) && entry.name !== AGY_DEFAULT_ACCOUNT_ID)
      .map(async (entry): Promise<AgyCompanyAccountRecord | null> => {
        const home = path.join(accountsDir, entry.name);
        try {
          const raw = JSON.parse(await fs.readFile(path.join(home, AGY_ACCOUNT_RECORD_FILE), "utf8")) as Record<string, unknown>;
          return {
            id: entry.name,
            label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : entry.name,
            home,
            createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
          };
        } catch {
          return null;
        }
      }),
  );
  return records
    .filter((record): record is AgyCompanyAccountRecord => record !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Creates the HOME directory and record for a new company account. */
export async function createAgyCompanyAccount(
  accountsDir: string,
  input: { label?: string | null; now?: Date } = {},
): Promise<AgyCompanyAccountRecord> {
  await fs.mkdir(accountsDir, { recursive: true });
  const existing = new Set((await fs.readdir(accountsDir).catch(() => [] as string[])));
  let index = existing.size + 1;
  let id = `account-${index}`;
  while (existing.has(id)) id = `account-${++index}`;
  const home = path.join(accountsDir, id);
  await fs.mkdir(home);
  const record: AgyCompanyAccountRecord = {
    id,
    label: input.label?.trim() || id,
    home,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  await fs.writeFile(
    path.join(home, AGY_ACCOUNT_RECORD_FILE),
    `${JSON.stringify({ label: record.label, createdAt: record.createdAt }, null, 2)}\n`,
    "utf8",
  );
  return record;
}

/** Deletes a company account HOME, including its AGY sign-in. */
export async function removeAgyCompanyAccount(accountsDir: string, accountId: string): Promise<boolean> {
  if (!ACCOUNT_ID_RE.test(accountId) || accountId === AGY_DEFAULT_ACCOUNT_ID) return false;
  const home = path.resolve(accountsDir, accountId);
  if (path.dirname(home) !== path.resolve(accountsDir)) return false;
  const stat = await fs.lstat(home).catch(() => null);
  if (!stat?.isDirectory()) return false;
  await fs.rm(home, { recursive: true, force: true });
  return true;
}

/**
 * The accounts a run may use, in priority order. An explicit `config.accounts`
 * list wins. Otherwise the company accounts are used, after the host's own
 * sign-in when it exists. With no company accounts the list is empty and the
 * adapter runs exactly as a single-account agent.
 */
export async function resolveAgyAccountPool(input: {
  config: Record<string, unknown>;
  companyAccountsDir: string | null;
  defaultHome: string;
}): Promise<{ accounts: AgyAccount[]; warnings: string[]; source: "config" | "company" | "none" }> {
  const configured = readAgyAccounts(input.config);
  if (configured.accounts.length > 0 || configured.warnings.length > 0) {
    return { ...configured, source: configured.accounts.length > 0 ? "config" : "none" };
  }
  if (!input.companyAccountsDir) return { accounts: [], warnings: [], source: "none" };
  const records = await listAgyCompanyAccounts(input.companyAccountsDir);
  if (records.length === 0) return { accounts: [], warnings: [], source: "none" };
  const accounts: AgyAccount[] = [];
  if (await isAgyHomeSignedIn(input.defaultHome)) accounts.push({ id: AGY_DEFAULT_ACCOUNT_ID, home: null });
  for (const record of records) {
    if (await isAgyHomeSignedIn(record.home)) accounts.push({ id: record.id, home: record.home });
  }
  return { accounts, warnings: [], source: "company" };
}

function readAccountEntry(value: unknown): AgyAccount | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const separator = trimmed.indexOf("=");
    const id = (separator >= 0 ? trimmed.slice(0, separator) : trimmed).trim();
    const home = separator >= 0 ? trimmed.slice(separator + 1).trim() : "";
    return { id, home: home || null };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const home = typeof record.home === "string" ? record.home.trim() : "";
    return { id, home: home || null };
  }
  return null;
}

/**
 * Reads `config.accounts` in priority order. Entries are `{ id, home? }`
 * objects or `id` / `id=home` strings. Invalid, relative or duplicate entries
 * are dropped and reported in `warnings`.
 */
export function readAgyAccounts(config: Record<string, unknown>): {
  accounts: AgyAccount[];
  warnings: string[];
} {
  const raw = config.accounts;
  if (!Array.isArray(raw)) return { accounts: [], warnings: [] };
  const accounts: AgyAccount[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const entry = readAccountEntry(value);
    if (!entry || !ACCOUNT_ID_RE.test(entry.id)) {
      warnings.push(`Ignored AGY account entry ${JSON.stringify(value)}: it needs an id of letters, digits, ".", "_" or "-".`);
      continue;
    }
    if (seen.has(entry.id)) {
      warnings.push(`Ignored duplicate AGY account "${entry.id}".`);
      continue;
    }
    if (entry.home && !path.isAbsolute(entry.home)) {
      warnings.push(`Ignored AGY account "${entry.id}": home "${entry.home}" must be an absolute path.`);
      continue;
    }
    seen.add(entry.id);
    accounts.push(entry);
  }
  return { accounts, warnings };
}

export function resolveAgyAccountHome(account: AgyAccount, defaultHome: string): string {
  return account.home ? path.resolve(account.home) : defaultHome;
}

function agyAccountStatePath(home: string): string {
  return path.join(home, ".gemini", AGY_ACCOUNT_STATE_FILE);
}

export async function readAgyAccountState(home: string): Promise<AgyAccountQuotaState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(agyAccountStatePath(home), "utf8")) as Record<string, unknown>;
    return {
      exhaustedUntil: typeof parsed.exhaustedUntil === "string" ? parsed.exhaustedUntil : null,
      resetHint: typeof parsed.resetHint === "string" ? parsed.resetHint : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

export function isAgyAccountAvailable(state: AgyAccountQuotaState | null, now = Date.now()): boolean {
  if (!state?.exhaustedUntil) return true;
  const until = Date.parse(state.exhaustedUntil);
  return !Number.isFinite(until) || until <= now;
}

export async function readAgyAccountCandidates(
  accounts: AgyAccount[],
  defaultHome: string,
): Promise<AgyAccountCandidate[]> {
  return Promise.all(
    accounts.map(async (account) => {
      const home = resolveAgyAccountHome(account, defaultHome);
      return { account, home, state: await readAgyAccountState(home) };
    }),
  );
}

/**
 * Picks the first account with quota, in configured order. `preferId` (the
 * account that owns the saved conversation) wins while it still has quota so
 * the conversation can resume.
 */
export function pickAgyAccount(
  candidates: AgyAccountCandidate[],
  options: { exclude?: ReadonlySet<string>; preferId?: string | null; now?: number } = {},
): AgyAccountCandidate | null {
  const now = options.now ?? Date.now();
  const usable = candidates.filter(
    (candidate) => !options.exclude?.has(candidate.account.id) && isAgyAccountAvailable(candidate.state, now),
  );
  return usable.find((candidate) => candidate.account.id === options.preferId) ?? usable[0] ?? null;
}

async function writeAgyAccountState(home: string, state: AgyAccountQuotaState, now: number): Promise<void> {
  const target = agyAccountStatePath(home);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${now}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temp, target);
}

export async function markAgyAccountExhausted(
  home: string,
  input: { retryNotBefore: string | null; resetHint: string | null },
  now = Date.now(),
): Promise<AgyAccountQuotaState> {
  const state: AgyAccountQuotaState = {
    exhaustedUntil: input.retryNotBefore ?? new Date(now + AGY_DEFAULT_QUOTA_WINDOW_MS).toISOString(),
    resetHint: input.resetHint,
    updatedAt: new Date(now).toISOString(),
  };
  await writeAgyAccountState(home, state, now);
  return state;
}

/**
 * When `/usage` shows a limit at zero, the account waits for the earliest reset
 * of those limits. Disabled limits do not count. Null when every limit has quota.
 */
export function agyUsageExhaustedUntil(groups: AgyUsageGroup[], now = Date.now()): string | null {
  let earliest: number | null = null;
  for (const group of groups) {
    for (const bucket of group.buckets) {
      if (bucket.disabled || bucket.remainingFraction === null || bucket.remainingFraction > 0) continue;
      const reset = bucket.resetAt ? Date.parse(bucket.resetAt) : NaN;
      const until = Number.isFinite(reset) && reset > now ? reset : now + AGY_DEFAULT_QUOTA_WINDOW_MS;
      if (earliest === null || until < earliest) earliest = until;
    }
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

/**
 * Writes the account's quota state from a live `/usage` read, so the state
 * follows the limits AGY reports. An account that has quota again is cleared.
 */
export async function syncAgyAccountQuotaFromUsage(
  home: string,
  groups: AgyUsageGroup[],
  now = Date.now(),
): Promise<AgyAccountQuotaState | null> {
  const current = await readAgyAccountState(home);
  const exhaustedUntil = agyUsageExhaustedUntil(groups, now);
  if ((current?.exhaustedUntil ?? null) === exhaustedUntil) return current;
  const state: AgyAccountQuotaState = {
    exhaustedUntil,
    resetHint: exhaustedUntil ? (current?.resetHint ?? null) : null,
    updatedAt: new Date(now).toISOString(),
  };
  await writeAgyAccountState(home, state, now);
  return state;
}

/**
 * Asks `/usage` about the accounts that the state marks as exhausted, and
 * clears the ones that have quota again. Accounts with quota are not asked.
 */
export async function refreshExhaustedAgyAccounts(
  candidates: AgyAccountCandidate[],
  options: { command?: string; now?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  await Promise.all(
    candidates
      .filter((candidate) => !isAgyAccountAvailable(candidate.state, now))
      .map(async (candidate) => {
        const result = await readAgyUsage({ home: candidate.home, command: options.command });
        if (!result.ok) return;
        candidate.state = await syncAgyAccountQuotaFromUsage(candidate.home, result.groups, now);
      }),
  );
}

/** Earliest moment any configured account gets quota back, for retryNotBefore. */
export function earliestAgyAccountReset(candidates: AgyAccountCandidate[], now = Date.now()): string | null {
  let earliest: number | null = null;
  for (const candidate of candidates) {
    const until = candidate.state?.exhaustedUntil ? Date.parse(candidate.state.exhaustedUntil) : NaN;
    if (!Number.isFinite(until) || until <= now) continue;
    if (earliest === null || until < earliest) earliest = until;
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

export function describeAgyAccountStates(candidates: AgyAccountCandidate[], now = Date.now()): string {
  return candidates
    .map((candidate) =>
      isAgyAccountAvailable(candidate.state, now)
        ? `${candidate.account.id}: available`
        : `${candidate.account.id}: exhausted until ${candidate.state?.exhaustedUntil}`,
    )
    .join("; ");
}

async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

/**
 * Environment for running AGY as `account`. Replacing HOME isolates the AGY
 * sign-in; git and gh keep reading the real HOME's configuration unless the
 * run already chose their locations.
 */
export async function buildAgyAccountEnv(
  home: string,
  defaultHome: string,
  env: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  if (path.resolve(home) === path.resolve(defaultHome)) return {};
  const overrides: Record<string, string> = { HOME: home };
  if (process.platform === "win32") overrides.USERPROFILE = home;
  const gitConfig = path.join(defaultHome, ".gitconfig");
  if (!env.GIT_CONFIG_GLOBAL && (await pathExists(gitConfig))) {
    overrides.GIT_CONFIG_GLOBAL = gitConfig;
  }
  const ghConfig = path.join(env.XDG_CONFIG_HOME || path.join(defaultHome, ".config"), "gh");
  if (!env.GH_CONFIG_DIR && (await pathExists(ghConfig))) {
    overrides.GH_CONFIG_DIR = ghConfig;
  }
  return overrides;
}
