import { randomUUID } from "node:crypto";
import os from "node:os";
import type { Db } from "@paperclipai/db";
import type {
  AgyAccountLogin,
  AgyAccountLoginStatus,
  AgyAccountSummary,
  DeploymentExposure,
  DeploymentMode,
} from "@paperclipai/shared";
import {
  AGY_DEFAULT_ACCOUNT_ID,
  AGY_LOGIN_TIMEOUT_MS,
  createAgyCompanyAccount,
  isAgyHomeSignedIn,
  listAgyCompanyAccounts,
  readAgyAccountState,
  removeAgyCompanyAccount,
  resolveAgyCompanyAccountsDir,
  startAgyLogin,
  type AgyLoginHandle,
} from "@paperclipai/adapter-agy-local/server";
import { conflict, notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logActivity } from "./activity-log.js";
import { supportsLocalAiLogin } from "./local-ai-login-policy.js";

// Company-shared AGY accounts. An account is a HOME directory under
// `<instanceRoot>/companies/<companyId>/agy-accounts`, which the agy_local
// adapter reads at run time. Sign-in runs the agy CLI on this host in a
// pseudo-terminal. The OAuth URL lives only in memory and in the owner's API
// response; activity records carry no URL or code.

const FINISHED_LOGIN_RETENTION_MS = 10 * 60 * 1000;

interface AgyLoginEntry {
  id: string;
  companyId: string;
  accountId: string;
  actorId: string;
  status: AgyAccountLoginStatus;
  authorizationUrl: string | null;
  error: string | null;
  expiresAt: string;
  finishedAt: number | null;
  handle: AgyLoginHandle | null;
}

// Shared by every service instance in this process; the CLI runs here.
const logins = new Map<string, AgyLoginEntry>();

function pruneFinishedLogins(now = Date.now()) {
  for (const [id, entry] of logins) {
    if (entry.finishedAt !== null && now - entry.finishedAt > FINISHED_LOGIN_RETENTION_MS) logins.delete(id);
  }
}

function toPublicLogin(entry: AgyLoginEntry): AgyAccountLogin {
  return {
    id: entry.id,
    accountId: entry.accountId,
    status: entry.status,
    authorizationUrl: entry.status === "waiting_for_code" ? entry.authorizationUrl : null,
    error: entry.error,
    expiresAt: entry.expiresAt,
  };
}

function isActive(entry: AgyLoginEntry) {
  return entry.finishedAt === null;
}

export interface AgyAccountServiceOptions {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
  trustedLocalStdioRuntimeHost?: string | null;
  instanceRoot?: string;
  platform?: NodeJS.Platform;
  defaultHome?: string;
  startLogin?: typeof startAgyLogin;
}

