import { Router, type Request, type Response } from "express";
import { AlipayAccountService, FinanceError, type AccountStore, type AlipayAccount, type AlipayCredentials } from "./alipayAccounts.js";
import { probeAlipayAccount } from "./alipayReadClient.js";

export function createAlipayAccountRouter(store: AccountStore, env = process.env, probe: (appId: string, credentials: AlipayCredentials) => Promise<AlipayAccount["capabilities"]> = probeAlipayAccount) {
  const router = Router();
  const service = new AlipayAccountService(store, env);
  const running = new Set<string>();
  const recentChecks = new Map<string, number>();
  router.use((req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      const origin = req.get("origin");
      const expected = env.APP_ORIGIN?.trim() || `${req.protocol}://${req.get("host")}`;
      if ((origin && origin !== expected) || req.get("sec-fetch-site") === "cross-site") return res.status(403).json({ error: "请求来源无效" });
    }
    next();
  });
  const route = (action: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!req.user) return res.status(401).json({ error: "未登录" });
      await action(req, res);
    } catch (error) {
      // Never log SDK errors, request bodies or credential objects: SDK diagnostics may contain signatures/data.
      if (error instanceof FinanceError) res.status(error.status).json({ error: error.message });
      else res.status(503).json({ error: "资金账户操作失败，请检查加密主密钥或联系维护人员" });
    }
  };
  router.get("/", route(async (req, res) => { res.json(await service.state(req.user!)); }));
  router.post("/accounts", route(async (req, res) => { res.status(201).json({ account: await service.save(req.user!, req.body) }); }));
  router.post("/accounts/generate-key", route(async (req, res) => { res.status(201).json({ account: await service.save(req.user!, req.body, undefined, true) }); }));
  router.put("/accounts/:id", route(async (req, res) => { res.json({ account: await service.save(req.user!, req.body, String(req.params.id)) }); }));
  router.post("/accounts/:id/check", route(async (req, res) => {
    const id = String(req.params.id), key = `${req.user!.companyId}:${id}`;
    // Check authorization before consuming cooldown or initiating upstream calls.
    const state = await service.state(req.user!);
    if (!state.configurationOpen) throw new FinanceError("资金账户配置已锁定或未开放", 403);
    if (!state.accounts.some(a => a.id === id)) throw new FinanceError("账户不存在", 404);
    if (running.has(key) || Date.now() - (recentChecks.get(key) || 0) < 30000) throw new FinanceError("该账户正在检测或刚检测过，请30秒后重试", 429);
    running.add(key);
    recentChecks.set(key, Date.now());
    // Bounded per-process cooldown state, independent of account data.
    for (const [k, at] of recentChecks) if (at < Date.now() - 60000) recentChecks.delete(k);
    try { res.json({ account: await service.check(req.user!, id, probe) }); }
    finally { running.delete(key); }
  }));
  router.post("/lock", route(async (req, res) => { res.json(await service.lock(req.user!)); }));
  router.use((_req, res) => { res.status(404).json({ error: "资金账户接口不存在" }); });
  return router;
}
