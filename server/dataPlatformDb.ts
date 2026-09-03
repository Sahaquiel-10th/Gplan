import mysql from "mysql2/promise";
import type {
  NormalizedInbound,
  NormalizedInventory,
  NormalizedOutbound,
  NormalizedProduct,
  NormalizedShop
} from "./data-connectors/wanliniu/mappers.js";
import { mysqlDateInShanghai } from "./data-connectors/wanliniu/mappers.js";

export type DataResource = "shops" | "products" | "inventory" | "sale_outbound" | "purchase_inbound";
export type SyncMode = "full" | "incremental";

export type DataPlatformStatus = {
  configured: boolean;
  ready: boolean;
  provider: "mysql" | "disabled";
  database?: string;
  message: string;
};

export type SyncCursor = {
  modifiedThrough: string;
  completedAt: string;
  mode: SyncMode;
};

export type SyncRunResult = {
  recordsRead: number;
  recordsWritten: number;
  cursor?: SyncCursor;
};

export type ManagementDashboardFacts = {
  reportDate: string;
  summary: {
    gmv: number;
    actualPayment: number;
    orders: number;
    units: number;
    averageOrderValue: number;
    inboundOrders: number;
    inboundUnits: number;
    inventoryUnits: number;
    inventorySkus: number;
    lockedInventoryUnits: number;
    thirtyDayDailyAverageGmv: number;
    thirtyDayDailyAverageOrders: number;
  };
  dailyTrend: Array<{ date: string; gmv: number; orders: number }>;
  shops: Array<{ name: string; source: string; gmv: number; orders: number; units: number }>;
  products: Array<{ skuCode: string; name: string; gmv: number; units: number }>;
  inventory: Array<{ skuCode: string; name: string; units: number; lockedUnits: number; inTransitUnits: number }>;
  dataStatus: Array<{ resource: string; modifiedThrough: string; lastSuccessAt: string }>;
};

export interface DataPlatformStore {
  status(): DataPlatformStatus;
  startSyncRun(run: { id: string; resource: DataResource; mode: SyncMode; startedAt: string }): Promise<void>;
  completeSyncRun(id: string, result: SyncRunResult): Promise<void>;
  failSyncRun(id: string, message: string): Promise<void>;
  getCursor(resource: DataResource): Promise<SyncCursor | undefined>;
  saveCursor(resource: DataResource, cursor: SyncCursor): Promise<void>;
  upsertShops(companyId: string, records: NormalizedShop[], runId: string): Promise<number>;
  upsertProducts(companyId: string, records: NormalizedProduct[], runId: string): Promise<number>;
  upsertInventory(companyId: string, records: NormalizedInventory[], runId: string): Promise<number>;
  upsertOutbound(companyId: string, records: NormalizedOutbound[], runId: string): Promise<number>;
  upsertInbound(companyId: string, records: NormalizedInbound[], runId: string): Promise<number>;
  getManagementDashboardFacts(companyId: string, reportDate: string): Promise<ManagementDashboardFacts>;
}

class UnavailableDataPlatformStore implements DataPlatformStore {
  constructor(private currentStatus: DataPlatformStatus) {}
  status() { return this.currentStatus; }
  private unavailable(): never { throw new Error(this.currentStatus.message); }
  async startSyncRun() { this.unavailable(); }
  async completeSyncRun() { this.unavailable(); }
  async failSyncRun() { this.unavailable(); }
  async getCursor() { return this.unavailable(); }
  async saveCursor() { this.unavailable(); }
  async upsertShops() { return this.unavailable(); }
  async upsertProducts() { return this.unavailable(); }
  async upsertInventory() { return this.unavailable(); }
  async upsertOutbound() { return this.unavailable(); }
  async upsertInbound() { return this.unavailable(); }
  async getManagementDashboardFacts() { return this.unavailable(); }
}

class MySqlDataPlatformStore implements DataPlatformStore {
  constructor(private pool: mysql.Pool, private database: string) {}

