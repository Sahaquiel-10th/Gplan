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
import { CommerceService, commerceJobUsesAttachment, ensureCommerceAgent, publicCommerceJob } from "./commerce.js";
import { signToken } from "./security.js";
import type { Store } from "./db.js";
import type { Attachment, Database, ModelConfig, User } from "./types.js";

const at = new Date().toISOString();
function fixture(count = 3) {
  const owner: User = { id: "owner", companyId: "batch-company", username: "owner", role: "admin", enabled: true, passwordHash: "", createdAt: at };
  const peer: User = { ...owner, id: "peer", role: "user" };
  const model: ModelConfig = { id: "image", name: "image", provider: "fixture", kind: "image", protocol: "openai", baseUrl: "https://fixture.invalid", apiKey: "fixture", model: "fixture", enabled: true, isDefault: true, systemPrompt: "", createdAt: at };
  const attachments: Attachment[] = Array.from({ length: count }, (_, i) => ({ id: `source-${i}`, companyId: owner.companyId, userId: owner.id, originalName: `图片${i + 1}.png`, kind: "image", mimeType: "image/png", size: 1, storagePath: "/unused", extractedText: "", createdAt: at }));
  const db = { users: [owner, peer], agents: [], models: [model], attachments, commerceJobs: [], modelUsageRecords: [], settings: { safetyRules: "" } } as unknown as Database;
  const store: Store = { read: async () => db, mutate: async fn => fn(db) };
  const agent = ensureCommerceAgent(db, owner.companyId, "image_edit")!;
  return { owner, peer, db, store, agent };
}
async function until(fn: () => boolean) { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw Error("batch job timed out"); await new Promise(r => setTimeout(r, 5)); } }
const terminal = (status: string) => !["queued", "generating", "planning"].includes(status);

test("only the legacy built-in small-edit description migrates to the batch wording", () => {
  const { db, owner, agent } = fixture();
  agent.description = "上传一张图片，说清要改哪里，生成可下载的新版本。";
  agent.updatedAt = "2020-01-01T00:00:00Z";
  ensureCommerceAgent(db, owner.companyId, "image_edit");
  assert.match(agent.description, /单张或批量/); assert.notEqual(agent.updatedAt, "2020-01-01T00:00:00Z");
  agent.description = "我的自定义图片修改工具";
  ensureCommerceAgent(db, owner.companyId, "image_edit");
  assert.equal(agent.description, "我的自定义图片修改工具");
});

test("batch edits isolate each source/instruction, deduplicate requests, preserve successes and retry only the selected image", async () => {
  const { db, store, owner, agent } = fixture();
  let release: (() => void) | undefined, failSource = "source-1", inFlight = 0, maximum = 0;
  const calls: { ids: string[]; prompt: string }[] = [];
  const service = new CommerceService(store, {
    readImages: async attachments => attachments.map(a => a.id),
    saveImage: async (_url, job, variant) => ({ ...db.attachments[0], id: `result-${calls.length}`, userId: job.userId, originalName: variant.name + ".png" }),
    model: async (model, messages) => {
      assert.equal(model.kind, "image"); assert.equal(messages[0].imageSize, "auto");
      const ids = messages[0].inputImageDataUrls!;
      calls.push({ ids, prompt: messages[0].content });
      inFlight++; maximum = Math.max(maximum, inFlight);
      if (calls.length === 1) await new Promise<void>(r => { release = r; });
      inFlight--;
      if (ids[0] === failSource) throw Error("one paid image request failed");
      return { content: "", imageUrl: "data:fixture" };
    },
  });
  const input = { instruction: "统一把79元改成69元", items: [{ imageId: "source-0" }, { imageId: "source-1", instruction: "只删除右上角角标" }, { imageId: "source-2", instruction: " " }] };
  const created = await service.createEdit(owner, agent.id, input, "batch-dedup-key");
  await until(() => calls.length === 1);
  const duplicate = await service.createEdit(owner, agent.id, input, "batch-dedup-key");
  assert.equal(duplicate.id, created.id); assert.equal(db.commerceJobs!.length, 1); assert.equal(calls.length, 1);
  release!(); const job = db.commerceJobs![0]; await until(() => terminal(job.status));
  assert.equal(job.status, "partial"); assert.equal(maximum, 1); assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c.ids), [["source-0"], ["source-1"], ["source-2"]]);
  assert.match(calls[0].prompt, /统一把79元改成69元/); assert.ok(!calls[0].prompt.includes("只删除右上角角标"));
  assert.match(calls[1].prompt, /只删除右上角角标/); assert.ok(!calls[1].prompt.includes("统一把79元改成69元"));
  assert.match(calls[2].prompt, /统一把79元改成69元/);
  assert.deepEqual(job.brief.productImageIds, ["source-0", "source-1", "source-2"]); assert.equal(job.brief.count, 3);
  assert.equal(publicCommerceJob(job).variants[1].editInstruction, "只删除右上角角标");
  assert.ok(job.variants.every(v => v.productImageIds?.length === 1 && v.selected));
  assert.ok(job.variants.filter(v => v.status === "completed").every(v => v.qualityNote === "请对照原图核对修改内容、文字和未修改区域。"));
  assert.ok(job.brief.productImageIds.every(id => commerceJobUsesAttachment(job, id)));
  const first = job.variants[0], firstOutput = first.imageAttachmentId, lastOutput = job.variants[2].imageAttachmentId;
  await new Promise(r => setTimeout(r, 0)); failSource = "none";
  await Promise.all([service.retry(owner, job.id, job.variants[1].id, undefined, "retry-batch-item-key"), service.retry(owner, job.id, job.variants[1].id, undefined, "retry-batch-item-key")]); await until(() => terminal(job.status));
  assert.equal(job.status, "completed"); assert.equal(calls.length, 4); assert.deepEqual(calls[3].ids, ["source-1"]);
  await service.retry(owner, job.id, job.variants[1].id, undefined, "retry-batch-item-key");
  assert.equal(calls.length, 4, "repeating an acknowledged retry must not issue another image request");
  assert.equal(first.imageAttachmentId, firstOutput); assert.equal(job.variants[2].imageAttachmentId, lastOutput);
  await new Promise(r => setTimeout(r, 0)); failSource = "source-0";
  await service.retry(owner, job.id, first.id); await until(() => terminal(job.status));
  assert.equal(job.status, "partial"); assert.equal(first.status, "failed"); assert.equal(first.imageAttachmentId, firstOutput);
  await new Promise(r => setTimeout(r, 0)); failSource = "none";
  await service.retry(owner, job.id, first.id); await until(() => terminal(job.status));
  assert.equal(job.status, "completed"); assert.ok(first.previousImageIds?.includes(firstOutput!)); assert.equal(calls.length, 6);
});

