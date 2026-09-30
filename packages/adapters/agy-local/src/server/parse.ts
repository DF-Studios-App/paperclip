import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

const CONVERSATION_ID_RE =
  /(?:conversation|session)(?:\s+id)?[:\s]+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
const CONVERSATION_TRAVERSED_RE =
  /(?:traversed\s+workspace\s+for\s+conversation\s+|conversation\s+)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;

export function parseAgyOutput(stdout: string, stderr: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd: number | null = null;

  // Extract session/conversation ID from explicit patterns in output
  const combinedText = `${stdout}\n${stderr}`;
  const conversationMatch =
    combinedText.match(CONVERSATION_ID_RE) ?? combinedText.match(CONVERSATION_TRAVERSED_RE);
  if (conversationMatch && conversationMatch[1]) {
    sessionId = conversationMatch[1];
  }

  // Parse stdout lines
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Check if the line is JSON
    if (line.startsWith("{") && line.endsWith("}")) {
      const event = parseJson(line);
      if (event) {
        const type = asString(event.type, "").trim().toLowerCase();
        const subtype = asString(event.subtype, "").trim().toLowerCase();

        if (type === "system" && subtype === "init") {
          const eventSessionId = asString(
            event.sessionId ?? event.session_id ?? event.conversationId ?? event.conversation_id,
            "",
          );
          if (eventSessionId) sessionId = eventSessionId;
        } else if (type === "error" || type === "stderr") {
          errorMessage = asString(event.message ?? event.error ?? event.text, errorMessage ?? "");
        } else if (type === "assistant" || type === "text") {
          const text = asString(event.text ?? event.content ?? event.message, "");
          if (text) messages.push(text);
        } else if (type === "result" || type === "stats" || type === "usage") {
          const stats = parseObject(event.stats ?? event.usage ?? event);
          if (stats) {
            usage.inputTokens = asNumber(stats.inputTokens ?? stats.input_tokens, usage.inputTokens);
            usage.outputTokens = asNumber(stats.outputTokens ?? stats.output_tokens, usage.outputTokens);
            usage.cachedInputTokens = asNumber(
              stats.cachedInputTokens ?? stats.cached_input_tokens,
              usage.cachedInputTokens,
            );
            const cost = stats.total_cost_usd ?? stats.costUsd ?? stats.cost;
            if (typeof cost === "number") {
              costUsd = cost;
            }
          }
        }
        continue;
      }
    }

    // Accumulate non-JSON text lines as part of the summary
    messages.push(line);
  }

  // If we have an exit error or stderr contains error indications
  if (!errorMessage) {
    const stderrLines = stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.toLowerCase().includes("error") || l.toLowerCase().includes("failed"));
    if (stderrLines.length > 0) {
      errorMessage = stderrLines[0];
    }
  }

  return {
    sessionId,
    summary: messages.join("\n").trim(),
    usage,
    costUsd,
    errorMessage: errorMessage || null,
  };
}

export const parseAntigravityOutput = parseAgyOutput;

export function isAgyUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();
  return (
    haystack.includes("unknown conversation") ||
    haystack.includes("conversation not found") ||
    haystack.includes("unknown session") ||
    haystack.includes("session not found") ||
    haystack.includes("failed to resume") ||
    haystack.includes("cannot resume") ||
    haystack.includes("no conversation found")
  );
}

export const isAntigravityUnknownSessionError = isAgyUnknownSessionError;

export function describeAgyFailure(stdout: string, stderr: string): string | null {
  const { errorMessage } = parseAgyOutput(stdout, stderr);
  if (errorMessage) {
    return `AGY CLI failed: ${errorMessage}`;
  }
  const firstStderr = stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (firstStderr) {
    return `AGY CLI failed: ${firstStderr}`;
  }
  return "AGY CLI failed with non-zero exit code";
}

export const describeAntigravityFailure = describeAgyFailure;

const AGY_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|login\s+required|requires\s+login|unauthorized|authentication\s+required|api[_ ]?key\s+(?:required|missing|invalid)|invalid\s+credentials|run\s+`?agy\s+login`?\s+first)/i;

export function detectAgyAuthRequired(input: {
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const combined = `${input.stdout}\n${input.stderr}`;
  const requiresAuth = AGY_AUTH_REQUIRED_RE.test(combined);
  return { requiresAuth };
}

export const detectAntigravityAuthRequired = detectAgyAuthRequired;

export function isAgyTurnLimitResult(
  stdout: string,
  stderr: string,
  exitCode?: number | null,
): boolean {
  if (exitCode === 53) return true;
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("turn_limit") ||
    combined.includes("max_turns") ||
    combined.includes("max_turns_exhausted") ||
    combined.includes("turn_limit_exhausted")
  );
}

export const isAntigravityTurnLimitResult = isAgyTurnLimitResult;

/**
 * Matches AGY CLI quota / rate-limit errors that are transient and
 * should be retried automatically after a back-off.
 */
const AGY_QUOTA_RE =
  /(?:individual\s+quota\s+reached|quota\s+(?:reached|exceeded|exhausted)|resource[_\s]exhausted|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|service\s+unavailable|\b503\b|overages\s+(?:not\s+)?enabled|resets?\s+in\s+\d)/i;

/**
 * Parses a human-readable duration string produced by agy such as
 * "4h3m21s", "2h30m", "45m", "90s" into milliseconds.
 * Returns null if the string cannot be parsed.
 */
export function parseAgyResetDurationMs(raw: string): number | null {
  const match = raw.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const hours = parseInt(match[1] ?? "0", 10);
  const minutes = parseInt(match[2] ?? "0", 10);
  const seconds = parseInt(match[3] ?? "0", 10);
  const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
  return totalMs > 0 ? totalMs : null;
}

export function detectAgyQuotaExhausted(input: {
  stdout: string;
  stderr: string;
}): { exhausted: boolean; resetHint: string | null; retryNotBefore: string | null } {
  const combined = `${input.stdout}\n${input.stderr}`;
  const exhausted = AGY_QUOTA_RE.test(combined);

  if (!exhausted) return { exhausted: false, resetHint: null, retryNotBefore: null };

  const resetMatch = combined.match(/resets?\s+in\s+([\dhms\s]+)/i);
  const resetHint = resetMatch ? `Resets in ${resetMatch[1].trim()}` : null;

  let retryNotBefore: string | null = null;
  if (resetMatch) {
    const durationMs = parseAgyResetDurationMs(resetMatch[1].trim());
    if (durationMs !== null) {
      retryNotBefore = new Date(Date.now() + durationMs + 60_000).toISOString();
    }
  }

  return { exhausted, resetHint, retryNotBefore };
}

export const detectAntigravityQuotaExhausted = detectAgyQuotaExhausted;
