# @paperclipai/adapter-agy-local

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

## Canonical Models

Available model identifiers for Antigravity CLI:

- `auto` (Default — lets `agy` use its default configured model)
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
agy --output-format stream-json -p [--dangerously-skip-permissions] [--model <model>] [--conversation <id>] "<prompt>"
```

- `-p` / `--print`: Non-interactive headless output mode suitable for daemon / harness execution.
- `--output-format stream-json`: Emits structured events used by Paperclip for transcript rendering, session capture, and usage parsing.
- `--dangerously-skip-permissions`: Optional; auto-approves AGY tool actions. Paperclip only passes it when `dangerouslySkipPermissions` is enabled.
- `--conversation <id>`: Resumes prior session state when available.

### Side-Effect Free Environment Testing

The adapter's `testEnvironment` preflight probe:
1. Validates working directory accessibility.
2. Verifies the executable resolves.
3. Runs `agy help` probe with a 10s timeout to confirm invocation health without triggering model generation or consuming quota.
4. Returns an informational diagnostic explaining that preflight confirms binary availability while complete account authentication is validated at turn execution.

### Session Recovery

If a run fails due to an unknown, expired, or missing conversation session (e.g. `conversation not found` or `unknown session`), the adapter returns `clearSession: true` to purge the invalid session ID and automatically restart fresh on the next heartbeat.
