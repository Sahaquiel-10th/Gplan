import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { parse as parseCsv } from "csv-parse/sync";
import type { Store } from "./db.js";
import type { Attachment, Database, User } from "./types.js";
import { CommerceService, commerceAttachments } from "./commerce.js";
import { normalizeComposition } from "./commerceComposition.js";
import { defaultCommerceBrief, type CommerceBrief, type CommerceKeyword, type CommerceSavedProduct, type CommerceSavedTemplate } from "./commerceTypes.js";
import { canUseAgent } from "./operationsPolicy.js";
import { uid } from "./security.js";

const MAX_TABLE_BYTES = 10 * 1024 * 1024;
const clean = (value: unknown, max = 120) => typeof value === "string" ? value.trim().slice(0, max) : "";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const values = (value: unknown, max = 30, chars = 160) => Array.isArray(value) ? [...new Set(value.map(x => clean(x, chars)).filter(Boolean))].slice(0, max) : [];
const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler => (req, res, next) => { void fn(req, res).catch(next); };

function availableAgent(db: Database, user: User, agentId?: string) {
  const member = db.users.find(u => u.id === user.id && u.companyId === user.companyId && u.enabled);
  const agent = member && db.agents.find(a => a.commerce?.kind === "product_creative" && (!agentId || a.id === agentId) && canUseAgent(a, member, db.users));
  if (!agent) throw new Error("智能体暂不可用");
  return agent;
}

function usableAttachment(db: Database, user: User, id: string): Attachment {
  const a = db.attachments.find(a => a.id === id && a.userId === user.id && a.companyId === user.companyId);
  if (!a) throw new Error("附件不存在或无权使用");
  const conversation = a.conversationId && db.conversations?.find(c => c.id === a.conversationId);
  if (conversation && conversation.agentId && !db.agents.some(agent => agent.id === conversation.agentId && canUseAgent(agent, user, db.users))) throw new Error("原资料已无权访问，请重新上传");
  return a;
}

function checkImages(db: Database, user: User, ids: string[]) {
  for (const id of ids) usableAttachment(db, user, id);
  return commerceAttachments(db, user, ids);
}

function keywordHeader(value: string): number {
  const word = value.toLowerCase().replace(/[\s_\-（）()]+/g, "");
  if (/数量|个数|词数|覆盖|占比|排名|指数|热度|人气|人数|点击|转化|成交|竞争|率/.test(word)) return 0;
  if (/^(关键词|搜索词|搜索关键词|检索词|热搜词|关联词|词根|词语|keyword|keywords|query|searchterm)$/.test(word)) return 4;
  return /关键词|搜索词|keyword|searchterm/.test(word) ? 2 : 0;
}
const heatHeader = (value: string) => /搜索人气|搜索热度|搜索指数|搜索量|搜索人数|搜索次数|热度|search.?volume|popularity/i.test(value) && !/变化|增长|环比|同比/.test(value);
const cell = (value: unknown) => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
const goodKeyword = (value: string) => value.length > 0 && value.length <= 60 && !/^[-+\d\s,.%‰~～—–:：/]+$/.test(value) && !/^(合计|汇总|总计|暂无|无数据|null|undefined|nan)$/i.test(value) && !keywordHeader(value) && !heatHeader(value);

export function extractCommerceKeywordRows(sheets: { name: string; rows: unknown[][] }[]): { keywords: CommerceKeyword[]; note: string } {
  const found = new Map<string, CommerceKeyword>();
  const columns: string[] = [];
  for (const { name, rows } of sheets.slice(0, 20)) {
    let header = -1, keywordCol = -1, heatCol = -1, score = 0;
    for (let r = 0; r < Math.min(rows.length, 40); r++) {
      const row = rows[r].map(cell);
      for (let col = 0; col < row.length; col++) {
        const candidate = keywordHeader(row[col]);
        if (candidate > score) { score = candidate; header = r; keywordCol = col; heatCol = row.findIndex(heatHeader); }
      }
    }
    if (keywordCol < 0) {
      const nonempty = rows.filter(row => row.some(x => cell(x)));
      if (!nonempty.length || nonempty.some(row => row.filter(x => cell(x)).length !== 1)) continue;
      keywordCol = Math.max(0, nonempty[0].findIndex(x => cell(x)));
      header = -1;
      columns.push(`${name}：单列关键词`);
    } else {
      // Some reports split keyword and traffic headings over two adjacent rows.
      if (heatCol < 0) {
        for (const row of rows.slice(Math.max(0, header - 1), header + 3)) {
          const index = row.map(cell).findIndex(heatHeader);
          if (index >= 0) { heatCol = index; break; }
        }
      }
      columns.push(`${name}：${cell(rows[header][keywordCol])}${heatCol >= 0 ? "及搜索热度列" : ""}`);
    }
    for (const row of rows.slice(header + 1, header + 5002)) {
      const word = cell(row[keywordCol]);
      if (!goodKeyword(word)) continue;
      const key = word.toLocaleLowerCase();
      const heat = heatCol >= 0 ? cell(row[heatCol]).slice(0, 80) : "";
      const existing = found.get(key);
      if (!existing) found.set(key, { text: word, source: "report", ...(heat && !heatHeader(heat) ? { heat } : {}) });
      else if (!existing.heat && heat && !heatHeader(heat)) existing.heat = heat;
      if (found.size >= 100) break;
    }
    if (found.size >= 100) break;
  }
  if (!found.size) throw new Error("没有识别到关键词列，请使用含“关键词”或“搜索词”表头的表格，也可以上传单列关键词清单");
  return { keywords: [...found.values()], note: `已读取${columns.join("；")}。关键词仅来自上传表格，热度保留报表原值；请勾选适合本商品的词。${found.size >= 100 ? "本次最多读取100个不重复关键词。" : ""}` };
}

