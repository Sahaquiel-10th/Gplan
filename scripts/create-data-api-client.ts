import "dotenv/config";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { hashToken, uid } from "../server/security.js";

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || "";
}

const clientCode = argument("code");
const clientName = argument("name");
const companyId = argument("company") || process.env.WANLINIU_COMPANY_ID?.trim() || "company_default";
const scopes = (argument("scopes") || "shipments:read,inventory:read,inbounds:read")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!clientCode || !clientName) {
  throw new Error("用法：--code=客户编码 --name=客户名称 [--company=企业编码] [--scopes=权限1,权限2]");
}

const pool = mysql.createPool({
  host: process.env.DATA_MYSQL_HOST,
  port: Number(process.env.DATA_MYSQL_PORT ?? 3306),
  user: process.env.DATA_MYSQL_USER,
  password: process.env.DATA_MYSQL_PASSWORD,
  database: process.env.DATA_MYSQL_DATABASE,
  connectionLimit: 1,
  charset: "utf8mb4"
});

const token = `gpd_${crypto.randomBytes(32).toString("base64url")}`;
const id = uid("dac");
try {
  await pool.execute(
    `INSERT INTO data_api_clients
      (id, company_id, client_code, client_name, token_hash, scopes_json, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, NOW(3))
     ON DUPLICATE KEY UPDATE
       client_name = VALUES(client_name), token_hash = VALUES(token_hash), scopes_json = VALUES(scopes_json),
       enabled = 1, expires_at = NULL`,
    [id, companyId, clientCode, clientName, hashToken(token), JSON.stringify(scopes)]
  );
  console.log(JSON.stringify({ clientCode, clientName, companyId, scopes, token }, null, 2));
} finally {
  await pool.end();
}
