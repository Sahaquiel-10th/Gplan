import test from "node:test";
import assert from "node:assert/strict";
import { buildEnterpriseQuery, enterpriseTools, normalizeDataQuery, shanghaiDate } from "./enterpriseDataQueries.js";
import { assertEnterpriseAdmin, canReadEnterpriseConversation } from "./enterpriseDataPolicy.js";
import type { Conversation, ModelConfig, User } from "./types.js";
import { planBrandReport, planCompanyAnalysis } from "./enterpriseDataPlanner.js";
import { createEnterpriseQueryExecutor } from "./enterpriseQueryExecutor.js";
import { enterpriseEvidenceStatus } from "./enterpriseDataPolicy.js";

const admin = { id: "a", companyId: "c1", role: "admin", enabled: true } as User;
const user = { ...admin, role: "user" } as User;

test("every enterprise SQL query binds tenant and rejects arbitrary capabilities/SQL", () => {
  for (const tool of Object.keys(enterpriseTools)) {
    const q = buildEnterpriseQuery("c1", tool, tool.startsWith("sales_") || tool.startsWith("inbound_") ? { startDate: "2026-10-01", endDate: "2026-10-29" } : {});
    for (const stmt of [q.rows, q.summary, q.freshness].filter(Boolean)) {
      assert.ok(stmt!.sql.startsWith("SELECT"));
      assert.ok(stmt!.values.includes("c1"));
      assert.match(stmt!.sql, /company_id=\?/);
      assert.equal((stmt!.sql.match(/\?/g) || []).length, stmt!.values.length);
      assert.ok(!stmt!.sql.includes("raw_payload AS"));
    }
  }
  for (const tool of ["DROP TABLE x", "__proto__", "alipay", "execute_sql"]) assert.throws(() => buildEnterpriseQuery("c1", tool, {}));
  assert.throws(() => buildEnterpriseQuery("c1", "inventory", { companyId: "c2" }));
  assert.throws(() => buildEnterpriseQuery("c1", "inventory", { sql: "SELECT *" }));
});

test("filters use bound values, summaries cover all matching rows and currencies stay separate", () => {
  const injection = "x' OR 1=1 --";
  const q = buildEnterpriseQuery("tenant", "sales_summary", { startDate: "2026-10-01", endDate: "2026-10-29", shopIds: [injection], warehouseIds: ["WH"], skuCodes: ["SKU"], brands: ["BRAND"], search: "%_", groupBy: "product", limit: 1, offset: 2 });
  assert.ok(!q.rows.sql.includes(injection));
  assert.ok(q.rows.values.includes(injection));
  assert.match(q.rows.sql, /LIMIT 2 OFFSET 2/);
  assert.ok(!/LIMIT|OFFSET/.test(q.summary!.sql));
  assert.match(q.summary!.sql, /GROUP BY.*currency_code/);
  assert.match(q.summary!.sql, /IS NULL.*THEN NULL/);
  assert.ok(q.rows.values.includes("2026-10-30 00:00:00"));
  assert.match(q.rows.sql, /p.company_id=i.company_id/);
  assert.match(q.note, /不等于平台成交订单/);
});

test("reject invalid dates, excessive scans, pagination, dimensions and ignored filters", () => {
  const date = { startDate: "2026-10-01", endDate: "2026-10-29" };
  for (const params of [{}, { ...date, startDate: "2026-02-30" }, { ...date, endDate: "2026-09-01" }, { ...date, startDate: "2020-01-01" }, { ...date, limit: 1000 }, { ...date, offset: -1 }, { ...date, groupBy: "supplier" }]) assert.throws(() => normalizeDataQuery("sales_summary", params));
  for (const [tool, params] of [["inventory", date], ["inventory", { shopIds: ["s"] }], ["products", { warehouseIds: ["w"] }], ["source_status", { search: "x" }], ["shops", { brands: ["b"] }]] as const) assert.throws(() => normalizeDataQuery(tool, params));
  assert.equal(shanghaiDate(new Date("2026-10-28T18:00:00Z")), "2026-10-29");
});

