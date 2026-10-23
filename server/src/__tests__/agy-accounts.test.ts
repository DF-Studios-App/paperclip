import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agyUsageExhaustedUntil,
  createAgyCompanyAccount,
  isAgyAccountAvailable,
  markAgyAccountExhausted,
  parseAgyUsageOutput,
  readAgyAccountState,
  resolveAgyCompanyAccountsDir,
  startAgyLogin,
  syncAgyAccountQuotaFromUsage,
  type AgyLoginOutcome,
  type AgyLoginProcess,
  type AgyUsageResult,
  type StartAgyLoginOptions,
} from "@paperclipai/adapter-agy-local/server";

const activity = vi.hoisted(() => ({ logActivity: vi.fn(async () => ({})) }));
vi.mock("../services/activity-log.js", () => activity);

import { agyAccountService, resetAgyAccountLoginsForTests } from "../services/agy-accounts.js";
import { agyAccountRoutes } from "../routes/agy-accounts.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SIGN_IN_PATH = [".gemini", "antigravity-cli", "antigravity-oauth-token"];
const GOOGLE_URL = "https://accounts.google.com/o/oauth2/auth?client_id=x&state=y";

async function writeSignIn(home: string) {
  await fs.mkdir(path.join(home, ...SIGN_IN_PATH.slice(0, -1)), { recursive: true });
  await fs.writeFile(path.join(home, ...SIGN_IN_PATH), "token");
}