export function agyAccountService(db: Db, options: AgyAccountServiceOptions = {}) {
  const platform = options.platform ?? process.platform;
  const startLogin = options.startLogin ?? startAgyLogin;
  const defaultHome = options.defaultHome ?? (process.env.HOME || os.homedir());
  const accountsDir = (companyId: string) =>
    resolveAgyCompanyAccountsDir(options.instanceRoot ?? resolvePaperclipInstanceRoot(), companyId);

  function availability(): { available: boolean; reason: string | null } {
    if (platform !== "linux") {
      return {
        available: false,
        reason: "AGY accounts need a Linux Paperclip host, such as the Docker image. On this OS AGY keeps one sign-in in the OS credential store.",
      };
    }
    if (!supportsLocalAiLogin(options)) {
      return { available: false, reason: "AGY sign-in runs on the Paperclip host, which this public deployment does not allow." };
    }
    return { available: true, reason: null };
  }

  function assertAvailable() {
    const { available, reason } = availability();
    if (!available) throw conflict(reason ?? "AGY accounts are unavailable on this host.");
  }

  async function list(companyId: string): Promise<AgyAccountSummary[]> {
    const summaries: AgyAccountSummary[] = [];
    const defaultSignedIn = await isAgyHomeSignedIn(defaultHome, platform);
    if (defaultSignedIn) {
      const state = await readAgyAccountState(defaultHome);
      summaries.push({
        id: AGY_DEFAULT_ACCOUNT_ID,
        label: "Host sign-in",
        isDefault: true,
        signedIn: true,
        exhaustedUntil: state?.exhaustedUntil ?? null,
        resetHint: state?.resetHint ?? null,
        createdAt: null,
      });
    }
    for (const record of await listAgyCompanyAccounts(accountsDir(companyId))) {
      const state = await readAgyAccountState(record.home);
      summaries.push({
        id: record.id,
        label: record.label,
        isDefault: false,
        signedIn: await isAgyHomeSignedIn(record.home, platform),
        exhaustedUntil: state?.exhaustedUntil ?? null,
        resetHint: state?.resetHint ?? null,
        createdAt: record.createdAt,
      });
    }
    return summaries;
  }

  function activeLogin(companyId: string): AgyAccountLogin | null {
    pruneFinishedLogins();
    const entries = [...logins.values()].filter((entry) => entry.companyId === companyId);
    const entry = entries.find(isActive) ?? entries.at(-1);
    return entry ? toPublicLogin(entry) : null;
  }

  function getEntry(companyId: string, loginId: string): AgyLoginEntry {
    const entry = logins.get(loginId);
    if (!entry || entry.companyId !== companyId) throw notFound("AGY sign-in not found");
    return entry;
  }

  async function finishLogin(entry: AgyLoginEntry, status: AgyAccountLoginStatus, error: string | null) {
    entry.status = status;
    entry.error = error;
    entry.authorizationUrl = null;
    entry.finishedAt = Date.now();
    entry.handle = null;
    if (status === "signed_in") {
      await logActivity(db, {
        companyId: entry.companyId,
        actorType: "user",
        actorId: entry.actorId,
        action: "agy_account.signed_in",
        entityType: "agy_account",
        entityId: entry.accountId,
      }).catch(() => undefined);
      return;
    }
    // A new account that never signed in has no use; remove its directory.
    const home = (await listAgyCompanyAccounts(accountsDir(entry.companyId))).find(
      (record) => record.id === entry.accountId,
    )?.home;
    if (home && !(await isAgyHomeSignedIn(home, platform))) {
      await removeAgyCompanyAccount(accountsDir(entry.companyId), entry.accountId).catch(() => undefined);
    }
  }

  async function beginLogin(companyId: string, actorId: string, input: { label?: string }) {
    assertAvailable();
    pruneFinishedLogins();
    if ([...logins.values()].some((entry) => entry.companyId === companyId && isActive(entry))) {
      throw conflict("Another AGY sign-in is already in progress for this company. Finish or cancel it first.");
    }
    const record = await createAgyCompanyAccount(accountsDir(companyId), { label: input.label });
    const entry: AgyLoginEntry = {
      id: randomUUID(),
      companyId,
      accountId: record.id,
      actorId,
      status: "starting",
      authorizationUrl: null,
      error: null,
      expiresAt: new Date(Date.now() + AGY_LOGIN_TIMEOUT_MS).toISOString(),
      finishedAt: null,
      handle: null,
    };
    logins.set(entry.id, entry);
    entry.handle = startLogin({
      home: record.home,
      onAuthorizationUrl: (url) => {
        if (entry.status === "starting") {
          entry.authorizationUrl = url;
          entry.status = "waiting_for_code";
        }
      },
      onCodeSubmitted: () => {
        entry.status = "verifying";
        entry.authorizationUrl = null;
      },
    });
    void entry.handle.done.then((result) =>
      finishLogin(
        entry,
        result.outcome,
        result.outcome === "failed" ? result.error : null,
      ),
    );
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId,
      action: "agy_account.login_started",
      entityType: "agy_account",
      entityId: record.id,
      details: { label: record.label },
    });
    return toPublicLogin(entry);
  }

  function getLogin(companyId: string, loginId: string): AgyAccountLogin {
    return toPublicLogin(getEntry(companyId, loginId));
  }

  async function submitCode(companyId: string, loginId: string, actorId: string, code: string) {
    const entry = getEntry(companyId, loginId);
    if (entry.status !== "waiting_for_code" || !entry.handle) {
      throw conflict("This AGY sign-in is not waiting for an authorization code.");
    }
    entry.handle.submitCode(code);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId,
      action: "agy_account.login_code_submitted",
      entityType: "agy_account",
      entityId: entry.accountId,
    });
    return toPublicLogin(entry);
  }

  async function cancelLogin(companyId: string, loginId: string, actorId: string) {
    const entry = getEntry(companyId, loginId);
    if (isActive(entry)) {
      entry.handle?.cancel();
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId,
        action: "agy_account.login_cancelled",
        entityType: "agy_account",
        entityId: entry.accountId,
      });
    }
    return toPublicLogin(entry);
  }

  async function remove(companyId: string, accountId: string, actorId: string) {
    if (accountId === AGY_DEFAULT_ACCOUNT_ID) {
      throw conflict("The host sign-in is managed on the Paperclip host and cannot be removed here.");
    }
    if ([...logins.values()].some((entry) => entry.companyId === companyId && entry.accountId === accountId && isActive(entry))) {
      throw conflict("Cancel the sign-in for this account before you remove it.");
    }
    const removed = await removeAgyCompanyAccount(accountsDir(companyId), accountId);
    if (!removed) throw notFound("AGY account not found");
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId,
      action: "agy_account.removed",
      entityType: "agy_account",
      entityId: accountId,
    });
  }

  return { availability, list, activeLogin, beginLogin, getLogin, submitCode, cancelLogin, remove };
}

/** Test helper: forgets every in-memory sign-in. */
export function resetAgyAccountLoginsForTests() {
  for (const entry of logins.values()) entry.handle?.cancel();
  logins.clear();
}
