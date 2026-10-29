import express from "express";
import type { Store } from "./db.js";
import { asyncRoute, auth } from "./middleware.js";
import { canUseAgent } from "./operationsPolicy.js";
import { ReviewReplyService, ensureReviewReplyAgent, reviewReplyModels } from "./reviewReplies.js";
import { reviewReplyTemplates } from "./reviewReplyTemplates.js";

export function createReviewReplyRouter(store: Store, secret: string) {
  const router = express.Router();
  const service = new ReviewReplyService(store);
  const ready = service.recover();
  void ready.catch(error => console.error("评价回复记录恢复失败", error));
  router.use("/review-replies", auth(secret), (_req, _res, next) => { void ready.then(() => next(), next); });

  router.get("/review-replies/config", asyncRoute(async (req, res) => {
    const agent = await store.mutate(db => ensureReviewReplyAgent(db, req.user!.companyId));
    const db = await store.read();
    if (!agent || !canUseAgent(agent, req.user!, db.users)) return res.status(404).json({ error: "评价回复助手暂不可用" });
    let ready = true, visionReady = true, message = "";
    try { reviewReplyModels(db); } catch { ready = false; message = "请管理员配置可用的文字模型"; }
    try { reviewReplyModels(db, true); } catch { visionReady = false; if (ready) message = "文字回复可用；截图识别需要配置支持图片理解的模型"; }
    res.json({ agentId: agent.id, ready, visionReady, message, templates: reviewReplyTemplates(req.user!) });
  }));
  router.get("/review-replies/profiles", asyncRoute(async (req, res) => { res.json({ profiles: await service.listProfiles(req.user!) }); }));
  router.post("/review-replies/profiles", asyncRoute(async (req, res) => { res.status(201).json({ profile: await service.saveProfile(req.user!, req.body.draft) }); }));
  router.get("/review-replies/profiles/:id", asyncRoute(async (req, res) => { res.json({ profile: await service.getProfile(req.user!, String(req.params.id)) }); }));
  router.put("/review-replies/profiles/:id", asyncRoute(async (req, res) => { res.json({ profile: await service.saveProfile(req.user!, req.body.draft, String(req.params.id), req.body.expectedRevision) }); }));
  router.delete("/review-replies/profiles/:id", asyncRoute(async (req, res) => { await service.deleteProfile(req.user!, String(req.params.id)); res.json({ ok: true }); }));
  router.post("/review-replies/profiles/:id/copy", asyncRoute(async (req, res) => { res.status(201).json({ profile: await service.copyProfile(req.user!, String(req.params.id)) }); }));
  router.post("/review-replies/profiles/:id/restore", asyncRoute(async (req, res) => { res.json({ profile: await service.restoreProfile(req.user!, String(req.params.id), req.body.revision, req.body.expectedRevision) }); }));
  router.get("/review-replies/profiles/:id/export", asyncRoute(async (req, res) => {
    const output = await service.exportSkill(req.user!, String(req.params.id));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(output.filename)}`);
    res.send(output.content);
  }));
  router.post("/review-replies/profiles/:id/rules", asyncRoute(async (req, res) => { res.json({ profile: await service.addRule(req.user!, String(req.params.id), req.body) }); }));
  router.post("/review-replies/analyze", asyncRoute(async (req, res) => { res.json(await service.analyze(req.user!, req.body)); }));
  router.post("/review-replies/recognize", asyncRoute(async (req, res) => { res.json(await service.recognize(req.user!, req.body)); }));
  router.get("/review-replies/runs", asyncRoute(async (req, res) => { res.json({ runs: await service.listRuns(req.user!) }); }));
  router.get("/review-replies/runs/:id", asyncRoute(async (req, res) => { res.json({ run: await service.getRun(req.user!, String(req.params.id)) }); }));
  router.post("/review-replies/runs", asyncRoute(async (req, res) => {
    const run = await service.createRun(req.user!, req.body);
    res.status(run.status === "generating" ? 202 : 201).json({ run });
  }));
  router.post("/review-replies/runs/:id/refine", asyncRoute(async (req, res) => { res.json({ run: await service.refine(req.user!, String(req.params.id), req.body) }); }));
  router.post("/review-replies/runs/:id/edit", asyncRoute(async (req, res) => { res.json({ run: await service.edit(req.user!, String(req.params.id), req.body) }); }));
  router.post("/review-replies/runs/:id/propose-rule", asyncRoute(async (req, res) => { res.json(await service.proposeRule(req.user!, String(req.params.id), req.body)); }));
  return router;
}
