import express from "express";
import fs from "node:fs/promises";
import JSZip from "jszip";
import type { Store } from "./db.js";
import { asyncRoute, auth } from "./middleware.js";
import { canUseAgent } from "./operationsPolicy.js";
import { CommerceService, commerceJobAccess, commerceModels, ensureCommerceAgent, publicCommerceJob } from "./commerce.js";
import { readCommerceImages, saveCommerceImage } from "./commerceStorage.js";

export function createCommerceRouter(store: Store, secret: string, uploadDir: string) {
  const router = express.Router();
  const service = new CommerceService(store, { readImages: readCommerceImages, saveImage: (url, job, variant) => saveCommerceImage(url, job, variant, uploadDir) });
  const ready = service.recover();
  void ready.then(() => service.tick()).catch(error => console.error("商品创作恢复失败", error));
  const timer = setInterval(() => { void service.tick().catch(error => console.error("商品创作任务调度失败", error)); }, 10000);
  timer.unref();
  router.use("/commerce", auth(secret), (_req, _res, next) => { void ready.then(() => next(), next); });

  router.get("/commerce/config", asyncRoute(async (req, res) => {
    const agent = await store.mutate(db => ensureCommerceAgent(db, req.user!.companyId));
    const db = await store.read();
    if (!agent || !canUseAgent(agent, req.user!, db.users)) return res.status(404).json({ error: "智能体暂不可用" });
    let ready = true, message = "";
    try { commerceModels(db); } catch (e) { ready = false; message = e instanceof Error ? e.message : "模型暂不可用"; }
    res.json({ agentId: agent.id, ready, message });
  }));

  const recognitionActive = new Set<string>();
  router.post("/commerce/recognize", asyncRoute(async (req, res) => {
    const db = await store.read();
    if (!db.agents.some(a => a.commerce && canUseAgent(a, req.user!, db.users))) return res.status(403).json({ error: "智能体暂不可用" });
    const ids: unknown = req.body.imageIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || ids.some(id => typeof id !== "string")) throw new Error("请上传1至3张商品图");
    if (recognitionActive.has(req.user!.id)) return res.status(429).json({ error: "正在识别商品，请稍等" });
    recognitionActive.add(req.user!.id);
    try { res.json({ recognition: await service.recognize(req.user!, ids) }); }
    finally { recognitionActive.delete(req.user!.id); }
  }));

  // Share the per-member guard across all auxiliary AI calls.
  router.post(["/commerce/reference/recognize", "/commerce/modules/suggest"], asyncRoute(async (req, res) => {
    if (recognitionActive.has(req.user!.id)) return res.status(429).json({ error: "正在识别或整理建议，请稍等" });
    recognitionActive.add(req.user!.id);
    try {
      if (req.path === "/commerce/reference/recognize") {
        if (typeof req.body.imageId !== "string") throw new Error("请选择主要参考图");
        res.json({ reference: await service.recognizeReference(req.user!, req.body.imageId) });
      } else res.json({ suggestions: await service.suggestModule(req.user!, req.body) });
    } finally { recognitionActive.delete(req.user!.id); }
  }));

  router.get("/commerce/jobs", asyncRoute(async (req, res) => {
    const db = await store.read();
    const jobs = (db.commerceJobs || []).filter(j => j.userId === req.user!.id && j.companyId === req.user!.companyId && db.agents.some(a => a.id === j.agentId && canUseAgent(a, req.user!, db.users)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40)
      .map(j => ({ id: j.id, productName: j.brief.productName, platform: j.brief.platform, status: j.status, phase: j.phase, createdAt: j.createdAt, completed: j.variants.filter(v => v.status === "completed").length, count: j.brief.count }));
    res.json({ jobs });
  }));
  router.post("/commerce/jobs", asyncRoute(async (req, res) => {
    const job = await service.create(req.user!, String(req.body.agentId || ""), req.body.brief, String(req.body.requestKey || ""));
    res.status(202).json({ job: publicCommerceJob(job) });
  }));
  router.get("/commerce/jobs/:id", asyncRoute(async (req, res) => {
    const db = await store.read();
    res.json({ job: publicCommerceJob(commerceJobAccess(db, req.user!, String(req.params.id))) });
  }));
  router.post("/commerce/jobs/:id/generate", asyncRoute(async (req, res) => {
    await service.generate(req.user!, String(req.params.id));
    res.status(202).json({ ok: true });
  }));
  router.post("/commerce/jobs/:id/retry", asyncRoute(async (req, res) => {
    await service.retry(req.user!, String(req.params.id), typeof req.body.variantId === "string" ? req.body.variantId : undefined);
    res.status(202).json({ ok: true });
  }));
  router.get("/commerce/jobs/:id/download", asyncRoute(async (req, res) => {
    const db = await store.read();
    const job = commerceJobAccess(db, req.user!, String(req.params.id));
    const zip = new JSZip();
    let count = 0;
    const titleLines = [`${job.brief.productName} · ${job.brief.platform}`, job.summary, ""];
    for (const [index, variant] of job.variants.entries()) {
      titleLines.push(`${index + 1}. ${variant.name}`, variant.title, `标题说明：${variant.titleReason}`, `方案说明：${variant.reason}`, `图片检查：${variant.qualityNote || "待检查"}`, "");
      const a = db.attachments.find(a => a.id === variant.imageAttachmentId && a.userId === req.user!.id && a.companyId === req.user!.companyId);
      if (!a) continue;
      const ext = a.mimeType === "image/jpeg" ? "jpg" : a.mimeType === "image/webp" ? "webp" : "png";
      zip.file(`${index + 1}-${variant.name.replace(/[^\p{L}\p{N}_-]/gu, "_")}.${ext}`, await fs.readFile(a.storagePath)); count++;
    }
    if (!count) throw new Error("还没有可下载的主图");
    zip.file("标题与方案说明.txt", titleLines.join("\n"));
    // Recheck immediately before serving saved company assets.
    commerceJobAccess(await store.read(), req.user!, job.id);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(job.brief.productName.slice(0, 40) + "-主图与标题.zip")}`);
    res.send(await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }));
  }));
  return router;
}