test("enterprise history requires current enabled admin in original company", () => {
  const c = { enterpriseData: { companyId: "c1" } } as Conversation;
  assert.equal(canReadEnterpriseConversation(c, admin), true);
  for (const u of [user, { ...admin, enabled: false }, { ...admin, companyId: "c2" }]) assert.equal(canReadEnterpriseConversation(c, u), false);
  assert.throws(() => assertEnterpriseAdmin(user), { status: 403 });
});

// Keep external services disabled even when tests run directly from a configured checkout.
process.env.DATA_DB_PROVIDER = "disabled";
const { buildEnterpriseDataContext, parseEnterprisePlan } = await import("./enterpriseData.js");
const model = { id: "m", kind: "chat" } as ModelConfig;
const base = { user: admin, model, messages: [{ role: "user" as const, content: "昨天全部商品排行", createdAt: "2026-10-29" }], requestId: "test", connectorEnabled: true, liveAllowed: false, ensureAccess: async () => {} };

test("orchestration preserves full aggregates, pagination and two-step catalog resolution", async () => {
  let plans = 0;
  const statements: Array<{ sql: string; values: (string | number)[] }> = [];
  const r = await buildEnterpriseDataContext(base, {
    databaseReady: () => true,
    callModel: async (_m, messages) => {
      plans++;
      if (plans === 2) assert.match(messages[0].content, /shop-real-id/);
      return { content: JSON.stringify({ calls: plans === 1 ? [{ tool: "shops", params: { search: "旗舰店" } }] : [{ tool: "sales_summary", params: { startDate: "2026-10-28", endDate: "2026-10-28", shopIds: ["shop-real-id"], groupBy: "product", limit: 1 } }] }) };
    },
    query: async (sql, values) => {
      statements.push({ sql, values });
      if (sql.includes("FROM ods_wln_shops")) return sql.includes("COUNT(*)") ? [{ totalRows: 1 }] : [{ shopId: "shop-real-id" }];
      if (sql.includes("latestSyncedAt")) return [{ latestSyncedAt: "2026-10-29 03:00:00" }];
      if (!sql.includes("LIMIT")) return [{ amount: "999999.00", quantity: 10000, documentCount: 1000 }];
      return [{ dimension: "sku1", amount: "20" }, { dimension: "sku2", amount: "10" }];
    },
  });
  assert.equal(plans, 2);
  assert.equal(r.evidence.status, "queried");
  assert.equal(r.evidence.sources[1].hasMore, true);
  assert.equal(r.evidence.sources[1].returnedRows, 1);
  assert.match(r.context, /999999.00/);
  assert.ok(statements.every(s => s.values.includes("c1")));
  assert.ok(statements.filter(s => s.sql.includes("sale_outbound")).every(s => s.values.includes("shop-real-id")));
});

test("no business access for members, unavailable sources, invalid plans or disabled connector", async () => {
  let calls = 0;
  const deps = { databaseReady: () => true, query: async () => { calls++; return []; }, callModel: async () => { calls++; return { content: "bad json" }; } };
  await assert.rejects(buildEnterpriseDataContext({ ...base, user }, deps), { status: 403 });
  const disabled = await buildEnterpriseDataContext({ ...base, connectorEnabled: false }, deps);
  assert.equal(disabled.evidence.status, "unavailable");
  assert.equal(calls, 0);
  const bad = await buildEnterpriseDataContext(base, deps);
  assert.equal(bad.evidence.status, "unavailable");
  assert.equal(calls, 1);
  assert.throws(() => parseEnterprisePlan('{"calls":[{"tool":"inventory","params":{},"sql":"DELETE"}]}'));
});

