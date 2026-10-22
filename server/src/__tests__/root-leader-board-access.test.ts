import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertBoard, assertBoardOrgAccess, assertCompanyAccess, assertInstanceAdmin, hasBoardOrgAccess } from "../routes/authz.js";
import { isRootLeaderAgent, leaderUserIdForCompany } from "../lib/root-leader-agent.js";
import { accessService } from "../services/access.js";
import { authorizationService } from "../services/authorization.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { HttpError } from "../errors.js";

function requestWithActor(actor: Request["actor"], method = "POST"): Request {
  return { actor, method } as unknown as Request;
}

function expectForbidden(fn: () => void) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
    return;
  }
  throw new Error("expected a 403");
}

describe("leader agent board authority (request guards)", () => {
  const companyId = randomUUID();
  const leader = requestWithActor({
    type: "agent", agentId: randomUUID(), companyId, source: "agent_key",
    isLeaderAgent: true, companyIds: [companyId],
  });

  it("passes board-only and instance-admin guards", () => {
    expect(() => assertBoard(leader)).not.toThrow();
    expect(() => assertBoardOrgAccess(leader)).not.toThrow();
    expect(() => assertInstanceAdmin(leader)).not.toThrow();
    expect(hasBoardOrgAccess(leader)).toBe(true);
  });

  it("stays inside its own company", () => {
    expect(() => assertCompanyAccess(leader, companyId)).not.toThrow();
    expectForbidden(() => assertCompanyAccess(leader, randomUUID()));
  });

  it("does not extend board authority to ordinary agents", () => {
    const engineer = requestWithActor({
      type: "agent", agentId: randomUUID(), companyId, source: "agent_key", companyIds: [companyId],
    });
    expectForbidden(() => assertBoard(engineer));
    expectForbidden(() => assertBoardOrgAccess(engineer));
    expectForbidden(() => assertInstanceAdmin(engineer));
    expect(hasBoardOrgAccess(engineer)).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("isRootLeaderAgent", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("root-leader-agent");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
  }, 20_000);

  afterAll(async () => {
    await cleanup?.();
  });

  const insertAgent = async (companyId: string, values: Partial<typeof agents.$inferInsert>) => {
    const [row] = await db.insert(agents).values({
      companyId,
      name: "Agent",
      role: "engineer",
      permissions: {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      ...values,
    }).returning();
    return row!;
  };

  it("is true only for the single root CEO of a company", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Leader detection",
      issuePrefix: `LD${companyId.slice(0, 6).toUpperCase()}`,
    });
    const ceo = await insertAgent(companyId, { name: "CEO", role: "ceo" });
    const cto = await insertAgent(companyId, { name: "CTO", role: "cto", reportsTo: ceo.id });
    expect(await isRootLeaderAgent(db, ceo)).toBe(true);
    expect(await isRootLeaderAgent(db, cto)).toBe(false);

    const secondRoot = await insertAgent(companyId, { name: "Second root", role: "ceo" });
    expect(await isRootLeaderAgent(db, ceo)).toBe(false);
    expect(await isRootLeaderAgent(db, secondRoot)).toBe(false);

    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  it("decides as board-equivalent even when low-trust and a missing responsible user would restrict an agent", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Leader authorization",
      issuePrefix: `LA${companyId.slice(0, 6).toUpperCase()}`,
    });
    const ceo = await insertAgent(companyId, { name: "CEO", role: "ceo", permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET } });
    const peer = await insertAgent(companyId, { name: "Peer", role: "engineer", reportsTo: ceo.id });
    await builtInAgentService(db).ensureCompanyDefaultAgentGrants(companyId);

    const decision = await authorizationService(db).decide({
      actor: {
        type: "agent", agentId: ceo.id, companyId, source: "agent_key", isLeaderAgent: true,
        onBehalfOfUserId: randomUUID(),
      },
      action: "agent_config:update",
      resource: { type: "agent", agentId: peer.id, companyId },
      scope: { requiresChangeGrant: true },
    });
    expect(decision).toMatchObject({ allowed: true });

    // The synthetic leader user carries the same grants and an owner membership.
    const leaderUserId = leaderUserIdForCompany(companyId);
    expect(await accessService(db).hasPermission(companyId, "user", leaderUserId, "users:invite")).toBe(true);
    expect(await accessService(db).hasPermission(companyId, "user", leaderUserId, "tools:admin")).toBe(true);

    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });
});
