import { z } from "zod";

/**
 * Company-shared Antigravity CLI (`agy`) accounts. Each account is a separate
 * HOME on the Paperclip host; `agy_local` agents of the company use them in
 * order and move to the next account when one runs out of quota.
 */
export const AGY_ACCOUNT_LABEL_MAX_LENGTH = 80;

export const startAgyAccountLoginSchema = z.object({
  label: z.string().trim().min(1).max(AGY_ACCOUNT_LABEL_MAX_LENGTH).optional(),
});
export type StartAgyAccountLogin = z.infer<typeof startAgyAccountLoginSchema>;

export const submitAgyAccountLoginCodeSchema = z.object({
  code: z.string().trim().min(1).max(4096),
});
export type SubmitAgyAccountLoginCode = z.infer<typeof submitAgyAccountLoginCodeSchema>;

export interface AgyAccountSummary {
  id: string;
  label: string;
  /** True for the sign-in in the Paperclip host's own HOME. It cannot be removed here. */
  isDefault: boolean;
  signedIn: boolean;
  exhaustedUntil: string | null;
  resetHint: string | null;
  createdAt: string | null;
}

/** One limit of an AGY account, as the CLI shows it under `/usage`. */
export interface AgyAccountQuotaBucket {
  id: string;
  name: string;
  /** The window AGY names, for example "5h" or "weekly". */
  window: string;
  /** Share of the limit left, from 0 to 1. Null when AGY reports no value. */
  remainingFraction: number | null;
  resetAt: string | null;
  /** AGY shows the bucket as disabled. */
  disabled: boolean;
}

export interface AgyAccountQuotaGroup {
  name: string;
  buckets: AgyAccountQuotaBucket[];
}

export type AgyAccountQuotaStatus = "ok" | "not_signed_in" | "error";

export interface AgyAccountQuota {
  accountId: string;
  status: AgyAccountQuotaStatus;
  checkedAt: string;
  groups: AgyAccountQuotaGroup[];
  error: string | null;
}

export interface AgyAccountsQuotaResponse {
  accounts: AgyAccountQuota[];
}

export type AgyAccountLoginStatus =
  | "starting"
  | "waiting_for_code"
  | "verifying"
  | "signed_in"
  | "failed"
  | "cancelled";

export interface AgyAccountLogin {
  id: string;
  accountId: string;
  status: AgyAccountLoginStatus;
  /** Google sign-in URL. Present only while the login waits for the user. */
  authorizationUrl: string | null;
  error: string | null;
  expiresAt: string;
}

export interface AgyAccountsResponse {
  /** False when this host cannot run the AGY sign-in (for example not Linux, or a public deployment). */
  available: boolean;
  unavailableReason: string | null;
  canManage: boolean;
  accounts: AgyAccountSummary[];
  login: AgyAccountLogin | null;
}
