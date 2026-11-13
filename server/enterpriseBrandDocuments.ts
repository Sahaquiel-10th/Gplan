import type { DataQueryParams, EnterpriseQuery } from "./enterpriseDataQueries.js";

// Brand document counts cannot be added across SKUs: one document may contain
// several SKUs of the same brand, or products from several brands.
export function buildBrandDocumentQuery(companyId: string, p: DataQueryParams): EnterpriseQuery {
  const values: (string | number)[] = [companyId, p.startDate! + " 00:00:00", new Date(Date.parse(p.endDate! + "T00:00:00Z") + 86400000).toISOString().slice(0, 10) + " 00:00:00", companyId];
  const filters: string[] = [];
  for (const [column, items] of [["h.shop_id", p.shopIds], ["h.storage_code", p.warehouseIds], ["i.sku_code", p.skuCodes], ["p.brandName", p.brands]] as const) {
    if (items?.length) { filters.push(`${column} IN (${items.map(() => "?").join(",")})`); values.push(...items); }
  }
  if (p.search) {
    const columns = ["i.sku_code", "i.goods_name", "p.goods_name", "p.brandName", "h.outbound_no", "h.shop_name", "h.shop_nick", "h.storage_name"];
    filters.push("(" + columns.map(column => `LOCATE(?,COALESCE(${column},''))>0`).join(" OR ") + ")");
    values.push(...columns.map(() => p.search!));
  }
  // CTE placeholder order is products/company first, then the header filters.
  const bound = [values[3], ...values.slice(0, 3), ...values.slice(4)];
  const cte = `WITH brand_documents AS (
    SELECT h.outbound_uid documentId,p.brandName dimension,COALESCE(NULLIF(TRIM(h.currency_code),''),'CNY') currencyCode
    FROM ods_wln_sale_outbound h FORCE INDEX (idx_wln_sale_outbound_bill_date)
    STRAIGHT_JOIN ods_wln_sale_outbound_items i ON i.company_id=h.company_id AND i.outbound_uid=h.outbound_uid
    LEFT JOIN (SELECT sku_code,${p.search ? "goods_name," : ""}NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(raw_payload,'$.goods.brand_name')),''),'null') brandName
      FROM ods_wln_products WHERE company_id=? LIMIT 18446744073709551615) p ON p.sku_code=i.sku_code
    WHERE h.company_id=? AND h.bill_date>=? AND h.bill_date<? ${filters.length ? "AND " + filters.join(" AND ") : ""}
    GROUP BY h.outbound_uid,p.brandName,COALESCE(NULLIF(TRIM(h.currency_code),''),'CNY')
  ), ranked_documents AS (
    SELECT documentId,dimension,currencyCode,
      CASE WHEN ROW_NUMBER() OVER (PARTITION BY currencyCode,documentId ORDER BY dimension)=1 THEN 1 ELSE 0 END firstDocument
    FROM brand_documents
  )`;
  return {
    tool: "sales_brand_documents", params: p,
    rows: { sql: `SELECT /*+ MAX_EXECUTION_TIME(40000) */ /* enterprise-sales */ report.* FROM (${cte}
      SELECT b.dimension,MAX(b.dimension) name,b.currencyCode,
      COUNT(*) documentCount,SUM(SUM(b.firstDocument)) OVER (PARTITION BY b.currencyCode) totalDocumentCount,
      SUM(COUNT(*)) OVER (PARTITION BY b.currencyCode) brandDocumentOccurrences,
      ROUND(COUNT(*)*100.0/NULLIF(SUM(SUM(b.firstDocument)) OVER (PARTITION BY b.currencyCode),0),4) documentSharePercent
      FROM ranked_documents b
      GROUP BY b.dimension,b.currencyCode) report
      ORDER BY documentCount DESC,dimension,currencyCode LIMIT ${p.limit + 1} OFFSET ${p.offset}`,
      values: bound },
    note: "销售笔数按ERP销售出库单据ID去重，不等于平台成交订单数。每个品牌在同一出库单中只计1笔；跨品牌单据会分别计入相关品牌。totalDocumentCount是分页前同范围、同币种的去重出库单总数，不是当前页合计。笔数占比以它为分母，因此跨品牌单据存在时，各品牌笔数占比之和可能超过100%。不得以商品明细行数替代笔数。",
  };
}