  status(): DataPlatformStatus {
    return {
      configured: true,
      ready: true,
      provider: "mysql",
      database: this.database,
      message: `经营数据库 ${this.database} 已连接，万里牛 ODS 表可用`
    };
  }

  async init() {
    const required = [
      "data_sync_runs",
      "data_sync_cursors",
      "ods_wln_shops",
      "ods_wln_products",
      "ods_wln_sale_outbound",
      "ods_wln_sale_outbound_items",
      "ods_wln_inventory_current",
      "ods_wln_purchase_inbound",
      "ods_wln_purchase_inbound_items"
    ];
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${required.map(() => "?").join(",")})`,
      [this.database, ...required]
    );
    const existing = new Set(rows.map((row) => String(row.TABLE_NAME)));
    const missing = required.filter((name) => !existing.has(name));
    if (missing.length) throw new Error(`经营数据库缺少表：${missing.join("、")}`);
  }

  async startSyncRun(run: { id: string; resource: DataResource; mode: SyncMode; startedAt: string }) {
    await this.pool.execute(
      `INSERT INTO data_sync_runs (id, connector_id, resource_name, sync_mode, status, started_at)
       VALUES (?, 'wanliniu', ?, ?, 'running', ?)`,
      [run.id, run.resource, run.mode, mysqlDateInShanghai(run.startedAt)]
    );
  }

  async completeSyncRun(id: string, result: SyncRunResult) {
    await this.pool.execute(
      `UPDATE data_sync_runs
       SET status = 'success', records_read = ?, records_written = ?, cursor_json = ?, finished_at = ?
       WHERE id = ?`,
      [result.recordsRead, result.recordsWritten, json(result.cursor), mysqlDateInShanghai(new Date()), id]
    );
  }

  async failSyncRun(id: string, message: string) {
    await this.pool.execute(
      "UPDATE data_sync_runs SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?",
      [message.slice(0, 4000), mysqlDateInShanghai(new Date()), id]
    );
  }

  async getCursor(resource: DataResource) {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT cursor_json FROM data_sync_cursors
       WHERE connector_id = 'wanliniu' AND resource_name = ? LIMIT 1`,
      [resource]
    );
    if (!rows.length) return undefined;
    const value = rows[0].cursor_json;
    return (typeof value === "string" ? JSON.parse(value) : value) as SyncCursor;
  }

  async saveCursor(resource: DataResource, cursor: SyncCursor) {
    await this.pool.execute(
      `INSERT INTO data_sync_cursors (connector_id, resource_name, cursor_json, last_success_at)
       VALUES ('wanliniu', ?, ?, ?)
       ON DUPLICATE KEY UPDATE cursor_json = VALUES(cursor_json), last_success_at = VALUES(last_success_at)`,
      [resource, json(cursor), mysqlDateInShanghai(new Date())]
    );
  }

  async upsertShops(companyId: string, records: NormalizedShop[], runId: string) {
    if (!records.length) return 0;
    const ingestedAt = mysqlDateInShanghai(new Date());
    const values = records.map((item) => [
      companyId, item.shopUid, item.sourceCompanyId, item.shopNick, item.shopName, item.shopType,
      item.shopSubType, item.status, item.groupUid, item.groupName,
      item.syncEnabled === null ? null : Number(item.syncEnabled), item.sourceModifiedAt,
      json(item.rawPayload), runId, ingestedAt
    ]);
    await batchUpsert(this.pool, `INSERT INTO ods_wln_shops (
      company_id, shop_uid, source_company_id, shop_nick, shop_name, shop_type, shop_sub_type,
      status, group_uid, group_name, sync_enabled, source_modified_at, raw_payload, sync_run_id, ingested_at
    ) VALUES `, values, ` ON DUPLICATE KEY UPDATE
      source_company_id=VALUES(source_company_id), shop_nick=VALUES(shop_nick), shop_name=VALUES(shop_name),
      shop_type=VALUES(shop_type), shop_sub_type=VALUES(shop_sub_type), status=VALUES(status),
      group_uid=VALUES(group_uid), group_name=VALUES(group_name), sync_enabled=VALUES(sync_enabled),
      source_modified_at=VALUES(source_modified_at), raw_payload=VALUES(raw_payload),
      sync_run_id=VALUES(sync_run_id), ingested_at=VALUES(ingested_at)`);
    return records.length;
  }

  async upsertProducts(companyId: string, records: NormalizedProduct[], runId: string) {
    if (!records.length) return 0;
    const ingestedAt = mysqlDateInShanghai(new Date());
    const values = records.map((item) => [
      companyId, item.skuCode, item.goodsCode, item.goodsName, item.specName, item.barCode,
      item.sourceGoodsUid, item.sourceSpecUid, item.status, item.sourceModifiedAt,
      json(item.rawPayload), runId, ingestedAt
    ]);
    await batchUpsert(this.pool, `INSERT INTO ods_wln_products (
      company_id, sku_code, goods_code, goods_name, spec_name, bar_code, source_goods_uid,
      source_spec_uid, status, source_modified_at, raw_payload, sync_run_id, ingested_at
    ) VALUES `, values, ` ON DUPLICATE KEY UPDATE
      goods_code=VALUES(goods_code), goods_name=VALUES(goods_name), spec_name=VALUES(spec_name),
      bar_code=VALUES(bar_code), source_goods_uid=VALUES(source_goods_uid), source_spec_uid=VALUES(source_spec_uid),
      status=VALUES(status), source_modified_at=VALUES(source_modified_at), raw_payload=VALUES(raw_payload),
      sync_run_id=VALUES(sync_run_id), ingested_at=VALUES(ingested_at)`);
    return records.length;
  }

  async upsertInventory(companyId: string, records: NormalizedInventory[], runId: string) {
    if (!records.length) return 0;
    const ingestedAt = mysqlDateInShanghai(new Date());
    const values = records.map((item) => [
      companyId, item.storageCode, item.skuCode, item.goodsCode, item.articleNumber, item.barCode,
      item.specName, item.actualQuantity, item.lockedQuantity, item.inTransitQuantity,
      item.defectQuantity, item.lockedDefectQuantity, item.inTransitDefectQuantity, item.totalCost,
      item.snapshotAt, json(item.rawPayload), runId, ingestedAt
    ]);
    await batchUpsert(this.pool, `INSERT INTO ods_wln_inventory_current (
      company_id, storage_code, sku_code, goods_code, article_number, bar_code, spec_name,
      actual_quantity, locked_quantity, in_transit_quantity, defect_quantity, locked_defect_quantity,
      in_transit_defect_quantity, total_cost, snapshot_at, raw_payload, sync_run_id, ingested_at
    ) VALUES `, values, ` ON DUPLICATE KEY UPDATE
      goods_code=VALUES(goods_code), article_number=VALUES(article_number), bar_code=VALUES(bar_code),
      spec_name=VALUES(spec_name), actual_quantity=VALUES(actual_quantity), locked_quantity=VALUES(locked_quantity),
      in_transit_quantity=VALUES(in_transit_quantity), defect_quantity=VALUES(defect_quantity),
      locked_defect_quantity=VALUES(locked_defect_quantity), in_transit_defect_quantity=VALUES(in_transit_defect_quantity),
      total_cost=VALUES(total_cost), snapshot_at=VALUES(snapshot_at), raw_payload=VALUES(raw_payload),
      sync_run_id=VALUES(sync_run_id), ingested_at=VALUES(ingested_at)`);
    return records.length;
  }

  async upsertOutbound(companyId: string, records: NormalizedOutbound[], runId: string) {
    if (!records.length) return 0;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const ingestedAt = mysqlDateInShanghai(new Date());
      const headers = records.map((item) => [
        companyId, item.outboundUid, item.outboundNo, item.externalOrderNo, item.billDate, item.billType,
        item.shopId, item.shopNick, item.shopName, item.shopSource, item.shopType, item.storageCode,
        item.storageName, item.grossAmount, item.paidAmount, item.actualPayment, item.discountAmount,
        item.postageAmount, item.currencyCode, item.sourceModifiedAt, json(item.rawPayload), runId, ingestedAt
      ]);
      await batchUpsert(connection, `INSERT INTO ods_wln_sale_outbound (
        company_id, outbound_uid, outbound_no, external_order_no, bill_date, bill_type, shop_id,
        shop_nick, shop_name, shop_source, shop_type, storage_code, storage_name, gross_amount,
        paid_amount, actual_payment, discount_amount, postage_amount, currency_code,
        source_modified_at, raw_payload, sync_run_id, ingested_at
      ) VALUES `, headers, ` ON DUPLICATE KEY UPDATE
        outbound_no=VALUES(outbound_no), external_order_no=VALUES(external_order_no), bill_date=VALUES(bill_date),
        bill_type=VALUES(bill_type), shop_id=VALUES(shop_id), shop_nick=VALUES(shop_nick), shop_name=VALUES(shop_name),
        shop_source=VALUES(shop_source), shop_type=VALUES(shop_type), storage_code=VALUES(storage_code),
        storage_name=VALUES(storage_name), gross_amount=VALUES(gross_amount), paid_amount=VALUES(paid_amount),
        actual_payment=VALUES(actual_payment), discount_amount=VALUES(discount_amount),
        postage_amount=VALUES(postage_amount), currency_code=VALUES(currency_code),
        source_modified_at=VALUES(source_modified_at), raw_payload=VALUES(raw_payload),
        sync_run_id=VALUES(sync_run_id), ingested_at=VALUES(ingested_at)`);
      await deleteChildren(connection, "ods_wln_sale_outbound_items", "outbound_uid", companyId, records.map((item) => item.outboundUid));
      const items = records.flatMap((header) => header.items.map((item) => [
        companyId, header.outboundUid, item.lineKey, item.sourceDetailId, item.goodsUid, item.skuUid,
        item.skuCode, item.barCode, item.goodsName, item.skuName, item.quantity, item.unit, item.salePrice,
        item.grossAmount, item.actualPaidAmount, item.discountAmount, item.costAmount,
        item.isPackage === null ? null : Number(item.isPackage), json(item.rawPayload), runId, ingestedAt
      ]));
      if (items.length) await batchInsert(connection, `INSERT INTO ods_wln_sale_outbound_items (
        company_id, outbound_uid, line_key, source_detail_id, goods_uid, sku_uid, sku_code, bar_code,
        goods_name, sku_name, quantity, unit, sale_price, gross_amount, actual_paid_amount,
        discount_amount, cost_amount, is_package, raw_payload, sync_run_id, ingested_at
      ) VALUES `, items);
      await connection.commit();
      return records.length;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async upsertInbound(companyId: string, records: NormalizedInbound[], runId: string) {
    if (!records.length) return 0;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const ingestedAt = mysqlDateInShanghai(new Date());
      const headers = records.map((item) => [
        companyId, item.stockCode, "PURCHASE", item.externalReceiptNo, item.billDate, item.createdAtSource,
        item.approvedAt, item.storageCode, item.storageName, item.supplierCode, item.supplierName,
        item.settlementStatus, item.billStatus, item.totalAmount, item.taxAmount, item.currencyCode,
        item.sourceModifiedAt, json(item.rawPayload), runId, ingestedAt
      ]);
      await batchUpsert(connection, `INSERT INTO ods_wln_purchase_inbound (
        company_id, stock_code, inbound_type, external_receipt_no, bill_date, created_at_source,
        approved_at, storage_code, storage_name, supplier_code, supplier_name, settlement_status,
        bill_status, total_amount, tax_amount, currency_code, source_modified_at, raw_payload,
        sync_run_id, ingested_at
      ) VALUES `, headers, ` ON DUPLICATE KEY UPDATE
        inbound_type=VALUES(inbound_type), external_receipt_no=VALUES(external_receipt_no), bill_date=VALUES(bill_date),
        created_at_source=VALUES(created_at_source), approved_at=VALUES(approved_at), storage_code=VALUES(storage_code),
        storage_name=VALUES(storage_name), supplier_code=VALUES(supplier_code), supplier_name=VALUES(supplier_name),
        settlement_status=VALUES(settlement_status), bill_status=VALUES(bill_status),
        total_amount=VALUES(total_amount), tax_amount=VALUES(tax_amount), currency_code=VALUES(currency_code),
        source_modified_at=VALUES(source_modified_at), raw_payload=VALUES(raw_payload),
        sync_run_id=VALUES(sync_run_id), ingested_at=VALUES(ingested_at)`);
      await deleteChildren(connection, "ods_wln_purchase_inbound_items", "stock_code", companyId, records.map((item) => item.stockCode));
      const items = records.flatMap((header) => header.items.map((item) => [
        companyId, header.stockCode, item.lineNo, item.skuCode, item.barCode, item.goodsName,
        item.specName, item.quantity, item.unit, item.unitPrice, item.totalAmount, item.taxAmount,
        item.inventoryType, item.batchCode, item.productionDate, item.expiryDate,
        json(item.rawPayload), runId, ingestedAt
      ]));
      if (items.length) await batchInsert(connection, `INSERT INTO ods_wln_purchase_inbound_items (
        company_id, stock_code, line_no, sku_code, bar_code, goods_name, spec_name, quantity,
        unit, unit_price, total_amount, tax_amount, inventory_type, batch_code, production_date,
        expiry_date, raw_payload, sync_run_id, ingested_at
      ) VALUES `, items);
      await connection.commit();
      return records.length;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getManagementDashboardFacts(companyId: string, reportDate: string): Promise<ManagementDashboardFacts> {
    const start = `${reportDate} 00:00:00`;
    const end = `${nextDate(reportDate)} 00:00:00`;
    const trendStart = `${addDays(reportDate, -29)} 00:00:00`;
    const [salesRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(SUM(gross_amount), 0) gmv, COALESCE(SUM(actual_payment), 0) actual_payment, COUNT(*) orders
       FROM ods_wln_sale_outbound WHERE company_id = ? AND bill_date >= ? AND bill_date < ?`,
      [companyId, start, end]
    );
    const [unitRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(SUM(i.quantity), 0) units
       FROM ods_wln_sale_outbound_items i
       JOIN ods_wln_sale_outbound h ON h.company_id = i.company_id AND h.outbound_uid = i.outbound_uid
       WHERE h.company_id = ? AND h.bill_date >= ? AND h.bill_date < ?`,
      [companyId, start, end]
    );
    const [trendRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT DATE_FORMAT(bill_date, '%Y-%m-%d') date, COALESCE(SUM(gross_amount), 0) gmv, COUNT(*) orders
       FROM ods_wln_sale_outbound WHERE company_id = ? AND bill_date >= ? AND bill_date < ?
       GROUP BY DATE(bill_date) ORDER BY DATE(bill_date)`,
      [companyId, trendStart, end]
    );
    const [shopRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(h.shop_name, h.shop_nick, '未命名店铺') name, COALESCE(h.shop_source, '') source,
              COALESCE(SUM(h.gross_amount), 0) gmv, COUNT(*) orders,
              COALESCE((SELECT SUM(i.quantity) FROM ods_wln_sale_outbound_items i
                JOIN ods_wln_sale_outbound ih ON ih.company_id=i.company_id AND ih.outbound_uid=i.outbound_uid
                WHERE ih.company_id=h.company_id AND ih.bill_date>=? AND ih.bill_date<?
                  AND COALESCE(ih.shop_name, ih.shop_nick, '未命名店铺')=COALESCE(h.shop_name, h.shop_nick, '未命名店铺')), 0) units
       FROM ods_wln_sale_outbound h WHERE h.company_id = ? AND h.bill_date >= ? AND h.bill_date < ?
       GROUP BY COALESCE(h.shop_name, h.shop_nick, '未命名店铺'), COALESCE(h.shop_source, '')
       ORDER BY gmv DESC LIMIT 20`,
      [start, end, companyId, start, end]
    );
    const [productRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(NULLIF(i.sku_code, ''), NULLIF(i.bar_code, ''), '未编码') sku_code,
              COALESCE(NULLIF(i.goods_name, ''), NULLIF(i.sku_name, ''), '未命名商品') name,
              COALESCE(SUM(i.gross_amount), 0) gmv, COALESCE(SUM(i.quantity), 0) units
       FROM ods_wln_sale_outbound_items i
       JOIN ods_wln_sale_outbound h ON h.company_id=i.company_id AND h.outbound_uid=i.outbound_uid
       WHERE h.company_id=? AND h.bill_date>=? AND h.bill_date<?
       GROUP BY COALESCE(NULLIF(i.sku_code, ''), NULLIF(i.bar_code, ''), '未编码'),
                COALESCE(NULLIF(i.goods_name, ''), NULLIF(i.sku_name, ''), '未命名商品')
       ORDER BY gmv DESC LIMIT 20`,
      [companyId, start, end]
    );
    const [inventoryRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT i.sku_code, COALESCE(NULLIF(p.goods_name, ''), NULLIF(i.spec_name, ''), i.sku_code) name,
              COALESCE(SUM(i.actual_quantity), 0) units, COALESCE(SUM(i.locked_quantity), 0) locked_units,
              COALESCE(SUM(i.in_transit_quantity), 0) in_transit_units
       FROM ods_wln_inventory_current i
       LEFT JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code
       WHERE i.company_id=? GROUP BY i.sku_code, COALESCE(NULLIF(p.goods_name, ''), NULLIF(i.spec_name, ''), i.sku_code)
       ORDER BY units DESC LIMIT 20`,
      [companyId]
    );
    const [inventorySummaryRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(SUM(actual_quantity), 0) units, COUNT(DISTINCT sku_code) skus,
              COALESCE(SUM(locked_quantity), 0) locked_units
       FROM ods_wln_inventory_current WHERE company_id=?`,
      [companyId]
    );
    const [inboundRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) inbound_orders FROM ods_wln_purchase_inbound
       WHERE company_id=? AND bill_date>=? AND bill_date<?`,
      [companyId, start, end]
    );
    const [inboundUnitRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(SUM(i.quantity), 0) inbound_units
       FROM ods_wln_purchase_inbound_items i
       JOIN ods_wln_purchase_inbound h ON h.company_id=i.company_id AND h.stock_code=i.stock_code
       WHERE h.company_id=? AND h.bill_date>=? AND h.bill_date<?`,
      [companyId, start, end]
    );
    const [statusRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT resource_name resource,
              COALESCE(JSON_UNQUOTE(JSON_EXTRACT(cursor_json, '$.modifiedThrough')), '') modified_through,
              DATE_FORMAT(last_success_at, '%Y-%m-%d %H:%i:%s') last_success_at
       FROM data_sync_cursors WHERE connector_id='wanliniu' ORDER BY resource_name`
    );
    const sales = salesRows[0] ?? {};
    const orders = number(sales.orders);
    const trend = trendRows.map((row) => ({ date: String(row.date), gmv: number(row.gmv), orders: number(row.orders) }));
    const trendDays = 30;
    return {
      reportDate,
      summary: {
        gmv: number(sales.gmv),
        actualPayment: number(sales.actual_payment),
        orders,
        units: number(unitRows[0]?.units),
        averageOrderValue: orders ? number(sales.gmv) / orders : 0,
        inboundOrders: number(inboundRows[0]?.inbound_orders),
        inboundUnits: number(inboundUnitRows[0]?.inbound_units),
        inventoryUnits: number(inventorySummaryRows[0]?.units),
        inventorySkus: number(inventorySummaryRows[0]?.skus),
        lockedInventoryUnits: number(inventorySummaryRows[0]?.locked_units),
        thirtyDayDailyAverageGmv: trend.reduce((sum, item) => sum + item.gmv, 0) / trendDays,
        thirtyDayDailyAverageOrders: trend.reduce((sum, item) => sum + item.orders, 0) / trendDays
      },
      dailyTrend: trend,
      shops: shopRows.map((row) => ({ name: String(row.name), source: String(row.source), gmv: number(row.gmv), orders: number(row.orders), units: number(row.units) })),
      products: productRows.map((row) => ({ skuCode: String(row.sku_code), name: String(row.name), gmv: number(row.gmv), units: number(row.units) })),
      inventory: inventoryRows.map((row) => ({ skuCode: String(row.sku_code), name: String(row.name), units: number(row.units), lockedUnits: number(row.locked_units), inTransitUnits: number(row.in_transit_units) })),
      dataStatus: statusRows.map((row) => ({ resource: String(row.resource), modifiedThrough: String(row.modified_through), lastSuccessAt: String(row.last_success_at) }))
    };
  }
}

type SqlExecutor = mysql.Pool | mysql.PoolConnection;

async function batchUpsert(executor: SqlExecutor, prefix: string, rows: unknown[][], suffix: string) {
  for (const chunk of chunks(rows, 100)) {
    const placeholders = chunk.map((row) => `(${row.map(() => "?").join(",")})`).join(",");
    await executor.execute(`${prefix}${placeholders}${suffix}`, chunk.flat() as any[]);
  }
}

async function batchInsert(executor: SqlExecutor, prefix: string, rows: unknown[][]) {
  for (const chunk of chunks(rows, 100)) {
    const placeholders = chunk.map((row) => `(${row.map(() => "?").join(",")})`).join(",");
    await executor.execute(`${prefix}${placeholders}`, chunk.flat() as any[]);
  }
}

async function deleteChildren(
  connection: mysql.PoolConnection,
  table: "ods_wln_sale_outbound_items" | "ods_wln_purchase_inbound_items",
  key: "outbound_uid" | "stock_code",
  companyId: string,
  ids: string[]
) {
  for (const chunk of chunks(ids, 200)) {
    await connection.execute(
      `DELETE FROM ${table} WHERE company_id = ? AND ${key} IN (${chunk.map(() => "?").join(",")})`,
      [companyId, ...chunk]
    );
  }
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function json(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function nextDate(date: string) {
  return addDays(date, 1);
}

async function createDataPlatformStore(): Promise<DataPlatformStore> {
  const provider = process.env.DATA_DB_PROVIDER?.trim()
    || (process.env.DB_PROVIDER === "mysql" ? "mysql" : "disabled");
  if (provider !== "mysql") {
    return new UnavailableDataPlatformStore({
      configured: false,
      ready: false,
      provider: "disabled",
      message: "经营数据库未启用；生产环境请配置 DATA_DB_PROVIDER=mysql"
    });
  }
  const database = process.env.DATA_MYSQL_DATABASE?.trim() || "gplan_data";
  const pool = mysql.createPool({
    host: process.env.DATA_MYSQL_HOST?.trim() || process.env.MYSQL_HOST,
    port: Number(process.env.DATA_MYSQL_PORT ?? process.env.MYSQL_PORT ?? 3306),
    user: process.env.DATA_MYSQL_USER?.trim() || process.env.MYSQL_USER,
    password: process.env.DATA_MYSQL_PASSWORD ?? process.env.MYSQL_PASSWORD,
    database,
    waitForConnections: true,
    connectionLimit: Math.max(1, Number(process.env.DATA_MYSQL_CONNECTION_LIMIT ?? 5)),
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
      message: `经营数据库 ${database} 连接失败或表结构不完整`
    });
  }
}

export const dataPlatformStore = await createDataPlatformStore();
