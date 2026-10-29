import type { Database, ModelConfig } from "./types.js";
import type { ReviewDraft, ReviewInput, ReviewResult } from "./reviewReplyTypes.js";
import { defaultReviewDraft } from "./reviewReplyTemplates.js";

export const replyText = (v: unknown, max = 200) => typeof v === "string" ? v.trim().slice(0, max) : "";
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
function str(v: unknown, max: number, label: string): string { if (v === undefined) return ""; if (typeof v !== "string" || v.length > max) throw new Error(`${label}最多${max}字`); return v.trim(); }
function arr(v: unknown, max: number, label: string): unknown[] { if (v === undefined) return []; if (!Array.isArray(v) || v.length > max) throw new Error(`${label}最多${max}项`); return v; }
const strings = (v: unknown, max: number, width: number, label: string) => [...new Set(arr(v, max, label).map(x => str(x, width, label)).filter(Boolean))];
export function reviewReplyModels(db: Database, vision = false): ModelConfig {
  const available = db.models.filter(m => m.enabled && m.apiKey && m.kind === "chat" && (!vision || m.protocol === "openai"));
  const model = available.find(m => m.isDefault) || available[0];
  if (!model) throw new Error(vision ? "请管理员配置支持图片理解的 OpenAI 协议对话模型" : "请管理员配置可用的对话模型");
  return model;
}
export function reviewRequestKey(v: unknown): string { if (typeof v !== "string" || !/^[\w-]{8,100}$/.test(v)) throw new Error("请求标识不正确，请刷新后重试"); return v; }
export function normalizeReviewDraft(value: unknown): ReviewDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请填写店铺规则");
  const v = obj(value), base = defaultReviewDraft(), settings = obj(v.settings);
  const products = arr(v.products, 50, "商品").map((raw, i) => { const p = obj(raw); return { id: str(p.id, 100, "商品标识") || `product-${i + 1}`, name: str(p.name, 120, "商品名称"), sku: str(p.sku, 120, "SKU") }; });
  if (products.some(p => !p.name) || new Set(products.map(p => p.id)).size !== products.length) throw new Error("请填写商品名称，商品标识不能重复");
  const facts = arr(v.facts, 150, "商品事实").map((raw, i) => {
    const f = obj(raw), status = f.status === undefined ? "pending" : f.status;
    if (!["approved", "pending", "internal", "forbidden"].includes(String(status))) throw new Error("请核对商品事实状态");
    const productId = str(f.productId, 100, "事实商品"); if (productId && !products.some(p => p.id === productId)) throw new Error("商品事实关联了不存在的商品");
    return { id: str(f.id, 100, "事实标识") || `fact-${i + 1}`, productId, text: str(f.text, 1000, "商品事实"), source: str(f.source, 300, "事实来源"), status: status as ReviewDraft["facts"][number]["status"] };
  }).filter(f => f.text);
  if (new Set(facts.map(f => f.id)).size !== facts.length) throw new Error("商品事实标识不能重复");
  const scenes: Record<string, string> = {};
  if (settings.sceneRules !== undefined && (!settings.sceneRules || typeof settings.sceneRules !== "object" || Array.isArray(settings.sceneRules))) throw new Error("场景规则格式不正确");
  if (Object.keys(obj(settings.sceneRules)).length > 20) throw new Error("场景规则最多20项");
  for (const [key, value] of Object.entries(obj(settings.sceneRules))) { if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("场景名称不正确"); scenes[str(key, 80, "场景名称")] = str(value, 1000, "场景规则"); }
  const length = settings.length ?? base.settings.length, count = settings.count ?? base.settings.count, marketing = settings.marketing ?? base.settings.marketing, address = settings.address ?? base.settings.address;
  if (!["short", "medium", "long"].includes(String(length)) || count !== 1 && count !== 2 || !["none", "light", "natural"].includes(String(marketing)) || !["您", "你", "自然称呼"].includes(String(address))) throw new Error("请选择正确的回复配置");
  const draft: ReviewDraft = {
    name: str(v.name, 100, "规则名称") || base.name, shopName: str(v.shopName, 120, "店铺名称"), brand: str(v.brand, 100, "品牌"), platform: str(v.platform, 60, "平台") || base.platform,
    settings: { tone: str(settings.tone, 1000, "品牌语气") || base.settings.tone, length: length as ReviewDraft["settings"]["length"], count, marketing: marketing as ReviewDraft["settings"]["marketing"], address: address as ReviewDraft["settings"]["address"], emoji: settings.emoji === true, signature: str(settings.signature, 120, "署名"), closing: str(settings.closing, 200, "固定收尾"), goals: strings(settings.goals ?? base.settings.goals, 10, 200, "回复目标"), forbiddenPhrases: strings(settings.forbiddenPhrases ?? base.settings.forbiddenPhrases, 50, 100, "禁用表达"), afterSales: str(settings.afterSales, 2000, "售后口径") || base.settings.afterSales, sceneRules: settings.sceneRules === undefined ? base.settings.sceneRules : scenes },
    products, facts, examples: arr(v.examples, 20, "回复示例").map((raw, i) => { const e = obj(raw); return { id: str(e.id, 100, "示例标识") || `example-${i + 1}`, review: str(e.review, 2000, "示例评价"), reply: str(e.reply, 2000, "示例回复") }; }).filter(e => e.reply),
    rules: strings(v.rules, 50, 1000, "长期规则"), sourceAttachmentIds: strings(v.sourceAttachmentIds, 12, 100, "资料附件"),
  };
  if (JSON.stringify(draft).length > 75000) throw new Error("店铺资料过长，请精简后保存");
  return draft;
}
export function normalizeReviewInputs(value: unknown, draft: ReviewDraft): ReviewInput[] {
  if (!Array.isArray(value) || !value.length || value.length > 10) throw new Error("每次请提供1至10条评价");
  const reviews = value.map((raw, i) => {
    const v = obj(raw), text = str(v.text, 3000, "评价"), productId = str(v.productId, 100, "商品");
    if (!text) throw new Error("评价不能为空");
    if (productId && !draft.products.some(p => p.id === productId)) throw new Error("评价关联了不存在的商品");
    return { id: str(v.id, 100, "评价标识") || `review-${i + 1}`, text, productId, afterSalesStatus: str(v.afterSalesStatus, 500, "售后情况") };
  });
  if (new Set(reviews.map(r => r.id)).size !== reviews.length) throw new Error("评价标识不能重复");
  if (reviews.reduce((n, r) => n + r.text.length, 0) > 14000) throw new Error("本次评价总长度最多14000字");
  return reviews;
}
export function parseReviewJson(content: string): Record<string, unknown> {
  try { const value = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw new Error("AI 返回的格式不完整，请重新发起任务"); }
}
export function assertSafeReply(text: string, draft: ReviewDraft) {
  if (!text.trim() || text.length > 3000) throw new Error("回复为空或过长，请重新生成");
  const prohibited = draft.settings.forbiddenPhrases.find(word => word && text.toLowerCase().includes(word.toLowerCase()));
  if (prohibited) throw new Error(`回复包含店铺禁用表达“${prohibited}”，请调整规则或重新生成`);
  if (/(?:100%|百分之百|百分百|绝对|保证|彻底|永久|立刻|立即|七天|7天)(?:有效|治愈|根治|祛痘|祛斑|美白|见效|修复)|包治|药到病除|零副作用|永不复发|最有效|全网第一|国家级功效/.test(text)) throw new Error("回复包含未经确认的绝对化或医疗功效表述，请修改后重试");
  if (/(?:\+?86[- ]?)?1[3-9]\d{9}|\b\d{17}[\dXx]\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)) throw new Error("回复疑似包含个人联系方式或身份信息，请移除后重试");
  if (/已(?:为您|给您|为你|给你)?(?:完成|处理|办理|安排)?(?:退款|退货|补发|赔付|赔偿|发货)|承诺(?:赔付|赔偿|退款)|(?:赔偿|赔付)\s*\d+/.test(text)) throw new Error("回复包含未经核实的售后结果或赔付承诺，请调整后重试");
}
export function reviewMinimumRisk(review: string): "low" | "medium" | "high" {
  if (/过敏|红肿|刺痛|起疹|烂脸|烧伤|灼伤|假货|监管|12315|消协|投诉举报|身体不适|呼吸困难/.test(review)) return "high";
  if (/漏液|破损|破了|碎了|售后|退货|退款|补发|赔付|赔偿|没收到|未收到|发错|少发|漏发|物流|不满意|失望/.test(review)) return "medium";
  return "low";
}
export function eligibleFacts(draft: ReviewDraft, productId: string) { return draft.facts.filter(f => f.status === "approved" && (!f.productId || f.productId === productId)); }
export function parseReviewResults(content: string, reviews: ReviewInput[], draft: ReviewDraft, makeId: () => string, at: string): ReviewResult[] {
  const parsed = parseReviewJson(content);
  if (!Array.isArray(parsed.results) || parsed.results.length !== reviews.length) throw new Error("AI 没有返回每条评价的完整回复");
  const rawResults = parsed.results.map(obj);
  if (new Set(rawResults.map(r => r.id)).size !== reviews.length || rawResults.some(r => !reviews.some(input => input.id === r.id))) throw new Error("AI 返回的评价对应关系不正确");
  return reviews.map(input => {
    const raw = rawResults.find(r => r.id === input.id)!;
    if (!Array.isArray(raw.candidates) || raw.candidates.length !== draft.settings.count) throw new Error("AI 返回的候选数量不完整");
    const candidates = raw.candidates.map((c, i) => { const item = obj(c); const text = replyText(item.text, 3001); assertSafeReply(text, draft); return { id: makeId(), label: replyText(item.label, 60) || (i ? "适度展开版" : "简洁回应版"), text, versions: [{ text, instruction: "首次生成", createdAt: at }] }; });
    if (new Set(candidates.map(c => c.text)).size !== candidates.length) throw new Error("候选回复过于相同，请重新生成");
    const allowed = eligibleFacts(draft, input.productId);
    const factIds = strings(raw.factIds, 15, 100, "引用事实");
    if (factIds.some(id => !allowed.some(f => f.id === id))) throw new Error("回复引用了未经批准或不属于该商品的资料");
    const minimum = reviewMinimumRisk(input.text);
    const modelRisk = raw.risk === "medium" || raw.risk === "high" ? raw.risk : "low";
    const risk = minimum === "high" || modelRisk === "high" ? "high" : minimum === "medium" || modelRisk === "medium" ? "medium" : "low";
    const checks = strings(raw.checks, 10, 300, "核查提示");
    if (risk === "high") checks.unshift("涉及不适、质量真伪或投诉等风险，请人工核实并优先处理，暂停营销。");
    else if (risk === "medium") checks.unshift("请人工核实售后情况与处理进度，不作未经确认的承诺。");
    return { ...input, scene: replyText(raw.scene, 100) || "一般评价", risk, axis: replyText(raw.axis, 400), factIds, checks: [...new Set(checks)].slice(0, 10), candidates };
  });
}
