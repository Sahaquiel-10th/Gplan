import mysql from "mysql2/promise";
import {createHash} from 'node:crypto';
import type {
  NormalizedInbound,
  NormalizedInventory,
  NormalizedOutbound,
  NormalizedProduct,
  NormalizedShop
} from "./data-connectors/wanliniu/mappers.js";
import { mysqlDateInShanghai } from "./data-connectors/wanliniu/mappers.js";
import {canonicalInventoryRows,MissingInventoryIdentityError} from './inventoryIdentity.js';
import {captureInventorySnapshot} from './inventorySnapshots.js';

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
  captureInventorySnapshot?(companyId:string,observedAt:string):Promise<unknown>;
  inventoryReconciliationSkus?(companyId:string):Promise<string[]>;
  assertInventoryReconciled?(companyId:string,runId:string):Promise<string[]|void>;
  acquireSyncLease?(companyId:string):Promise<()=>Promise<void>>;
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

export class MySqlDataPlatformStore implements DataPlatformStore {
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
      "ods_wln_purchase_inbound_items",
      "data_inventory_identity_archive","data_product_identity_aliases","data_inventory_report_snapshots"
    ];
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${required.map(() => "?").join(",")})`,
      [this.database, ...required]
    );
    const existing = new Set(rows.map((row) => String(row.TABLE_NAME)));
    const missing = required.filter((name) => !existing.has(name));
    if (missing.length) throw new Error(`经营数据库缺少表：${missing.join("、")}`);
    const[identity]=await this.pool.query<mysql.RowDataPacket[]>("SHOW INDEX FROM ods_wln_inventory_current WHERE Key_name='uniq_wln_inventory_spec'");
    if(!identity.length)throw new Error('库存稳定身份迁移未执行，禁止启用旧同步逻辑');
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
    const normalizedCodes=new Map<string,string|null>();
    for(const r of records){const k=r.skuCode.normalize('NFKC').toLowerCase();if(normalizedCodes.has(k)&&normalizedCodes.get(k)!==r.sourceSpecUid)throw new Error('规格编码存在大小写或字符宽度冲突，禁止覆盖不同商品身份');normalizedCodes.set(k,r.sourceSpecUid);}
    const requested=records.map(()=>"SELECT ? sku_code").join(' UNION ALL ');
    const[prior]=await this.pool.query<mysql.RowDataPacket[]>(`SELECT r.sku_code requested_sku,p.sku_code,p.source_spec_uid FROM (${requested}) r JOIN ods_wln_products p ON p.company_id=? AND p.sku_code=r.sku_code COLLATE utf8mb4_unicode_ci`,[...records.map(r=>r.skuCode),companyId]);
    for(const p of prior){const incoming=records.find(r=>r.skuCode===p.requested_sku)!;if(p.sku_code!==incoming.skuCode&&p.source_spec_uid&&incoming.sourceSpecUid&&p.source_spec_uid!==incoming.sourceSpecUid)throw new Error('规格编码排序规则冲突，禁止混合不同系统规格');}
    // Preserve observed codes/names/barcodes before a mutable source row changes.
    await this.pool.query(`INSERT IGNORE INTO data_product_identity_aliases(company_id,source_spec_uid,alias_sha256,sku_code,bar_code,goods_name,source_modified_at)
      SELECT company_id,source_spec_uid,SHA2(CAST(JSON_ARRAY(sku_code,bar_code,goods_name) AS CHAR),256),sku_code,bar_code,goods_name,source_modified_at FROM ods_wln_products WHERE company_id=? AND sku_code IN (?) AND source_spec_uid IS NOT NULL AND source_spec_uid<>''`,[companyId,records.map(r=>r.skuCode)]);
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
      sku_code=VALUES(sku_code),goods_code=VALUES(goods_code), goods_name=VALUES(goods_name), spec_name=VALUES(spec_name),
      bar_code=VALUES(bar_code), source_goods_uid=VALUES(source_goods_uid), source_spec_uid=VALUES(source_spec_uid),
      status=VALUES(status), source_modified_at=VALUES(source_modified_at), raw_payload=VALUES(raw_payload),
      sync_run_id=VALUES(sync_run_id), ingested_at=VALUES(ingested_at)`);
    await this.pool.query(`INSERT IGNORE INTO data_product_identity_aliases(company_id,source_spec_uid,alias_sha256,sku_code,bar_code,goods_name,source_modified_at)
      SELECT company_id,source_spec_uid,SHA2(CAST(JSON_ARRAY(sku_code,bar_code,goods_name) AS CHAR),256),sku_code,bar_code,goods_name,source_modified_at FROM ods_wln_products WHERE company_id=? AND sku_code IN (?) AND source_spec_uid IS NOT NULL AND source_spec_uid<>''`,[companyId,records.map(r=>r.skuCode)]);
    return records.length;
  }

  async upsertInventory(companyId: string, records: NormalizedInventory[], runId: string) {
    if (!records.length) return 0;
    const skus=[...new Set(records.map(r=>r.skuCode))];
    const requested=skus.map(()=>"SELECT ? sku_code").join(' UNION ALL ');
    const[products]=await this.pool.query<mysql.RowDataPacket[]>(`SELECT r.sku_code requested_sku,p.sku_code,source_spec_uid,DATE_FORMAT(source_modified_at,'%Y-%m-%d %H:%i:%s.%f') source_modified_at FROM (${requested}) r JOIN ods_wln_products p ON p.company_id=? AND p.sku_code=r.sku_code COLLATE utf8mb4_unicode_ci`,[...skus,companyId]);
    const metadata=new Map(products.map(p=>[String(p.requested_sku),p]));
    const usable=records.filter(r=>!(r.skuCode==='已删除商品'&&r.actualQuantity===0&&r.defectQuantity===0&&r.lockedQuantity===0));
    const missing=[...new Set(usable.filter(r=>!metadata.get(r.skuCode)?.source_spec_uid).map(r=>r.skuCode))];
    if(missing.length)throw new MissingInventoryIdentityError(missing);
    if(!usable.length)return 0;
    const selected=canonicalInventoryRows(usable.map(original=>{const p=metadata.get(original.skuCode)!;const item={...original,skuCode:String(p.sku_code)};return{company_id:companyId,storage_code:item.storageCode,sku_code:item.skuCode,source_spec_uid:String(p.source_spec_uid),product_modified:String(p.source_modified_at||''),snapshot_at:item.snapshotAt,actual_quantity:item.actualQuantity,item};})).kept;
    const connection=await this.pool.getConnection();
    const lock='inventory-write:'+createHash('sha256').update(companyId).digest('hex').slice(0,40);
    let locked=false;
    try{
    const[acquired]=await connection.query<mysql.RowDataPacket[]>('SELECT GET_LOCK(?,15) acquired',[lock]);locked=Number(acquired[0]?.acquired)===1;
    if(!locked)throw new Error('库存身份更新繁忙，请稍后重试');
    await connection.beginTransaction();
    const[existing]=await connection.query<mysql.RowDataPacket[]>(`SELECT i.*,DATE_FORMAT(i.snapshot_at,'%Y-%m-%d %H:%i:%s.%f') snapshot_at,DATE_FORMAT(p.source_modified_at,'%Y-%m-%d %H:%i:%s.%f') product_modified FROM ods_wln_inventory_current i LEFT JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code WHERE i.company_id=? AND (i.source_spec_uid IN (?) OR i.sku_code IN (?)) FOR UPDATE`,[companyId,selected.map(r=>r.source_spec_uid),skus]);
    const archive=async(row:mysql.RowDataPacket,reason:string)=>{
      const raw=json(row);await connection.execute(`INSERT IGNORE INTO data_inventory_identity_archive(company_id,storage_code,source_spec_uid,sku_code,payload_sha256,row_json,reason) VALUES(?,?,?,?,SHA2(?,256),?,?)`,[companyId,row.storage_code,row.source_spec_uid,row.sku_code,raw,raw,reason]);
    };
    const accepted=selected.filter(r=>{
      const prior=existing.find(x=>x.storage_code===r.storage_code&&x.source_spec_uid===r.source_spec_uid);
      return !prior || (String(prior.snapshot_at).slice(0,23)<=r.snapshot_at.slice(0,23) && (prior.sku_code===r.sku_code||String(prior.product_modified||'')<=r.product_modified));
    });
    for(const row of accepted){
      for(const prior of existing.filter(x=>x.storage_code===row.storage_code&&((x.source_spec_uid===row.source_spec_uid&&x.sku_code!==row.sku_code)||(x.sku_code===row.sku_code&&x.source_spec_uid!==row.source_spec_uid)))){
        await archive(prior,prior.source_spec_uid===row.source_spec_uid?'sku_renamed':'sku_reused');
        if(prior.source_spec_uid!==row.source_spec_uid)await connection.execute('DELETE FROM ods_wln_inventory_current WHERE company_id=? AND storage_code=? AND sku_code=?',[companyId,prior.storage_code,prior.sku_code]);
      }
    }
    const ingestedAt = mysqlDateInShanghai(new Date());
    const values = accepted.map(({item,source_spec_uid}) => [
      companyId, item.storageCode, item.skuCode, item.goodsCode, item.articleNumber, item.barCode,
      item.specName, item.actualQuantity, item.lockedQuantity, item.inTransitQuantity,
      item.defectQuantity, item.lockedDefectQuantity, item.inTransitDefectQuantity, item.totalCost,
      item.snapshotAt, json(item.rawPayload), runId, ingestedAt,source_spec_uid
    ]);
    if(values.length)await batchUpsert(connection, `INSERT INTO ods_wln_inventory_current (
      company_id, storage_code, sku_code, goods_code, article_number, bar_code, spec_name,
      actual_quantity, locked_quantity, in_transit_quantity, defect_quantity, locked_defect_quantity,
      in_transit_defect_quantity, total_cost, snapshot_at, raw_payload, sync_run_id, ingested_at,source_spec_uid
    ) VALUES `, values, ` ON DUPLICATE KEY UPDATE
      sku_code=VALUES(sku_code),source_spec_uid=VALUES(source_spec_uid),goods_code=VALUES(goods_code), article_number=VALUES(article_number), bar_code=VALUES(bar_code),
      spec_name=VALUES(spec_name), actual_quantity=VALUES(actual_quantity), locked_quantity=VALUES(locked_quantity),
      in_transit_quantity=VALUES(in_transit_quantity), defect_quantity=VALUES(defect_quantity),
      locked_defect_quantity=VALUES(locked_defect_quantity), in_transit_defect_quantity=VALUES(in_transit_defect_quantity),
      total_cost=VALUES(total_cost), snapshot_at=VALUES(snapshot_at), raw_payload=VALUES(raw_payload),
      sync_run_id=VALUES(sync_run_id), ingested_at=VALUES(ingested_at)`);
    await connection.commit();
    return accepted.length;
    }catch(error){await connection.rollback();throw error;}
    finally{if(locked)await connection.query('SELECT RELEASE_LOCK(?)',[lock]).catch(()=>undefined);connection.release();}
  }

  async captureInventorySnapshot(companyId:string,observedAt:string){return captureInventorySnapshot(this.pool,companyId,observedAt);}

  async inventoryReconciliationSkus(companyId:string){
    const[rows]=await this.pool.execute<mysql.RowDataPacket[]>(`SELECT p.sku_code,p.source_spec_uid,p.source_modified_at,p.status,
      EXISTS(SELECT 1 FROM ods_wln_inventory_current x WHERE x.company_id=p.company_id AND x.source_spec_uid=p.source_spec_uid AND x.storage_code IN ('CK001','CK008') AND (x.actual_quantity<>0 OR x.locked_quantity<>0 OR x.in_transit_quantity<>0 OR x.defect_quantity<>0)) has_stock
      FROM ods_wln_products p WHERE p.company_id=? AND p.source_spec_uid IN (SELECT i.source_spec_uid FROM ods_wln_inventory_current i WHERE i.company_id=? AND i.storage_code IN ('CK001','CK008') AND i.source_spec_uid IS NOT NULL) ORDER BY p.ingested_at DESC,p.source_modified_at DESC,p.sku_code DESC`,[companyId,companyId]);
    const canonical=new Map<string,mysql.RowDataPacket>();for(const r of rows)if(!canonical.has(r.source_spec_uid))canonical.set(r.source_spec_uid,r);
    return [...canonical.values()].filter(r=>Number(r.status)===1||Number(r.has_stock)>0).map(r=>String(r.sku_code));
  }
  async acquireSyncLease(companyId:string){
    const connection=await this.pool.getConnection();
    const lock='wanliniu-sync:'+createHash('sha256').update(companyId).digest('hex').slice(0,40);
    try{const[r]=await connection.query<mysql.RowDataPacket[]>('SELECT GET_LOCK(?,0) acquired',[lock]);if(Number(r[0]?.acquired)!==1)throw new Error('该企业的万里牛同步正在其他进程运行');}
    catch(error){connection.release();throw error;}
    return async()=>{try{await connection.query('SELECT RELEASE_LOCK(?)',[lock]);}finally{connection.release();}};
  }
  async assertInventoryReconciled(companyId:string,runId:string){
    const[missing]=await this.pool.execute<mysql.RowDataPacket[]>(`SELECT i.*,p.status product_status,
      JSON_UNQUOTE(JSON_EXTRACT(p.raw_payload,'$.goods.brand_name')) brand_name
      FROM ods_wln_inventory_current i LEFT JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code
      WHERE i.company_id=? AND i.storage_code IN ('CK001','CK008') AND i.source_spec_uid IS NOT NULL
      AND i.sync_run_id<>? AND (i.actual_quantity<>0 OR i.locked_quantity<>0 OR i.in_transit_quantity<>0 OR i.defect_quantity<>0)`,[companyId,runId]);
    // A provider may omit stopped products even in an explicit-SKU query. Keep
    // their last observation and audit the omission; never manufacture a zero.
    // Such omissions outside this report's brand must not block its publication.
    for(const row of missing){const raw=json({...row,reconciliation_run_id:runId});await this.pool.execute(
      `INSERT IGNORE INTO data_inventory_identity_archive(company_id,storage_code,source_spec_uid,sku_code,payload_sha256,row_json,reason) VALUES(?,?,?,?,SHA2(?,256),?,?)`,
      [companyId,row.storage_code,row.source_spec_uid,row.sku_code,raw,raw,'source_omitted_inventory']);}
    const blocking=missing.filter(r=>r.product_status===null||Number(r.product_status)!==0||!r.brand_name||r.brand_name==='薇诺娜');
    if(blocking.length)throw new Error('库存全量校验存在未返回的非零记录，禁止以零库存替代：'+blocking.slice(0,20).map(r=>r.storage_code+'/'+r.sku_code).join('、'));
    const warnings=missing.map(r=>'停用商品未返回当前库存，已保留原始观察并留痕：'+r.storage_code+'/'+r.sku_code);
    if(warnings.length)console.warn(JSON.stringify({event:'inventory_source_omissions',runId,warnings}));
    return warnings;
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
       FROM ods_wln_sale_outbound FORCE INDEX (idx_wln_sale_outbound_dashboard)
       WHERE company_id = ? AND bill_date >= ? AND bill_date < ?`,
      [companyId, start, end]
    );
    const [unitRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(SUM(i.quantity), 0) units
       FROM ods_wln_sale_outbound h FORCE INDEX (idx_wln_sale_outbound_bill_date)
       STRAIGHT_JOIN ods_wln_sale_outbound_items i ON i.company_id = h.company_id AND i.outbound_uid = h.outbound_uid
       WHERE h.company_id = ? AND h.bill_date >= ? AND h.bill_date < ?`,
      [companyId, start, end]
    );
    const [trendRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT DATE_FORMAT(bill_date, '%Y-%m-%d') date, COALESCE(SUM(gross_amount), 0) gmv, COUNT(*) orders
       FROM ods_wln_sale_outbound FORCE INDEX (idx_wln_sale_outbound_dashboard)
       WHERE company_id = ? AND bill_date >= ? AND bill_date < ?
       GROUP BY DATE_FORMAT(bill_date, '%Y-%m-%d') ORDER BY DATE_FORMAT(bill_date, '%Y-%m-%d')`,
      [companyId, trendStart, end]
    );
    const [shopRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(h.shop_name, h.shop_nick, '未命名店铺') name, COALESCE(h.shop_source, '') source,
              COALESCE(SUM(h.gross_amount), 0) gmv, COUNT(*) orders
       FROM ods_wln_sale_outbound h FORCE INDEX (idx_wln_sale_outbound_bill_date)
       WHERE h.company_id = ? AND h.bill_date >= ? AND h.bill_date < ?
       GROUP BY COALESCE(h.shop_name, h.shop_nick, '未命名店铺'), COALESCE(h.shop_source, '')
       ORDER BY gmv DESC LIMIT 20`,
      [companyId, start, end]
    );
    const [shopUnitRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(h.shop_name, h.shop_nick, '未命名店铺') name, COALESCE(h.shop_source, '') source,
              COALESCE(SUM(i.quantity), 0) units
       FROM ods_wln_sale_outbound h FORCE INDEX (idx_wln_sale_outbound_bill_date)
       STRAIGHT_JOIN ods_wln_sale_outbound_items i ON i.company_id=h.company_id AND i.outbound_uid=h.outbound_uid
       WHERE h.company_id=? AND h.bill_date>=? AND h.bill_date<?
       GROUP BY COALESCE(h.shop_name, h.shop_nick, '未命名店铺'), COALESCE(h.shop_source, '')`,
      [companyId, start, end]
    );
    const [productRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(NULLIF(i.sku_code, ''), NULLIF(i.bar_code, ''), '未编码') sku_code,
              COALESCE(NULLIF(i.goods_name, ''), NULLIF(i.sku_name, ''), '未命名商品') name,
              COALESCE(SUM(i.gross_amount), 0) gmv, COALESCE(SUM(i.quantity), 0) units
       FROM ods_wln_sale_outbound h FORCE INDEX (idx_wln_sale_outbound_bill_date)
       STRAIGHT_JOIN ods_wln_sale_outbound_items i ON i.company_id=h.company_id AND i.outbound_uid=h.outbound_uid
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
    const shopUnits = new Map(shopUnitRows.map((row) => [JSON.stringify([row.name, row.source]), number(row.units)]));
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
      shops: shopRows.map((row) => ({
        name: String(row.name),
        source: String(row.source),
        gmv: number(row.gmv),
        orders: number(row.orders),
        units: shopUnits.get(JSON.stringify([row.name, row.source])) || 0
      })),
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