test("revoke access between queries prevents further queries and context delivery", async () => {
  let revoked = false, queries = 0;
  await assert.rejects(buildEnterpriseDataContext({ ...base, ensureAccess: async () => { if (revoked) throw Object.assign(new Error("revoked"), { status: 403 }); } }, {
    databaseReady: () => true,
    callModel: async () => ({ content: JSON.stringify({ calls: [{ tool: "source_status", params: {} }, { tool: "shops", params: {} }] }) }),
    query: async () => { queries++; revoked = true; return []; },
  }), { status: 403 });
  assert.equal(queries, 1);
});

test("context trims complete rows without dropping aggregate metadata or producing broken JSON", async () => {
  const r = await buildEnterpriseDataContext(base, {
    databaseReady: () => true,
    callModel: async () => ({ content: '{"calls":[{"tool":"inventory","params":{}}]}' }),
    query: async sql => sql.includes("LIMIT") ? Array.from({ length: 50 }, () => ({ sku: "x".repeat(1000) })) : sql.includes("latestSyncedAt") ? [] : [{ totalRows: 1000, actualQuantity: 55555 }],
  });
  assert.match(r.context, /55555/);
  assert.equal(r.evidence.sources.length, 1);
  assert.ok(r.evidence.sources[0].returnedRows < 50);
  assert.equal(r.evidence.sources[0].hasMore, true);
  assert.ok(Array.isArray(JSON.parse(r.context.split("\n\n").at(-1)!)));
});

test("live ERP is separately gated and limited; driver errors cannot leak credentials", async () => {
  let liveCalls = 0;
  const deps = {
    databaseReady: () => false,
    callModel: async () => ({ content: '{"calls":[{"tool":"live_erp","params":{}}]}' }),
    liveContext: async () => { liveCalls++; return "【万里牛 AI Skill 返回结果】\n[{\"result\":123}]"; },
  };
  const unavailable = await buildEnterpriseDataContext(base, deps);
  assert.equal(unavailable.evidence.status, "unavailable");
  assert.equal(liveCalls, 0);
  const ok = await buildEnterpriseDataContext({ ...base, liveAllowed: true }, deps);
  assert.equal(liveCalls, 1);
  assert.equal(ok.evidence.sources[0].hasMore, true);
  const failure = await buildEnterpriseDataContext(base, { databaseReady: () => true, callModel: async () => ({ content: '{"calls":[{"tool":"shops","params":{}}]}' }), query: async () => { throw Error("password=SECRET mysql://root"); } });
  assert.ok(!failure.context.includes("SECRET"));
  assert.equal(failure.evidence.status, "unavailable");
});

