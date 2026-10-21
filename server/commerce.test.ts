import test from "node:test";
import assert from "node:assert/strict";
import { CommerceService, commerceImagePrompt, commerceJobAccess, commerceJobUsesAttachment, ensureCommerceAgent, normalizeCommerceBrief, parseCommercePlan, publicCommerceJob } from "./commerce.js";
import { defaultCommerceBrief, type CommerceJob } from "./commerceTypes.js";
import type { Attachment, Database, ModelConfig, User } from "./types.js";
import type { Store } from "./db.js";

const timestamp = new Date().toISOString();
function fixture() {
  const owner: User = { id: "owner", companyId: "c1", username: "运营", role: "admin", enabled: true, passwordHash: "", createdAt: timestamp };
  const other: User = { ...owner, id: "other", companyId: "c2" };
  const peer: User = { ...owner, id: "peer", role: "user" };
  const model: ModelConfig = { id: "chat", name: "chat", provider: "fixture", kind: "chat", protocol: "openai", baseUrl: "https://fixture.invalid", apiKey: "fixture", model: "fixture", enabled: true, isDefault: true, systemPrompt: "", createdAt: timestamp };
  const attachment: Attachment = { id: "original", companyId: "c1", userId: owner.id, originalName: "product.png", mimeType: "image/png", kind: "image", size: 1, storagePath: "/unused", extractedText: "", createdAt: timestamp };
  const db = { users: [owner, peer, other], agents: [], models: [model, { ...model, id: "image", kind: "image" }], attachments: [attachment], modelUsageRecords: [], settings: { safetyRules: "" }, commerceJobs: [] } as unknown as Database;
  const store: Store = { read: async () => db, mutate: async fn => fn(db) };
  const agent = ensureCommerceAgent(db, owner.companyId)!;
  const brief = { ...defaultCommerceBrief(), productImageIds: [attachment.id], productName: "演示商品", specification: "20片装", facts: ["便携包装"], mode: "direct" as const, focus: "产品特点" };
  return { db, store, owner, peer, other, agent, brief, model };
}
const plan = (count = 5) => JSON.stringify({ summary: "围绕便携包装比较不同构图。", variants: Array.from({ length: count }, (_, i) => ({ name: `方向${i}`, reason: "突出已确认的便携特点", headline: "便携包装", subline: "", imagePrompt: `Product layout ${i}: a single pack on a quiet background.`, title: `演示商品 便携包装 ${"甲乙丙丁戊"[i]}`, titleReason: "商品词与便携特点呼应" })) });
async function until(fn: () => boolean) { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 5)); } }

test("brief validates platform choices, image roles, optional references and variant count", () => {
  const { brief } = fixture();
  for (const platform of ["淘宝", "天猫", "京东", "抖音", "拼多多", "视频号"]) assert.equal(normalizeCommerceBrief({ ...brief, platform }).platform, platform);
  assert.deepEqual(normalizeCommerceBrief(brief).referenceImageIds, []);
  assert.throws(() => normalizeCommerceBrief({ ...brief, platform: "injected" }));
  assert.throws(() => normalizeCommerceBrief({ ...brief, count: 10 }));
  assert.throws(() => normalizeCommerceBrief({ ...brief, referenceImageIds: ["original"] }));
  assert.throws(() => normalizeCommerceBrief({ ...brief, style: "沿用参考图结构" }));
  assert.equal(normalizeCommerceBrief({ ...brief, mode: "explore", count: 4 }).count, 4);
  assert.throws(() => parseCommercePlan(plan(4), brief));
});

