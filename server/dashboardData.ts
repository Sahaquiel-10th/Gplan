import { query } from "./operationsData.js";
import { shiftDate } from "./operationsPolicy.js";
import type { DashboardView } from "./dashboardPreferences.js";
export const brandSql =
  "COALESCE(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p.raw_payload, '$.goods.brand_name')), ''), 'null'),'未标注品牌')";
export function dashboardTableQuery(
  companyId: string,
  date: string,
  view: DashboardView,
  page: number,
) {
  const search = view.search.replace(/[\\%_]/g, "\\$&");
  let sql = "",
    params: (string | number)[] = [];
  if (view.table === "lines") {
    sql = `SELECT ${brandSql} brand, COALESCE(i.sku_code,'') sku, COALESCE(i.goods_name,p.goods_name,i.sku_name,'') name, i.quantity quantity, i.gross_amount amount, i.cost_amount cost, h.bill_date billDate, h.outbound_no document, COALESCE(h.shop_name,h.shop_nick,h.shop_id) shop, h.outbound_uid _uid, i.line_key _line
  FROM ods_wln_sale_outbound h FORCE INDEX (idx_wln_sale_outbound_bill_date)
  STRAIGHT_JOIN ods_wln_sale_outbound_items i ON i.company_id=h.company_id AND i.outbound_uid=h.outbound_uid
  LEFT JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code
  WHERE h.company_id=? AND h.bill_date>=? AND h.bill_date<?`;
    params = [companyId, date, shiftDate(date, 1)];
  } else {
    // Master data drives the table so zero-sale products and brands are not dropped.
    sql = `SELECT ${brandSql} brand, p.sku_code sku, COALESCE(p.goods_name,p.spec_name,p.sku_code) name,
  COALESCE(s.quantity,0) quantity, COALESCE(s.amount,0) amount, CASE WHEN s.missingCost>0 THEN NULL ELSE COALESCE(s.cost,0) END cost, COALESCE(s.orders,0) orders
  FROM ods_wln_products p LEFT JOIN (
    SELECT i.sku_code, SUM(i.quantity) quantity, SUM(i.gross_amount) amount, SUM(i.cost_amount) cost, SUM(i.cost_amount IS NULL) missingCost, COUNT(DISTINCT h.outbound_uid) orders
    FROM ods_wln_sale_outbound h FORCE INDEX (idx_wln_sale_outbound_bill_date)
    STRAIGHT_JOIN ods_wln_sale_outbound_items i ON i.company_id=h.company_id AND i.outbound_uid=h.outbound_uid
    WHERE h.company_id=? AND h.bill_date>=? AND h.bill_date<? GROUP BY i.sku_code
  ) s ON s.sku_code=p.sku_code WHERE p.company_id=?`;
    params = [companyId, date, shiftDate(date, 1), companyId];
  }
  if (view.brand) {
    sql += ` AND ${brandSql}=?`;
    params.push(view.brand);
  }
  if (view.search) {
    sql +=
      view.table === "lines"
        ? ` AND (i.sku_code LIKE ? OR COALESCE(i.goods_name,p.goods_name,i.sku_name,'') LIKE ? OR h.outbound_no LIKE ?)`
        : ` AND (p.sku_code LIKE ? OR COALESCE(p.goods_name,p.spec_name,'') LIKE ? OR ${brandSql} LIKE ?)`;
    params.push("%" + search + "%", "%" + search + "%", "%" + search + "%");
  }
  if (view.table === "brands")
    sql = `SELECT brand,COUNT(*) products,SUM(quantity) quantity,SUM(amount) amount,CASE WHEN SUM(cost IS NULL)>0 THEN NULL ELSE SUM(cost) END cost FROM (${sql}) base GROUP BY brand`;
  const allowed =
    view.table === "lines"
      ? [
          "brand",
          "sku",
          "name",
          "quantity",
          "amount",
          "cost",
          "billDate",
          "document",
          "shop",
        ]
      : view.table === "brands"
        ? ["brand", "quantity", "amount", "cost"]
        : ["brand", "sku", "name", "quantity", "amount", "cost", "orders"];
  const sort = allowed.includes(view.sort) ? view.sort : "amount";
  const ties =
    view.table === "lines"
      ? "_uid, _line"
      : view.table === "brands"
        ? "brand"
        : "sku";
  return {
    sql: `SELECT /*+ MAX_EXECUTION_TIME(20000) */ * FROM (${sql}) result ORDER BY \`${sort}\` ${view.direction === "asc" ? "ASC" : "DESC"}, ${ties} LIMIT ${view.pageSize + 1} OFFSET ${(page - 1) * view.pageSize}`,
    params,
    sort,
  };
}
export async function dashboardTable(
  companyId: string,
  date: string,
  view: DashboardView,
  page: number,
) {
  const plan = dashboardTableQuery(companyId, date, view, page);
  const rows = await query(plan.sql, plan.params);
  return {
    rows: rows.slice(0, view.pageSize).map(({ _uid, _line, ...r }) => r),
    hasMore: rows.length > view.pageSize,
    page,
    pageSize: view.pageSize,
    sort: plan.sort,
    date,
    note:
      view.table === "lines"
        ? "销售出库单明细，按出库日期统计，金额来自明细销售金额；成本缺失不补零。"
        : "按商品主数据列出全部品牌／SKU，包含当日零销售商品；金额与数量为当日出库汇总。无商品主数据映射的明细请查看出库原始明细表；商品成本缺失显示空值。",
  };
}