function fakeLoginFactory() {
  const calls: Array<{
    options: StartAgyLoginOptions;
    submitted: string[];
    cancelled: boolean;
    finish: (outcome: AgyLoginOutcome) => void;
  }> = [];
  const startLogin = ((options: StartAgyLoginOptions) => {
    let finish: (outcome: AgyLoginOutcome) => void = () => {};
    const done = new Promise<AgyLoginOutcome>((resolve) => {
      finish = resolve;
    });
    const call = { options, submitted: [] as string[], cancelled: false, finish };
    calls.push(call);
    return {
      submitCode(code: string) {
        call.submitted.push(code);
        options.onCodeSubmitted?.();
      },
      cancel() {
        call.cancelled = true;
        finish({ outcome: "cancelled" });
      },
      done,
    };
  }) as typeof startAgyLogin;
  return { calls, startLogin };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("agy account service", () => {
  let root: string;
  let defaultHome: string;
  let accountsDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-accounts-service-"));
    defaultHome = path.join(root, "host-home");
    accountsDir = path.join(root, "instance", "companies", COMPANY_ID, "agy-accounts");
    activity.logActivity.mockClear();
  });

  afterEach(async () => {
    resetAgyAccountLoginsForTests();
    await fs.rm(root, { recursive: true, force: true });
  });

  const makeService = (startLogin: typeof startAgyLogin, platform: NodeJS.Platform = "linux") =>
    agyAccountService({} as Db, {
      instanceRoot: path.join(root, "instance"),
      defaultHome,
      platform,
      startLogin,
    });

  it("signs in a new company account through the code step", async () => {
    const fake = fakeLoginFactory();
    const service = makeService(fake.startLogin);

    const started = await service.beginLogin(COMPANY_ID, "alice", { label: "Conta 2" });
    expect(started.status).toBe("starting");
    expect(fake.calls[0].options.home).toBe(path.join(accountsDir, "account-1"));

    fake.calls[0].options.onAuthorizationUrl(GOOGLE_URL);
    expect(service.getLogin(COMPANY_ID, started.id)).toMatchObject({
      status: "waiting_for_code",
      authorizationUrl: GOOGLE_URL,
    });

    await service.submitCode(COMPANY_ID, started.id, "alice", "4/abc");
    expect(fake.calls[0].submitted).toEqual(["4/abc"]);
    expect(service.getLogin(COMPANY_ID, started.id)).toMatchObject({ status: "verifying", authorizationUrl: null });

    await writeSignIn(fake.calls[0].options.home);
    fake.calls[0].finish({ outcome: "signed_in" });
    await flush();

    expect(service.getLogin(COMPANY_ID, started.id).status).toBe("signed_in");
    expect(await service.list(COMPANY_ID)).toEqual([
      expect.objectContaining({ id: "account-1", label: "Conta 2", isDefault: false, signedIn: true }),
    ]);
    const actions = activity.logActivity.mock.calls.map((call) => (call as unknown as [unknown, { action: string; details?: unknown }])[1]);
    expect(actions.map((entry) => entry.action)).toEqual([
      "agy_account.login_started",
      "agy_account.login_code_submitted",
      "agy_account.signed_in",
    ]);
    expect(JSON.stringify(actions)).not.toContain("4/abc");
    expect(JSON.stringify(actions)).not.toContain(GOOGLE_URL);
  });

  it("lists the host sign-in first with its quota state", async () => {
    await writeSignIn(defaultHome);
    await fs.writeFile(
      path.join(defaultHome, ".gemini", ".paperclip-agy-quota.json"),
      JSON.stringify({ exhaustedUntil: "2099-01-01T00:00:00.000Z", resetHint: "Resets in 1h", updatedAt: "" }),
    );
    const service = makeService(fakeLoginFactory().startLogin);

    expect(await service.list(COMPANY_ID)).toEqual([
      expect.objectContaining({ id: "default", isDefault: true, exhaustedUntil: "2099-01-01T00:00:00.000Z" }),
    ]);
  });

  it("allows one active sign-in per company", async () => {
    const service = makeService(fakeLoginFactory().startLogin);
    await service.beginLogin(COMPANY_ID, "alice", {});
    await expect(service.beginLogin(COMPANY_ID, "alice", {})).rejects.toMatchObject({ status: 409 });
  });

  it("removes the directory of an account that never signed in", async () => {
    const fake = fakeLoginFactory();
    const service = makeService(fake.startLogin);
    const started = await service.beginLogin(COMPANY_ID, "alice", {});
    const home = fake.calls[0].options.home;

    await service.cancelLogin(COMPANY_ID, started.id, "alice");
    await flush();

    expect(service.getLogin(COMPANY_ID, started.id).status).toBe("cancelled");
    await expect(fs.access(home)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await service.list(COMPANY_ID)).toEqual([]);
  });

  it("removes a signed-in account but not the host sign-in", async () => {
    const fake = fakeLoginFactory();
    const service = makeService(fake.startLogin);
    await service.beginLogin(COMPANY_ID, "alice", {});
    await writeSignIn(fake.calls[0].options.home);
    fake.calls[0].finish({ outcome: "signed_in" });
    await flush();

    await expect(service.remove(COMPANY_ID, "default", "alice")).rejects.toMatchObject({ status: 409 });
    await service.remove(COMPANY_ID, "account-1", "alice");
    expect(await service.list(COMPANY_ID)).toEqual([]);
    await expect(service.remove(COMPANY_ID, "account-1", "alice")).rejects.toMatchObject({ status: 404 });
    await expect(service.remove(COMPANY_ID, "../escape", "alice")).rejects.toMatchObject({ status: 404 });
  });

  it("is unavailable off Linux", async () => {
    const service = makeService(fakeLoginFactory().startLogin, "win32");
    expect(service.availability().available).toBe(false);
    await expect(service.beginLogin(COMPANY_ID, "alice", {})).rejects.toMatchObject({ status: 409 });
  });

  it("hides a sign-in from another company", async () => {
    const service = makeService(fakeLoginFactory().startLogin);
    const started = await service.beginLogin(COMPANY_ID, "alice", {});
    expect(() => service.getLogin("22222222-2222-4222-8222-222222222222", started.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe("agy account routes", () => {
  const owner = {
    type: "board",
    userId: "alice",
    source: "session",
    companyIds: [COMPANY_ID],
    memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "owner" }],
  };
  const viewer = { ...owner, userId: "bob", memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "viewer" }] };
  const agent = { type: "agent", agentId: "agent-1", companyId: COMPANY_ID, source: "agent_key" };

  function makeApp(actor: unknown) {
    const service = {
      availability: vi.fn(() => ({ available: true, reason: null })),
      list: vi.fn(async () => []),
      activeLogin: vi.fn(() => null),
      beginLogin: vi.fn(async () => ({ id: "login-1", accountId: "account-1", status: "starting", authorizationUrl: null, error: null, expiresAt: "" })),
      getLogin: vi.fn(),
      submitCode: vi.fn(),
      cancelLogin: vi.fn(),
      remove: vi.fn(async () => undefined),
      quota: vi.fn(async () => []),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as typeof req.actor;
      next();
    });
    app.use("/api", agyAccountRoutes({} as Db, { service: service as unknown as ReturnType<typeof agyAccountService> }));
    app.use(errorHandler);
    return { app, service };
  }

  it("lets an owner add an account", async () => {
    const { app, service } = makeApp(owner);
    const res = await request(app).post(`/api/companies/${COMPANY_ID}/agy-accounts/logins`).send({ label: "Conta 2" });
    expect(res.status).toBe(201);
    expect(service.beginLogin).toHaveBeenCalledWith(COMPANY_ID, "alice", { label: "Conta 2" });
  });

  it("returns the remaining limits of each account to a board member", async () => {
    const { app, service } = makeApp(viewer);
    const quota = [{ accountId: "default", status: "ok", checkedAt: "", groups: [], error: null }];
    service.quota.mockResolvedValueOnce(quota as never);
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/agy-accounts/quota`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accounts: quota });
    expect(service.quota).toHaveBeenCalledWith(COMPANY_ID);
  });

  it("shows a viewer the accounts without the sign-in and blocks changes", async () => {
    const { app, service } = makeApp(viewer);
    const list = await request(app).get(`/api/companies/${COMPANY_ID}/agy-accounts`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ canManage: false, login: null });
    expect(service.activeLogin).not.toHaveBeenCalled();

    const add = await request(app).post(`/api/companies/${COMPANY_ID}/agy-accounts/logins`).send({});
    expect(add.status).toBe(403);
    const remove = await request(app).delete(`/api/companies/${COMPANY_ID}/agy-accounts/account-1`);
    expect(remove.status).toBe(403);
    expect(service.remove).not.toHaveBeenCalled();
  });

  it("rejects agent keys", async () => {
    const { app } = makeApp(agent);
    const res = await request(app).get(`/api/companies/${COMPANY_ID}/agy-accounts`);
    expect(res.status).toBe(403);
  });

  it("validates the authorization code body", async () => {
    const { app, service } = makeApp(owner);
    const res = await request(app).post(`/api/companies/${COMPANY_ID}/agy-accounts/logins/login-1/code`).send({ code: "" });
    expect(res.status).toBe(400);
    expect(service.submitCode).not.toHaveBeenCalled();
  });
});

describe("agy account quota", () => {
  const usageGroups = [
    {
      name: "Gemini Models",
      buckets: [
        { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0, resetAt: "2026-10-26T13:03:19Z", disabled: false },
      ],
    },
  ];

  it("reads the limits of each signed-in account and does not ask an account without a sign-in", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-accounts-quota-"));
    try {
      const defaultHome = path.join(root, "host-home");
      const instanceRoot = path.join(root, "instance");
      await writeSignIn(defaultHome);
      const accountsDir = resolveAgyCompanyAccountsDir(instanceRoot, COMPANY_ID);
      const signedIn = await createAgyCompanyAccount(accountsDir, { label: "Conta 2" });
      await writeSignIn(signedIn.home);
      await createAgyCompanyAccount(accountsDir, { label: "Conta 3" });

      const readUsage = vi.fn(async (_options: { home: string }): Promise<AgyUsageResult> => ({ ok: true, groups: usageGroups }));
      const service = agyAccountService({} as Db, {
        instanceRoot,
        defaultHome,
        platform: "linux",
        startLogin: fakeLoginFactory().startLogin,
        readUsage,
      });

      const quota = await service.quota(COMPANY_ID);
      expect(readUsage.mock.calls.map(([options]) => options.home)).toEqual([defaultHome, signedIn.home]);
      expect(quota).toEqual([
        { accountId: "default", status: "ok", checkedAt: expect.any(String), groups: usageGroups, error: null },
        { accountId: signedIn.id, status: "ok", checkedAt: expect.any(String), groups: usageGroups, error: null },
        { accountId: "account-2", status: "not_signed_in", checkedAt: expect.any(String), groups: [], error: null },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports an account whose usage read fails, without the other accounts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-accounts-quota-error-"));
    try {
      const defaultHome = path.join(root, "host-home");
      await writeSignIn(defaultHome);
      const readUsage = vi.fn(async (_options: { home: string }): Promise<AgyUsageResult> => ({ ok: false, error: "AGY did not answer in time." }));
      const service = agyAccountService({} as Db, {
        instanceRoot: path.join(root, "instance"),
        defaultHome,
        platform: "linux",
        startLogin: fakeLoginFactory().startLogin,
        readUsage,
      });

      expect(await service.quota(COMPANY_ID)).toEqual([
        { accountId: "default", status: "error", checkedAt: expect.any(String), groups: [], error: "AGY did not answer in time." },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("waits for the earliest reset of the limits at zero, and ignores disabled limits", () => {
    const now = Date.parse("2026-10-22T20:00:00.000Z");
    const groups = [
      {
        name: "Gemini Models",
        buckets: [
          { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remainingFraction: 0, resetAt: "2026-10-22T21:00:00.000Z", disabled: false },
          { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0, resetAt: "2026-10-26T13:03:19.000Z", disabled: false },
          { id: "gemini-off", name: "Off", window: "5h", remainingFraction: 0, resetAt: "2026-10-22T20:30:00.000Z", disabled: true },
        ],
      },
      { name: "Claude", buckets: [{ id: "3p-weekly", name: "Weekly", window: "weekly", remainingFraction: 1, resetAt: null, disabled: false }] },
    ];
    expect(agyUsageExhaustedUntil(groups, now)).toBe("2026-10-22T21:00:00.000Z");
    expect(agyUsageExhaustedUntil(usageGroups, now)).toBe("2026-10-26T13:03:19.000Z");
    expect(agyUsageExhaustedUntil([{ name: "Claude", buckets: [{ id: "x", name: "x", window: "5h", remainingFraction: 0.5, resetAt: null, disabled: false }] }], now)).toBeNull();
  });

  it("clears the quota state of an account that has quota again", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-accounts-sync-"));
    try {
      const home = path.join(root, "account-1");
      await markAgyAccountExhausted(home, { retryNotBefore: "2099-01-01T00:00:00.000Z", resetHint: "Resets in 1h" });
      const stillOut = [{ name: "Gemini Models", buckets: [{ id: "g", name: "Weekly", window: "weekly", remainingFraction: 0, resetAt: "2099-02-01T00:00:00.000Z", disabled: false }] }];
      expect(await syncAgyAccountQuotaFromUsage(home, stillOut)).toMatchObject({ exhaustedUntil: "2099-02-01T00:00:00.000Z", resetHint: "Resets in 1h" });

      const withQuota = [{ name: "Gemini Models", buckets: [{ id: "g", name: "Weekly", window: "weekly", remainingFraction: 0.9, resetAt: "2099-02-01T00:00:00.000Z", disabled: false }] }];
      await syncAgyAccountQuotaFromUsage(home, withQuota);
      expect(await readAgyAccountState(home)).toMatchObject({ exhaustedUntil: null, resetHint: null });
      expect(isAgyAccountAvailable(await readAgyAccountState(home))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reads the groups and buckets from the /usage JSON", () => {
    const stdout = JSON.stringify({
      conversation_id: "",
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", disabled: true, remaining_fraction: 0.9999 },
                { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0, reset_time: "2026-10-26T13:03:19Z" },
              ],
            },
          ],
        },
      },
    });

    expect(parseAgyUsageOutput(stdout)).toEqual([
      {
        name: "Gemini Models",
        buckets: [
          { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remainingFraction: 0.9999, resetAt: null, disabled: true },
          { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0, resetAt: "2026-10-26T13:03:19Z", disabled: false },
        ],
      },
    ]);
  });

  it("returns null when the output has no usage report", () => {
    expect(parseAgyUsageOutput("not json")).toBeNull();
    expect(parseAgyUsageOutput(JSON.stringify({ status: "SUCCESS", response: "hi" }))).toBeNull();
  });
});

describe("agy CLI sign-in driver", () => {
  class FakeProcess extends EventEmitter implements AgyLoginProcess {
    stdout = new PassThrough();
    stderr = new PassThrough();
    written: string[] = [];
    killed = false;
    stdin = { write: (data: string) => this.written.push(data) };
    kill() {
      this.killed = true;
      return true;
    }
  }

  function start(signInExists: () => Promise<boolean> = async () => false) {
    const proc = new FakeProcess();
    const urls: string[] = [];
    const handle = startAgyLogin({
      home: "/tmp/account-1",
      onAuthorizationUrl: (url) => urls.push(url),
      spawnBridge: () => proc,
      signInExists,
      timeoutMs: 60_000,
    });
    return { proc, urls, handle };
  }

  const MENU = "\x1b[1mWelcome to the Antigravity CLI.\x1b[0m\r\nSelect login method:\r\n> 1. Google OAuth\r\n";
  const URL_SCREEN = `Your browser should open automatically. If not:\r\n\x1b[4m${GOOGLE_URL}\x1b[0m\r\n` +
    "If you aren't automatically redirected, paste the authorization code below:\r\n";

  it("selects Google OAuth, reports the URL, and finishes when the sign-in file appears", async () => {
    let signedIn = false;
    const { proc, urls, handle } = start(async () => signedIn);
    proc.stdout.write(MENU);
    await flush();
    expect(proc.written).toEqual(["\r"]);

    proc.stdout.write(URL_SCREEN);
    await flush();
    expect(urls).toEqual([GOOGLE_URL]);

    handle.submitCode(" 4/abc\n");
    expect(proc.written).toEqual(["\r", "4/abc", "\r"]);
    signedIn = true;
    await expect(handle.done).resolves.toEqual({ outcome: "signed_in" });
    expect(proc.killed).toBe(true);
  });

  it("fails when AGY rejects the code", async () => {
    const { proc, handle } = start();
    proc.stdout.write(MENU + URL_SCREEN);
    await flush();
    handle.submitCode("bad");
    proc.stdout.write("Error: invalid authorization code\r\n");
    await expect(handle.done).resolves.toMatchObject({ outcome: "failed" });
  });

  it("fails when AGY exits before the sign-in finishes", async () => {
    const { proc, handle } = start();
    proc.emit("close", 1);
    await expect(handle.done).resolves.toMatchObject({ outcome: "failed" });
  });

  it("ignores a code before the URL is shown", async () => {
    const { proc, handle } = start();
    handle.submitCode("early");
    expect(proc.written).toEqual([]);
    handle.cancel();
    await expect(handle.done).resolves.toEqual({ outcome: "cancelled" });
  });
});
