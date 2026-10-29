import test from "node:test";
import assert from "node:assert/strict";
import { buildEnterpriseQuery, enterpriseTools, normalizeDataQuery, shanghaiDate } from "./enterpriseDataQueries.js";
import { assertEnterpriseAdmin, canReadEnterpriseConversation } from "./enterpriseDataPolicy.js";
import type { Conversation, ModelConfig, User } from "./types.js";

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
