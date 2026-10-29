import test from "node:test";
import assert from "node:assert/strict";
import { CommerceService, ensureCommerceAgent, parseCommercePlan, normalizeCommerceBrief, commerceJobUsesAttachment } from "./commerce.js";
import { commerceVariantBrief, defaultComposition, mergeReferenceModules, parseCommerceReference, commercePlanningBrief } from "./commerceComposition.js";
import { commerceTitleInstructions, commerceTitleUnits, normalizeCommerceTitle } from "./commercePrompts.js";
import { defaultCommerceBrief, type CommerceJob } from "./commerceTypes.js";
import type { Attachment, Database, ModelConfig, User } from "./types.js";
import type { Store } from "./db.js";

const at = new Date().toISOString();
async function until(fn: () => boolean) {
  for (let i = 0; i < 300; i++) { if (fn()) { await new Promise(r => setTimeout(r, 0)); return; } await new Promise(r => setTimeout(r, 5)); }
  throw Error("generation fixture timed out");
}
function setup() {
  const user = { id: "operator", companyId: "company", username: "运营", role: "admin", enabled: true, passwordHash: "", createdAt: at } as User;
  const chat = { id: "chat", kind: "chat", protocol: "openai", provider: "fixture", apiKey: "fixture", model: "fixture", baseUrl: "https://fixture.invalid", enabled: true, isDefault: true } as ModelConfig;
  const asset = (id: string): Attachment => ({ id, companyId: user.companyId, userId: user.id, kind: "image", mimeType: "image/png", originalName: `${id}.png`, storagePath: "/unused", size: 1, extractedText: "", createdAt: at });
  const db = { users: [user], models: [chat, { ...chat, id: "image", kind: "image" }], agents: [], attachments: ["product", "ref-a", "ref-b", "gift", "sku-a", "sku-b", "detail"].map(asset), commerceJobs: [], modelUsageRecords: [], settings: { safetyRules: "" } } as unknown as Database;
  const store = { read: async () => db, mutate: async fn => fn(db) } as Store;
  const agent = ensureCommerceAgent(db, user.companyId)!;
  const brief = { ...defaultCommerceBrief(), productImageIds: ["product"], referenceImageIds: ["ref-a", "ref-b"], brand: "润培", productName: "身体乳", facts: ["保湿"], keywords: ["身体乳", "保湿"], count: 4 };
  const calls: { prompt: string; images: string[]; jobId?: string }[] = [];
  let chatCalls = 0;
  const plan = () => JSON.stringify({ summary: "比较四种构图", variants: Array.from({ length: 4 }, (_, i) => ({ name: `方向${i + 1}`, reason: "比较构图", headline: "保湿护理", subline: "", imagePrompt: `composition ${i}`, title: `润培身体乳保湿${"甲乙丙丁"[i]}`, titleReason: "品类和相关卖点" })) });
  const service = new CommerceService(store, {
    readImages: async images => images.map(a => a.id),
    saveImage: async (_raw, job, v) => { v.sourceWidth = 1024; v.sourceHeight = 1024; v.outputWidth = 1440; v.outputHeight = job.taskType === "portrait" ? 1920 : 1440; return asset(`output-${calls.length}-${v.id}`); },
    model: async (model, messages) => {
      const message = messages.at(-1)!;
      if (model.kind === "image") { calls.push({ prompt: message.content, images: message.inputImageDataUrls || [] }); return { content: "", imageUrl: "data:fixture" }; }
      chatCalls++;
      if (message.content.startsWith("根据商品资料")) return { content: plan() };
      if (message.content.startsWith("检查最后")) return { content: '{"passed":true,"note":"fixture only"}' };
      if (message.content.startsWith("你是电商商品资料提炼助手")) return { content: '{"productName":"身体乳","brand":"润培","specification":"250g","facts":["保湿"],"keywords":["身体乳","保湿"],"note":"请核对"}', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, source: "provider" as const } };
      return { content: "fixture analysis" };
    },
  });
  const current = (id: string) => db.commerceJobs!.find(j => j.id === id)!;
  const idle = (id: string) => until(() => !["planning", "queued", "generating"].includes(current(id).status));
  return { db, user, agent, brief, calls, service, current, idle, chatCalls: () => chatCalls };
}

test("a click generates one variant with exactly its selected reference; other ideas stay pending", async () => {
  const f = setup();
  const job = await f.service.create(f.user, f.agent.id, f.brief, "selective-test-key"); await f.idle(job.id);
  const saved = f.current(job.id);
  assert.deepEqual(saved.variants.map(v => v.referenceImageId), ["ref-a", "ref-b", "ref-a", "ref-b"]);
  await assert.rejects(f.service.generate(f.user, job.id), /选择/);
  await assert.rejects(f.service.generate(f.user, job.id, saved.variants[0].id, "detail"), /不属于/);
  await f.service.generate(f.user, job.id, saved.variants[0].id, "ref-b"); await f.idle(job.id);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].images, ["product", "ref-b"]);
  assert.equal(saved.variants.filter(v => v.status === "pending").length, 3);
  assert.equal(saved.status, "review"); assert.equal(saved.variants[0].outputWidth, 1440);
  await f.service.generate(f.user, job.id, saved.variants[1].id, ""); await f.idle(job.id);
  assert.deepEqual(f.calls[1].images, ["product"]);
  await assert.rejects(f.service.generate(f.user, job.id, saved.variants[0].id, "ref-a"), /重新生成/);
});

