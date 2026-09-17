// Run on the application host: node scripts/migrate-operations-index.mjs
// Uses the existing data DB credentials. No row data is modified.
import "dotenv/config";
import mysql from "mysql2/promise";
const e = process.env;
const connection = await mysql.createConnection({
  host: e.DATA_MYSQL_HOST || e.MYSQL_HOST,
  port: Number(e.DATA_MYSQL_PORT || e.MYSQL_PORT || 3306),
  user: e.DATA_MYSQL_USER || e.MYSQL_USER,
  password: e.DATA_MYSQL_PASSWORD ?? e.MYSQL_PASSWORD,
  database: e.DATA_MYSQL_DATABASE || "gplan_data",
  connectTimeout: 8000,
});
try {
  const [rows] = await connection.execute(
    "SELECT COLUMN_NAME,SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ods_wln_sale_outbound' AND INDEX_NAME='idx_wln_sale_outbound_agent_scope' ORDER BY SEQ_IN_INDEX",
  );
  if (rows.length) {
    if (
      rows.map((r) => r.COLUMN_NAME).join(",") !==
      "company_id,shop_id,bill_date"
    )
      throw new Error("Existing index has unexpected columns");
    console.log("Operations scope index already exists.");
  } else {
    await connection.query(
      "ALTER TABLE ods_wln_sale_outbound ADD INDEX idx_wln_sale_outbound_agent_scope (company_id,shop_id,bill_date), ALGORITHM=INPLACE, LOCK=NONE",
    );
    console.log("Operations scope index created. Restart the app to use it.");
  }
} finally {
  await connection.end();
}
