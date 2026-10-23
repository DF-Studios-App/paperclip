import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  startAgyAccountLoginSchema,
  submitAgyAccountLoginCodeSchema,
  type AgyAccountsQuotaResponse,
  type AgyAccountsResponse,
  type DeploymentExposure,
  type DeploymentMode,
} from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { canManageAiConnections } from "./ai-connections.js";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { agyAccountService, type AgyAccountServiceOptions } from "../services/agy-accounts.js";

export function agyAccountRoutes(
  db: Db,
  options: {
    deploymentMode?: DeploymentMode;
    deploymentExposure?: DeploymentExposure;
    trustedLocalStdioRuntimeHost?: string | null;
    service?: ReturnType<typeof agyAccountService>;
    serviceOptions?: AgyAccountServiceOptions;
  } = {},
) {
  const router = Router();
  const service = options.service ?? agyAccountService(db, { ...options, ...options.serviceOptions });

  async function assertCanManage(req: Request, companyId: string): Promise<string> {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!(await canManageAiConnections(db, req, companyId))) {
      throw forbidden("Manage connections permission is required");
    }
    return getActorInfo(req).actorId;
  }

  router.get("/companies/:companyId/agy-accounts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const canManage = await canManageAiConnections(db, req, companyId);
    const { available, reason } = service.availability();
    const body: AgyAccountsResponse = {
      available,
      unavailableReason: reason,
      canManage,
      accounts: await service.list(companyId),
      login: canManage ? service.activeLogin(companyId) : null,
    };
    res.json(body);
  });

  router.get("/companies/:companyId/agy-accounts/quota", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body: AgyAccountsQuotaResponse = { accounts: await service.quota(companyId) };
    res.json(body);
  });

  router.post("/companies/:companyId/agy-accounts/logins", validate(startAgyAccountLoginSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const actorId = await assertCanManage(req, companyId);
    res.status(201).json(await service.beginLogin(companyId, actorId, req.body));
  });

  router.get("/companies/:companyId/agy-accounts/logins/:loginId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManage(req, companyId);
    res.json(service.getLogin(companyId, req.params.loginId as string));
  });

  router.post(
    "/companies/:companyId/agy-accounts/logins/:loginId/code",
    validate(submitAgyAccountLoginCodeSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actorId = await assertCanManage(req, companyId);
      res.json(await service.submitCode(companyId, req.params.loginId as string, actorId, req.body.code));
    },
  );

  router.delete("/companies/:companyId/agy-accounts/logins/:loginId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actorId = await assertCanManage(req, companyId);
    res.json(await service.cancelLogin(companyId, req.params.loginId as string, actorId));
  });

  router.delete("/companies/:companyId/agy-accounts/:accountId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actorId = await assertCanManage(req, companyId);
    await service.remove(companyId, req.params.accountId as string, actorId);
    res.status(204).end();
  });

  return router;
}
