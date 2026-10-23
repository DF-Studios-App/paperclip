import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `agy -p "/usage"` only reads the account's limits. It starts no agent turn and spends no quota. */
export const AGY_USAGE_TIMEOUT_MS = 30_000;

export interface AgyUsageBucket {
  id: string;
  name: string;
  /** The window AGY names, for example "5h" or "weekly". */
  window: string;
  /** Share of the limit left, from 0 to 1. Null when AGY reports no value. */
  remainingFraction: number | null;
  resetAt: string | null;
  /** AGY shows the bucket as disabled, for example the 5-hour limit while the weekly limit is spent. */
  disabled: boolean;
}

export interface AgyUsageGroup {
  name: string;
  buckets: AgyUsageBucket[];
}

export type AgyUsageResult = { ok: true; groups: AgyUsageGroup[] } | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseBucket(raw: unknown): AgyUsageBucket[] {
  const bucket = asRecord(raw);
  const id = asText(bucket?.id);
  const name = asText(bucket?.name);
  if (!bucket || !id || !name) return [];
  const fraction = bucket.remaining_fraction;
  return [
    {
      id,
      name,
      window: asText(bucket.window) ?? "",
      remainingFraction:
        typeof fraction === "number" && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null,
      resetAt: asText(bucket.reset_time),
      disabled: bucket.disabled === true,
    },
  ];
}

/**
 * Reads the groups from the JSON that `agy -p "/usage" --output-format json`
 * prints. Returns null when the output has no usage report.
 */
export function parseAgyUsageOutput(stdout: string): AgyUsageGroup[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const data = asRecord(asRecord(asRecord(parsed)?.command)?.data);
  if (!data || !Array.isArray(data.groups)) return null;
  return data.groups.flatMap((raw) => {
    const group = asRecord(raw);
    const name = asText(group?.name);
    if (!group || !name || !Array.isArray(group.buckets)) return [];
    return [{ name, buckets: group.buckets.flatMap(parseBucket) }];
  });
}

/**
 * Asks AGY for the limits of the sign-in in `home`, the same numbers the CLI
 * shows for `/usage`. The sign-in must already exist in `home`.
 */
export async function readAgyUsage(options: {
  home: string;
  command?: string;
  timeoutMs?: number;
}): Promise<AgyUsageResult> {
  try {
    const { stdout } = await execFileAsync(options.command ?? "agy", ["-p", "/usage", "--output-format", "json"], {
      cwd: os.tmpdir(),
      env: { ...process.env, HOME: options.home },
      timeout: options.timeoutMs ?? AGY_USAGE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const groups = parseAgyUsageOutput(stdout);
    return groups ? { ok: true, groups } : { ok: false, error: "AGY returned no usage report." };
  } catch (err) {
    const timedOut = (err as { killed?: boolean }).killed === true;
    return {
      ok: false,
      error: timedOut ? "AGY did not answer in time." : "AGY could not report usage for this account.",
    };
  }
}