test("sync status reads bounded cursors and cannot expose another connector company's metadata", () => {
  const q = buildEnterpriseQuery("other-company", "source_status", {});
  assert.match(q.rows.sql, /data_sync_cursors/);
  assert.match(q.rows.sql, /scope\.company_id=\?/);
  assert.match(q.rows.sql, /LIMIT 5/);
  assert.doesNotMatch(q.rows.sql, /ods_wln_|COUNT\(/);
  assert.deepEqual(q.rows.values, ["other-company", process.env.WANLINIU_COMPANY_ID?.trim() || "company_default"]);
});

test("warehouse catalog stays bounded to current inventory instead of scanning outbound history", () => {
  const q = buildEnterpriseQuery("c1", "warehouses", { search: "CK", limit: 1 });
  for (const statement of [q.rows, q.summary!]) {
    assert.match(statement.sql, /ods_wln_inventory_current/);
    assert.doesNotMatch(statement.sql, /sale_outbound|UNION/);
    assert.ok(statement.values.includes("c1"));
  }
  assert.match(q.note, /仅列出当前库存/);
  assert.match(q.rows.sql, /NULL warehouseName/);
});

test("brand reports default missing currency to CNY, preserve source currencies and compute shares before paging", () => {
  const q = buildEnterpriseQuery("c1", "sales_summary", { startDate: "2026-08-02", endDate: "2026-10-30", groupBy: "brand", limit: 1 });
  assert.match(q.rows.sql, /TRIM\(h.currency_code\).*'CNY'/);
  assert.match(q.rows.sql, /OVER \(PARTITION BY/);
  assert.match(q.rows.sql, /amountSharePercent/);
  assert.match(q.rows.sql, /STRAIGHT_JOIN/);
  assert.match(q.summary!.sql, /daysWithRecords/);
  assert.doesNotMatch(q.summary!.sql, /ods_wln_products|LIMIT/);
  assert.doesNotMatch(q.freshness!.sql, /ods_wln_products/);
  assert.match(q.note, /默认人民币CNY/);
  const filtered = buildEnterpriseQuery("c1", "sales_summary", { startDate: "2026-10-01", endDate: "2026-10-30", brands: ["brand"] });
  assert.match(filtered.summary!.sql, /ods_wln_products/);
});

test("brand planning covers original incident dates and interprets calendar weeks without model calls", () => {
  const message = (content: string) => ({ role: "user" as const, content, createdAt: "2026-10-30" });
  const first = message("帮我梳理最近一段时间公司各个品牌的销售额及销售额占比，越详细越好");
  const get = (messages: ReturnType<typeof message>[]) => planBrandReport(messages, "2026-10-30")!.calls[0].params;
  assert.equal(get([first]).startDate, "2026-10-01");
  assert.equal(get([first, message("2026-08-02 至 2026-10-30")]).startDate, "2026-08-02");
  assert.equal(get([first, message("那就帮我查看2026-10-01 至 2026-10-30之间，你能查到多少天就查多少天的")]).startDate, "2026-10-01");
  assert.equal(get([message("最近一周公司所有销售品牌的销售金额和占比")]).startDate, "2026-10-24");
  const previous = get([first, message("那上上周呢？")]);
  assert.equal(previous.startDate, "2026-10-12");
  assert.equal(previous.endDate, "2026-10-18");
  assert.equal(planBrandReport([message("天猫店各品牌销售金额占比")], "2026-10-30"), undefined);
  assert.equal(planBrandReport([first, message("只看薇诺娜")], "2026-10-30"), undefined);
  assert.equal(planBrandReport([message("各品牌销售额占比，不包括赠品")], "2026-10-30"), undefined);
  assert.equal(planBrandReport([message("按月统计公司各个品牌销售额占比")], "2026-10-30"), undefined);
  assert.equal(planBrandReport([first, message("删除所有数据")], "2026-10-30"), undefined);
});

test("executor discovers optional covering indexes once and never changes tenant bindings or unrelated SQL", async () => {
  const calls: Array<{ sql: string; values: (string | number)[] }> = [];
  const run = createEnterpriseQueryExecutor(async (sql, values) => {
    calls.push({ sql, values });
    return sql.includes("information_schema") ? [{ indexName: "idx_wln_sale_enterprise_summary" }, { indexName: "idx_wln_items_enterprise_summary" }] : [];
  });
  const q = buildEnterpriseQuery("c1", "sales_summary", { startDate: "2026-10-01", endDate: "2026-10-30", groupBy: "brand" });
  await run(q.rows.sql, q.rows.values);
  await run(q.summary!.sql, q.summary!.values);
  assert.equal(calls.filter(c => c.sql.includes("information_schema")).length, 1);
  assert.match(calls[1].sql, /FORCE INDEX \(idx_wln_sale_enterprise_summary\)/);
  assert.match(calls[1].sql, /FORCE INDEX \(idx_wln_items_enterprise_summary\)/);
  assert.deepEqual(calls[1].values, q.rows.values);
  await run("SELECT x FROM other WHERE company_id=?", ["c2"]);
  assert.equal(calls.at(-1)!.sql, "SELECT x FROM other WHERE company_id=?");
});

test("sync success cannot hide failed business queries, including previously saved evidence", async () => {
  const r = await buildEnterpriseDataContext(base, {
    databaseReady: () => true,
    callModel: async () => ({ content: '{"calls":[{"tool":"source_status","params":{}},{"tool":"sales_summary","params":{"startDate":"2026-10-01","endDate":"2026-10-30","groupBy":"brand"}}]}' }),
    query: async sql => { if (sql.includes("data_sync_cursors")) return []; throw Object.assign(Error("private driver detail"), { code: "ER_QUERY_TIMEOUT" }); },
  });
  assert.equal(r.evidence.status, "unavailable");
  assert.match(r.evidence.sources[1].note, /数据查询阶段超时/);
  assert.doesNotMatch(r.context, /private driver detail/);
  assert.equal(enterpriseEvidenceStatus({ ...r.evidence, status: "queried" }), "unavailable");
  assert.equal(enterpriseEvidenceStatus({ ...r.evidence, sources: [...r.evidence.sources, { ...r.evidence.sources[1], status: "success" }] }), "partial");
});

test("deterministic brand report skips planner, retains actual record days, and rechecks access", async () => {
  let modelCalls = 0, checks = 0;
  const r = await buildEnterpriseDataContext({ ...base, messages: [{ role: "user", content: "公司各个品牌的销售额及销售额占比，2026-10-01 至 2026-10-30", createdAt: "2026-10-30" }], ensureAccess: async () => { checks++; } }, {
    databaseReady: () => true,
    callModel: async () => { modelCalls++; throw Error("planner unavailable"); },
    query: async sql => sql.includes("latestSyncedAt") ? [{ latestSyncedAt: "2026-10-30" }] : sql.includes("LIMIT") ? [{ dimension: "B", amount: "100", amountSharePercent: "100" }] : [{ currencyCode: "CNY", amount: "100", daysWithRecords: 29, firstRecordDate: "2026-10-01", lastRecordDate: "2026-10-29" }],
  });
  assert.equal(modelCalls, 0);
  assert.ok(checks >= 4);
  assert.equal(r.evidence.status, "queried");
  assert.equal(r.evidence.sources[0].coverage!.queriedDays, 30);
  assert.equal(r.evidence.sources[0].coverage!.recordsByCurrency[0].daysWithRecords, 29);
  assert.match(r.context, /默认人民币CNY/);
});

test("incident regression: yesterday resolves to Nov 4 and the three shares require both data tools", async () => {
  const content = "给我昨天所有品牌的销售额及销售占比，包括销售额占比和销售笔数占比和销售件数占比";
  const messages = [{ role: "user" as const, content, createdAt: "2026-11-05T04:06:57.634Z" }];
  const plan = planBrandReport(messages, "2026-11-05")!;
  assert.equal(plan.startDate, "2026-11-04"); assert.equal(plan.endDate, "2026-11-04");
  assert.deepEqual(plan.calls.map(call => call.tool), ["sales_summary", "sales_brand_documents"]);
  assert.deepEqual(new Set(plan.requestedMetrics), new Set(["amount", "amountSharePercent", "quantity", "quantitySharePercent", "documentCount", "documentSharePercent"]));
  let plannerCalls = 0;
  const result = await buildEnterpriseDataContext({ ...base, messages, referenceDate: new Date("2026-11-05T04:06:57.634Z") }, {
    databaseReady: () => true,
    callModel: async () => { plannerCalls++; throw Error("not needed"); },
    query: async sql => sql.includes("brand_documents") ? [{ dimension: "品牌A", currencyCode: "CNY", documentCount: 5, documentSharePercent: 100, totalDocumentCount: 5 }] : sql.includes("latestSyncedAt") ? [{ latestSyncedAt: "2026-11-05" }] : [{ dimension: "品牌A", currencyCode: "CNY", amount: "100", amountSharePercent: 100, quantity: 20, quantitySharePercent: 100 }],
  });
  assert.equal(plannerCalls, 0); assert.equal(result.evidence.status, "queried");
  assert.equal(result.evidence.sources.length, 2); assert.equal(result.evidence.task!.completed, true);
  assert.deepEqual(result.evidence.task!.missingMetrics, []);
  assert.match(result.context, /按品牌dimension和币种currencyCode关联/);
  assert.match(result.context, /documentSharePercent/);
  assert.ok(result.evidence.context!.sha256.length === 64);
  assert.ok(result.evidence.sources.every(source => source.querySteps!.every(step => step.status === "success")));
});

test("a missing secondary query keeps acquired values and marks the task partial", async () => {
  const result = await buildEnterpriseDataContext({ ...base, messages: [{ role: "user", content: "昨天所有品牌销售额、销售笔数及占比", createdAt: "now" }] }, {
    databaseReady: () => true,
    callModel: async () => { throw Error("not needed"); },
    query: async sql => {
      if (sql.includes("brand_documents")) throw Object.assign(Error("secret schema"), { code: "ER_QUERY_TIMEOUT" });
      return [{ dimension: "品牌A", amount: 100, amountSharePercent: 100 }];
    },
  });
  assert.equal(result.evidence.status, "partial"); assert.match(result.context, /"amount":100/);
  assert.deepEqual(result.evidence.task!.missingMetrics, ["documentCount", "documentSharePercent"]);
  assert.ok(!result.context.includes("secret schema"));
});

test("date interpretation includes single dates, today and the day before yesterday", () => {
  for (const [term, expected] of [["昨天", "2026-11-04"], ["昨日", "2026-11-04"], ["前天", "2026-11-03"], ["今天", "2026-11-05"], ["2026-10-01", "2026-10-01"]]) {
    const plan = planBrandReport([{ role: "user", content: `${term}所有品牌的销售额占比`, createdAt: "now" }], "2026-11-05")!;
    assert.equal(plan.startDate, expected); assert.equal(plan.endDate, expected);
  }
});


test("a successful summary does not prevent a second round for another fact", async () => {
  let rounds = 0;
  const result = await buildEnterpriseDataContext({ ...base, messages: [{ role: "user", content: "查看销售和库存", createdAt: "now" }] }, {
    databaseReady: () => true,
    callModel: async () => ({ content: JSON.stringify({ calls: ++rounds === 1 ? [{ tool: "sales_summary", params: { startDate: "2026-11-04", endDate: "2026-11-04", groupBy: "brand" } }] : [{ tool: "inventory", params: {} }] }) }),
    query: async () => [{ amount: 100, quantity: 5 }],
  });
  assert.equal(rounds, 2);
  assert.deepEqual(result.evidence.sources.map(source => source.tool), ["sales_summary", "inventory"]);
  assert.ok(result.evidence.sources.every(source => source.status === "success"));
});

const analysisQuestion = "结合以往你可以查看的所有数据，和我们知识库中关于公司的所有内容，对我们这一天的数据进行全方位多方面的梳理和分析，越详细越完整越好。";
const analysisHistory = [
  { role: "user" as const, content: "昨天所有品牌销售额、笔数、件数及占比", createdAt: "2026-11-13T00:00:00Z" },
  { role: "assistant" as const, content: "11月12日品牌表", createdAt: "2026-11-13T00:00:01Z", enterpriseData: { status: "queried" as const, notices: [], sources: [{ tool: "sales_summary", title: "销售", mode: "database" as const, filters: { startDate: "2026-11-12", endDate: "2026-11-12", groupBy: "brand", limit: 100, offset: 0 }, queriedAt: "now", returnedRows: 23, hasMore: false, status: "success" as const, note: "" }] } },
  { role: "user" as const, content: analysisQuestion, createdAt: "2026-11-13T01:00:00Z" },
];

test("incident follow-up uses the established day and seven prior days without yearly scans", async () => {
  const plan = planCompanyAnalysis(analysisHistory, "2026-11-14")!;
  assert.equal(plan.startDate, "2026-11-12");
  assert.equal(plan.calls.length, 7);
  assert.deepEqual(plan.calls[2].params, { startDate: "2026-11-05", endDate: "2026-11-11", groupBy: "day", limit: 100 });
  let planners = 0;
  const result = await buildEnterpriseDataContext({ ...base, messages: analysisHistory }, {
    databaseReady: () => true,
    callModel: async () => { planners++; throw Error("unexpected planner"); },
    query: async () => [{ amount: 100, amountSharePercent: 100, quantity: 10, quantitySharePercent: 100, documentCount: 5, documentSharePercent: 100 }],
  });
  assert.equal(planners, 0);
  assert.equal(result.evidence.sources.length, 7);
  assert.equal(result.evidence.task!.completed, true);
  assert.match(result.context, /目标日前7天/);
  const scoped = structuredClone(analysisHistory);
  scoped[1].enterpriseData!.sources[0].filters = { ...scoped[1].enterpriseData!.sources[0].filters, brands: ["品牌A"] } as any;
  assert.equal(planCompanyAnalysis(scoped), undefined);
  assert.equal(planCompanyAnalysis([{ ...analysisHistory[2], content: "对薇诺娜全面分析" }]), undefined);
  assert.equal(planCompanyAnalysis([...analysisHistory, { ...analysisHistory[2], content: "结合去年数据，对这一天全面分析" }]), undefined);
});

test("failed first page blocks subsequent offsets of the same normalized range", async () => {
  let queries = 0;
  const result = await buildEnterpriseDataContext(base, {
    databaseReady: () => true,
    callModel: async () => ({ content: JSON.stringify({ calls: [0, 100, 200].map(offset => ({ tool: "sales_summary", params: { startDate: "2025-11-13", endDate: "2026-11-12", groupBy: "day", limit: 100, offset } })) }) }),
    query: async () => { queries++; throw Object.assign(Error("timeout"), { code: "ER_QUERY_TIMEOUT" }); },
  });
  assert.equal(queries, 1);
  assert.equal(result.evidence.sources.length, 1);
  assert.match(result.evidence.notices.join(""), /停止同范围/);
});

test("successful grouped values survive a later total timeout", async () => {
  const result = await buildEnterpriseDataContext({ ...base, messages: [{ role: "user", content: "昨天所有品牌销售额占比", createdAt: "now" }] }, {
    databaseReady: () => true,
    query: async sql => {
      if (!sql.includes("LIMIT")) throw Object.assign(Error("timeout"), { code: "ER_QUERY_TIMEOUT" });
      return [{ dimension: "品牌A", amount: 100, amountSharePercent: 100 }];
    },
  });
  assert.equal(result.evidence.status, "partial");
  assert.equal(result.evidence.sources[0].status, "success");
  assert.equal(result.evidence.sources[0].partial, true);
  assert.equal(result.evidence.task!.completed, false);
  assert.match(result.context, /"amount":100/);
  assert.match(result.context, /已保留成功的分组数据/);
});

test("SQL execution is bounded by remaining data budget and stops before extra statements", async () => {
  let clock = 0, queries = 0;
  const result = await buildEnterpriseDataContext({ ...base, messages: [{ role: "user", content: "昨天所有品牌销售额占比", createdAt: "now" }], deadline: 60000 }, {
    now: () => clock,
    databaseReady: () => true,
    query: async sql => {
      queries++;
      assert.match(sql, /MAX_EXECUTION_TIME\(12000\)/);
      clock = 44500;
      return [{ amount: 100, amountSharePercent: 100 }];
    },
  });
  assert.equal(queries, 1);
  assert.equal(result.evidence.sources[0].failureReason, "budget");
  assert.equal(result.evidence.timing!.totalMs, 44500);
  assert.equal(result.evidence.timing!.budgetMs, 45000);
  assert.equal(result.evidence.status, "partial");
});

test("daily and shop aggregates omit an unused product join while brand filters keep it", () => {
  for (const groupBy of ["day", "shop"] as const) {
    const q = buildEnterpriseQuery("c1", "sales_summary", { startDate: "2026-11-05", endDate: "2026-11-11", groupBy });
    assert.doesNotMatch(q.rows.sql, /ods_wln_products/);
    assert.ok(q.rows.values.includes("c1"));
    const scoped = buildEnterpriseQuery("c1", "sales_summary", { ...q.params, brands: ["品牌A"] });
    assert.match(scoped.rows.sql, /ods_wln_products/);
    assert.ok(scoped.rows.values.includes("品牌A"));
  }
});
