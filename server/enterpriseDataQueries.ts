// Only the server builds SQL. Model output supplies validated business parameters.
export const enterpriseTools = {
  source_status: "万里牛各资源同步状态",
  shops: "店铺目录",
  warehouses: "当前库存仓库编码目录（不含名称与无库存历史仓库）",
  products: "商品与 SKU 资料",
  inventory: "当前分仓库存",
  sales_summary: "销售出库汇总与排行",
  sales_details: "销售出库明细",
  inbound_summary: "采购入库汇总与排行",
  inbound_details: "采购入库明细（含供应商、批次、效期）",
} as const;
export type EnterpriseTool = keyof typeof enterpriseTools;
export type DataQueryParams = {
  startDate?: string;
  endDate?: string;
  shopIds?: string[];
  warehouseIds?: string[];
  skuCodes?: string[];
  brands?: string[];
  search?: string;
  groupBy?: "day" | "shop" | "product" | "warehouse" | "supplier" | "brand";
  limit: number;
  offset: number;
};
export type SqlStatement = { sql: string; values: (string | number)[] };
export type EnterpriseQuery = {
  tool: EnterpriseTool;
  params: DataQueryParams;
  rows: SqlStatement;
  summary?: SqlStatement;
  freshness?: SqlStatement;
  note: string;
};

export class EnterpriseQueryValidationError extends Error {}