test("batch validation rejects malformed, duplicate, missing-instruction, oversized and inaccessible items before any job is queued", async () => {
  const { db, store, owner, peer, agent } = fixture(21);
  let calls = 0;
  const service = new CommerceService(store, { readImages: async () => [], saveImage: async () => { throw Error("unused"); }, model: async () => { calls++; throw Error("must not call"); } });
  const base = { instruction: "修改价格", items: [{ imageId: "source-0" }] };
  const invalid = [
    { ...base, items: [] }, { ...base, items: Array.from({ length: 21 }, (_, i) => ({ imageId: `source-${i}` })) },
    { ...base, items: "source-0" }, { ...base, items: [null] }, { ...base, items: [{ imageId: 3 }] },
    { ...base, items: [{ imageId: "source-0" }, { imageId: " source-0 " }] },
    { ...base, instruction: "", items: [{ imageId: "source-0", instruction: "只修改本张" }, { imageId: "source-1" }] },
    { ...base, instruction: "字".repeat(1001) }, { ...base, items: [{ imageId: "source-0", instruction: "字".repeat(1001) }] },
    { ...base, items: [{ imageId: "source-0", instruction: 3 }] },
    { ...base, items: [{ imageId: "source-0" }, { imageId: "missing" }] },
  ];
  for (const input of invalid) await assert.rejects(service.createEdit(owner, agent.id, input, "invalid-batch-key"));
  db.attachments[1].userId = peer.id;
  await assert.rejects(service.createEdit(owner, agent.id, { ...base, items: [{ imageId: "source-0" }, { imageId: "source-1" }] }, "private-batch-key"), /无权/);
  db.attachments[2].companyId = "foreign-company";
  await assert.rejects(service.createEdit(owner, agent.id, { ...base, items: [{ imageId: "source-0" }, { imageId: "source-2" }] }, "foreign-batch-key"), /无权/);
  db.attachments[3].size = 10 * 1024 * 1024 + 1;
  await assert.rejects(service.createEdit(owner, agent.id, { ...base, items: [{ imageId: "source-0" }, { imageId: "source-3" }] }, "oversize-batch-key"), /10MB/);
  assert.equal(db.commerceJobs!.length, 0); assert.equal(calls, 0);
});

test("twenty per-image instructions need no common instruction; all failures stay failed and recovery never repeats charged work", async () => {
  const { db, store, owner, agent } = fixture(20); let calls = 0;
  const service = new CommerceService(store, { readImages: async a => a.map(x => x.id), saveImage: async () => { throw Error("unused"); }, model: async () => { calls++; throw Error("fixture failure"); } });
  const created = await service.createEdit(owner, agent.id, { items: db.attachments.map((a, i) => ({ imageId: a.id, instruction: `单独要求${i + 1}` })) }, "twenty-batch-key");
  const job = db.commerceJobs!.find(j => j.id === created.id)!; await until(() => terminal(job.status));
  assert.equal(job.brief.count, 20); assert.equal(job.brief.notes, ""); assert.equal(calls, 20); assert.equal(job.status, "failed");
  assert.ok(job.variants.every(v => v.attempts === 1 && v.status === "failed"));
  job.status = "generating"; job.variants[0].status = "generating"; job.variants[1].status = "pending";
  await service.recover(); await service.tick();
  assert.equal(job.status, "interrupted"); assert.equal(calls, 20); assert.equal(job.variants[1].status, "failed");
});

