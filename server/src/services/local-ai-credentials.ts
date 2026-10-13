import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";
import fs from "node:fs/promises";
import path from "node:path";
import { readClaudeToken, readIsolatedClaudeKeychainToken, fetchClaudeQuota } from "@paperclipai/adapter-claude-local/server";
import { readCodexAuthInfo, fetchCodexQuota } from "@paperclipai/adapter-codex-local/server";
import { parseGrokAuthPayload, hasUsableGrokAuthValue } from "@paperclipai/adapter-grok-local/server";
import type { AiProvider } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import {
  parseClaudeSubscriptionCredential,
  serializeClaudeSubscriptionCredential,
  type ClaudeSubscriptionCredential,
} from "./claude-subscription-credential.js";

/**
 * Read an owned login home, or an explicitly authorized local-operator import.
 * `storable` returns the Claude record with its refresh token, so the caller can
 * save a connection that Paperclip can renew.
 */
export async function readVerifiedLocalAiCredential(
  provider: AiProvider,
  loginHome?: string,
  options: { storable?: boolean } = {},
): Promise<string> {
  if (provider === "openrouter") throw unprocessable("OpenRouter requires an API key.");
  if ((provider === "openai" || provider === "xai") && !loginHome)
    throw unprocessable("Start a separate local sign-in for this connection before connecting.");
  try {
    if (provider === "anthropic") {
      // Never change process.env or fall back to the server account when an
      // authenticated user's isolated login is missing or invalid.
      let record: ClaudeSubscriptionCredential | null = null;
      if (loginHome) {
        for (const name of [".credentials.json", "credentials.json"]) {
          const raw = await readLocalAiCredentialFile(path.join(loginHome, name)).catch(() => null);
          if (!raw) continue;
          let parsed;
          try { parsed = JSON.parse(raw); } catch { continue; }
          const value = parsed?.claudeAiOauth?.accessToken;
          if (typeof value === "string" && value.length) { record = parseClaudeSubscriptionCredential(raw); break; }
        }
        // On macOS the CLI stores the isolated login in the auth home's own
        // suffixed Keychain item rather than a credentials file. The helper
        // never consults the unsuffixed operator item.
        if (!record) {
          const token = await readIsolatedClaudeKeychainToken(loginHome);
          if (token) record = { accessToken: token };
        }
      } else {
        const token = await readClaudeToken({ allowKeychain: true });
        if (token) record = { accessToken: token };
      }
      if (!record) throw new Error("Missing login");
      await fetchClaudeQuota(record.accessToken);
      // Keychain and host imports carry no refresh token, so they stay plain tokens.
      if (options.storable && record.refreshToken) return serializeClaudeSubscriptionCredential(record);
      return record.accessToken;
    }
    if (provider === "openai") {
      const auth = await readCodexAuthInfo(loginHome);
      if (!auth?.accessToken || !auth.refreshToken || !auth.idToken) throw new Error("Missing login");
      await fetchCodexQuota(auth.accessToken, auth.accountId);
      return JSON.stringify({ tokens: { access_token: auth.accessToken, refresh_token: auth.refreshToken, id_token: auth.idToken, account_id: auth.accountId }, last_refresh: auth.lastRefresh });
    }
    const raw = await fs.readFile(path.join(loginHome!, "auth.json"), "utf8");
    const payload = parseGrokAuthPayload(JSON.parse(raw));
    if (!payload || !hasUsableGrokAuthValue(payload.value)) throw new Error("Missing login");
    const response = await fetch("https://api.x.ai/v1/models", {
      headers: { Authorization: `Bearer ${payload.value.key}` },
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Invalid login");
    return raw;
  } catch {
    // Provider/CLI errors may contain credential material; never return them.
    throw unprocessable(provider === "anthropic" && !loginHome
      ? "Could not verify the local subscription. Run claude auth login in a terminal on the machine running Paperclip, then try Connect again."
      : "Could not verify the local subscription. Run the sign-in command shown for this connection, finish signing in, then try Connect again.");
  }
}
