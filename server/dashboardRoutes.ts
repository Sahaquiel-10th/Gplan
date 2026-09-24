import { Router } from "express";
import { auth, requireRole, asyncRoute } from "./middleware.js";
import type { Store } from "./db.js";
import { uid } from "./security.js";
import {
  defaultDashboardView,
  normalizeDashboardView,
  dashboardWidgets,
  dashboardColumns,
} from "./dashboardPreferences.js";
import { operationsGrant, reportDate, scopeKey } from "./operationsPolicy.js";
import { operationsCatalog } from "./operationsData.js";
import { savedReport, assertCurrent } from "./operationsArchive.js";
import { dashboardTable } from "./dashboardData.js";
export function createDashboardRouter(store: Store, secret: string) {
  async function stillAdmin(id: string, companyId: string) {
    const db = await store.read();
    return db.users.some(
      (u) =>
        u.id === id &&
        u.companyId === companyId &&
        u.enabled &&
        u.role === "admin",
    );
  }
  const router = Router();
  router.use("/dashboard", auth(secret), (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get(
    "/dashboard/preferences",
    asyncRoute(async (req, res) => {
      const db = await store.read(),
        user = req.user!;
      const base =
        db.dashboardDefaults?.[user.companyId] || defaultDashboardView;
      // A company default describes layout only, never grants or confidential filter names.
      const defaults = { ...base, sourceAgentId: "", brand: "", search: "" };
      res.json({
        defaults,
        presets: (db.dashboardPresets || []).filter(
          (p) => p.userId === user.id && p.companyId === user.companyId,
        ),
        widgets: dashboardWidgets,
        columns: dashboardColumns,
        sources: db.agents
          .filter((a) => operationsGrant(a, user))
          .map((a) => ({ id: a.id, name: a.name, kind: a.operations!.kind })),
        admin: user.role === "admin",
      });
    }),
  );
  router.post(
    "/dashboard/presets",
    asyncRoute(async (req, res) => {
      const name =
        typeof req.body.name === "string" ? req.body.name.trim() : "";
      if (!name || name.length > 40) throw new Error("方案名称需为1到40字");
      const view = normalizeDashboardView(req.body.view);
      const preset = await store.mutate((db) => {
        db.dashboardPresets ??= [];
        let p = req.body.id
          ? db.dashboardPresets.find(
              (p) =>
                p.id === req.body.id &&
                p.userId === req.user!.id &&
                p.companyId === req.user!.companyId,
            )
          : undefined;
        if (req.body.id && !p) throw new Error("方案不存在或无权修改");
        if (
          !p &&
          db.dashboardPresets.filter(
            (p) =>
              p.userId === req.user!.id && p.companyId === req.user!.companyId,
          ).length >= 20
        )
          throw new Error("最多保存20套方案");
        if (p) {
          p.name = name;
          p.view = view;
          p.updatedAt = new Date().toISOString();
        } else {
          p = {
            id: uid("dash"),
            name,
            view,
            userId: req.user!.id,
            companyId: req.user!.companyId,
            updatedAt: new Date().toISOString(),
          };
          db.dashboardPresets.push(p);
        }
        return p;
      });
      res.json({ preset });
    }),
  );
  router.delete(
    "/dashboard/presets/:id",
    asyncRoute(async (req, res) => {
      await store.mutate((db) => {
        const p = db.dashboardPresets?.find(
          (p) =>
            p.id === req.params.id &&
            p.userId === req.user!.id &&
            p.companyId === req.user!.companyId,
        );
        if (!p) throw new Error("方案不存在或无权删除");
        db.dashboardPresets = db.dashboardPresets!.filter((x) => x !== p);
      });
      res.json({ ok: true });
    }),
  );
  router.put(
    "/dashboard/default",
    requireRole("admin"),
    asyncRoute(async (req, res) => {
      const view = normalizeDashboardView(req.body.view);
      await store.mutate((db) => {
        db.dashboardDefaults ??= {};
        db.dashboardDefaults[req.user!.companyId] = {
          ...view,
          sourceAgentId: "",
          brand: "",
          search: "",
        };
      });
      res.json({ ok: true });
    }),
  );
  router.get(
    "/dashboard/catalog",
    requireRole("admin"),
    asyncRoute(async (req, res) => {
      const catalog = await operationsCatalog(req.user!.companyId);
      if (!(await stillAdmin(req.user!.id, req.user!.companyId)))
        return void res.status(403).json({ error: "权限已变更" });
      res.json({ brands: [...new Set([...catalog.brands, "未标注品牌"])] });
    }),
  );
  router.post(
    "/dashboard/table",
    requireRole("admin"),
    asyncRoute(async (req, res) => {
      const view = normalizeDashboardView(req.body.view),
        page = Number(req.body.page || 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
        throw new Error("页码不合法");
      try {
        const result = await dashboardTable(
          req.user!.companyId,
          reportDate(req.body.date),
          view,
          page,
        );
        if (!(await stillAdmin(req.user!.id, req.user!.companyId)))
          return void res.status(403).json({ error: "权限已变更" });
        res.json(result);
      } catch {
        res
          .status(503)
          .json({ error: "原始表暂时无法读取，请缩小查询条件或稍后重试" });
      }
    }),
  );
  router.get(
    "/dashboard/scoped-report",
    asyncRoute(async (req, res) => {
      const db = await store.read(),
        user = req.user!,
        agent = db.agents.find(
          (a) => a.id === req.query.agentId && operationsGrant(a, user),
        );
      if (!agent)
        return void res
          .status(403)
          .json({ error: "尚未获得此经营助手的数据授权" });
      const key = scopeKey(agent, user),
        snapshot = await savedReport(
          store,
          agent,
          user,
          reportDate(req.query.date),
        );
      assertCurrent(await store.read(), agent.id, user.id, key);
      res.json({
        report: snapshot.report,
        accessVersion: key,
        agentName: agent.name,
      });
    }),
  );
  return router;
}
