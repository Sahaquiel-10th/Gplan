// Read-only MySQL contract check. Uses inline synthetic rows, never inserts or
// changes ERP data. Run in an authorized data-database environment with tsx.
import "dotenv/config";
import assert from "node:assert/strict";
import { buildEnterpriseQuery } from "../server/enterpriseDataQueries.js";
import { query } from "../server/operationsData.js";

const headers = `(SELECT 'fixture' company_id,'d1' outbound_uid,'2026-11-04 00:00:00' bill_date,NULL currency_code
 UNION ALL SELECT 'fixture','d2','2026-11-04 12:00:00','CNY'
 UNION ALL SELECT 'fixture','d3','2026-11-04 12:00:00','USD'
 UNION ALL SELECT 'foreign','dx','2026-11-04 12:00:00','CNY') h`;
const items = `(SELECT 'fixture' company_id,'d1' outbound_uid,'a1' sku_code
 UNION ALL SELECT 'fixture','d1','a2' UNION ALL SELECT 'fixture','d2','a1'
 UNION ALL SELECT 'fixture','d2','b1' UNION ALL SELECT 'fixture','d3','a1'
 UNION ALL SELECT 'foreign','dx','a1') i`;
const products = `(SELECT 'fixture' company_id,'a1' sku_code,JSON_OBJECT('goods',JSON_OBJECT('brand_name','A')) raw_payload
 UNION ALL SELECT 'fixture','a2',JSON_OBJECT('goods',JSON_OBJECT('brand_name','A'))
 UNION ALL SELECT 'fixture','b1',JSON_OBJECT('goods',JSON_OBJECT('brand_name','B'))
 UNION ALL SELECT 'foreign','a1',JSON_OBJECT('goods',JSON_OBJECT('brand_name','Foreign'))) products_fixture`;
const params = { startDate: "2026-11-04", endDate: "2026-11-04", limit: 100 };
async function execute(limit: number) {
  const compiled = buildEnterpriseQuery("fixture", "sales_brand_documents", { ...params, limit });
  const sql = compiled.rows.sql
    .replace("ods_wln_sale_outbound h FORCE INDEX (idx_wln_sale_outbound_bill_date)", headers)
    .replace("ods_wln_sale_outbound_items i ON", items + " ON")
    .replace("ods_wln_products WHERE", products + " WHERE");
  return query(sql, compiled.rows.values);
}
const all = await execute(100);
assert.equal(all.length, 3);
const a = all.find(row => row.dimension === "A" && row.currencyCode === "CNY")!;
const b = all.find(row => row.dimension === "B" && row.currencyCode === "CNY")!;
assert.equal(Number(a.documentCount), 2); assert.equal(Number(a.totalDocumentCount), 2);
assert.equal(Number(a.brandDocumentOccurrences), 3); assert.equal(Number(a.documentSharePercent), 100);
assert.equal(Number(b.documentCount), 1); assert.equal(Number(b.documentSharePercent), 50);
assert.equal(Number(all.find(row => row.currencyCode === "USD")!.documentCount), 1);
const page = await execute(1);
assert.equal(Number(page[0].totalDocumentCount), 2);
assert.equal(Number(page[0].documentSharePercent), 100);
console.log(JSON.stringify({ brandDocumentSemantics: "passed", sameBrandSkusDeduplicated: true, mixedBrandDocumentsCountedOncePerBrand: true, currenciesSeparate: true, tenantIsolated: true, denominatorBeforePagination: true }));
process.exit(0);
