import "dotenv/config";
import { Router, type NextFunction, type Request, type Response } from "express";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { hashToken, uid } from "./security.js";

type DataApiClient = {
  id: string;
  companyId: string;
  clientCode: string;
  scopes: string[];
};

declare global {
  namespace Express {
    interface Request {
      dataApiClient?: DataApiClient;
    }
  }
}

const configured = process.env.DATA_DB_PROVIDER === "mysql" && Boolean(
  process.env.DATA_MYSQL_HOST
  && process.env.DATA_MYSQL_USER
  && process.env.DATA_MYSQL_PASSWORD
  && process.env.DATA_MYSQL_DATABASE
);

const pool = configured ? mysql.createPool({
  host: process.env.DATA_MYSQL_HOST,
  port: Number(process.env.DATA_MYSQL_PORT ?? 3306),
  user: process.env.DATA_MYSQL_USER,
  password: process.env.DATA_MYSQL_PASSWORD,
  database: process.env.DATA_MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: Math.max(2, Number(process.env.DATA_MYSQL_CONNECTION_LIMIT ?? 5)),
  charset: "utf8mb4",
  decimalNumbers: true
}) : null;

const router = Router();

function requirePool() {
  if (!pool) throw new Error("甲方数据 API 尚未配置经营数据库");
  return pool;
}

function bearerToken(req: Request) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function parseScopes(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function authenticate(scope?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = bearerToken(req);
      if (!token) return res.status(401).json({ code: 40101, message: "缺少 Bearer Token" });
      const db = requirePool();
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT id, company_id, client_code, scopes_json
         FROM data_api_clients
         WHERE token_hash = ? AND enabled = 1
           AND (expires_at IS NULL OR expires_at > NOW(3))
         LIMIT 1`,
        [hashToken(token)]
      );
      const row = rows[0];
      if (!row) return res.status(401).json({ code: 40102, message: "API Token 无效或已停用" });
      const scopes = parseScopes(row.scopes_json);
      if (scope && !scopes.includes("*") && !scopes.includes(scope)) {
        return res.status(403).json({ code: 40301, message: `Token 缺少权限：${scope}` });
      }
      req.dataApiClient = {
        id: String(row.id),
        companyId: String(row.company_id),
        clientCode: String(row.client_code),
        scopes
      };
      await db.execute("UPDATE data_api_clients SET last_used_at = NOW(3) WHERE id = ?", [row.id]);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, Math.trunc(parsed));
}

function requiredDate(req: Request, name: "start_date" | "end_date") {
  const value = typeof req.query[name] === "string" ? req.query[name].trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} 必须是 YYYY-MM-DD`);
  return value;
}

function dateRange(req: Request) {
  const startDate = requiredDate(req, "start_date");
  const endDate = requiredDate(req, "end_date");
  const start = new Date(`${startDate}T00:00:00+08:00`);
  const end = new Date(`${endDate}T00:00:00+08:00`);
  if (end < start) throw new Error("end_date 不能早于 start_date");
  if (end.getTime() - start.getTime() > 30 * 86_400_000) throw new Error("单次查询日期跨度不能超过 31 个自然日");
  return { startDate, endDate };
}

