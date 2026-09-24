import mysql, { type RowDataPacket } from "mysql2/promise";
import type { Agent, User } from "./types.js";
import {
  estimateProfit,
  finiteDecimal,
  inventoryMetrics,
  operationsGrant,
  operationsNames,
  scopeKey,
  shiftDate,
  type OperationsGrant,
} from "./operationsPolicy.js";

export type OperationsReport = {
  agentId: string;
  title: string;
  date: string;
  generatedAt: string;
  revision: number;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number | null>>;
  summary: Array<{ label: string; value: string | number }>;
  alerts: number;
  incomplete: boolean;
  methodology: {
    formula: string;
    sources: string[];
    included: string[];
    excluded: string[];
    notes: string[];
    sync: Array<{ resource: string; at: string }>;
  };
};
export type OperationsCatalog = {
  shops: Array<{ id: string; name: string }>;
  brands: string[];
  warehouses: Array<{ id: string; name: string }>;
};
let pool: mysql.Pool | undefined;
const reportCache = new Map<
  string,
  { expires: number; report: OperationsReport }
>();
const pendingReports = new Map<string, Promise<OperationsReport>>();
let scopeIndex: Promise<boolean> | undefined;
async function outboundIndex() {
  scopeIndex ??= query(
    "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ods_wln_sale_outbound' AND INDEX_NAME='idx_wln_sale_outbound_agent_scope' LIMIT 1",
    [],
  )
    .then((rows) => rows.length > 0)
    .catch(() => false);
  return (await scopeIndex)
    ? "idx_wln_sale_outbound_agent_scope"
    : "idx_wln_sale_outbound_bill_date";
}
function connection() {
  if (pool) return pool;
  const e = process.env;
  if (
    (e.DATA_DB_PROVIDER ||
      (e.DB_PROVIDER === "mysql" ? "mysql" : "disabled")) !== "mysql"
  )
    throw new Error("经营数据库未配置，需通过已授权的 RDS 环境运行");
  pool = mysql.createPool({
    host: e.DATA_MYSQL_HOST || e.MYSQL_HOST,
    port: Number(e.DATA_MYSQL_PORT || e.MYSQL_PORT || 3306),
    user: e.DATA_MYSQL_USER || e.MYSQL_USER,
    password: e.DATA_MYSQL_PASSWORD ?? e.MYSQL_PASSWORD,
    database: e.DATA_MYSQL_DATABASE || "gplan_data",
    connectionLimit: 3,
    connectTimeout: 8000,
    timezone: "+08:00",
    dateStrings: true,
  });
  return pool;
}
export async function query(
  sql: string,
  params: (string | number)[],
): Promise<RowDataPacket[]> {
  const [rows] = await connection().execute<RowDataPacket[]>(sql, params);
  return rows;
}
const brand =
  "NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(p.raw_payload, '$.goods.brand_name')), ''), 'null')";
