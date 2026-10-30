import "dotenv/config";
import mysql from "mysql2/promise";

const env = process.env;
if ((env.DATA_DB_PROVIDER || (env.DB_PROVIDER === "mysql" ? "mysql" : "disabled")) !== "mysql") {
  console.log("Enterprise indexes: data database disabled, skipped");
  process.exit(0);
}
const connection = await mysql.createConnection({
  host: env.DATA_MYSQL_HOST || env.MYSQL_HOST,
  port: Number(env.DATA_MYSQL_PORT || env.MYSQL_PORT || 3306),
  user: env.DATA_MYSQL_USER || env.MYSQL_USER,
  password: env.DATA_MYSQL_PASSWORD ?? env.MYSQL_PASSWORD,
  database: env.DATA_MYSQL_DATABASE || "gplan_data",
});
try {
  for (const [table, name, columns] of [
    ["ods_wln_sale_outbound", "idx_wln_sale_enterprise_summary", "company_id,bill_date,currency_code,ingested_at"],
    ["ods_wln_sale_outbound_items", "idx_wln_items_enterprise_summary", "company_id,outbound_uid,sku_code,quantity,gross_amount,cost_amount"],
  ]) {
    const [rows] = await connection.execute("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1", [table, name]);
    if (rows.length) { console.log(`${name}: ready`); continue; }
    const start = Date.now();
    console.log(`${name}: building online`);
    await connection.query(`ALTER TABLE ${table} ADD INDEX ${name} (${columns}), ALGORITHM=INPLACE, LOCK=NONE`);
    console.log(`${name}: ready (${Date.now() - start}ms)`);
  }
} finally { await connection.end(); }
