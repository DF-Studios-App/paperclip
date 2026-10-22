# @paperclipai/adapter-agy-local

> **Note:** AGY is a workspace-only feature in this fork and npm publication from the fork is intentionally disabled.

Paperclip built-in adapter for Google Antigravity CLI (`agy`).

## Overview

The `agy_local` adapter allows Paperclip agents to execute tasks through the local Antigravity CLI harness (`agy`).

- **Adapter Type**: `agy_local`
- **Execution Mode**: Local CLI sub-process or remote SSH target
- **Authentication**: Uses the existing AGY account session on the execution host. No Gemini API key field or secret prompt is required.
- **Skills Directory**: `~/.gemini/skills/`
- **Session Continuity**: Multi-turn conversation resumption via `--conversation <id>` with automatic clean retry on unknown/stale sessions.

## Prerequisites

1. Install `agy` on the host machine running Paperclip or the configured remote execution target.
2. Complete sign-in using the authentication flow supported by your installed AGY version.
3. Verify that `agy` is on `PATH` (or provide custom path in agent configuration).

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `command` | `string` | `"agy"` | Path to the `agy` binary. |
| `model` | `string` | `"auto"` | Model identifier. `"auto"` omits `--model` to respect the CLI's default configuration. |
| `cwd` | `string` | `undefined` | Working directory for local execution. |
| `extraArgs` | `string[]` | `[]` | Additional command-line flags to pass to `agy`. |
| `env` | `Record<string, unknown>` | `{}` | Environment variable overrides. |
| `sandbox` | `boolean` | `true` | When true, passes `--sandbox` flag. Set to false if bypassing sandbox. |
| `dangerouslySkipPermissions` | `boolean` | `false` | When true, adds `--dangerously-skip-permissions` and auto-approves AGY tool actions. Enable only when unattended actions are intended. |
| `instructionsFilePath` | `string` | `undefined` | Path to persistent agent instructions file. |
| `accounts` | `Array<{ id, home? } \| string>` | `undefined` | AGY accounts in priority order for quota failover. See [Multiple accounts](#multiple-accounts). |

## Multiple accounts

AGY keeps its sign-in in `$HOME/.gemini`. On Linux hosts (including the Docker
image) the sign-in is a file there, so a separate HOME is a separate account.
Sign in each extra account once:

```sh
mkdir -p /paperclip/agy-accounts/conta2
HOME=/paperclip/agy-accounts/conta2 agy
```

Then list the accounts in priority order. An entry without `home` uses the
default sign-in. Strings of the form `id` or `id=/absolute/home` are also accepted.

```json
"accounts": [
  { "id": "conta1" },
  { "id": "conta2", "home": "/paperclip/agy-accounts/conta2" },
  { "id": "conta3", "home": "/paperclip/agy-accounts/conta3" }
]
```

How switching works:

- A run uses the first account that has quota. A saved conversation resumes only on the account that created it; the account is stored as `agyAccountId` in the session parameters.
- When AGY reports exhausted account quota (for example `Individual quota reached ... Resets in 4h3m21s`), the adapter records the reset time in `<home>/.gemini/.paperclip-agy-quota.json` and runs the same turn again on the next account, in a fresh conversation with the full prompt. Every agent that lists the account reads the same file. Without a reset time, the account is skipped for 5 hours.
- An account that is not signed in is skipped for that run.
- Short upstream errors (`503`, `429`, rate limits without a quota message) do not switch accounts.
- When every account is out of quota, the run fails with `agy_quota_exhausted` and `retryNotBefore` set to the earliest reset, so the heartbeat retries then.
- With a separate HOME, the run keeps reading git and gh configuration from the default HOME (`GIT_CONFIG_GLOBAL`, `GH_CONFIG_DIR`) unless the run sets them already. Paperclip skills are linked into each account's `.gemini/skills`.
- Accounts apply to local execution only. On Windows and macOS AGY stores its sign-in in the OS credential store, which a separate HOME does not isolate.

## Canonical Models

Available model identifiers for Antigravity CLI:

- `auto` (Default — lets `agy` use its default configured model)
- `gemini-4-argon-high`
- `gemini-4-argon-medium`
- `gemini-4-argon-low`
- `gemini-3.8-flash-high`
- `gemini-3.8-flash-medium`
- `gemini-3.8-flash-low`
- `gemini-3.7-flash-high`
- `gemini-3.7-flash-medium`
- `gemini-3.7-flash-low`
- `gemini-3.1-pro-high`
- `gemini-3.1-pro-low`
- `claude-sonnet-4-6`
- `claude-opus-4-6`
- `gpt-oss-1`

## Runtime Architecture

### Command Invocation

```sh
agy --output-format stream-json --input-format stream-json [--dangerously-skip-permissions] [--model <model>] [--conversation <id>]
```

- `--output-format stream-json`: Emits structured events used by Paperclip for transcript rendering, session capture, and usage parsing.
- `--input-format stream-json`: Reads the prompt from stdin as a newline-delimited JSON `user` event. This avoids Windows command-line length limits for large Paperclip prompts.
- `--dangerously-skip-permissions`: Optional; auto-approves AGY tool actions. Paperclip only passes it when `dangerouslySkipPermissions` is enabled.
- `--conversation <id>`: Resumes prior session state when available.

Paperclip-managed MCP servers granted to the agent are written to the workspace
`.agents/mcp_config.json` for the duration of a local run. The adapter uses the
Antigravity `serverUrl` and `headers.Authorization` fields, preserves existing
workspace servers, and removes its run-scoped entries when the CLI exits.
Remote execution targets do not receive these runtime MCP servers yet.

Paperclip sends one JSON line to stdin in this shape:

```json
{"event":"user","message":{"content":"/goal <prompt>"}}
```

Every `agy_local` run starts with Antigravity's `/goal` slash command so the
agent continues working toward its Paperclip objective. `/goal` is a prompt
command, not a CLI flag; legacy `-goal` or `--goal` entries in `extraArgs` are
ignored. This does not change Paperclip's own approval gates.

### Side-Effect Free Environment Testing

The adapter's `testEnvironment` preflight probe:
1. Validates working directory accessibility.
2. Verifies the executable resolves.
3. Runs `agy help` probe with a 10s timeout to confirm invocation health without triggering model generation or consuming quota.
4. Returns an informational diagnostic explaining that preflight confirms binary availability while complete account authentication is validated at turn execution.

### Session Recovery

The adapter persists the `conversation_id` from init, step and terminal result events. It resumes with `--conversation` only when the working directory and execution-target identity match. A confirmed missing conversation triggers one fresh retry in the same heartbeat; a successful replacement session is saved, otherwise `clearSession: true` clears the stale ID. An incompatible session is never reused as a fallback.

`agy_local` explicitly supports session resume. Native context management remains unconfirmed, so Paperclip uses its conservative default compaction policy: 200 runs, 2,000,000 raw input tokens, or 72 hours, configurable through runtime session compaction overrides.

### Stream parsing and usage

All three consumers share dependency-free normalization of AGY `event: init`, `step_update`, and `result` envelopes, while retaining legacy type-based events. Response deltas concatenate without added newlines; the terminal response is authoritative. Step usage is counted once per step and reported with `usageBasis: "per_run"`, ensuring the heartbeat does not session-delta already distinct run tokens.

When step usage is absent, the adapter falls back to `result.usage`. If previous cumulative usage is known in session parameters from earlier turns, the adapter computes the per-run delta and reports `usageBasis: "per_run"`; otherwise, it declares `usageBasis: "session_cumulative"` so the control plane derives the run delta from prior session history. Alternating between step usage and cumulative fallback maintains continuous cumulative tracking in `sessionParams`, preventing both undercounting and double counting on resumed sessions. See the [official headless protocol](https://www.antigravity.google/docs/cli/headless/). Regression fixtures include a sanitized local AGY 1.2.11 run.

### Remote skills

Remote execution stores managed skill copies in `~/.gemini/.paperclip-agy-skills` and links them into `~/.gemini/skills`. External entries, including name collisions and dangling links, are preserved. Only links pointing to the exact private store entry are refreshed or removed when deselected; the skills directory is never replaced. Symlinked skills/store roots are rejected. Existing unmarked copies from older adapter versions are treated as external and require manual migration if they collide.