function optionalFilter(req: Request, name: string) {
  const value = req.query[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function paging(req: Request) {
  const page = positiveInteger(req.query.page, 1, 1_000_000);
  const pageSize = positiveInteger(req.query.page_size, 100, 200);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function sendPage(res: Response, rows: RowDataPacket[], total: number, page: number, pageSize: number) {
  res.json({
    code: 0,
    message: "success",
    request_id: res.locals.requestId,
    data: rows,
    pagination: {
      page,
      page_size: pageSize,
      total,
      has_more: page * pageSize < total
    },
    generated_at: new Date().toISOString()
  });
}

async function recordRequest(clientId: string, res: Response, endpoint: string, rows: number, startedAt: number) {
  await requirePool().execute(
    `INSERT INTO data_api_request_logs
      (client_id, request_id, endpoint, http_status, response_rows, duration_ms, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
    [clientId, res.locals.requestId, endpoint, res.statusCode, rows, Date.now() - startedAt]
  ).catch(() => undefined);
}

router.get("/ping", authenticate(), (req, res) => {
  res.json({
    code: 0,
    message: "success",
    request_id: res.locals.requestId,
    client_code: req.dataApiClient!.clientCode,
    api_version: "v1",
    server_time: new Date().toISOString()
  });
});

router.get("/shipments", authenticate("shipments:read"), async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const db = requirePool();
    const client = req.dataApiClient!;
    const { startDate, endDate } = dateRange(req);
    const { page, pageSize, offset } = paging(req);
    const shopCode = optionalFilter(req, "shop_code");
    const productCode = optionalFilter(req, "product_code");
    const shopExpr = "COALESCE(ms.target_code, NULLIF(v.shop_nick, ''), v.shop_name)";
    const productExpr = "COALESCE(mp.target_code, v.product_code)";
    const where = ["v.company_id = ?", "v.shipment_time >= ?", "v.shipment_time < DATE_ADD(?, INTERVAL 1 DAY)"];
    const params: unknown[] = [client.companyId, startDate, endDate];
    if (shopCode) { where.push(`${shopExpr} = ?`); params.push(shopCode); }
    if (productCode) { where.push(`${productExpr} = ?`); params.push(productCode); }
    const fromSql = `FROM vw_wln_shipments_v1 v
      LEFT JOIN data_api_entity_mappings ms
        ON ms.client_id = ? AND ms.entity_type = 'shop' AND ms.source_code = COALESCE(NULLIF(v.shop_nick, ''), v.shop_name) AND ms.enabled = 1
      LEFT JOIN data_api_entity_mappings mw
        ON mw.client_id = ? AND mw.entity_type = 'storage' AND mw.source_code = v.storage_code AND mw.enabled = 1
      LEFT JOIN data_api_entity_mappings mp
        ON mp.client_id = ? AND mp.entity_type = 'product' AND mp.source_code = v.product_code AND mp.enabled = 1
      WHERE ${where.join(" AND ")}`;
    const joinParams = [client.id, client.id, client.id, ...params];
    const [countRows] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) total ${fromSql}`, joinParams);
    const [rows] = await db.query<RowDataPacket[]>(`SELECT
        v.shipment_time,
        COALESCE(ms.target_name, v.shop_name) AS shop_name,
        ${productExpr} AS product_code,
        COALESCE(mp.target_name, v.product_name) AS product_name,
        v.quantity,
        v.gmv
      ${fromSql}
      ORDER BY v.shipment_time, v.outbound_no, v.product_code
      LIMIT ? OFFSET ?`, [...joinParams, pageSize, offset]);
    sendPage(res, rows, Number(countRows[0]?.total || 0), page, pageSize);
    await recordRequest(client.id, res, "/shipments", rows.length, startedAt);
  } catch (error) { next(error); }
});

router.get("/inventory", authenticate("inventory:read"), async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const db = requirePool();
    const client = req.dataApiClient!;
    const { page, pageSize, offset } = paging(req);
    const productCode = optionalFilter(req, "product_code");
    const productExpr = "COALESCE(mp.target_code, v.product_code)";
    const where = ["v.company_id = ?"];
    const filters: unknown[] = [client.companyId];
    if (productCode) { where.push(`${productExpr} = ?`); filters.push(productCode); }
    const fromSql = `FROM vw_wln_inventory_v1 v
      LEFT JOIN data_api_entity_mappings mp
        ON mp.client_id = ? AND mp.entity_type = 'product' AND mp.source_code = v.product_code AND mp.enabled = 1
      WHERE ${where.join(" AND ")}
      GROUP BY ${productExpr}`;
    const params = [client.id, ...filters];
    const [countRows] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) total FROM (SELECT 1 ${fromSql}) grouped`, params);
    const [rows] = await db.query<RowDataPacket[]>(`SELECT
        ${productExpr} AS product_code,
        MAX(COALESCE(mp.target_name, v.product_name)) AS product_name,
        SUM(v.inventory_quantity) AS inventory_quantity
      ${fromSql}
      ORDER BY product_code
      LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
    sendPage(res, rows, Number(countRows[0]?.total || 0), page, pageSize);
    await recordRequest(client.id, res, "/inventory", rows.length, startedAt);
  } catch (error) { next(error); }
});

router.get("/inbounds", authenticate("inbounds:read"), async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const db = requirePool();
    const client = req.dataApiClient!;
    const { startDate, endDate } = dateRange(req);
    const { page, pageSize, offset } = paging(req);
    const storageCode = optionalFilter(req, "storage_code");
    const productCode = optionalFilter(req, "product_code");
    const storageExpr = "COALESCE(mw.target_code, v.storage_code)";
    const productExpr = "COALESCE(mp.target_code, v.product_code)";
    const where = ["v.company_id = ?", "v.inbound_time >= ?", "v.inbound_time < DATE_ADD(?, INTERVAL 1 DAY)"];
    const filters: unknown[] = [client.companyId, startDate, endDate];
    if (storageCode) { where.push(`${storageExpr} = ?`); filters.push(storageCode); }
    if (productCode) { where.push(`${productExpr} = ?`); filters.push(productCode); }
    const fromSql = `FROM vw_wln_inbound_v1 v
      LEFT JOIN data_api_entity_mappings mw
        ON mw.client_id = ? AND mw.entity_type = 'storage' AND mw.source_code = v.storage_code AND mw.enabled = 1
      LEFT JOIN data_api_entity_mappings mp
        ON mp.client_id = ? AND mp.entity_type = 'product' AND mp.source_code = v.product_code AND mp.enabled = 1
      WHERE ${where.join(" AND ")}`;
    const params = [client.id, client.id, ...filters];
    const [countRows] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) total ${fromSql}`, params);
    const [rows] = await db.query<RowDataPacket[]>(`SELECT
        v.inbound_time,
        ${productExpr} AS product_code,
        COALESCE(mp.target_name, v.product_name) AS product_name,
        v.inbound_quantity
      ${fromSql}
      ORDER BY v.inbound_time, v.inbound_no, v.product_code
      LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
    sendPage(res, rows, Number(countRows[0]?.total || 0), page, pageSize);
    await recordRequest(client.id, res, "/inbounds", rows.length, startedAt);
  } catch (error) { next(error); }
});

export const clientDataApiRouter = router;
