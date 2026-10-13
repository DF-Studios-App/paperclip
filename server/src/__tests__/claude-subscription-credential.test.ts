import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_URL,
  claudeSubscriptionNeedsRefresh,
  parseClaudeSubscriptionCredential,
  refreshClaudeSubscriptionCredential,
  serializeClaudeSubscriptionCredential,
} from "../services/claude-subscription-credential.js";

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

describe("claude subscription credential", () => {
  it("reads a legacy plain access token without a refresh token", () => {
    expect(parseClaudeSubscriptionCredential("plain-token")).toEqual({ accessToken: "plain-token" });
    expect(claudeSubscriptionNeedsRefresh(parseClaudeSubscriptionCredential("plain-token"), NOW)).toBe(false);
  });

  it("round-trips the CLI claudeAiOauth shape", () => {
    const stored = serializeClaudeSubscriptionCredential({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: NOW + HOUR,
      scopes: ["user:inference"],
      subscriptionType: "pro",
    });
    expect(JSON.parse(stored).claudeAiOauth.accessToken).toBe("access-1");
    expect(parseClaudeSubscriptionCredential(stored)).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: NOW + HOUR,
      scopes: ["user:inference"],
      subscriptionType: "pro",
      rateLimitTier: undefined,
    });
  });

  it("rejects a JSON record without an access token", () => {
    expect(() => parseClaudeSubscriptionCredential(JSON.stringify({ claudeAiOauth: {} }))).toThrow("malformed");
  });

  it("asks for a refresh only inside the skew window", () => {
    const base = { accessToken: "a", refreshToken: "r" };
    expect(claudeSubscriptionNeedsRefresh({ ...base, expiresAt: NOW + HOUR }, NOW)).toBe(false);
    expect(claudeSubscriptionNeedsRefresh({ ...base, expiresAt: NOW + 60 * 1000 }, NOW)).toBe(true);
    expect(claudeSubscriptionNeedsRefresh({ ...base, expiresAt: NOW - HOUR }, NOW)).toBe(true);
    expect(claudeSubscriptionNeedsRefresh({ accessToken: "a", expiresAt: NOW - HOUR }, NOW)).toBe(false);
  });

  it("exchanges the refresh token with the CLI endpoint and client", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: "access-2", refresh_token: "refresh-2", expires_in: 28800,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const renewed = await refreshClaudeSubscriptionCredential(
      { accessToken: "access-1", refreshToken: "refresh-1", scopes: ["a", "b"] },
      NOW,
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLAUDE_OAUTH_TOKEN_URL);
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");
    expect(form.get("client_id")).toBe(CLAUDE_OAUTH_CLIENT_ID);
    expect(form.get("scope")).toBe("a b");
    expect(renewed).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2", expiresAt: NOW + 28800 * 1000 });
  });

  it("keeps the old refresh token when the provider does not rotate it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "access-2", expires_in: 3600 }), { status: 200 }));
    const renewed = await refreshClaudeSubscriptionCredential(
      { accessToken: "access-1", refreshToken: "refresh-1" }, NOW, fetchImpl as unknown as typeof fetch,
    );
    expect(renewed.refreshToken).toBe("refresh-1");
    expect(renewed.expiresAt).toBe(NOW + 3600 * 1000);
  });

  it("fails without echoing the provider body", async () => {
    const fetchImpl = vi.fn(async () => new Response("leaked-refresh-secret", { status: 400 }));
    const attempt = refreshClaudeSubscriptionCredential(
      { accessToken: "a", refreshToken: "refresh-1" }, NOW, fetchImpl as unknown as typeof fetch,
    );
    await expect(attempt).rejects.toThrow("status 400");
    await attempt.catch((error: Error) => expect(error.message).not.toContain("leaked"));
  });
});