export function parseCommerceKeywordFile(data: Buffer, filename: string) {
  if (data.length > MAX_TABLE_BYTES) throw new Error("关键词表格请控制在10MB以内");
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".csv") {
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(data); }
    catch { source = new TextDecoder("gb18030").decode(data); }
    const rows = parseCsv(source, { bom: true, relax_column_count: true, skip_empty_lines: true, max_record_size: 100000 }) as unknown[][];
    return extractCommerceKeywordRows([{ name: "CSV", rows }]);
  }
  if (![".xlsx", ".xls"].includes(extension)) throw new Error("请上传 XLSX、XLS 或 CSV 关键词表格");
  const workbook = XLSX.read(data, { type: "buffer", sheetRows: 5042, cellDates: false, bookVBA: false });
  return extractCommerceKeywordRows(workbook.SheetNames.slice(0, 20).map(name => ({ name, rows: XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, raw: false, defval: "" }) })));
}

export function commerceLibraryUsesAttachment(db: Database, id: string): boolean {
  return !!db.commerceProducts?.some(p => [...p.brief.productImageIds, ...(p.brief.detailImageIds || [])].includes(id))
    || !!db.commerceTemplates?.some(t => [...t.referenceImageIds, ...t.composition.modules.map(m => m.assetId).filter(Boolean)].includes(id));
}

export function saveCommerceProduct(db: Database, user: User, value: unknown): CommerceSavedProduct {
  const input = object(value), agent = availableAgent(db, user, clean(input.agentId));
  const v = object(input.brief), productImageIds = values(v.productImageIds, 3, 120), detailImageIds = values(v.detailImageIds, 12, 120);
  if (!productImageIds.length) throw new Error("请先上传商品白底图");
  checkImages(db, user, [...productImageIds, ...detailImageIds]);
  const productName = clean(v.productName), name = clean(input.name) || productName;
  if (!productName || !name) throw new Error("请填写商品名称");
  const keywordCandidates: CommerceKeyword[] = Array.isArray(v.keywordCandidates) ? v.keywordCandidates.slice(0, 100).map(raw => {
    const k = object(raw);
    return { text: clean(k.text, 60), heat: clean(k.heat, 80) || undefined, source: ["report", "detail", "manual", "packaging"].includes(String(k.source)) ? k.source as CommerceKeyword["source"] : "manual" };
  }).filter(k => k.text) : [];
  // A product stores durable facts, never the old campaign, price or creative composition.
  const brief: CommerceBrief = { ...defaultCommerceBrief(), productImageIds, detailImageIds, detailText: clean(v.detailText, 20000), productName, brand: clean(v.brand, 80), specification: clean(v.specification, 160), category: clean(v.category, 60) || "其他品类", facts: values(v.facts, 30), keywords: values(v.keywords, 30, 60), keywordCandidates };
  db.commerceProducts ??= [];
  const id = clean(input.id), existing = id ? db.commerceProducts.find(p => p.id === id && p.userId === user.id && p.companyId === user.companyId && p.agentId === agent.id) : undefined;
  if (id && !existing) throw new Error("商品资料不存在或无权修改");
  if (!existing && db.commerceProducts.filter(p => p.userId === user.id && p.companyId === user.companyId).length >= 100) throw new Error("最多保存100份商品资料，请先删除不再使用的资料");
  const now = new Date().toISOString();
  const product: CommerceSavedProduct = { id: existing?.id || uid("product"), name, brief, companyId: user.companyId, userId: user.id, agentId: agent.id, createdAt: existing?.createdAt || now, updatedAt: now };
  if (existing) Object.assign(existing, product); else db.commerceProducts.push(product);
  return structuredClone(product);
}

