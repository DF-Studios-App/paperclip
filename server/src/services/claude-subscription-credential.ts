/**
 * Claude subscription credentials as the Claude CLI stores them.
 *
 * The CLI keeps a short-lived access token next to a long-lived refresh token.
 * Paperclip used to store only the access token, so the connection broke when
 * it expired. The stored value is now the full `claudeAiOauth` record, and the
 * runtime renews the access token before it expires. A plain token string from
 * an older connection still works, but it cannot be renewed.
 */

// Public OAuth client and token endpoint used by the Claude CLI itself.
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Renew this long before expiry so a run never starts with a token that dies mid-run. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export interface ClaudeSubscriptionCredential {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds, as the CLI writes it. Absent for legacy plain tokens. */
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

/** Parses a stored value. A value that is not JSON is a legacy plain access token. */
export function parseClaudeSubscriptionCredential(raw: string): ClaudeSubscriptionCredential {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { accessToken: trimmed };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { accessToken: trimmed };
  }
  const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken.length) {
    throw new Error("Stored Claude credential is malformed");
  }
  return {
    accessToken: oauth.accessToken,
    refreshToken: typeof oauth.refreshToken === "string" && oauth.refreshToken.length ? oauth.refreshToken : undefined,
    expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((s): s is string => typeof s === "string") : undefined,
    subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined,
    rateLimitTier: typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : undefined,
  };
}

/** Serializes to the same shape the CLI writes, so the value is interchangeable. */
export function serializeClaudeSubscriptionCredential(credential: ClaudeSubscriptionCredential): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken ?? null,
      expiresAt: credential.expiresAt ?? null,
      scopes: credential.scopes ?? [],
      subscriptionType: credential.subscriptionType ?? null,
      rateLimitTier: credential.rateLimitTier ?? null,
    },
  });
}

export function claudeSubscriptionNeedsRefresh(credential: ClaudeSubscriptionCredential, now = Date.now()): boolean {
  return Boolean(credential.refreshToken) && typeof credential.expiresAt === "number" &&
    credential.expiresAt - REFRESH_SKEW_MS <= now;
}

/**
 * Exchanges the refresh token for a new access token. The refresh token can
 * rotate, so the caller must store the returned credential. Errors never echo
 * the provider response body, because it can contain token material.
 */
export async function refreshClaudeSubscriptionCredential(
  credential: ClaudeSubscriptionCredential,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<ClaudeSubscriptionCredential> {
  if (!credential.refreshToken) throw new Error("Claude credential has no refresh token");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
  });
  if (credential.scopes?.length) body.set("scope", credential.scopes.join(" "));
  const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Claude token refresh failed with status ${response.status}`);
  }
  const payload = (await response.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof payload.access_token !== "string" || !payload.access_token.length) {
    throw new Error("Claude token refresh returned no access token");
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : DEFAULT_EXPIRES_IN_SECONDS;
  return {
    ...credential,
    accessToken: payload.access_token,
    // Keep the old refresh token when the provider does not rotate it.
    refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token.length
      ? payload.refresh_token
      : credential.refreshToken,
    expiresAt: now + expiresIn * 1000,
  };
}