const marks = (values: unknown[]) => values.map(() => "?").join(",");
export async function operationsCatalog(
  companyId: string,
): Promise<OperationsCatalog> {
  const [shops, brands, warehouses] = await Promise.all([
    query(
      "SELECT shop_uid id, COALESCE(NULLIF(shop_name,''),shop_nick,shop_uid) name FROM ods_wln_shops WHERE company_id=? ORDER BY name",
      [companyId],
    ),
    query(
      `SELECT DISTINCT ${brand} name FROM ods_wln_products p WHERE p.company_id=? AND ${brand} IS NOT NULL ORDER BY name`,
      [companyId],
    ),
    query(
      "SELECT DISTINCT storage_code id, storage_code name FROM ods_wln_inventory_current WHERE company_id=? ORDER BY storage_code",
      [companyId],
    ),
  ]);
  return {
    shops: shops.map((r) => ({ id: String(r.id), name: String(r.name) })),
    brands: brands.map((r) => String(r.name)),
    warehouses: warehouses.map((r) => ({
      id: String(r.id),
      name: String(r.name),
    })),
  };
}
function scope(
  companyId: string,
  grant: OperationsGrant,
  start: string,
  end: string,
  warehouse = false,
) {
  const params: (string | number)[] = [
    companyId,
    start,
    shiftDate(end, 1),
    ...grant.shopIds,
  ];
  let sql = `h.company_id=? AND h.bill_date>=? AND h.bill_date<? AND h.shop_id IN (${marks(grant.shopIds)})`;
  if (warehouse || grant.warehouseIds.length) {
    if (!grant.warehouseIds.length) throw new Error("未授权仓库");
    sql += ` AND h.storage_code IN (${marks(grant.warehouseIds)})`;
    params.push(...grant.warehouseIds);
  }
  return { sql, params };
}
export async function operationsReport(
  agent: Agent,
  user: User,
  date: string,
  refresh = false,
): Promise<OperationsReport> {
  const key = scopeKey(agent, user);
  if (!key) throw new Error("智能体不可用或未授权数据范围");
  const cacheKey = key + ":" + date;
  for (const [id, entry] of reportCache)
    if (entry.expires <= Date.now()) reportCache.delete(id);
  const cached = reportCache.get(cacheKey);
  if (cached && !refresh) return structuredClone(cached.report);
  let pending = pendingReports.get(cacheKey);
  if (!pending) {
    if (pendingReports.size >= 4)
      throw new Error("经营报表正在处理其他查询，请稍后重试");
    pending = computeOperationsReport(agent, user, date)
      .then((report) => {
        if (reportCache.size >= 100)
          reportCache.delete(reportCache.keys().next().value!);
        reportCache.set(cacheKey, { expires: Date.now() + 120000, report });
        return report;
      })
      .finally(() => pendingReports.delete(cacheKey));
    pendingReports.set(cacheKey, pending);
  }
  return structuredClone(await pending);
}
async function computeOperationsReport(
  agent: Agent,
  user: User,
  date: string,
): Promise<OperationsReport> {
  const grant = operationsGrant(agent, user);
  if (!grant || !agent.operations)
    throw new Error("智能体不可用或未授权数据范围");
  const config = agent.operations,
    rules = config.rules;
  const result: OperationsReport = {
    agentId: agent.id,
    title: operationsNames[config.kind],
    date,
    generatedAt: new Date().toISOString(),
    revision: config.revision,
    columns: [],
    rows: [],
    summary: [],
    alerts: 0,
    incomplete: false,
    methodology: {
      formula: "",
      sources: [],
      included: [],
      excluded: [],
      notes: [
        `口径版本 v${config.revision}；时间按北京时间，日期筛选使用出库日期，不等同于支付订单日期。`,
        "仅含授权店铺及品牌；无品牌、无法匹配店铺的数据不纳入。",
      ],
      sync: [],
    },
  };
  result.methodology.notes.push(
    `授权范围：${grant.shopIds.length} 家店铺；品牌：${grant.brands.join("、")}；${grant.warehouseIds.length ? grant.warehouseIds.length + " 个仓库" : "未按仓库收窄"}。短时缓存最多2分钟，权限与口径变化会使用新缓存。`,
  );
  const sync = await query(
    "SELECT resource_name,last_success_at FROM data_sync_cursors WHERE connector_id=?",
    ["wanliniu"],
  );
  const required =
    config.kind === "inventory"
      ? ["sale_outbound", "products", "inventory"]
      : ["sale_outbound", "products"];
  result.methodology.sync = sync
    .filter((r) => required.includes(r.resource_name))
    .map((r) => ({
      resource: String(r.resource_name),
      at: String(r.last_success_at),
    }));
  const endTime = Date.parse(`${shiftDate(date, 1)}T00:00:00+08:00`);
  if (
    required.some(
      (resource) =>
        !sync.some(
          (r) =>
            r.resource_name === resource &&
            Date.parse(
              String(r.last_success_at).replace(" ", "T") + "+08:00",
            ) >= endTime,
        ),
    )
  ) {
    result.incomplete = true;
    result.methodology.notes.push(
      "部分同步尚未覆盖所选日期，结果暂不完整，不代表没有异常。",
    );
  }
  if (config.kind === "loss") {
    const scoped = scope(user.companyId, grant, date, date);
    // Whole-document amounts are only returned when every item is inside the brand grant.
    const rows = await query(
      `SELECT /*+ MAX_EXECUTION_TIME(12000) */ h.outbound_uid,h.outbound_no,h.shop_name,h.bill_type,h.actual_payment,h.currency_code,
      JSON_UNQUOTE(JSON_EXTRACT(h.raw_payload,'$.delivery_cost')) delivery_cost,
      JSON_UNQUOTE(JSON_EXTRACT(h.raw_payload,'$.service_fee')) service_fee,
      JSON_UNQUOTE(JSON_EXTRACT(h.raw_payload,'$.storage_fee')) storage_fee,
      CASE WHEN CONCAT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(h.raw_payload,'$.remark')),''),' ',COALESCE(JSON_UNQUOTE(JSON_EXTRACT(h.raw_payload,'$.sys_remark')),'')) REGEXP '补发|漏发|换货' THEN 1 ELSE 0 END suspect_resend,
      SUM(i.cost_amount) cost, SUM(CASE WHEN i.cost_amount IS NULL OR i.cost_amount<0 OR i.quantity<=0 OR i.is_package=1 THEN 1 ELSE 0 END) uncertain_items
      FROM ods_wln_sale_outbound h STRAIGHT_JOIN ods_wln_sale_outbound_items i ON i.company_id=h.company_id AND i.outbound_uid=h.outbound_uid
      WHERE ${scoped.sql} AND NOT EXISTS (
        SELECT 1 FROM ods_wln_sale_outbound_items x LEFT JOIN ods_wln_products p ON p.company_id=x.company_id AND p.sku_code=x.sku_code
        WHERE x.company_id=h.company_id AND x.outbound_uid=h.outbound_uid AND (${brand} IS NULL OR ${brand} NOT IN (${marks(grant.brands)})))
      GROUP BY h.outbound_uid,h.outbound_no,h.shop_name,h.bill_type,h.actual_payment,h.currency_code,h.raw_payload
      ORDER BY h.outbound_uid LIMIT 1001`,
      [...scoped.params, ...grant.brands],
    );
    if (rows.length > 1000) {
      result.incomplete = true;
      result.methodology.notes.push(
        "本次最多核算1000张出库单，仅为部分结果；请缩小授权店铺范围后复核。",
      );
    }
    let pending = 0,
      excluded = 0,
      loss = 0,
      evaluated = 0;
    for (const row of rows.slice(0, 1000)) {
      if (
        row.bill_type !== null &&
        rules.excludedBillTypes.includes(Number(row.bill_type))
      ) {
        excluded++;
        continue;
      }
      const fees: unknown[] = [];
      if (rules.includeDeliveryCost) fees.push(row.delivery_cost);
      if (rules.includeServiceFee) fees.push(row.service_fee);
      if (rules.includeStorageFee) fees.push(row.storage_fee);
      const profit =
        Number(row.uncertain_items) > 0 ||
        !(
          ["CNY", "RMB", "人民币"].includes(
            String(row.currency_code).toUpperCase(),
          ) ||
          (rules.assumeMissingCurrencyCny && !row.currency_code)
        )
          ? null
          : estimateProfit(row.actual_payment, row.cost, fees);
      evaluated++;
      if (profit === null) pending++;
      else if (profit < 0) {
        result.alerts++;
        loss += Math.round(-profit * 100);
      }
      if (profit === null || profit < 0)
        result.rows.push({
          document: String(row.outbound_no),
          shop: String(row.shop_name || ""),
          paid: finiteDecimal(row.actual_payment),
          cost: finiteDecimal(row.cost),
          delivery: rules.includeDeliveryCost
            ? finiteDecimal(row.delivery_cost)
            : null,
          profit,
          status:
            profit === null
              ? "待核算"
              : Number(row.suspect_resend)
                ? "疑似补发，待确认"
                : "预估亏损",
        });
    }
    result.incomplete ||= pending > 0;
    result.rows.sort(
      (a, b) =>
        (typeof a.profit === "number" ? a.profit : Infinity) -
        (typeof b.profit === "number" ? b.profit : Infinity),
    );
    result.columns = [
      { key: "document", label: "出库单号" },
      { key: "shop", label: "店铺" },
      { key: "paid", label: "实收金额" },
      { key: "cost", label: "商品成本" },
      { key: "delivery", label: "物流费用" },
      { key: "profit", label: "预估毛利" },
      { key: "status", label: "状态" },
    ];
    result.summary = [
      { label: "已检查出库单", value: evaluated },
      { label: "预估亏损单", value: result.alerts },
      { label: "预估亏损合计（元）", value: loss / 100 },
      { label: "待核算", value: pending },
      { label: "按类型排除", value: excluded },
    ];
    result.methodology.formula = `预估毛利 = 实收金额 − 明细商品成本合计${rules.includeDeliveryCost ? " − delivery_cost" : ""}${rules.includeServiceFee ? " − service_fee" : ""}${rules.includeStorageFee ? " − storage_fee" : ""}`;
    result.methodology.sources = [
      "RDS：ods_wln_sale_outbound",
      "RDS：ods_wln_sale_outbound_items",
      "RDS：ods_wln_products（品牌权限）",
    ];
    result.methodology.included = [
      "actual_payment（实收）",
      "sum_cost / cost_amount（商品成本）",
      ...(rules.includeDeliveryCost
        ? ["delivery_cost（待业务对账确认的物流费用字段）"]
        : []),
      ...(rules.includeServiceFee ? ["service_fee"] : []),
      ...(rules.includeStorageFee ? ["storage_fee"] : []),
    ];
    result.methodology.excluded = [
      "退款、广告花费、未明确纳入的其他费用",
      "post_fee 不作为实际物流成本重复扣除",
      `排除单据类型：${rules.excludedBillTypes.join("、") || "无；备注关键词只标记疑似补发，不自动排除"}`,
    ];
    result.methodology.notes.push(
      "按出库单核算，拆单／合单与支付订单可能不一一对应；不称为最终净利润。",
      "缺少必需费用、非人民币、负值及套装成本层级不明时列为待核算，不按零补齐。",
      rules.assumeMissingCurrencyCny
        ? "当前币种缺失按人民币暂估（可在口径设置关闭）；已明确标识其他币种的不核算。"
        : "币种缺失不核算。",
      "混合未授权品牌的整张出库单不纳入，避免整单金额泄露。",
    );
  } else {
    // One-day index ranges avoid MySQL choosing a scan of the full large ODS table.
    // Aggregate daily inside SQL, then combine a bounded number of SKU rows in code.
    const index = await outboundIndex();
    const totals = new Map<
      string,
      {
        sku_code: string;
        name: string;
        sales3: number;
        sales7: number;
        previous7: number;
        sales30: number;
        amount7: number;
        package_rows: number;
      }
    >();
    const days = Array.from({ length: 30 }, (_, i) => shiftDate(date, -i));
    let next = 0;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (next < days.length) {
          const day = days[next++];
          const scoped = scope(
            user.companyId,
            grant,
            day,
            day,
            config.kind === "inventory",
          );
          const daily = await query(
            `SELECT /*+ MAX_EXECUTION_TIME(12000) */ i.sku_code,MAX(p.goods_name) name,
          SUM(i.quantity) units,SUM(i.gross_amount) amount,
          SUM(CASE WHEN i.is_package=1 THEN 1 ELSE 0 END) package_rows
          FROM ods_wln_sale_outbound h FORCE INDEX (${index})
          STRAIGHT_JOIN ods_wln_sale_outbound_items i ON i.company_id=h.company_id AND i.outbound_uid=h.outbound_uid
          STRAIGHT_JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code
          WHERE ${scoped.sql} AND ${brand} IN (${marks(grant.brands)}) AND i.quantity>0
          GROUP BY i.sku_code LIMIT 5001`,
            [...scoped.params, ...grant.brands],
          );
          if (daily.length > 5000)
            throw new Error("单日商品过多，请缩小成员授权范围后重试");
          for (const row of daily) {
            const key = String(row.sku_code);
            const total = totals.get(key) || {
              sku_code: key,
              name: String(row.name),
              sales3: 0,
              sales7: 0,
              previous7: 0,
              sales30: 0,
              amount7: 0,
              package_rows: 0,
            };
            const units = Number(row.units);
            total.sales30 += units;
            total.package_rows += Number(row.package_rows);
            if (day >= shiftDate(date, -2)) total.sales3 += units;
            if (day >= shiftDate(date, -6)) {
              total.sales7 += units;
              total.amount7 += Math.round(Number(row.amount || 0) * 100);
            }
            if (day >= shiftDate(date, -13) && day < shiftDate(date, -6))
              total.previous7 += units;
            totals.set(key, total);
          }
          if (totals.size > 10000)
            throw new Error("统计商品过多，请缩小成员授权范围后重试");
        }
      }),
    );
    const rows = [...totals.values()]
      .sort(
        (a, b) => b.sales7 - a.sales7 || a.sku_code.localeCompare(b.sku_code),
      )
      .map((r) => ({ ...r, amount7: r.amount7 / 100 }));
    if (rows.length > 200) {
      result.incomplete = true;
      result.methodology.notes.push(
        "展示近7天销量前200个商品，预警数量仅针对这些商品，不代表全部商品。",
      );
    }
    const items = rows.slice(0, 200);
    const stocks =
      config.kind === "inventory" && items.length
        ? await query(
            `SELECT i.sku_code,SUM(i.actual_quantity-i.locked_quantity) available,SUM(i.in_transit_quantity) transit,MIN(i.snapshot_at) snapshot FROM ods_wln_inventory_current i JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code WHERE i.company_id=? AND i.storage_code IN (${marks(grant.warehouseIds)}) AND ${brand} IN (${marks(grant.brands)}) AND i.sku_code IN (${marks(items)}) GROUP BY i.sku_code`,
            [
              user.companyId,
              ...grant.warehouseIds,
              ...grant.brands,
              ...items.map((r) => r.sku_code),
            ],
          )
        : [];
    const stockMap = new Map(stocks.map((r) => [r.sku_code, r]));
    for (const row of items) {
      const sales3 = Number(row.sales3),
        sales7 = Number(row.sales7),
        sales30 = Number(row.sales30),
        previous7 = Number(row.previous7);
      if (Number(row.package_rows) > 0) {
        result.incomplete = true;
        result.rows.push({
          sku: String(row.sku_code),
          name: String(row.name),
          status: "套装消耗映射待核实",
          sales7: null,
        });
        continue;
      }
      if (config.kind === "inventory") {
        const stock = stockMap.get(row.sku_code);
        const stale =
          !stock ||
          !Number.isFinite(
            Date.parse(String(stock.snapshot).replace(" ", "T") + "+08:00"),
          ) ||
          Date.now() -
            Date.parse(String(stock.snapshot).replace(" ", "T") + "+08:00") >
            36 * 3600000;
        if (stale) {
          result.incomplete = true;
          result.rows.push({
            sku: String(row.sku_code),
            name: String(row.name),
            sales7,
            status: "库存缺失或超过36小时未更新",
          });
          continue;
        }
        const metrics = inventoryMetrics(
          Number(stock.available),
          sales3,
          sales7,
          sales30,
          rules,
        );
        if (
          metrics.risk === "缺货" ||
          metrics.risk === "需关注" ||
          metrics.spike
        )
          result.alerts++;
        result.rows.push({
          sku: String(row.sku_code),
          name: String(row.name),
          sales7,
          available: Number(stock.available),
          days: metrics.days,
          transit: Number(stock.transit),
          targetGap: metrics.targetGap,
          status: metrics.risk + (metrics.spike ? " · 销量放大" : ""),
        });
      } else {
        const change =
          previous7 > 0
            ? Math.round((sales7 / previous7 - 1) * 1000) / 10
            : null;
        if (change !== null && Math.abs(change) >= 50) result.alerts++;
        result.rows.push({
          sku: String(row.sku_code),
          name: String(row.name),
          sales7,
          previous7,
          change,
          amount7: finiteDecimal(row.amount7),
          status:
            change === null
              ? "上期无销量，待观察"
              : change >= 50
                ? "销量上升"
                : change <= -50
                  ? "销量下降"
                  : "变化平稳",
        });
      }
    }
    result.columns =
      config.kind === "inventory"
        ? [
            { key: "name", label: "商品" },
            { key: "sku", label: "SKU" },
            { key: "sales7", label: "7天销量" },
            { key: "available", label: "当前可用库存" },
            { key: "days", label: "参考天数" },
            { key: "transit", label: "在途数量" },
            { key: "targetGap", label: "目标库存缺口" },
            { key: "status", label: "状态" },
          ]
        : [
            { key: "name", label: "商品" },
            { key: "sku", label: "SKU" },
            { key: "sales7", label: "近7天销量" },
            { key: "previous7", label: "前7天销量" },
            { key: "change", label: "变化（%）" },
            { key: "amount7", label: "7天出库销售额" },
            { key: "status", label: "状态" },
          ];
    result.summary = [
      { label: "本次商品", value: result.rows.length },
      { label: "需关注", value: result.alerts },
    ];
    result.methodology.sources = [
      "RDS：ods_wln_sale_outbound / items",
      "RDS：ods_wln_products",
      ...(config.kind === "inventory"
        ? ["RDS：ods_wln_inventory_current"]
        : []),
    ];
    result.methodology.formula =
      config.kind === "inventory"
        ? `参考天数 = max(0,当前可用库存) ÷ 近3天日均出库销量；关注线 ${rules.dangerDays} 天；目标缺口 = max(0,近7天日均销量 × ${rules.targetDays} − 可用库存)，向上取整。`
        : "销量变化 = (近7天销量 ÷ 前7天销量 − 1) × 100%；绝对变化达到50%列为关注。";
    result.methodology.included = [
      "仅统计授权店铺、品牌及选定仓库内的正向出库数量",
    ];
    result.methodology.excluded = [
      "退货净额、广告、曝光、点击、转化数据",
      "未核实的套装消耗映射；无销售记录的商品不进入本次榜单",
    ];
    result.methodology.notes.push(
      "近3／7／30天均为包含所选日期的完整自然日窗口；源数据漏同步与真实零销量尚不能逐日区分，趋势和阈值仅供复核。",
    );
    if (config.kind === "inventory")
      result.methodology.notes.push(
        "参考天数使用当前库存与所选期间销量，不是历史库存回放。",
        "共享库存可能被其他店铺使用；这里只使用授权店铺销量，参考天数可能偏高，不代表全仓断货预测。",
        "在途到货日期尚未接入，所以在途仅展示，不抵扣目标库存缺口；目标缺口不是自动采购指令。",
        "销售放大倍数使用3日日均／30日日均，30天销量为0时不计算。",
      );
    else
      result.methodology.notes.push(
        "当前粒度为系统商品SKU，未取得完整线上链接映射；不推断广告效率或转化原因。",
      );
  }
  return result;
}
