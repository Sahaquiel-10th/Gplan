import type { ManagementBriefDefinition, ManagementBriefDimensionId } from "./types.js";

export type ManagementBriefDimension = {
  id: ManagementBriefDimensionId;
  name: string;
  description: string;
  fields: string[];
};

export const managementBriefDimensions: ManagementBriefDimension[] = [
  {
    id: "sales_overview",
    name: "整体销售概览",
    description: "看企业整体经营结果。",
    fields: ["GMV", "实付金额", "订单数", "销售件数", "客单价"]
  },
  {
    id: "shop_performance",
    name: "店铺经营表现",
    description: "按店铺、平台和仓库拆分销售表现。",
    fields: ["店铺名称", "平台", "仓库", "GMV", "订单数", "销售件数"]
  },
  {
    id: "product_performance",
    name: "商品销售表现",
    description: "识别畅销、下滑和异常商品。",
    fields: ["产品编码", "产品名称", "销量", "GMV", "销售单价", "成本金额"]
  },
  {
    id: "inventory_status",
    name: "库存与库存风险",
    description: "查看当前库存结构及潜在积压、缺货风险。",
    fields: ["仓库", "产品编码", "产品名称", "实际库存", "锁定库存", "在途库存", "残次品", "库存成本"]
  },
  {
    id: "purchase_inbound",
    name: "采购入库情况",
    description: "查看采购到货、供应商和入库商品情况。",
    fields: ["入库时间", "仓库", "供应商", "产品编码", "产品名称", "入库数量", "入库金额"]
  },
  {
    id: "period_comparison",
    name: "历史趋势对比",
    description: "把目标日与近 7 天、近 30 天基准进行比较。",
    fields: ["日环比", "近 7 天日均", "近 30 天日均", "趋势变化", "异常偏离"]
  },
  {
    id: "data_quality",
    name: "数据完整性",
    description: "让简报说明同步进度、缺失或异常，避免把不完整数据当成经营结论。",
    fields: ["同步完成时间", "覆盖日期", "各资源记录数", "同步错误", "完整性提示"]
  }
];

const systemCreatedAt = "2026-09-03T00:00:00.000Z";

export function defaultManagementBriefDefinitions(companyId = "company_default"): ManagementBriefDefinition[] {
  return [
    {
      id: "brief_system_daily_operations",
      companyId,
      source: "system",
      name: "每日经营简报",
      description: "面向管理层概括昨日经营结果、趋势和最需要关注的问题。",
      dimensionIds: ["sales_overview", "shop_performance", "period_comparison", "data_quality"],
      prompt: "请用管理者语言总结昨日整体经营结果，并与近 7 天、近 30 天日均比较。先给一句话结论，再列出增长点、下滑点、异常与建议动作。所有判断必须引用已提供的数据；数据不完整时明确说明，不要猜测原因。",
      enabled: true,
      createdAt: systemCreatedAt,
      updatedAt: systemCreatedAt
    },
    {
      id: "brief_system_shop_performance",
      companyId,
      source: "system",
      name: "店铺经营简报",
      description: "比较各店铺的表现，帮助管理层快速定位亮点和落后项。",
      dimensionIds: ["shop_performance", "product_performance", "period_comparison", "data_quality"],
      prompt: "请比较各店铺昨日表现及其近 30 天基准。指出表现最好、改善最快、下滑明显和数据异常的店铺，并说明由哪些销售或商品数据支持。建议必须具体到店铺；无法由数据证明的原因只列为待核查项。",
      enabled: true,
      createdAt: systemCreatedAt,
      updatedAt: systemCreatedAt
    },
    {
      id: "brief_system_product_inventory",
      companyId,
      source: "system",
      name: "商品与库存风险简报",
      description: "结合销售、库存和入库识别缺货、积压与补货风险。",
      dimensionIds: ["product_performance", "inventory_status", "purchase_inbound", "period_comparison", "data_quality"],
      prompt: "请结合昨日商品销售、当前库存、近期采购入库和近 30 天趋势，识别畅销、滞销、缺货与积压风险。按风险优先级输出需要补货、促销、暂停采购或人工复核的商品，并列出支撑数据。不要在缺少销量或库存依据时自行推断。",
      enabled: true,
      createdAt: systemCreatedAt,
      updatedAt: systemCreatedAt
    }
  ];
}

export function normalizeManagementBriefDimensionIds(value: unknown): ManagementBriefDimensionId[] {
  if (!Array.isArray(value)) throw new Error("请至少选择一个数据维度");
  const allowed = new Set(managementBriefDimensions.map((item) => item.id));
  const normalized = value
    .filter((item): item is ManagementBriefDimensionId => typeof item === "string" && allowed.has(item as ManagementBriefDimensionId));
  const unique = [...new Set(normalized)];
  if (!unique.length) throw new Error("请至少选择一个有效的数据维度");
  if (unique.length > managementBriefDimensions.length) throw new Error("数据维度数量无效");
  return unique;
}
