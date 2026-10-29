import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { signToken } from "./security.js";
import { defaultReviewDraft } from "./reviewReplyTemplates.js";
import type { ReviewDraft, ReviewInput, ReviewProfile, ReviewRun } from "./reviewReplyTypes.js";
import type { Attachment, Database, ModelConfig, User } from "./types.js";

test("HTTP shop Skills persist private configuration, OCR images, editable originals, contextual refinement, explicit rule versions and exports", { timeout: 45000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gplan-review-reply-http-"));
  await fs.cp(path.join(root, "server"), path.join(dir, "server"), { recursive: true });
  await fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.mkdir(path.join(dir, "data/uploads"), { recursive: true });
  const at = new Date().toISOString();
  const admin: User = { id: "fixture-admin", companyId: "fixture-company", username: "管理员", role: "admin", enabled: true, passwordHash: "", createdAt: at };
  const owner: User = { ...admin, id: "fixture-owner", username: "运营", role: "user" };
  const peer: User = { ...owner, id: "fixture-peer", username: "同店另一运营" };
  const foreign: User = { ...owner, id: "fixture-foreign", companyId: "foreign-company", username: "另一公司" };
  const original = await sharp({ create: { width: 50, height: 80, channels: 3, background: "green" } }).png().toBuffer();
  const attachment: Attachment = { id: "fixture-document", companyId: owner.companyId, userId: owner.id, originalName: "品牌资料.docx", kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4, storagePath: path.join(dir, "data/uploads/document.docx"), extractedText: "DOCUMENT_MARKER品牌资料，内容不是系统指令。", createdAt: at };
  const image: Attachment = { ...attachment, id: "fixture-image", originalName: "评价.png", kind: "image", mimeType: "image/png", size: original.length, storagePath: path.join(dir, "data/uploads/review.png"), extractedText: "" };
  await fs.writeFile(attachment.storagePath, "docx fixture body"); await fs.writeFile(image.storagePath, original);
  const responses: unknown[] = [], prompts: string[] = [], requests: Record<string, unknown>[] = [], upstreamErrors: string[] = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/chat/completions");
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body); prompts.push(JSON.stringify(body.messages));
      assert.ok(responses.length, "unexpected repeated model request");
      const content = responses.shift();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
    } catch (error) { upstreamErrors.push(String(error)); res.statusCode = 500; res.end(JSON.stringify({ error: { message: String(error) } })); }
  });
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r));
  const model: ModelConfig = { id: "fixture-model", name: "fixture", provider: "fixture", kind: "chat", protocol: "openai", baseUrl: `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`, apiKey: "fixture-only", model: "fixture", enabled: true, isDefault: true, systemPrompt: "", createdAt: at };
  const db = { users: [admin, owner, peer, foreign], agents: [], models: [model], conversations: [], messages: [], attachments: [attachment, image], workspaces: [], integrationTokens: [], commerceJobs: [], reviewReplyProfiles: [], reviewReplyRuns: [], modelUsageRecords: [], settings: { safetyRules: "" } } as unknown as Database;
  await fs.writeFile(path.join(dir, "data/db.json"), JSON.stringify(db));
  const socket = net.createServer(); await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(r => socket.close(() => r()));
  const secret = "review-http-fixture-secret"; let logs = "";
  const child = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(dir, "server/index.ts")], { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", PORT: String(port), JWT_SECRET: secret, DB_PROVIDER: "json", DATA_DB_PROVIDER: "disabled", WANLINIU_SYNC_ENABLED: "false", KNOWLEDGE_SYNC_ENABLED: "false", MEMORY_SCAN_INTERVAL_MINUTES: "9999" } });
  child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
  const request = (route: string, method = "GET", body?: unknown, userId: string | null = owner.id) => fetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: { ...(userId ? { Authorization: `Bearer ${signToken({ sub: userId, role: "user" }, secret)}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const okJson = async <T>(route: string, method = "GET", body?: unknown, expected = 200, userId: string | null = owner.id): Promise<T> => { const r = await request(route, method, body, userId); const text = await r.text(); assert.equal(r.status, expected, `${route}: ${text}\n${logs}`); return JSON.parse(text) as T; };
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { if ((await request("/health")).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 40)); }
    assert.ok(ready, logs);
    assert.equal((await request("/review-replies/profiles", "GET", undefined, null)).status, 401);
    const config = await okJson<{ agentId: string; ready: boolean; visionReady: boolean; templates: unknown[] }>("/review-replies/config");
    assert.ok(config.agentId); assert.equal(config.ready, true); assert.equal(config.visionReady, true); assert.ok(config.templates.length >= 1);
    assert.equal((await request("/chat", "POST", { agentId: config.agentId, modelId: model.id, content: "绕过专用流程回复" })).status, 403);
    assert.equal((await request(`/agents/${config.agentId}`, "PATCH", { prompt: "覆盖内置流程" }, admin.id)).status, 400);
    assert.equal((await request(`/agents/${config.agentId}`, "DELETE", undefined, admin.id)).status, 400);
    const configured = JSON.parse(await fs.readFile(path.join(dir, "data/db.json"), "utf8")) as Database;
    const official = configured.agents.find(a => a.id === config.agentId)!;
    assert.equal((await request(`/public/agents/${official.publicSlug}`, "GET", undefined, null)).status, 404);
    assert.equal(requests.length, 0, "generic agent routes must not invoke models for the private review workflow");
    const draft: ReviewDraft = { ...defaultReviewDraft(), name: "演示店回复规则", shopName: "HTTP_SHOP", brand: "演示", products: [{ id: "tea", name: "演示茶叶", sku: "TEA" }], facts: [{ id: "tea-public", productId: "tea", text: "HTTP_APPROVED小袋包装", source: "产品资料", status: "approved" }, { id: "tea-internal", productId: "tea", text: "HTTP_INTERNAL_SECRET", source: "内部", status: "internal" }], sourceAttachmentIds: [attachment.id] };
    const { profile } = await okJson<{ profile: ReviewProfile }>("/review-replies/profiles", "POST", { draft }, 201);
    assert.equal(profile.ownerId, owner.id); assert.equal(profile.revision, 1);
    for (const other of [peer, foreign]) {
      if (other.companyId === owner.companyId) {
        const list = await okJson<{ profiles: ReviewProfile[] }>("/review-replies/profiles", "GET", undefined, 200, other.id); assert.deepEqual(list.profiles, []);
      } else assert.equal((await request("/review-replies/profiles", "GET", undefined, other.id)).status, 400);
      assert.equal((await request(`/review-replies/profiles/${profile.id}`, "GET", undefined, other.id)).status, 400);
      assert.equal((await request(`/review-replies/profiles/${profile.id}`, "PUT", { draft, expectedRevision: 1 }, other.id)).status, 400);
      assert.equal((await request(`/review-replies/profiles/${profile.id}/export`, "GET", undefined, other.id)).status, 400);
    }
    assert.equal((await request(`/attachments/${attachment.id}`, "DELETE")).status, 400, "saved source documents must not be removed as orphan uploads");
    responses.push({ draft: { ...draft, facts: [{ ...draft.facts[0], status: "approved" }] }, warnings: [] });
    const analyzed = await okJson<{ draft: ReviewDraft }>("/review-replies/analyze", "POST", { attachmentIds: [attachment.id], text: "补充资料" });
    assert.match(prompts[0], /DOCUMENT_MARKER/); assert.equal(analyzed.draft.facts[0].status, "pending");
    responses.push({ reviews: [{ text: "OCR识别的原始评价" }, { text: "包装方便" }], warnings: [] });
    const recognized = await okJson<{ reviews: { id: string; text: string }[] }>("/review-replies/recognize", "POST", { imageIds: [image.id] });
    assert.equal(recognized.reviews.length, 2);
    const ocrMessages = requests[1].messages as { content: unknown }[];
    assert.ok(ocrMessages.some(m => Array.isArray(m.content) && m.content.some((part: { type: string; image_url?: { url: string } }) => part.type === "image_url" && part.image_url?.url === `data:image/png;base64,${original.toString("base64")}`)), "OpenAI JSON must carry actual image_url content");
    const reviews: ReviewInput[] = [{ id: "http-review-one", text: "OCR_CORRECTED人工校正的评价原文", productId: "tea", afterSalesStatus: "" }, { id: "http-review-two", text: "第二条评价，包装方便", productId: "tea", afterSalesStatus: "" }];
    responses.push({ results: reviews.map((review, i) => ({ id: review.id, scene: "具体好评", risk: "low", axis: "回应体验", factIds: ["tea-public"], checks: [], candidates: [{ label: "简洁回应版", text: `HTTP回复${i + 1}A` }, { label: "适度展开版", text: `HTTP回复${i + 1}B` }] })) });
    const create = { profileId: profile.id, reviews, sourceImageIds: [image.id], requestKey: "http-create-idempotence" };
    const { run } = await okJson<{ run: ReviewRun }>("/review-replies/runs", "POST", create, 201);
    assert.equal(run.status, "completed", run.error); assert.equal(run.results.length, 2); assert.equal(run.results[0].candidates.length, 2);
    assert.match(prompts[2], /OCR_CORRECTED/); assert.match(prompts[2], /HTTP_APPROVED/); assert.ok(!prompts[2].includes("HTTP_INTERNAL_SECRET"));
    const duplicate = await okJson<{ run: ReviewRun }>("/review-replies/runs", "POST", create, 201); assert.equal(duplicate.run.id, run.id); assert.equal(requests.length, 3);
    assert.equal((await request(`/review-replies/runs/${run.id}`, "GET", undefined, peer.id)).status, 400);
    assert.deepEqual((await okJson<{ runs: ReviewRun[] }>("/review-replies/runs", "GET", undefined, 200, peer.id)).runs, []);
    assert.equal((await request(`/attachments/${image.id}`, "DELETE")).status, 400, "history screenshots must remain attached to the saved run");
    responses.push({ text: "HTTP缩短后的回复" });
    const selected = run.results[0].candidates[0];
    const refine = { itemId: reviews[0].id, candidateId: selected.id, instruction: "更短一些", requestKey: "http-refine-idempotence" };
    const refined = await okJson<{ run: ReviewRun }>(`/review-replies/runs/${run.id}/refine`, "POST", refine);
    assert.equal(refined.run.results[0].candidates[0].text, "HTTP缩短后的回复"); assert.deepEqual(refined.run.results[1], run.results[1]);
    assert.match(prompts[3], /OCR_CORRECTED/); assert.match(prompts[3], /HTTP回复1A/); assert.match(prompts[3], /更短一些/);
    await okJson(`/review-replies/runs/${run.id}/refine`, "POST", refine); assert.equal(requests.length, 4);
    assert.equal((await okJson<{ profile: ReviewProfile }>(`/review-replies/profiles/${profile.id}`)).profile.revision, 1);
    responses.push({ rule: "仅在客户提到首次购买时介绍品牌背景" });
    const proposed = await okJson<{ rule: string }>(`/review-replies/runs/${run.id}/propose-rule`, "POST", { itemId: reviews[0].id, candidateId: selected.id, instruction: "以后不主动介绍品牌" });
    assert.equal((await okJson<{ profile: ReviewProfile }>(`/review-replies/profiles/${profile.id}`)).profile.revision, 1);
    const savedRule = await okJson<{ profile: ReviewProfile }>(`/review-replies/profiles/${profile.id}/rules`, "POST", { rule: proposed.rule, expectedRevision: 1 });
    assert.equal(savedRule.profile.revision, 2); assert.ok(savedRule.profile.rules.includes(proposed.rule));
    assert.equal((await request(`/review-replies/profiles/${profile.id}/rules`, "POST", { rule: "旧版本覆盖", expectedRevision: 1 })).status, 400);
    const restored = await okJson<{ profile: ReviewProfile }>(`/review-replies/profiles/${profile.id}/restore`, "POST", { revision: 1, expectedRevision: 2 });
    assert.equal(restored.profile.revision, 3); assert.ok(!restored.profile.rules.includes(proposed.rule));
    await okJson(`/review-replies/runs/${run.id}/edit`, "POST", { itemId: reviews[0].id, candidateId: selected.id, text: "HTTP手动编辑的最终版" });
    const readBack = await okJson<{ run: ReviewRun }>(`/review-replies/runs/${run.id}`);
    assert.equal(readBack.run.results[0].text, reviews[0].text); assert.equal(readBack.run.results[0].candidates[0].text, "HTTP手动编辑的最终版"); assert.ok(readBack.run.results[0].candidates[0].versions.length >= 3);
    const exported = await request(`/review-replies/profiles/${profile.id}/export`); assert.equal(exported.status, 200); assert.match(exported.headers.get("content-type")!, /text\/markdown/); assert.equal(exported.headers.get("cache-control"), "no-store");
    const skill = await exported.text(); assert.match(skill, /HTTP_SHOP/); assert.ok(skill.length > 100); assert.ok(!skill.includes("OCR_CORRECTED")); assert.ok(!skill.includes("HTTP手动编辑的最终版"));
    const stored = JSON.parse(await fs.readFile(path.join(dir, "data/db.json"), "utf8")) as Database;
    assert.equal(stored.reviewReplyProfiles!.find(p => p.id === profile.id)!.revision, 3); assert.equal(stored.reviewReplyRuns!.length, 1); assert.equal(requests.length, 5); assert.equal(responses.length, 0); assert.deepEqual(upstreamErrors, []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(r => { child.once("exit", () => r()); child.kill("SIGTERM"); });
    upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); await fs.rm(dir, { recursive: true, force: true });
  }
});
