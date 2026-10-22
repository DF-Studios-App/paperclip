import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { isAgyAccountAvailable, readAgyAccountCandidates, readAgyAccounts } from "./accounts.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agy");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `agy-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "agy_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "agy_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "agy_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  // agy is not on npm; skip sandbox auto-install (SANDBOX_INSTALL_COMMAND is null)
  if (SANDBOX_INSTALL_COMMAND) {
    const installCheck = await maybeRunSandboxInstallCommand({
      runId,
      target,
      adapterKey: "agy",
      installCommand: SANDBOX_INSTALL_COMMAND,
      detectCommand: command,
      env,
    });
    if (installCheck) checks.push(installCheck);
  }

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "agy_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "agy_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "agy_cwd_invalid" && check.code !== "agy_command_unresolvable");

  if (canRunProbe) {
    if (!commandLooksLike(command, "agy")) {
      checks.push({
        code: "agy_help_probe_skipped_custom_command",
        level: "info",
        message: "Skipped help probe because command is not `agy`.",
        detail: command,
        hint: "Use the `agy` CLI command to run the automatic installation and verification.",
      });
    } else {
      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        ["help"],
        {
          cwd,
          env,
          timeoutSec: 10,
          graceSec: 2,
          onLog: async () => {},
        },
      );

      if (probe.timedOut) {
        checks.push({
          code: "agy_help_probe_timed_out",
          level: "warn",
          message: "AGY CLI help probe timed out.",
          hint: "Verify if another agy process is holding a session lock.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        checks.push({
          code: "agy_help_probe_passed",
          level: "info",
          message: "AGY CLI help probe succeeded.",
          detail: "Command help runs successfully.",
        });
      } else {
        checks.push({
          code: "agy_help_probe_failed",
          level: "error",
          message: "AGY CLI help probe failed.",
          detail: probe.stderr || probe.stdout,
          hint: "Verify if agy command is correctly installed and configured.",
        });
      }
    }
  }

  const { accounts, warnings: accountWarnings } = readAgyAccounts(config);
  for (const warning of accountWarnings) {
    checks.push({ code: "agy_account_invalid", level: "warn", message: warning });
  }
  if (accounts.length > 0 && targetIsRemote) {
    checks.push({
      code: "agy_accounts_remote_ignored",
      level: "warn",
      message: "AGY accounts apply to local execution only; this remote target uses its own AGY sign-in.",
    });
  } else if (accounts.length > 0) {
    const candidates = await readAgyAccountCandidates(accounts, runtimeEnv.HOME || os.homedir());
    for (const candidate of candidates) {
      const label = `AGY account "${candidate.account.id}" (HOME=${candidate.home})`;
      // On Linux AGY stores its sign-in as a file; elsewhere it uses the OS
      // credential store, which a separate HOME does not isolate.
      const signInFile = path.join(candidate.home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
      const homeExists = await fs.access(candidate.home).then(() => true, () => false);
      const signedIn =
        process.platform !== "linux" || (await fs.access(signInFile).then(() => true, () => false));
      if (!homeExists || !signedIn) {
        checks.push({
          code: "agy_account_not_signed_in",
          level: "warn",
          message: `${label} has no AGY sign-in.`,
          hint: `Sign in once with: HOME=${candidate.home} agy`,
        });
      } else if (!isAgyAccountAvailable(candidate.state)) {
        checks.push({
          code: "agy_account_quota_exhausted",
          level: "info",
          message: `${label} is out of quota until ${candidate.state?.exhaustedUntil}.`,
        });
      } else {
        checks.push({ code: "agy_account_ready", level: "info", message: `${label} is configured.` });
      }
    }
    if (process.platform !== "linux") {
      checks.push({
        code: "agy_accounts_shared_credential_store",
        level: "warn",
        message:
          "On this OS AGY keeps its sign-in in the OS credential store, so separate account HOME directories may share one sign-in. Multi-account switching is supported on Linux hosts such as the Docker image.",
      });
    }
  }

  // Preflight guidance clearly distinguishing executable probe from login/model authentication
  checks.push({
    code: "agy_auth_preflight_guidance",
    level: "info",
    message:
      "AGY preflight verifies CLI installation and command execution only. It does not verify account authentication or model access; those are checked when a run executes.",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
