import { createHash } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";

type LeaderCandidate = {
  id: string;
  companyId: string;
  role: string;
  reportsTo: string | null;
  status: string;
  metadata: unknown;
};

/**
 * True when the agent is the company's leader: the single non-built-in root CEO.
 * Mirrors the selection in builtInAgentService.ensureRootAgentDefaultChangeGrants,
 * so the leader that receives the default grants is the one that gets board access.
 */
export async function isRootLeaderAgent(db: Db, agent: LeaderCandidate): Promise<boolean> {
  if (agent.role.trim().toLowerCase() !== "ceo") return false;
  if (agent.reportsTo || agent.status === "terminated" || agent.status === "pending_approval") return false;
  if (readBuiltInAgentMarker(agent.metadata)) return false;

  const roots = await db
    .select({ id: agents.id, role: agents.role, status: agents.status, metadata: agents.metadata })
    .from(agents)
    .where(and(
      eq(agents.companyId, agent.companyId),
      isNull(agents.reportsTo),
      ne(agents.status, "terminated"),
      ne(agents.status, "pending_approval"),
    ));
  const rootCeos = roots.filter((root) =>
    root.role.trim().toLowerCase() === "ceo" && !readBuiltInAgentMarker(root.metadata));
  return rootCeos.length === 1 && rootCeos[0]!.id === agent.id;
}

/**
 * Stable synthetic user id for a company's leader. Board-only routes that need a
 * human user identity resolve the leader to this user, which holds the leader's
 * full grant set through its own membership and permission rows.
 */
export function leaderUserIdForCompany(companyId: string): string {
  return `leader-${createHash("sha256").update(`paperclip-root-leader:${companyId}`).digest("hex").slice(0, 32)}`;
}