test("alternate reference drops inherited source geometry but preserves user edits and confirmed copy", () => {
  const f = setup();
  const ref = parseCommerceReference({ overall: { layout: "原参考左图右文", background: "原粉色", palette: "粉", visualStyle: "柔光" }, modules: [{ type: "benefit", name: "卖点", location: "右边", appearance: "红字", texts: ["原竞品词"] }] }, "ref-a");
  const c = mergeReferenceModules(defaultComposition(f.brief), ref);
  const benefit = c.modules.find(m => m.type === "benefit")!; benefit.enabled = true; benefit.content = "保湿"; benefit.appearance = "用户指定蓝字";
  c.overall.background = "用户指定实验室";
  const b = commerceVariantBrief({ ...f.brief, composition: c }, { referenceImageId: "ref-b" } as never);
  assert.equal(b.composition!.overall.layout, ""); assert.equal(b.composition!.overall.background, "用户指定实验室");
  const changed = b.composition!.modules.find(m => m.type === "benefit")!;
  assert.equal(changed.location, ""); assert.equal(changed.appearance, "用户指定蓝字"); assert.equal(changed.content, "保湿");
  assert.equal(changed.source, undefined);
});

test("portrait, revision and SKU derive directly from selected image; SKU outputs use separate item assets", async () => {
  const f = setup();
  const parent = await f.service.create(f.user, f.agent.id, f.brief, "derive-parent-key"); await f.idle(parent.id);
  const first = f.current(parent.id).variants[0];
  await f.service.generate(f.user, parent.id, first.id, "ref-a"); await f.idle(parent.id);
  const source = first.imageAttachmentId!, plannedCalls = f.chatCalls();
  const request = { variantId: first.id, kind: "portrait" as const, requestKey: "derive-portrait-key" };
  const portrait = await f.service.derive(f.user, parent.id, request); await f.idle(portrait.id);
  assert.equal(f.current(portrait.id).variants[0].outputHeight, 1920);
  assert.deepEqual(f.calls[1].images, [source, "product"]);
  assert.match(f.calls[1].prompt, /宽1440像素、高1920像素/);
  assert.equal(f.chatCalls(), plannedCalls + 1, "only inspection, no repeat planning");
  assert.equal((await f.service.derive(f.user, parent.id, request)).id, portrait.id); assert.equal(f.calls.length, 2);
  const revised = await f.service.derive(f.user, parent.id, { variantId: first.id, kind: "revision", instruction: "删去左下角文字并重新排版", requestKey: "derive-revision-key" }); await f.idle(revised.id);
  assert.match(f.calls[2].prompt, /删去左下角文字并重新排版/); assert.deepEqual(f.calls[2].images, [source, "product"]);
  const sku = await f.service.derive(f.user, parent.id, { variantId: first.id, kind: "sku", requestKey: "derive-sku-key", items: [{ name: "花香", specification: "250g", imageIds: ["sku-a"] }, { name: "组合装", specification: "两件组合", imageIds: ["sku-a", "sku-b"] }] }); await f.idle(sku.id);
  assert.equal(sku.variants.length, 2); assert.deepEqual(f.calls[3].images, [source, "sku-a"]); assert.deepEqual(f.calls[4].images, [source, "sku-a", "sku-b"]);
  assert.equal(f.current(sku.id).status, "completed"); assert.ok(commerceJobUsesAttachment(f.current(sku.id), source));
  await assert.rejects(f.service.derive({ ...f.user, id: "other" }, parent.id, request), /无权/);
});

test("titles retain brand and channel budget; only selected facts/keywords enter planning", async () => {
  const f = setup();
  const title = normalizeCommerceTitle("身体乳" + "保湿滋润".repeat(20), f.brief);
  assert.ok(title.startsWith("润培")); assert.ok(commerceTitleUnits(title) <= 60);
  assert.equal(normalizeCommerceTitle("简短护理", { ...f.brief, platform: "小红书" }), "润培 简短护理");
  assert.match(commerceTitleInstructions(f.brief), /其他品牌/); assert.match(commerceTitleInstructions(f.brief), /不要重复/);
  const brief = normalizeCommerceBrief({ ...f.brief, detailImageIds: ["detail"], detailText: "未确认详情功效", keywordCandidates: [{ text: "保湿", source: "detail" }, { text: "未勾选词", source: "report", heat: "999" }] });
  const input = JSON.stringify(commercePlanningBrief(brief)); assert.ok(!input.includes("未确认详情功效")); assert.ok(!input.includes("未勾选词"));
  const recognition = await f.service.recognizeDetails(f.user, { imageIds: ["detail"], text: "润培身体乳250g，保湿" });
  assert.deepEqual(recognition.keywords, ["身体乳", "保湿"]); assert.equal(f.db.modelUsageRecords.length, 1);
  await assert.rejects(f.service.recognizeDetails(f.user, { imageIds: ["missing"], text: "" }), /无权/);
});
