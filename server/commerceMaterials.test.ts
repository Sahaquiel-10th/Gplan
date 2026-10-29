import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { extractCommerceKeywordRows, parseCommerceKeywordFile, readCommerceLibrary, saveCommerceProduct, saveCommerceTemplate, commerceLibraryUsesAttachment } from "./commerceMaterials.js";
import { ensureCommerceAgent } from "./commerce.js";
import { defaultCommerceBrief } from "./commerceTypes.js";
import { defaultComposition } from "./commerceComposition.js";
import type { Database, User, Attachment } from "./types.js";

test("keyword CSV uses keyword/search-heat columns, ignores other metrics, deduplicates and preserves actual heat", () => {
  const parsed = parseCommerceKeywordFile(Buffer.from('报表日期,2026-10-01\n关键词,搜索人气,点击率\n身体乳,100~200,10%\n润肤乳,88,9%\n身体乳,100~200,11%\n合计,288,10%\n'), "report.csv");
  assert.deepEqual(parsed.keywords, [{ text: "身体乳", source: "report", heat: "100~200" }, { text: "润肤乳", source: "report", heat: "88" }]);
  assert.match(parsed.note, /搜索热度列/);
});

test("keyword workbook supports shifted and split headings without treating numeric metrics as keywords", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["搜索词报表"], ["关键词", "", "点击率"], ["", "搜索人气", ""], ["保湿身体乳", "200", "10%"], ["250", "300", "20%"]]), "运营词表");
  const parsed = parseCommerceKeywordFile(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), "运营词表.xlsx");
  assert.deepEqual(parsed.keywords, [{ text: "保湿身体乳", source: "report", heat: "200" }]);
  assert.throws(() => extractCommerceKeywordRows([{ name: "numbers", rows: [["搜索人气", "点击率"], [123, "10%"]] }]), /没有识别到关键词列/);
  assert.deepEqual(parseCommerceKeywordFile(Buffer.from("身体乳\n保湿乳\n"), "single.csv").keywords.map(k => k.text), ["身体乳", "保湿乳"]);
});

function fixture() {
  const user: User = { id: "owner", companyId: "c", username: "owner", enabled: true, role: "admin", passwordHash: "", createdAt: new Date().toISOString() };
  const image: Attachment = { id: "product-image", companyId: "c", userId: user.id, originalName: "product.png", mimeType: "image/png", kind: "image", size: 1, storagePath: "/unused", extractedText: "", createdAt: user.createdAt };
  const db = { users: [user], agents: [], models: [], attachments: [image, { ...image, id: "detail" }], conversations: [], commerceJobs: [] } as unknown as Database;
  const agent = ensureCommerceAgent(db, user.companyId)!;
  const brief = { ...defaultCommerceBrief(), productImageIds: [image.id], detailImageIds: ["detail"], productName: "身体乳", brand: "示例品牌", facts: ["250g"], offer: "满100减50", detailText: "保湿身体乳250g", keywords: ["身体乳"], keywordCandidates: [{ text: "身体乳", source: "detail" as const }] };
  return { db, user, agent, brief };
}

test("saved product carries only durable materials and facts; libraries are private and respect agent revocation", () => {
  const { db, user, agent, brief } = fixture();
  const product = saveCommerceProduct(db, user, { agentId: agent.id, name: "我的身体乳", brief: { ...brief, composition: defaultComposition(brief) } });
  assert.equal(product.brief.offer, "");
  assert.equal(product.brief.composition, undefined);
  assert.equal(product.brief.detailText, brief.detailText);
  assert.equal(commerceLibraryUsesAttachment(db, "detail"), true);
  assert.equal(readCommerceLibrary(db, user).products.length, 1);
  const peer = { ...user, id: "peer", role: "user" as const }; db.users.push(peer);
  assert.equal(readCommerceLibrary(db, peer).products.length, 0);
  assert.throws(() => saveCommerceProduct(db, peer, { agentId: agent.id, brief }), /无权/);
  const updated = saveCommerceProduct(db, user, { id: product.id, agentId: agent.id, name: "更新名称", brief });
  assert.equal(updated.id, product.id); assert.equal(db.commerceProducts!.length, 1);
  agent.access = { mode: "members", userIds: [] }; agent.ownerId = "other";
  assert.throws(() => readCommerceLibrary(db, user), /暂不可用/);
});

test("template assets are retained; revoked source-job images disappear from reusable materials", () => {
  const { db, user, agent, brief } = fixture();
  const template = saveCommerceTemplate(db, user, { agentId: agent.id, name: "固定构图", composition: defaultComposition(brief), referenceImageIds: [] });
  assert.equal(template.name, "固定构图");
  saveCommerceProduct(db, user, { agentId: agent.id, brief });
  const unavailable = { ...agent, id: "revoked", ownerId: "other", published: false }; db.agents.push(unavailable);
  db.commerceJobs!.push({ id: "old", agentId: unavailable.id, brief, variants: [], userId: user.id, companyId: user.companyId } as never);
  assert.equal(readCommerceLibrary(db, user).products.length, 0);
  assert.throws(() => saveCommerceProduct(db, user, { agentId: agent.id, brief }), /原图片所属任务/);
});
