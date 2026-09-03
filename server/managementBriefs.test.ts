import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultManagementBriefDefinitions,
  managementBriefDimensions,
  normalizeManagementBriefDimensionIds
} from "./managementBriefs.js";

test("系统预设简报固定为只读来源并覆盖核心经营场景", () => {
  const definitions = defaultManagementBriefDefinitions("company_test");
  assert.equal(definitions.length, 3);
  assert.ok(definitions.every((item) => item.companyId === "company_test"));
  assert.ok(definitions.every((item) => item.source === "system" && item.enabled));
  assert.deepEqual(definitions.map((item) => item.name), ["每日经营简报", "店铺经营简报", "商品与库存风险简报"]);
});

test("管理员选择的数据维度会去重且只接受目录内维度", () => {
  assert.deepEqual(
    normalizeManagementBriefDimensionIds(["sales_overview", "shop_performance", "sales_overview", "unknown"]),
    ["sales_overview", "shop_performance"]
  );
  assert.throws(() => normalizeManagementBriefDimensionIds([]), /至少选择一个/);
  assert.equal(managementBriefDimensions.length, 7);
});
