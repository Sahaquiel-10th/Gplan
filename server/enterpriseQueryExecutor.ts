import { query } from "./operationsData.js";

type Run = (sql: string, values: (string | number)[]) => Promise<Record<string, unknown>[]>;

// The indexes are additive and optional: older databases keep the date-index path.
// Discover server-side; model parameters can never choose tables or index names.
export function createEnterpriseQueryExecutor(run: Run) {
  let indexes: Promise<Set<string>> | undefined;
  return async (sql: string, values: (string | number)[]) => {
    if (!sql.includes("/* enterprise-sales */")) return run(sql, values);
    indexes ??= run("SELECT INDEX_NAME indexName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND INDEX_NAME IN ('idx_wln_sale_enterprise_summary','idx_wln_items_enterprise_summary')", [])
      .then(rows => new Set(rows.map(row => String(row.indexName)))).catch(() => new Set<string>());
    const available = await indexes;
    if (available.has("idx_wln_sale_enterprise_summary")) sql = sql.replace("FORCE INDEX (idx_wln_sale_outbound_bill_date)", "FORCE INDEX (idx_wln_sale_enterprise_summary)");
    if (available.has("idx_wln_items_enterprise_summary")) sql = sql.replace("ods_wln_sale_outbound_items i ON", "ods_wln_sale_outbound_items i FORCE INDEX (idx_wln_items_enterprise_summary) ON");
    return run(sql, values);
  };
}

export const queryEnterpriseStatement = createEnterpriseQueryExecutor(query);