export function saveCommerceTemplate(db: Database, user: User, value: unknown): CommerceSavedTemplate {
  const input = object(value), agent = availableAgent(db, user, clean(input.agentId)), name = clean(input.name);
  if (!name) throw new Error("请为模板起一个名称");
  const referenceImageIds = values(input.referenceImageIds, 3, 120);
  const composition = normalizeComposition(input.composition, referenceImageIds);
  if (!composition) throw new Error("请先配置主图模块");
  checkImages(db, user, [...referenceImageIds, ...composition.modules.map(m => m.assetId).filter(Boolean)]);
  db.commerceTemplates ??= [];
  const id = clean(input.id), existing = id ? db.commerceTemplates.find(t => t.id === id && t.userId === user.id && t.companyId === user.companyId && t.agentId === agent.id) : undefined;
  if (id && !existing) throw new Error("模板不存在或无权修改");
  if (!existing && db.commerceTemplates.filter(t => t.userId === user.id && t.companyId === user.companyId).length >= 100) throw new Error("最多保存100份模板，请先删除不再使用的模板");
  const now = new Date().toISOString();
  const template: CommerceSavedTemplate = { id: existing?.id || uid("template"), name, composition, referenceImageIds, companyId: user.companyId, userId: user.id, agentId: agent.id, createdAt: existing?.createdAt || now, updatedAt: now };
  if (existing) Object.assign(existing, template); else db.commerceTemplates.push(template);
  return structuredClone(template);
}

export function readCommerceLibrary(db: Database, user: User) {
  availableAgent(db, user);
  const owned = (item: { companyId: string; userId: string; agentId: string }) => item.companyId === user.companyId && item.userId === user.id && db.agents.some(a => a.id === item.agentId && a.commerce?.kind === "product_creative" && canUseAgent(a, user, db.users));
  const assetsAvailable = (ids: string[]) => { try { checkImages(db, user, ids); return true; } catch { return false; } };
  const products = (db.commerceProducts || []).filter(p => owned(p) && assetsAvailable([...p.brief.productImageIds, ...(p.brief.detailImageIds || [])]));
  const templates = (db.commerceTemplates || []).filter(t => owned(t) && assetsAvailable([...t.referenceImageIds, ...t.composition.modules.map(m => m.assetId).filter(Boolean)]));
  return structuredClone({ products: products.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), templates: templates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
}

export function createCommerceMaterialsRouter(store: Store, service: Pick<CommerceService, "recognizeDetails">, active = new Set<string>()) {
  const router = express.Router();
  router.post("/materials/recognize", route(async (req, res) => {
    const db = await store.read(); availableAgent(db, req.user!);
    const input = object(req.body), ids = input.imageIds ?? [], detailText = input.text ?? "";
    if (!Array.isArray(ids) || ids.length > 12 || ids.some(id => typeof id !== "string" || !id || id.length > 120)) throw new Error("详情图最多上传12张");
    if (typeof detailText !== "string" || detailText.trim().length > 20000) throw new Error("详情文字请控制在20000字以内");
    if (!ids.length && !detailText.trim()) throw new Error("请上传详情图片或粘贴详情文字");
    const images = checkImages(db, req.user!, ids);
    if (images.some(a => a.size > MAX_TABLE_BYTES)) throw new Error("每张详情图片请控制在10MB以内");
    if (active.has(req.user!.id)) return res.status(429).json({ error: "正在识别或整理建议，请稍等" });
    active.add(req.user!.id);
    try { res.json({ recognition: await service.recognizeDetails(req.user!, { imageIds: ids, text: detailText.trim(), productName: clean(input.productName), brand: clean(input.brand, 80), specification: clean(input.specification, 160) }) }); }
    finally { active.delete(req.user!.id); }
  }));
  router.post("/keywords/import", route(async (req, res) => {
    const db = await store.read(); availableAgent(db, req.user!);
    const attachment = usableAttachment(db, req.user!, clean(req.body.attachmentId));
    if (attachment.kind !== "spreadsheet" || !/\.(xlsx|xls|csv)$/i.test(attachment.originalName)) throw new Error("请上传 XLSX、XLS 或 CSV 关键词表格");
    if (attachment.size > MAX_TABLE_BYTES || (await fs.stat(attachment.storagePath)).size > MAX_TABLE_BYTES) throw new Error("关键词表格请控制在10MB以内");
    const result = parseCommerceKeywordFile(await fs.readFile(attachment.storagePath), attachment.originalName);
    const current = await store.read(); availableAgent(current, req.user!); usableAttachment(current, req.user!, attachment.id);
    res.json(result);
  }));
  router.get("/library", route(async (req, res) => res.json(readCommerceLibrary(await store.read(), req.user!))));
  router.post("/products", route(async (req, res) => res.status(201).json({ product: await store.mutate(db => saveCommerceProduct(db, req.user!, req.body)) })));
  router.post("/templates", route(async (req, res) => res.status(201).json({ template: await store.mutate(db => saveCommerceTemplate(db, req.user!, req.body)) })));
  for (const kind of ["products", "templates"] as const) router.delete(`/${kind}/:id`, route(async (req, res) => {
    await store.mutate(db => {
      availableAgent(db, req.user!);
      const list = kind === "products" ? db.commerceProducts : db.commerceTemplates;
      const index = list?.findIndex(item => item.id === req.params.id && item.userId === req.user!.id && item.companyId === req.user!.companyId && db.agents.some(a => a.id === item.agentId && canUseAgent(a, req.user!, db.users))) ?? -1;
      if (!list || index < 0) throw new Error("资料不存在或无权删除");
      list.splice(index, 1);
    });
    res.json({ ok: true });
  }));
  return router;
}