test("plan first, make five sequential independent images, preserve successes and retry only the failed image", async () => {
  const { db, store, owner, peer, other, agent, brief } = fixture();
  let imageCalls = 0, imageInFlight = 0, maximum = 0, analyses = 0, plans = 0, checks = 0;
  const inputs: string[][] = [], prompts: string[] = [];
  const service = new CommerceService(store, {
    readImages: async attachments => attachments.map(a => `data:${a.id}`),
    saveImage: async (_url, job, variant) => ({ ...db.attachments[0], id: `output-${variant.id}-${imageCalls}`, originalName: "output.png", userId: job.userId }),
    model: async (model, messages) => {
      const content = messages[0].content;
      if (model.kind === "image") {
        imageCalls++; imageInFlight++; maximum = Math.max(maximum, imageInFlight);
        inputs.push(messages[0].inputImageDataUrls!); prompts.push(content);
        await new Promise(r => setTimeout(r, 2)); imageInFlight--;
        if (imageCalls === 3) throw new Error("第三张演示失败");
        return { content: "", imageUrl: `data:image-${imageCalls}` };
      }
      if (content.startsWith("检查最后")) { checks++; return { content: checks === 1 ? "inspection unavailable" : '{"passed":true,"note":"演示检查通过"}' }; }
      if (content.startsWith("根据商品资料")) { plans++; return { content: plan() }; }
      analyses++; return { content: "只使用便携包装这一已核对事实。" };
    },
  });
  const initial = await service.create(owner, agent.id, brief, "request-12345");
  await until(() => db.commerceJobs![0].status === "review");
  assert.equal(analyses, 1); assert.equal(plans, 1); assert.equal(imageCalls, 0);
  const duplicate = await service.create(owner, agent.id, brief, "request-12345");
  assert.equal(duplicate.id, initial.id); assert.equal(db.commerceJobs!.length, 1);
  assert.throws(() => commerceJobAccess(db, peer, initial.id));
  assert.throws(() => commerceJobAccess(db, other, initial.id));
  assert.ok(!("analysis" in publicCommerceJob(db.commerceJobs![0])));
  assert.ok(!("imagePrompt" in publicCommerceJob(db.commerceJobs![0]).variants[0]));
  await Promise.all([service.generate(owner, initial.id), service.generate(owner, initial.id)]);
  await until(() => db.commerceJobs![0].status === "partial");
  assert.equal(imageCalls, 5); assert.equal(maximum, 1); assert.equal(checks, 4);
  assert.equal(new Set(prompts).size, 5);
  for (const images of inputs) assert.deepEqual(images, ["data:original"]);
  const job = db.commerceJobs![0];
  assert.equal(job.variants.filter(v => v.imageAttachmentId).length, 4);
  assert.equal(job.variants[0].quality, "review");
  assert.ok(job.variants[0].imageAttachmentId, "inspection errors must preserve the paid image");
  const saved = job.variants.filter(v => v.status === "completed").map(v => v.imageAttachmentId);
  const failed = job.variants.find(v => v.status === "failed")!;
  await new Promise(r => setTimeout(r, 0));
  await service.retry(owner, initial.id, failed.id);
  await until(() => job.status === "completed");
  assert.equal(imageCalls, 6); assert.equal(analyses, 1); assert.equal(plans, 1);
  assert.equal(failed.attempts, 2);
  assert.deepEqual(job.variants.filter(v => v.id !== failed.id).map(v => v.imageAttachmentId), saved);
  const first = job.variants[0], originalOutput = first.imageAttachmentId!;
  await new Promise(r => setTimeout(r, 0));
  await service.retry(owner, initial.id, first.id);
  await until(() => job.status === "completed");
  assert.equal(imageCalls, 7);
  assert.notEqual(first.imageAttachmentId, originalOutput);
  assert.ok(first.previousImageIds?.includes(originalOutput));
  assert.ok(commerceJobUsesAttachment(job, originalOutput));
});

test("ownership and restart recovery preserve results without repeating charged work", async () => {
  const { db, store, owner, other, agent, brief } = fixture();
  const service = new CommerceService(store, { readImages: async () => [], saveImage: async () => { throw Error("unused"); }, model: async () => { throw Error("must not call"); } });
  await assert.rejects(service.create(other, agent.id, brief, "request-foreign"));
  const parsed = parseCommercePlan(plan(), brief);
  const job: CommerceJob = { id: "saved", companyId: owner.companyId, userId: owner.id, agentId: agent.id, requestKey: "saved-key", brief, status: "generating", phase: "", summary: parsed.summary, analysis: "", variants: parsed.variants, chatModelId: "chat", imageModelId: "image", createdAt: timestamp, updatedAt: timestamp };
  job.variants[0].status = "completed"; job.variants[0].imageAttachmentId = "saved-image";
  job.variants[1].status = "generating";
  db.commerceJobs!.push(job);
  await service.recover();
  assert.equal(job.status, "interrupted"); assert.equal(job.variants[0].imageAttachmentId, "saved-image");
  assert.ok(job.variants.slice(1).every(v => v.status === "failed"));
  await service.tick(); assert.equal(job.status, "interrupted");
  db.users[0].enabled = false;
  assert.throws(() => commerceJobAccess(db, owner, job.id));
  const prompt = commerceImagePrompt(job, job.variants[0]);
  assert.ok(prompt.includes("严禁拼图")); assert.ok(prompt.includes("产品特点")); assert.ok(prompt.includes("20片装"));
});
