import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDashboardView,
  defaultDashboardView,
} from "./dashboardPreferences.js";
import { dashboardTableQuery } from "./dashboardData.js";
test("presets validate dimensions and cannot introduce arbitrary sort SQL or excessive pages", () => {
  const normalized = normalizeDashboardView({
    ...defaultDashboardView,
    widgets: ["raw", "raw"],
  });
  assert.deepEqual(normalized.widgets, ["raw"]);
  assert.throws(
    () =>
      normalizeDashboardView({
        ...defaultDashboardView,
        sort: "amount;DROP TABLE x",
      }),
    /排序/,
  );
  assert.throws(
    () =>
      normalizeDashboardView({ ...defaultDashboardView, widgets: ["secrets"] }),
    /维度/,
  );
  assert.throws(
    () => normalizeDashboardView({ ...defaultDashboardView, pageSize: 100000 }),
    /每页/,
  );
});
test("raw tables use tenant predicates, parameterized filters, all master products and stable server pagination", () => {
  for (const table of ["products", "brands", "lines"] as const) {
    const q = dashboardTableQuery(
      "company-test",
      "2026-09-20",
      {
        ...defaultDashboardView,
        table,
        brand: "brand' OR 1=1 --",
        search: "sku_%",
        pageSize: 20,
      },
      3,
    );
    assert.ok(q.params.includes("company-test"));
    assert.ok(q.params.includes("brand' OR 1=1 --"));
    assert.ok(!q.sql.includes("brand' OR"));
    assert.match(q.sql, /LIMIT 21 OFFSET 40/);
    assert.match(q.sql, /company_id=\?/);
    if (table !== "lines")
      assert.match(q.sql, /FROM ods_wln_products p LEFT JOIN/);
  }
});
