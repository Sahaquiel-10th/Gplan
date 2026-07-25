import mysql from "mysql2/promise";
import type { WanliniuShop } from "./data-connectors/wanliniu/client.js";

export type DataPlatformStatus = {
  configured: boolean;
  ready: boolean;
  provider: "mysql" | "disabled";
  database?: string;
  message: string;
};

export type DataSyncRun = {
  id: string;
  connectorId: string;
  resource: string;
  mode: "full" | "incremental";
  startedAt: string;
};

export type DataSyncRunResult = {
  recordsRead: number;
  recordsWritten: number;
  cursor?: unknown;
};

export interface DataPlatformStore {
  status(): DataPlatformStatus;
  startSyncRun(run: DataSyncRun): Promise<void>;
  completeSyncRun(id: string, result: DataSyncRunResult): Promise<void>;
  failSyncRun(id: string, message: string): Promise<void>;
  saveCursor(connectorId: string, resource: string, cursor: unknown): Promise<void>;
  upsertWanliniuShops(companyId: string, shops: WanliniuShop[], syncRunId: string): Promise<number>;
  countWanliniuShops(companyId: string): Promise<number>;
}

class UnavailableDataPlatformStore implements DataPlatformStore {
  constructor(private currentStatus: DataPlatformStatus) {}
  status() { return this.currentStatus; }
  private unavailable(): never { throw new Error(this.currentStatus.message); }
  async startSyncRun() { this.unavailable(); }
  async completeSyncRun() { this.unavailable(); }
  async failSyncRun() { this.unavailable(); }
  async saveCursor() { this.unavailable(); }
  async upsertWanliniuShops() { return this.unavailable(); }
  async countWanliniuShops() { return this.unavailable(); }
}

class MySqlDataPlatformStore implements DataPlatformStore {
  constructor(private pool: mysql.Pool, private database: string) {}

  status(): DataPlatformStatus {
    return {
      configured: true,
      ready: true,
      provider: "mysql",
      database: this.database,
      message: `经营数据库 ${this.database} 已连接`
    };
  }

