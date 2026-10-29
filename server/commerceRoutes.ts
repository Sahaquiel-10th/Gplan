import express from "express";
import fs from "node:fs/promises";
import JSZip from "jszip";
import type { Store } from "./db.js";
import { asyncRoute, auth } from "./middleware.js";
import { canUseAgent } from "./operationsPolicy.js";
import { CommerceService, commerceAttachments, commerceJobAccess, commerceModels, imageEditModel, ensureCommerceAgent, publicCommerceJob } from "./commerce.js";
import { compositionAssetIds } from "./commerceComposition.js";
import { readCommerceImages, saveCommerceImage } from "./commerceStorage.js";
import { createCommerceMaterialsRouter } from "./commerceMaterials.js";

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

  router.get("/commerce/edit-config", asyncRoute(async (req, res) => {
    const agent = await store.mutate(db => ensureCommerceAgent(db, req.user!.companyId, "image_edit"));
    const db = await store.read();
    if (!agent || !canUseAgent(agent, req.user!, db.users)) return res.status(404).json({ error: "小修小改暂不可用" });
    let ready = true, message = "";
    try { imageEditModel(db); } catch (e) { ready = false; message = e instanceof Error ? e.message : "图片编辑模型暂不可用"; }
    res.json({ agentId: agent.id, ready, message });
  }));
  router.post("/commerce/edits", asyncRoute(async (req, res) => {
    const job = await service.createEdit(req.user!, String(req.body.agentId || ""), req.body, String(req.body.requestKey || ""));
    res.status(202).json({ job: publicCommerceJob(job) });
  }));

  const recognitionActive = new Set<string>();
  router.use("/commerce", createCommerceMaterialsRouter(store, service, recognitionActive));
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
    const kind = req.query.kind === "image_edit" ? "image_edit" : "product_creative";
    const jobs = (db.commerceJobs || []).filter(j => (j.kind || "product_creative") === kind && j.userId === req.user!.id && j.companyId === req.user!.companyId && db.agents.some(a => a.id === j.agentId && canUseAgent(a, req.user!, db.users)))
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
    await service.generate(req.user!, String(req.params.id), typeof req.body.variantId === "string" ? req.body.variantId : undefined, typeof req.body.referenceImageId === "string" ? req.body.referenceImageId : undefined);
    res.status(202).json({ ok: true });
  }));
  router.post("/commerce/jobs/:id/retry", asyncRoute(async (req, res) => {
    await service.retry(req.user!, String(req.params.id), typeof req.body.variantId === "string" ? req.body.variantId : undefined, typeof req.body.referenceImageId === "string" ? req.body.referenceImageId : undefined);
    res.status(202).json({ ok: true });
  }));
  router.post("/commerce/jobs/:id/derive", asyncRoute(async (req, res) => {
    const job = await service.derive(req.user!, String(req.params.id), req.body);
    res.status(202).json({ job: publicCommerceJob(job) });
  }));
  router.get("/commerce/jobs/:id/download", asyncRoute(async (req, res) => {
    const db = await store.read();
    const job = commerceJobAccess(db, req.user!, String(req.params.id));
    const zip = new JSZip();
    let count = 0;
    const titleLines = [`${job.brief.productName} · ${job.brief.platform}`, job.summary, `规格：${job.brief.specification}`, `确认卖点：${job.brief.facts.join("、")}`, `标题关键词：${job.brief.keywords.join("、")}`, `其他要求：${job.brief.notes}`, ""];
    for (const module of job.brief.composition?.modules.filter(m => m.enabled) || []) titleLines.push(`模块「${module.name}」：${module.content}；位置：${module.location || "自动安排"}；样式：${module.appearance || "自动安排"}`);
    for (const [index, variant] of job.variants.entries()) {
      titleLines.push(`${index + 1}. ${variant.name}`, variant.title, `标题说明：${variant.titleReason}`, `方案说明：${variant.reason}`, `本张参考：${variant.referenceImageId ? `参考图${job.brief.referenceImageIds.indexOf(variant.referenceImageId) + 1}` : "无参考或沿用底图"}`, `导出尺寸：${variant.outputWidth || "待确认"}×${variant.outputHeight || "待确认"}`, `图片检查：${variant.qualityNote || "待检查"}`, "");
      const a = db.attachments.find(a => a.id === variant.imageAttachmentId && a.userId === req.user!.id && a.companyId === req.user!.companyId);
      if (!a) continue;
      const ext = a.mimeType === "image/jpeg" ? "jpg" : a.mimeType === "image/webp" ? "webp" : "png";
      zip.file(`${index + 1}-${variant.name.replace(/[^\p{L}\p{N}_-]/gu, "_")}.${ext}`, await fs.readFile(a.storagePath)); count++;
    }
    if (!count) throw new Error("还没有可下载的主图");
    if (req.query.handoff === "1") {
      const ids = [...new Set([...job.brief.productImageIds, ...job.brief.referenceImageIds, ...compositionAssetIds(job.brief, true), ...job.variants.flatMap(v => [...(v.productImageIds || []), ...(v.sourceImageId ? [v.sourceImageId] : [])])])];
      for (const [index, asset] of commerceAttachments(db, req.user!, ids).entries()) zip.file(`原始素材/${index + 1}-${asset.originalName.replace(/[^\p{L}\p{N}_.-]/gu, "_")}`, await fs.readFile(asset.storagePath));
      titleLines.push("交付说明：包含选定效果图、确认文案和原始素材。请对照图片检查商品包装、文字、规格与赠品；需要完善的位置可在方案说明后补充。");
    }
    zip.file("标题与方案说明.txt", titleLines.join("\n"));
    // Recheck immediately before serving saved company assets.
    commerceJobAccess(await store.read(), req.user!, job.id);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(job.brief.productName.slice(0, 40) + "-主图与标题.zip")}`);
    res.send(await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }));
  }));
  return router;
}