test("HTTP batch edits send independent n=1,size=auto calls and export exact image bytes plus each instruction in ZIP", { timeout: 30000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gplan-batch-edit-http-"));
  await fs.cp(path.join(root, "server"), path.join(dir, "server"), { recursive: true });
  await fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.mkdir(path.join(dir, "data/uploads"), { recursive: true });
  const original = await sharp({ create: { width: 60, height: 40, channels: 3, background: "red" } }).png().toBuffer();
  const output = await sharp({ create: { width: 80, height: 60, channels: 3, background: "blue" } }).webp().toBuffer();
  const { db, owner, peer, agent } = fixture(2);
  for (const a of db.attachments) { a.storagePath = path.join(dir, `data/uploads/${a.id}.png`); a.size = original.length; await fs.writeFile(a.storagePath, original); }
  let calls = 0, fail = true;
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString(); calls++;
    assert.equal(req.url, "/images/edits"); assert.match(body, /name="n"\r\n\r\n1\r\n/); assert.match(body, /name="size"\r\n\r\nauto\r\n/);
    assert.equal((body.match(/name="image\[\]"/g) || []).length, 1);
    assert.match(body, calls === 1 ? /把79元改成69元/ : /删除右上角角标/);
    res.setHeader("Content-Type", "application/json");
    if (calls === 2 && fail) { res.statusCode = 503; res.end('{"error":{"message":"batch image failure"}}'); return; }
    res.end(JSON.stringify({ data: [{ url: `data:image/webp;base64,${output.toString("base64")}` }] }));
  });
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r));
  db.models[0].baseUrl = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
  await fs.writeFile(path.join(dir, "data/db.json"), JSON.stringify({ ...db, conversations: [], messages: [], workspaces: [], integrationTokens: [] }));
  const socket = net.createServer(); await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(r => socket.close(() => r()));
  const secret = "batch-http-fixture-secret"; let logs = "";
  const child = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(dir, "server/index.ts")], { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", PORT: String(port), JWT_SECRET: secret, DB_PROVIDER: "json", DATA_DB_PROVIDER: "disabled", WANLINIU_SYNC_ENABLED: "false", KNOWLEDGE_SYNC_ENABLED: "false", MEMORY_SCAN_INTERVAL_MINUTES: "9999" } });
  child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
  const request = async (url: string, body?: unknown, userId = owner.id) => fetch(`http://127.0.0.1:${port}/api${url}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${signToken({ sub: userId, role: "admin" }, secret)}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const readJob = async (id: string) => { for (let i = 0; i < 150; i++) { const r = await request(`/commerce/jobs/${id}`); const body = await r.json(); if (body.job && terminal(body.job.status)) return body.job; await new Promise(r => setTimeout(r, 20)); } throw Error(logs); };
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { if ((await request("/health")).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 40)); }
    assert.ok(ready, logs);
    const input = { agentId: agent.id, requestKey: "batch-http-request", instruction: "把79元改成69元", items: [{ imageId: "source-0" }, { imageId: "source-1", instruction: "删除右上角角标" }] };
    assert.equal((await request("/commerce/edits", input, peer.id)).status, 400); assert.equal(calls, 0);
    const response = await request("/commerce/edits", input); assert.equal(response.status, 202);
    const id = (await response.json()).job.id; let job = await readJob(id);
    assert.equal(job.status, "partial", JSON.stringify(job)); assert.equal(calls, 2);
    assert.equal((await (await request("/commerce/edits", input)).json()).job.id, id); assert.equal(calls, 2);
    assert.equal((await request(`/commerce/jobs/${id}/download`, undefined, peer.id)).status, 400);
    const download = await request(`/commerce/jobs/${id}/download`);
    assert.equal(download.status, 200); assert.match(download.headers.get("content-disposition")!, new RegExp(encodeURIComponent("修改结果.zip")));
    const zip = await JSZip.loadAsync(await download.arrayBuffer());
    assert.equal(Object.keys(zip.files).length, 2); assert.ok(zip.file("修改说明.txt"));
    const notes = await zip.file("修改说明.txt")!.async("string"); assert.match(notes, /把79元改成69元/); assert.match(notes, /删除右上角角标/); assert.match(notes, /未完成/);
    const imageName = Object.keys(zip.files).find(name => name.endsWith(".webp"))!;
    assert.ok(imageName); assert.deepEqual(await zip.file(imageName)!.async("nodebuffer"), output);
    fail = false;
    assert.equal((await request(`/commerce/jobs/${id}/retry`, { variantId: job.variants[1].id })).status, 202);
    job = await readJob(id); assert.equal(job.status, "completed"); assert.equal(calls, 3);
    const finalZip = await JSZip.loadAsync(await (await request(`/commerce/jobs/${id}/download`)).arrayBuffer());
    assert.equal(Object.keys(finalZip.files).length, 3);
    assert.ok(job.variants.every((v: { outputWidth: number; outputHeight: number }) => v.outputWidth === 80 && v.outputHeight === 60));
  } finally {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(r => { child.once("exit", () => r()); child.kill("SIGTERM"); });
    upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); await fs.rm(dir, { recursive: true, force: true });
  }
});