  async init() {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS data_sync_runs (
        id VARCHAR(64) PRIMARY KEY,
        connector_id VARCHAR(64) NOT NULL,
        resource_name VARCHAR(128) NOT NULL,
        sync_mode VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL,
        records_read INT NOT NULL DEFAULT 0,
        records_written INT NOT NULL DEFAULT 0,
        cursor_json JSON NULL,
        error_message TEXT NULL,
        started_at DATETIME(3) NOT NULL,
        finished_at DATETIME(3) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sync_runs_resource (connector_id, resource_name, started_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS data_sync_cursors (
        connector_id VARCHAR(64) NOT NULL,
        resource_name VARCHAR(128) NOT NULL,
        cursor_json JSON NOT NULL,
        last_success_at DATETIME(3) NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (connector_id, resource_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS ods_wln_shops (
        company_id VARCHAR(128) NOT NULL,
        shop_uid VARCHAR(128) NOT NULL,
        source_company_id VARCHAR(128) NULL,
        shop_nick VARCHAR(255) NULL,
        shop_name VARCHAR(255) NULL,
        shop_type INT NULL,
        shop_sub_type INT NULL,
        status INT NULL,
        group_uid VARCHAR(128) NULL,
        group_name VARCHAR(255) NULL,
        sync_enabled TINYINT(1) NULL,
        source_modified_at DATETIME(3) NULL,
        raw_payload JSON NOT NULL,
        sync_run_id VARCHAR(64) NOT NULL,
        ingested_at DATETIME(3) NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (company_id, shop_uid),
        INDEX idx_wln_shops_nick (company_id, shop_nick),
        INDEX idx_wln_shops_modified (company_id, source_modified_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async startSyncRun(run: DataSyncRun) {
    await this.pool.execute(
      `INSERT INTO data_sync_runs (id, connector_id, resource_name, sync_mode, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      [run.id, run.connectorId, run.resource, run.mode, mysqlDate(run.startedAt)]
    );
  }

  async completeSyncRun(id: string, result: DataSyncRunResult) {
    await this.pool.execute(
      `UPDATE data_sync_runs
       SET status = 'success', records_read = ?, records_written = ?, cursor_json = ?, finished_at = ?
       WHERE id = ?`,
      [result.recordsRead, result.recordsWritten, jsonValue(result.cursor), mysqlDate(new Date()), id]
    );
  }

  async failSyncRun(id: string, message: string) {
    await this.pool.execute(
      "UPDATE data_sync_runs SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?",
      [message.slice(0, 4000), mysqlDate(new Date()), id]
    );
  }

  async saveCursor(connectorId: string, resource: string, cursor: unknown) {
    await this.pool.execute(
      `INSERT INTO data_sync_cursors (connector_id, resource_name, cursor_json, last_success_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE cursor_json = VALUES(cursor_json), last_success_at = VALUES(last_success_at)`,
      [connectorId, resource, jsonValue(cursor) ?? "{}", mysqlDate(new Date())]
    );
  }

  async upsertWanliniuShops(companyId: string, shops: WanliniuShop[], syncRunId: string) {
    if (!shops.length) return 0;
    const ingestedAt = mysqlDate(new Date());
    const values = shops.map((shop) => [
      companyId,
      requiredShopUid(shop),
      nullableString(shop.com_uid),
      nullableString(shop.shop_nick),
      nullableString(shop.shop_name),
      nullableNumber(shop.shop_type),
      nullableNumber(shop.sub_type),
      nullableNumber(shop.status),
      nullableString(shop.group_uid),
      nullableString(shop.group_name),
      typeof shop.is_sync === "boolean" ? Number(shop.is_sync) : null,
      sourceDate(shop.modify_time),
      JSON.stringify(sanitizeShopPayload(shop)),
      syncRunId,
      ingestedAt
    ]);
    const placeholders = values.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
    await this.pool.execute(
      `INSERT INTO ods_wln_shops (
        company_id, shop_uid, source_company_id, shop_nick, shop_name, shop_type, shop_sub_type,
        status, group_uid, group_name, sync_enabled, source_modified_at, raw_payload, sync_run_id, ingested_at
      ) VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE
        source_company_id = VALUES(source_company_id), shop_nick = VALUES(shop_nick), shop_name = VALUES(shop_name),
        shop_type = VALUES(shop_type), shop_sub_type = VALUES(shop_sub_type), status = VALUES(status),
        group_uid = VALUES(group_uid), group_name = VALUES(group_name), sync_enabled = VALUES(sync_enabled),
        source_modified_at = VALUES(source_modified_at), raw_payload = VALUES(raw_payload),
        sync_run_id = VALUES(sync_run_id), ingested_at = VALUES(ingested_at)`,
      values.flat()
    );
    return shops.length;
  }

  async countWanliniuShops(companyId: string) {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM ods_wln_shops WHERE company_id = ?",
      [companyId]
    );
    return Number(rows[0]?.count ?? 0);
  }
}

function requiredShopUid(shop: WanliniuShop) {
  const value = nullableString(shop.shop_uid) || nullableString(shop.shop_nick);
  if (!value) throw new Error("万里牛店铺数据缺少 shop_uid 和 shop_nick，无法幂等落库");
  return value;
}

function sanitizeShopPayload(shop: WanliniuShop) {
  const { cellphone: _cellphone, phone: _phone, contacts: _contacts, ...safe } = shop;
  return safe;
}

function nullableString(value: unknown) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sourceDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : mysqlDate(date);
}

function mysqlDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function jsonValue(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

async function createDataPlatformStore(): Promise<DataPlatformStore> {
  const provider = process.env.DATA_DB_PROVIDER?.trim() || (process.env.DB_PROVIDER === "mysql" ? "mysql" : "disabled");
  if (provider !== "mysql") {
    return new UnavailableDataPlatformStore({
      configured: false,
      ready: false,
      provider: "disabled",
      message: "本地经营数据库未启用；生产环境请配置 DATA_DB_PROVIDER=mysql"
    });
  }
  const database = process.env.DATA_MYSQL_DATABASE?.trim();
  if (!database) {
    return new UnavailableDataPlatformStore({
      configured: false,
      ready: false,
      provider: "mysql",
      message: "经营数据库未配置：缺少 DATA_MYSQL_DATABASE（建议值 gplan_data）"
    });
  }
  const pool = mysql.createPool({
    host: process.env.DATA_MYSQL_HOST?.trim() || process.env.MYSQL_HOST,
    port: Number(process.env.DATA_MYSQL_PORT ?? process.env.MYSQL_PORT ?? 3306),
    user: process.env.DATA_MYSQL_USER?.trim() || process.env.MYSQL_USER,
    password: process.env.DATA_MYSQL_PASSWORD ?? process.env.MYSQL_PASSWORD,
    database,
    waitForConnections: true,
    connectionLimit: Number(process.env.DATA_MYSQL_CONNECTION_LIMIT ?? 5),
    charset: "utf8mb4"
  });
  const store = new MySqlDataPlatformStore(pool, database);
  try {
    await store.init();
    return store;
  } catch (error) {
    console.error(JSON.stringify({
      event: "data_platform_database_init_failed",
      database,
      error: error instanceof Error ? error.message : String(error)
    }));
    await pool.end().catch(() => undefined);
    return new UnavailableDataPlatformStore({
      configured: true,
      ready: false,
      provider: "mysql",
      database,
      message: `经营数据库 ${database} 连接失败，请检查 DATA_MYSQL_* 配置和数据库授权`
    });
  }
}

export const dataPlatformStore = await createDataPlatformStore();