const brandSql = "NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p.raw_payload, '$.goods.brand_name')), ''), 'null')";
const allowedKeys = new Set(["startDate", "endDate", "shopIds", "warehouseIds", "skuCodes", "brands", "search", "groupBy", "limit", "offset"]);
function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00+08:00`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function nextDay(value: string) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}
export function normalizeDataQuery(tool: string, input: unknown): { tool: EnterpriseTool; params: DataQueryParams } {
  if (!Object.hasOwn(enterpriseTools, tool)) throw new EnterpriseQueryValidationError("未开放的数据查询能力");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new EnterpriseQueryValidationError("查询参数须为对象");
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some(k => !allowedKeys.has(k))) throw new EnterpriseQueryValidationError("查询包含未允许的参数");
  if (tool === "source_status" && Object.keys(v).length) throw new EnterpriseQueryValidationError("同步状态查询不支持筛选参数");
  const p: DataQueryParams = { limit: 50, offset: 0 };
  for (const key of ["limit", "offset"] as const) {
    if (v[key] !== undefined) {
      if (!Number.isInteger(v[key]) || Number(v[key]) < (key === "limit" ? 1 : 0) || Number(v[key]) > (key === "limit" ? 100 : 10000)) throw new EnterpriseQueryValidationError("分页参数超出允许范围");
      p[key] = Number(v[key]);
    }
  }
  for (const key of ["shopIds", "warehouseIds", "skuCodes", "brands"] as const) {
    const value = v[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > 50 || value.some(x => typeof x !== "string" || !x.trim() || x.length > 128)) throw new EnterpriseQueryValidationError("数据筛选条件无效");
    p[key] = [...new Set(value.map(x => x.trim()))];
  }
  if (v.search !== undefined) {
    if (typeof v.search !== "string" || v.search.length > 100) throw new EnterpriseQueryValidationError("搜索词最多100字");
    p.search = v.search.trim();
  }
  if (v.groupBy !== undefined) {
    const choices = tool.startsWith("sales_") ? ["day", "shop", "product", "warehouse", "brand"] : tool.startsWith("inbound_") ? ["day", "product", "warehouse", "supplier", "brand"] : [];
    if (!choices.includes(String(v.groupBy)) || !tool.endsWith("_summary")) throw new EnterpriseQueryValidationError("该查询不支持此汇总维度");
    p.groupBy = v.groupBy as DataQueryParams["groupBy"];
  }
  if (tool.startsWith("sales_") || tool.startsWith("inbound_")) {
    if (!validDate(v.startDate) || !validDate(v.endDate) || v.startDate > v.endDate) throw new EnterpriseQueryValidationError("出入库查询需要有效的起止日期");
    if ((Date.parse(v.endDate) - Date.parse(v.startDate)) / 86400000 > 365) throw new EnterpriseQueryValidationError("单次出入库查询最多366天，请缩小时间范围");
    p.startDate = v.startDate;
    p.endDate = v.endDate;
  } else if (v.startDate !== undefined || v.endDate !== undefined) {
    throw new EnterpriseQueryValidationError(tool === "inventory" ? "当前库存不支持历史日期查询" : "该查询不支持日期筛选");
  }
  // Reject unsupported filters rather than silently returning a wider scope.
  if (p.shopIds?.length && !["shops", "sales_summary", "sales_details"].includes(tool)) throw new EnterpriseQueryValidationError("此数据按仓库或商品组织，不能按店铺筛选");
  if (p.warehouseIds?.length && ["shops", "products", "source_status"].includes(tool)) throw new EnterpriseQueryValidationError("该查询不支持仓库筛选");
  if ((p.skuCodes?.length || p.brands?.length) && ["shops", "warehouses", "source_status"].includes(tool)) throw new EnterpriseQueryValidationError("该查询不支持商品筛选");
  if (tool === "source_status" && p.search) throw new EnterpriseQueryValidationError("同步状态不支持搜索词");
  return { tool: tool as EnterpriseTool, params: p };
}

export function buildEnterpriseQuery(companyId: string, toolName: string, input: unknown): EnterpriseQuery {
  if (!companyId) throw new EnterpriseQueryValidationError("企业范围不能为空");
  const { tool, params: p } = normalizeDataQuery(toolName, input);
  const values: (string | number)[] = [companyId];
  const where: string[] = [];
  const inFilter = (column: string, list?: string[]) => {
    if (list?.length) { where.push(`${column} IN (${list.map(() => "?").join(",")})`); values.push(...list); }
  };
  const search = (columns: string[]) => {
    if (!p.search) return;
    where.push(`(${columns.map(column => `LOCATE(?, COALESCE(${column},'')) > 0`).join(" OR ")})`);
    values.push(...columns.map(() => p.search!));
  };
  const sql = (select: string, from: string, suffix = ""): SqlStatement => ({
    sql: `SELECT /*+ MAX_EXECUTION_TIME(12000) */ ${select} FROM ${from} WHERE ${where.join(" AND ")} ${suffix}`,
    values: [...values],
  });
  const page = (order: string) => `ORDER BY ${order} LIMIT ${p.limit + 1} OFFSET ${p.offset}`;
  const freshness = (alias: string, from: string): SqlStatement => sql(`MIN(${alias}.ingested_at) oldestSyncedAt, MAX(${alias}.ingested_at) latestSyncedAt`, from);
  let result: EnterpriseQuery;
  if (tool === "source_status") {
    // Cursors belong to the configured connector company, not every tenant.
    // Read the five bounded cursor rows instead of scanning historical ODS tables.
    const connectorCompanyId = process.env.WANLINIU_COMPANY_ID?.trim() || "company_default";
    result = { tool, params: p, rows: {
      sql: `SELECT /*+ MAX_EXECUTION_TIME(12000) */ c.resource_name resource,
        DATE_FORMAT(c.last_success_at,'%Y-%m-%d %H:%i:%s') lastSuccessAt,
        JSON_UNQUOTE(JSON_EXTRACT(c.cursor_json,'$.modifiedThrough')) modifiedThrough
        FROM data_sync_cursors c JOIN (SELECT ? company_id) tenant_scope ON tenant_scope.company_id=?
        WHERE c.connector_id='wanliniu' AND c.resource_name IN ('shops','products','inventory','sale_outbound','purchase_inbound')
        ORDER BY c.resource_name LIMIT 5`,
      values: [companyId, connectorCompanyId],
    }, note: "各资源最后一次成功同步的时间，仅当前万里牛连接器所属企业可见；不代表上游数据实时状态。" };
  } else if (tool === "warehouses") {
    where.push("w.company_id=?", "w.storage_code IS NOT NULL");
    inFilter("w.storage_code", p.warehouseIds);
    search(["w.storage_code"]);
    const from = "ods_wln_inventory_current w";
    result = { tool, params: p, rows: sql("w.storage_code warehouseId, NULL warehouseName, MAX(w.snapshot_at) snapshotAt", from, "GROUP BY w.storage_code " + page("w.storage_code")), summary: sql("COUNT(DISTINCT w.storage_code) totalRows", from), note: "仅列出当前库存记录覆盖的仓库编码。名称及没有当前库存记录的历史仓库不在此目录中；需要这些信息时须通过现有万里牛实时只读接口核实，不能猜测名称。" };
  } else if (tool === "shops") {
    where.push("s.company_id=?");
    inFilter("s.shop_uid", p.shopIds);
    search(["s.shop_uid", "s.shop_name", "s.shop_nick"]);
    const from = "ods_wln_shops s";
    result = { tool, params: p, rows: sql("s.shop_uid shopId, s.shop_name shopName, s.shop_nick shopNick, s.shop_type shopType, s.status, s.ingested_at syncedAt", from, page("s.shop_uid")), summary: sql("COUNT(*) totalRows", from), note: "店铺主数据；shopId 可用于后续销售出库查询。" };
  } else if (tool === "products" || tool === "inventory") {
    const inventory = tool === "inventory";
    const alias = inventory ? "i" : "p";
    where.push(`${alias}.company_id=?`);
    inFilter(`${alias}.sku_code`, p.skuCodes);
    inFilter(brandSql, p.brands);
    if (inventory) inFilter("i.storage_code", p.warehouseIds);
    search([`${alias}.sku_code`, "p.goods_name", "p.goods_code", "p.spec_name", "p.bar_code", brandSql, ...(inventory ? ["i.storage_code"] : [])]);
    const from = inventory ? "ods_wln_inventory_current i LEFT JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code" : "ods_wln_products p";
    const select = inventory
      ? `i.storage_code warehouseId, i.sku_code skuCode, COALESCE(p.goods_name,i.spec_name) productName, ${brandSql} brand, i.actual_quantity actualQuantity, i.locked_quantity lockedQuantity, (i.actual_quantity-i.locked_quantity) availableQuantity, i.in_transit_quantity inTransitQuantity, i.defect_quantity defectQuantity, i.total_cost totalCost, i.snapshot_at snapshotAt`
      : `p.sku_code skuCode, p.goods_code goodsCode, p.goods_name productName, p.spec_name specification, p.bar_code barCode, ${brandSql} brand, p.status, p.ingested_at syncedAt`;
    const totals = inventory ? "COUNT(*) totalRows, COUNT(DISTINCT i.sku_code) skuCount, COUNT(DISTINCT i.storage_code) warehouseCount, SUM(i.actual_quantity) actualQuantity, SUM(i.locked_quantity) lockedQuantity, SUM(i.actual_quantity-i.locked_quantity) availableQuantity, SUM(i.in_transit_quantity) inTransitQuantity, MIN(i.snapshot_at) oldestSnapshotAt, MAX(i.snapshot_at) latestSnapshotAt" : "COUNT(*) totalRows";
    result = { tool, params: p, rows: sql(select, from, page(inventory ? "availableQuantity DESC, i.storage_code, i.sku_code" : "p.sku_code")), summary: sql(totals, from), freshness: freshness(alias, from), note: inventory ? "当前仓库+SKU库存快照，非历史库存。可用库存=实际-锁定；店铺共用仓库不得重复计算。汇总覆盖全部匹配行，明细可能分页。" : "商品与SKU主数据；品牌仅取源数据明确提供的值，缺失时不猜测。" };
  } else {
    const sales = tool.startsWith("sales_");
    const details = tool.endsWith("_details");
    const header = sales ? "ods_wln_sale_outbound" : "ods_wln_purchase_inbound";
    const items = sales ? "ods_wln_sale_outbound_items" : "ods_wln_purchase_inbound_items";
    const id = sales ? "outbound_uid" : "stock_code";
    where.push("h.company_id=?", "h.bill_date>=?", "h.bill_date<?");
    values.push(`${p.startDate} 00:00:00`, `${nextDay(p.endDate!)} 00:00:00`);
    inFilter("h.storage_code", p.warehouseIds);
    if (sales) inFilter("h.shop_id", p.shopIds);
    inFilter("i.sku_code", p.skuCodes);
    inFilter(brandSql, p.brands);
    search(["i.sku_code", "i.goods_name", "p.goods_name", brandSql, sales ? "h.outbound_no" : "h.stock_code", sales ? "h.shop_name" : "h.supplier_name", ...(sales ? ["h.shop_nick"] : []), "h.storage_name"]);
    const from = `${header} h JOIN ${items} i ON i.company_id=h.company_id AND i.${id}=h.${id} LEFT JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code`;
    const amount = sales ? "i.gross_amount" : "i.total_amount";
    const totals = `COUNT(*) matchedLines, COUNT(DISTINCT h.${id}) documentCount, SUM(i.quantity) quantity, CASE WHEN SUM(${amount} IS NULL)>0 THEN NULL ELSE SUM(${amount}) END amount, SUM(${amount} IS NULL) missingAmountLines${sales ? ", CASE WHEN SUM(i.cost_amount IS NULL)>0 THEN NULL ELSE SUM(i.cost_amount) END cost, SUM(i.cost_amount IS NULL) missingCostLines" : ""}`;
    let select: string, suffix: string;
    if (details) {
      select = `h.${id} documentId, h.bill_date billDate, h.storage_code warehouseId, h.storage_name warehouseName, i.sku_code skuCode, COALESCE(i.goods_name,p.goods_name) productName, ${brandSql} brand, i.quantity, ${amount} amount, h.currency_code currencyCode, ${sales ? "h.outbound_no documentNo, h.shop_id shopId, h.shop_name shopName, h.bill_type billType, i.actual_paid_amount actualPaidAmount, i.cost_amount cost" : "h.supplier_code supplierCode, h.supplier_name supplierName, i.batch_code batchCode, i.production_date productionDate, i.expiry_date expiryDate"}`;
      suffix = page(`h.bill_date DESC, h.${id}, i.${sales ? "line_key" : "line_no"}`);
    } else {
      const group = p.groupBy || "day";
      const dimensions: Record<string, string> = {
        day: "DATE_FORMAT(h.bill_date,'%Y-%m-%d')",
        shop: "h.shop_id",
        product: "i.sku_code",
        warehouse: "h.storage_code",
        supplier: "h.supplier_code",
        brand: brandSql,
      };
      const names: Record<string, string> = { day: dimensions.day, shop: "h.shop_name", product: "COALESCE(i.goods_name,p.goods_name)", warehouse: "h.storage_name", supplier: "h.supplier_name", brand: brandSql };
      select = `${dimensions[group]} dimension, MAX(${names[group]}) name, COALESCE(NULLIF(h.currency_code,''),'UNKNOWN') currencyCode, ${totals}`;
      // Currency is always a separate group; totals never mix currencies into one amount.
      suffix = `GROUP BY ${dimensions[group]}, COALESCE(NULLIF(h.currency_code,''),'UNKNOWN') ${page("amount DESC, dimension, currencyCode")}`;
    }
    const summary = sql(`COALESCE(NULLIF(h.currency_code,''),'UNKNOWN') currencyCode, ${totals}`, from, "GROUP BY COALESCE(NULLIF(h.currency_code,''),'UNKNOWN')");
    result = { tool, params: p, rows: sql(select, from, suffix), summary, freshness: freshness("h", from), note: `${sales ? "销售出库单明细口径，不等于平台成交订单、净销售额或到账金额；单据数不是平台订单数。成本只反映源明细成本，不含其他费用，不能直接认定净利润。" : "仅采购入库，不默认包含销售退货、调拨或其他入库。"} 日期均为北京时间，含起止日。金额按币种分别统计，UNKNOWN表示源币种缺失，不能直接当人民币。汇总覆盖全部匹配明细，返回行可能分页；缺金额或成本保留null。按源单据类型原样统计，未自动排除红冲或其他特殊类型。` };
  }
  return result;
}
