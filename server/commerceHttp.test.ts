import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import sharp from "sharp";
import { hashPassword, signToken } from "./security.js";
import { defaultComposition, mergeReferenceModules } from "./commerceComposition.js";
import { defaultCommerceBrief } from "./commerceTypes.js";

test("HTTP creative flow: private jobs, original assets retained, five separate edits, single retry, ZIP and restart", { timeout: 60000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gplan-creative-http-"));
  await fs.cp(path.join(root, "server"), path.join(dir, "server"), { recursive: true });
  await fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.mkdir(path.join(dir, "data/uploads"), { recursive: true });
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } }).png().toBuffer();
  await fs.writeFile(path.join(dir, "data/uploads/original.png"), png);
  for (const id of ["reference", "logo"]) await fs.writeFile(path.join(dir, `data/uploads/${id}.png`), png);
  let calls = 0, plans = 0, referenceCalls = 0, editCalls = 0;
  const prompts: string[] = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/images/edits" && body.includes("对输入的这一张原图做小范围修改")) {
      editCalls++;
      assert.match(body, /name="n"\r\n\r\n1\r\n/);
      assert.match(body, /name="size"\r\n\r\nauto\r\n/);
      assert.equal((body.match(/name="image\[\]"/g) || []).length, 1);
      assert.match(body, /把79元改成69元/);
      assert.match(body, /其余内容尽量保留原样/);
      if (editCalls === 2) { res.statusCode = 503; res.end('{"error":{"message":"fixture edit failed"}}'); return; }
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })); return;
    }
    if (req.url === "/images/edits") {
      calls++;
      assert.match(body, /name="n"\r\n\r\n1\r\n/);
      assert.equal((body.match(/name="image\[\]"/g) || []).length, 3);
      assert.match(body, /严禁拼图/); assert.match(body, /本店周年庆/); assert.match(body, /输入第3张/); assert.ok(!body.includes("竞品价9999元")); prompts.push(body);
      if (calls === 3) { res.statusCode = 503; res.end('{"error":{"message":"fixture image 3 failed"}}'); return; }
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })); return;
    }
    assert.equal(req.url, "/chat/completions");
    const request = JSON.parse(body);
    const content = request.messages.at(-1).content;
    const prompt = typeof content === "string" ? content : content[0].text;
    let answer = "商品是演示商品，只有已提供的便携特点，不推断用户画像。";
    if (prompt.startsWith("你是电商主图的视觉结构分析助手")) {
      referenceCalls++;
      assert.equal(content.filter((x: { type: string }) => x.type === "image_url").length, 1);
      answer = JSON.stringify({ overall: { layout: "上方活动，商品居中", palette: "红白", background: "白", visualStyle: "简洁" }, modules: [{ type: "activity", name: "顶部活动条", location: "顶部", bbox: [0, 0, 1, .2], texts: ["竞品价9999元"], appearance: "红底白字", confidence: "high", uncertainties: [] }] });
    } else if (prompt.startsWith("你是电商商品资料提炼助手")) answer = '{"productName":"演示商品","brand":"","specification":"20片装","facts":["便携包装"],"keywords":["便携","护理"],"note":"fixture details"}';
    else if (prompt.startsWith("为电商主图的一个模块")) answer = '{"suggestions":["便携包装","随身携带更方便"]}';
    else if (prompt.startsWith("根据商品资料")) {
      plans++;
      answer = JSON.stringify({ summary: "比较同一商品的五个呈现方向。", variants: Array.from({ length: 5 }, (_, i) => ({ name: `演示方案${i + 1}`, reason: "比较信息层级", headline: "便携包装", subline: "", imagePrompt: `A single complete product image, composition ${i}`, title: `演示商品 便携护理 ${"甲乙丙丁戊"[i]}`, titleReason: "商品词配合便携重点" })) });
    } else if (prompt.startsWith("检查最后")) answer = '{"passed":true,"note":"fixture inspection only"}';
    res.end(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
  });
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r));
  const modelPort = (upstream.address() as net.AddressInfo).port;
  const time = new Date().toISOString();
  const users = [
    { id: "owner", companyId: "c1", username: "owner", role: "admin", enabled: true, passwordHash: hashPassword("fixture-password"), createdAt: time },
    { id: "peer", companyId: "c1", username: "peer", role: "user", enabled: true, passwordHash: "", createdAt: time },
    { id: "foreign", companyId: "c2", username: "foreign", role: "admin", enabled: true, passwordHash: "", createdAt: time },
  ];
  const models = ["chat", "image"].map(kind => ({ id: kind, name: kind, kind, protocol: "openai", provider: "fixture", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "fixture", model: "fixture", systemPrompt: "", enabled: true, isDefault: kind === "chat", createdAt: time }));
  await fs.writeFile(path.join(dir, "data/db.json"), JSON.stringify({ users, models, agents: [], conversations: [], messages: [], workspaces: [], integrationTokens: [], attachments: [{ id: "original", companyId: "c1", userId: "owner", originalName: "original.png", mimeType: "image/png", kind: "image", size: png.length, storagePath: path.join(dir, "data/uploads/original.png"), extractedText: "", createdAt: "2020-01-01T00:00:00Z" }, ...["reference", "logo"].map(id => ({ id, companyId: "c1", userId: "owner", originalName: `${id}.png`, mimeType: "image/png", kind: "image", size: png.length, storagePath: path.join(dir, `data/uploads/${id}.png`), extractedText: "", createdAt: time }))], settings: { safetyRules: "" } }));
  const socket = net.createServer(); await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(r => socket.close(() => r()));
  const secret = "creative-http-test-secret";
  let logs = "";
  const start = () => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(dir, "server/index.ts")], { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", PORT: String(port), JWT_SECRET: secret, DB_PROVIDER: "json", DATA_DB_PROVIDER: "disabled", WANLINIU_SYNC_ENABLED: "false", KNOWLEDGE_SYNC_ENABLED: "false", MEMORY_SCAN_INTERVAL_MINUTES: "9999" } });
    child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; }); return child;
  };
  let child = start();
  const request = async (url: string, user = "owner", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${signToken({ sub: user, role: "user" }, secret)}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { response, data: await response.json().catch(() => null) };
  };
  const waitReady = async () => { for (let i = 0; i < 150; i++) { try { if ((await request("/api/health")).response.ok) return; } catch {} await new Promise(r => setTimeout(r, 80)); } throw Error(logs); };
  const jobAt = async (id: string, status: string) => { for (let i = 0; i < 150; i++) { const r = await request(`/api/commerce/jobs/${id}`); if (r.data?.job?.status === status) return r.data.job; await new Promise(r => setTimeout(r, 50)); } throw Error(logs); };
  try {
    await waitReady();
    const agents = await request("/api/agents");
    const agent = agents.data.agents.find((a: { commerceKind?: string }) => a.commerceKind === "product_creative");
    assert.ok(agent);
    assert.equal((await request(`/api/public/agents/${agent.publicSlug}`)).response.status, 404);
    assert.equal((await request("/api/chat", "owner", { modelId: "chat", agentId: agent.id, content: "bypass" })).response.status, 403);
    const unauth = await fetch(`http://127.0.0.1:${port}/api/commerce/reference/recognize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageId: "original" }) });
    assert.equal(unauth.status, 401);
    assert.notEqual((await request("/api/commerce/reference/recognize", "peer", { imageId: "original" })).response.status, 200);
    assert.equal(referenceCalls, 0);
    const refId = "reference", logoId = "logo";
    const recognized = await request("/api/commerce/reference/recognize", "owner", { imageId: refId });
    assert.equal(recognized.response.status, 200); assert.equal(referenceCalls, 1);
    assert.equal(recognized.data.reference.modules[0].texts[0], "竞品价9999元");
    const suggested = await request("/api/commerce/modules/suggest", "owner", { type: "benefit", productName: "演示商品", facts: ["便携包装"] });
    assert.equal(suggested.data.suggestions.length, 2);
    assert.notEqual((await request("/api/commerce/modules/suggest", "owner", { type: "price", productName: "演示商品" })).response.status, 200);
    const brief = { ...defaultCommerceBrief(), productImageIds: ["original"], referenceImageIds: [refId], productName: "演示商品", facts: ["便携包装"], platform: "京东", composition: mergeReferenceModules(defaultComposition({ ...defaultCommerceBrief(), referenceImageIds: [refId] }), recognized.data.reference) };
    const activity = brief.composition.modules.find(m => m.type === "activity")!;
    activity.enabled = true;
    const incomplete = await request("/api/commerce/jobs", "owner", { agentId: agent.id, brief, requestKey: "incomplete-module-123" });
    assert.equal(incomplete.response.status, 400); assert.match(incomplete.data.error, /填写/);
    activity.content = "本店周年庆";
    Object.assign(brief.composition.modules.find(m => m.type === "brand")!, { enabled: true, assetId: logoId, location: "右上角" });
    assert.equal((await request("/api/commerce/jobs", "peer", { agentId: agent.id, brief, requestKey: "foreign-original" })).response.status, 400);
    const created = await request("/api/commerce/jobs", "owner", { agentId: agent.id, brief, requestKey: "test-request-123" });
    assert.equal(created.response.status, 202);
    const id = created.data.job.id;
    assert.notEqual((await request(`/api/commerce/jobs/${id}`, "peer")).response.status, 200);
    assert.notEqual((await request(`/api/commerce/jobs/${id}`, "foreign")).response.status, 200);
    const reviewed = await jobAt(id, "review"); assert.equal(calls, 0); assert.equal(plans, 1);
    const form = new FormData(); form.append("files", new Blob([png], { type: "image/png" }), "new.png");
    const uploaded = await fetch(`http://127.0.0.1:${port}/api/attachments`, { method: "POST", headers: { Authorization: `Bearer ${signToken({ sub: "owner", role: "admin" }, secret)}` }, body: form });
    assert.equal(uploaded.status, 200);
    assert.equal((await request("/api/attachments/original/content")).response.status, 200);
    assert.equal((await request(`/api/attachments/${logoId}/content`)).response.status, 200);
    assert.equal((await request(`/api/commerce/jobs/${id}/generate`, "owner", {})).response.status, 400);
    for (let i = 0; i < reviewed.variants.length; i++) {
      const selected = await request(`/api/commerce/jobs/${id}/generate`, "owner", { variantId: reviewed.variants[i].id, referenceImageId: refId });
      assert.equal(selected.response.status, 202);
      await jobAt(id, i < 2 ? "review" : "partial");
      assert.equal(calls, i + 1, "each click must generate just one image");
    }
    const partial = await jobAt(id, "partial"); assert.equal(calls, 5); assert.equal(partial.variants.filter((v: { status: string }) => v.status === "completed").length, 4);
    const failed = partial.variants.find((v: { status: string }) => v.status === "failed");
    await request(`/api/commerce/jobs/${id}/retry`, "owner", { variantId: failed.id });
    await jobAt(id, "completed"); assert.equal(calls, 6); assert.equal(plans, 1);
    const download = await fetch(`http://127.0.0.1:${port}/api/commerce/jobs/${id}/download`, { headers: { Authorization: `Bearer ${signToken({ sub: "owner", role: "admin" }, secret)}` } });
    assert.equal(download.status, 200);
    const zip = await JSZip.loadAsync(await download.arrayBuffer()); assert.equal(Object.keys(zip.files).length, 6);
    assert.ok(Object.values(zip.files).some(f => f.name.endsWith(".txt")));
    const editAgent = agents.data.agents.find((a: { commerceKind?: string }) => a.commerceKind === "image_edit");
    assert.equal(editAgent.name, "小修小改");
    assert.equal((await request("/api/commerce/edit-config")).data.ready, true);
    assert.equal((await request(`/api/public/agents/${editAgent.publicSlug}`)).response.status, 404);
    assert.equal((await request("/api/chat", "owner", { modelId: "image", agentId: editAgent.id, content: "bypass" })).response.status, 403);
    const editInput = { agentId: editAgent.id, imageId: "original", instruction: "把79元改成69元", requestKey: "simple-http-edit" };
    assert.equal((await request("/api/commerce/edits", "peer", editInput)).response.status, 400);
    assert.equal((await request("/api/commerce/edits", "foreign", editInput)).response.status, 400);
    assert.equal((await request("/api/commerce/edits", "owner", { ...editInput, instruction: "" })).response.status, 400);
    assert.equal((await request("/api/commerce/edits", "owner", { ...editInput, imageId: ["original"] })).response.status, 400);
    const edit = await request("/api/commerce/edits", "owner", editInput);
    assert.equal(edit.response.status, 202); assert.equal(edit.data.job.kind, "image_edit");
    const editId = edit.data.job.id;
    let edited = await jobAt(editId, "completed");
    assert.equal(editCalls, 1); assert.equal(edited.variants.length, 1); assert.equal(plans, 1);
    assert.equal((await request("/api/commerce/edits", "owner", editInput)).data.job.id, editId);
    assert.equal(editCalls, 1);
    const source = edited.variants[0].imageAttachmentId;
    const imageResponse = await fetch(`http://127.0.0.1:${port}/api/attachments/${source}/content?download=1`, { headers: { Authorization: `Bearer ${signToken({ sub: "owner", role: "admin" }, secret)}` } });
    assert.equal(imageResponse.status, 200); assert.match(imageResponse.headers.get("content-disposition")!, /attachment/);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
    assert.equal((await request(`/api/attachments/${source}/content`, "peer")).response.status, 404);
    const editHistory = (await request("/api/commerce/jobs?kind=image_edit")).data.jobs;
    assert.equal(editHistory.length, 1); assert.equal(editHistory[0].id, editId); assert.equal(editHistory[0].count, 1);
    assert.equal((await request("/api/commerce/jobs")).data.jobs.length, 1);
    assert.notEqual((await request(`/api/commerce/jobs/${editId}/retry`, "peer", { variantId: edited.variants[0].id })).response.status, 202);
    await request(`/api/commerce/jobs/${editId}/retry`, "owner", { variantId: edited.variants[0].id });
    edited = await jobAt(editId, "failed"); assert.equal(editCalls, 2); assert.equal(edited.variants[0].imageAttachmentId, source);
    await request(`/api/commerce/jobs/${editId}/retry`, "owner", { variantId: edited.variants[0].id });
    edited = await jobAt(editId, "completed"); assert.equal(editCalls, 3); assert.ok(edited.variants[0].previousImageIds.includes(source));
    assert.equal(plans, 1);
    const details = await request("/api/commerce/materials/recognize", "owner", { imageIds: [], text: "演示商品20片装，便携包装" });
    assert.equal(details.response.status, 200); assert.deepEqual(details.data.recognition.keywords, ["便携", "护理"]);
    const keywordForm = new FormData(); keywordForm.append("files", new Blob(["搜索词,搜索人气\n便携,1200\n护理,800\n"], { type: "text/csv" }), "keywords.csv");
    const keywordUploaded = await fetch(`http://127.0.0.1:${port}/api/attachments`, { method: "POST", headers: { Authorization: `Bearer ${signToken({ sub: "owner", role: "admin" }, secret)}` }, body: keywordForm });
    assert.equal(keywordUploaded.status, 200); const keywordAsset = (await keywordUploaded.json()).attachments[0].id;
    const keywords = await request("/api/commerce/keywords/import", "owner", { attachmentId: keywordAsset });
    assert.equal(keywords.response.status, 200); assert.equal(keywords.data.keywords[0].heat, "1200");
    assert.notEqual((await request("/api/commerce/keywords/import", "peer", { attachmentId: keywordAsset })).response.status, 200);
    assert.equal((await request("/api/commerce/products", "owner", { agentId: agent.id, name: "常用商品", brief })).response.status, 201);
    assert.equal((await request("/api/commerce/templates", "owner", { agentId: agent.id, name: "常用模板", composition: brief.composition, referenceImageIds: brief.referenceImageIds })).response.status, 201);
    assert.equal((await request("/api/commerce/library")).data.products.length, 1);
    assert.equal((await request("/api/commerce/library", "peer")).data.products.length, 0);
    const handoff = await fetch(`http://127.0.0.1:${port}/api/commerce/jobs/${id}/download?handoff=1`, { headers: { Authorization: `Bearer ${signToken({ sub: "owner", role: "admin" }, secret)}` } });
    const handoffZip = await JSZip.loadAsync(await handoff.arrayBuffer());
    assert.equal(Object.keys(handoffZip.files).filter(name => name.startsWith("原始素材/") && !handoffZip.files[name].dir).length, 3);
    const deriveRequest = { variantId: partial.variants[0].id, kind: "portrait", requestKey: "http-portrait-key" };
    assert.notEqual((await request(`/api/commerce/jobs/${id}/derive`, "peer", deriveRequest)).response.status, 202);
    const portrait = await request(`/api/commerce/jobs/${id}/derive`, "owner", deriveRequest);
    assert.equal(portrait.response.status, 202); const portraitJob = await jobAt(portrait.data.job.id, "completed");
    assert.equal(portraitJob.variants[0].outputWidth, 1440); assert.equal(portraitJob.variants[0].outputHeight, 1920);
    assert.equal((await request(`/api/commerce/jobs/${id}/derive`, "owner", deriveRequest)).data.job.id, portraitJob.id);
    assert.equal(calls, 7); assert.equal(plans, 1);
    await new Promise<void>(r => { child.once("exit", () => r()); child.kill(); });
    child = start(); await waitReady();
    const saved = await request(`/api/commerce/jobs/${id}`); assert.equal(saved.data.job.status, "completed"); assert.equal(calls, 7); assert.equal(saved.data.job.brief.composition.modules.find((m: { type: string }) => m.type === "activity").content, "本店周年庆");
    assert.equal((await request("/api/commerce/library")).data.templates.length, 1);
    assert.ok(prompts.slice(0, 6).every(p => p.includes("输入第1张是唯一主品外观依据")));
    const restoredEdit = await request(`/api/commerce/jobs/${editId}`);
    assert.equal(restoredEdit.data.job.status, "completed"); assert.equal(editCalls, 3);
    assert.equal(restoredEdit.data.job.brief.notes, "把79元改成69元");
  } finally {
    child.kill(); upstream.close(); await fs.rm(dir, { recursive: true, force: true });
  }
});
