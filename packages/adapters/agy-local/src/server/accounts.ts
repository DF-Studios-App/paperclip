import fs from "node:fs/promises";
import path from "node:path";

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

const AGY_ACCOUNT_STATE_FILE = ".paperclip-agy-quota.json";
const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  const target = agyAccountStatePath(home);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${now}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temp, target);
  return state;
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
