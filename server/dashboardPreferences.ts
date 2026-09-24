export const dashboardWidgets = [
  { id: "overview", name: "核心指标" },
  { id: "trend", name: "销售趋势" },
  { id: "shops", name: "店铺排名" },
  { id: "products", name: "商品排名" },
  { id: "inventory", name: "库存分布" },
  { id: "briefs", name: "AI 管理简报" },
  { id: "raw", name: "原始明细表" },
];
export type DashboardView = {
  widgets: string[];
  sourceAgentId: string;
  table: "products" | "brands" | "lines";
  brand: string;
  search: string;
  sort: string;
  direction: "asc" | "desc";
  pageSize: number;
  columns: string[];
  columnWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
};
export const dashboardColumns = [
  "brand",
  "sku",
  "name",
  "quantity",
  "amount",
  "cost",
  "orders",
  "billDate",
  "document",
  "shop",
  "paid",
  "delivery",
  "profit",
  "status",
  "sales7",
  "available",
  "days",
  "transit",
  "targetGap",
  "previous7",
  "change",
  "amount7",
];
export const defaultDashboardView: DashboardView = {
  widgets: ["overview", "trend", "shops", "raw"],
  sourceAgentId: "",
  table: "products",
  brand: "",
  search: "",
  sort: "amount",
  direction: "desc",
  pageSize: 20,
  columns: ["brand", "sku", "name", "quantity", "amount"],
};
export type DashboardPreset = {
  id: string;
  companyId: string;
  userId: string;
  name: string;
  view: DashboardView;
  updatedAt: string;
};
export function normalizeDashboardView(value: unknown): DashboardView {
  const v = value as Partial<DashboardView>;
  if (
    !v ||
    !Array.isArray(v.widgets) ||
    !v.widgets.length ||
    v.widgets.some((w) => !dashboardWidgets.some((d) => d.id === w))
  )
    throw new Error("请选择有效展示维度");
  if (!["products", "brands", "lines"].includes(v.table || ""))
    throw new Error("明细表类型无效");
  if (!dashboardColumns.includes(v.sort || "")) throw new Error("排序字段无效");
  if (!["asc", "desc"].includes(v.direction || ""))
    throw new Error("排序方向无效");
  if (![20, 50, 100].includes(Number(v.pageSize)))
    throw new Error("每页支持20、50或100条");
  if (
    !Array.isArray(v.columns) ||
    !v.columns.length ||
    v.columns.some((c) => !dashboardColumns.includes(c))
  )
    throw new Error("请选择有效数据列");
  function sizes(input: unknown, row: boolean): Record<string, number> {
    if (input === undefined) return {};
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("表格尺寸无效");
    const entries = Object.entries(input);
    if (entries.length > (row ? 300 : 100)) throw new Error("表格尺寸过多");
    return Object.fromEntries(
      entries.map(([key, size]) => {
        const [table, field] = key.split(":");
        const valid =
          ["products", "brands", "lines"].includes(table) &&
          key.split(":").length === 2 &&
          (row
            ? /^(?:[1-9]|[1-9][0-9]|100)$/.test(field)
            : [...dashboardColumns, "products"].includes(field));
        if (
          !valid ||
          typeof size !== "number" ||
          !Number.isFinite(size) ||
          size < (row ? 36 : 80) ||
          size > (row ? 400 : 800)
        )
          throw new Error("表格尺寸无效");
        return [key, Math.round(size)];
      }),
    );
  }
  return {
    columnWidths: sizes(v.columnWidths, false),
    rowHeights: sizes(v.rowHeights, true),
    widgets: [...new Set(v.widgets)],
    sourceAgentId: String(v.sourceAgentId || "").slice(0, 100),
    table: v.table!,
    brand: String(v.brand || "").slice(0, 200),
    search: String(v.search || "").slice(0, 100),
    sort: v.sort!,
    direction: v.direction!,
    pageSize: Number(v.pageSize),
    columns: [...new Set(v.columns)],
  };
}
