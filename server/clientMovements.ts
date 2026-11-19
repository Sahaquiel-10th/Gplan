import mysql, { type Connection, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { normalizeOutbound, mysqlDateInShanghai } from './data-connectors/wanliniu/mappers.js';
import { wanliniuClient, type WanliniuClient, type WanliniuRecord } from './data-connectors/wanliniu/client.js';
import { uid } from './security.js';

export const movementResources = ['transfer_in', 'transfer_out', 'sales_return'] as const;
export type MovementResource = typeof movementResources[number];
type Db = Pool | PoolConnection | Connection;
type MovementCursor = { modifiedThrough: string; completedAt: string; initialFrom: string; mode: string };
export type MovementCoverage = { status: 'complete' | 'partial' | 'unavailable'; available_from: string | null; synced_through: string | null; unresolved_rows?: number; message?: string };

export async function ensureClientMovementSchema(db: Db) {
  await db.query(`CREATE TABLE IF NOT EXISTS ods_wln_stock_movements (
    company_id VARCHAR(128) NOT NULL,resource VARCHAR(32) NOT NULL,document_no VARCHAR(128) NOT NULL,
    line_key VARCHAR(191) NOT NULL,document_uid VARCHAR(128) NULL,related_transfer_no VARCHAR(512) NULL,
    bill_date DATETIME(3) NOT NULL,storage_code VARCHAR(128) NOT NULL,shop_id VARCHAR(128) NULL,
    sku_code VARCHAR(255) NOT NULL,source_spec_uid VARCHAR(128) NULL,bar_code VARCHAR(128) NULL,
    goods_name VARCHAR(512) NULL,quantity DECIMAL(20,6) NOT NULL,raw_payload JSON NOT NULL,
    source_modified_at DATETIME(3) NULL,sync_run_id VARCHAR(64) NOT NULL,ingested_at DATETIME(3) NOT NULL,
    PRIMARY KEY(company_id,resource,document_no,line_key),
    KEY idx_wln_stock_movement_date(company_id,bill_date,resource),
    KEY idx_wln_stock_movement_spec(company_id,source_spec_uid,bill_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

export function normalizeClientMovement(resource: MovementResource, source: WanliniuRecord) {
  const documentNo = String(resource === 'sales_return' ? source.inv_no || source.inv_uid || '' : source.stock_code || '');
  if (!documentNo) throw new Error(`${resource} 缺少实际出入库单号`);
  if (!Array.isArray(source.details)) throw new Error(`${documentNo} 缺少明细数组`);
  for (const detail of source.details) {
    const quantity = detail?.nums ?? detail?.quantity;
    if (quantity === undefined || quantity === null || quantity === '' || !Number.isFinite(Number(quantity))) throw new Error(`${documentNo} 明细数量缺失或无效`);
  }
  const normalized = normalizeOutbound({ ...source, inv_uid: source.inv_uid || source.bill_uid || documentNo, inv_no: documentNo });
  if (!normalized.billDate || !normalized.storageCode || normalized.items.some(item => !item.skuCode)) throw new Error(`${documentNo} 缺少业务日期、仓库或规格编码`);
  return { ...normalized, documentNo, relatedTransferNo: typeof source.inventory_change_bill_code === 'string' ? source.inventory_change_bill_code : null };
}

export async function writeClientMovements(db: PoolConnection, company: string, resource: MovementResource, records: WanliniuRecord[], runId: string) {
  if (!records.length) return 0;
  const documents = records.map(source => normalizeClientMovement(resource, source));
  const skus = [...new Set(documents.flatMap(document => document.items.map(item => item.skuCode!)))];
  const identities = new Map<string, Set<string>>();
  if (skus.length) {
    const [current] = await db.query<RowDataPacket[]>('SELECT sku_code,source_spec_uid FROM ods_wln_products WHERE company_id=? AND sku_code IN (?)', [company, skus]);
    const [aliases] = await db.query<RowDataPacket[]>('SELECT sku_code,source_spec_uid FROM data_product_identity_aliases WHERE company_id=? AND sku_code IN (?)', [company, skus]);
    const rows = [...current, ...aliases];
    for (const row of rows) {
      if (!row.source_spec_uid) continue;
      const values = identities.get(row.sku_code) || new Set<string>();
      values.add(String(row.source_spec_uid)); identities.set(row.sku_code, values);
    }
  }
  await db.beginTransaction();
  try {
    // The same transfer UID can occur on both sides and on partial receipts.
    // Resource plus the actual DC/DR document number identifies each posting.
    await db.query('DELETE FROM ods_wln_stock_movements WHERE company_id=? AND resource=? AND document_no IN (?)', [company, resource, documents.map(document => document.documentNo)]);
    const now = mysqlDateInShanghai(new Date());
    const rows = documents.flatMap(document => document.items.map(item => {
      const candidates = identities.get(item.skuCode!);
      const specId = item.skuUid || (candidates?.size === 1 ? [...candidates][0] : null);
      return [company, resource, document.documentNo, item.lineKey, document.outboundUid, document.relatedTransferNo,
        document.billDate, document.storageCode, document.shopId, item.skuCode, specId, item.barCode,
        item.goodsName || item.skuName, item.quantity,
        JSON.stringify({ document_no: document.documentNo, related_transfer_no: document.relatedTransferNo, item: item.rawPayload }),
        document.sourceModifiedAt, runId, now];
    }));
    for (let offset = 0; offset < rows.length; offset += 200) {
      const page = rows.slice(offset, offset + 200);
      await db.query(`INSERT INTO ods_wln_stock_movements(company_id,resource,document_no,line_key,document_uid,related_transfer_no,
        bill_date,storage_code,shop_id,sku_code,source_spec_uid,bar_code,goods_name,quantity,raw_payload,source_modified_at,sync_run_id,ingested_at)
        VALUES ${page.map(() => '(' + new Array(18).fill('?').join(',') + ')').join(',')}`, page.flat());
    }
    await db.commit();
    return documents.length;
  } catch (error) { await db.rollback(); throw error; }
}

export async function loadMovementCoverage(db: Db, company: string, date: string): Promise<MovementCoverage> {
  const configuredCompany = process.env.WANLINIU_COMPANY_ID?.trim() || 'company_default';
  if (company !== configuredCompany) return { status: 'unavailable', available_from: null, synced_through: null };
  const [rows] = await db.query<RowDataPacket[]>(`SELECT resource_name,cursor_json FROM data_sync_cursors
    WHERE connector_id='wanliniu' AND resource_name IN ('transfer_in','transfer_out','sales_return') ORDER BY resource_name`);
  const cursors = rows.map(row => typeof row.cursor_json === 'string' ? JSON.parse(row.cursor_json) : row.cursor_json) as MovementCursor[];
  if (cursors.length !== movementResources.length || cursors.some(cursor => !cursor.initialFrom || !cursor.modifiedThrough)) {
    return { status: 'unavailable', available_from: null, synced_through: null, message: '新增调拨、退货数据尚未全部同步完成，未取得的数据不能视为零' };
  }
  const availableFrom = cursors.map(cursor => cursor.initialFrom).sort().at(-1)!;
  const through = cursors.map(cursor => cursor.modifiedThrough).sort()[0];
  const firstDay = new Date(Date.parse(availableFrom) + 8 * 3600000).toISOString().slice(0, 10);
  const lastCompleteDay = new Date(Date.parse(through) + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
  const complete = date >= firstDay && date <= lastCompleteDay;
  return { status: complete ? 'complete' : date < firstDay ? 'unavailable' : 'partial', available_from: firstDay, synced_through: through,
    ...(!complete ? { message: date < firstDay ? '该日期早于新增调拨、退货接口本次可回补的时间范围；缺失不能按零处理' : '该业务日的调拨、退货记录可能尚未同步完整' } : {}) };
}

export class ClientMovementSync {
  constructor(private pool: Pool, private client: WanliniuClient = wanliniuClient, private now = () => new Date()) {}

  async sync(company: string, from?: string) {
    if (company !== (process.env.WANLINIU_COMPANY_ID?.trim() || 'company_default')) throw new Error('该企业没有此万里牛连接器的同步权限');
    await ensureClientMovementSchema(this.pool);
    const db = await this.pool.getConnection();
    let locked = false;
    const summaries: Array<{ resource: MovementResource; documents: number; pages: number }> = [];
    try {
      const [lock] = await db.query<RowDataPacket[]>("SELECT GET_LOCK('gplan-client-stock-movements',10) acquired");
      locked = Number(lock[0]?.acquired) === 1;
      if (!locked) throw new Error('调拨与退货同步任务正在运行');
      const end = new Date(Math.floor(this.now().getTime() / 1000) * 1000);
      const oldest = new Date(Date.parse(mysqlDateInShanghai(end).slice(0, 10) + 'T00:00:00+08:00') - 89 * 86400000);
      for (const resource of movementResources) {
        const [saved] = await db.query<RowDataPacket[]>('SELECT cursor_json FROM data_sync_cursors WHERE connector_id=? AND resource_name=?', ['wanliniu', resource]);
        const cursor: MovementCursor | undefined = saved[0] ? typeof saved[0].cursor_json === 'string' ? JSON.parse(saved[0].cursor_json) : saved[0].cursor_json : undefined;
        const initialFrom = from ? new Date(from + 'T00:00:00+08:00') : cursor?.initialFrom ? new Date(cursor.initialFrom) : oldest;
        let start = from ? initialFrom : cursor?.modifiedThrough ? new Date(Date.parse(cursor.modifiedThrough) - 600000) : initialFrom;
        if (!Number.isFinite(start.getTime()) || start > end || start < oldest) throw new Error('调拨退货同步起止时间无效或超过上游近90天查询范围');
        const runId = uid('movement');
        await db.execute(`INSERT INTO data_sync_runs(id,connector_id,resource_name,sync_mode,status,started_at) VALUES(?,'wanliniu',?,?,'running',NOW(3))`, [runId, resource, cursor ? 'incremental' : 'full']);
        let documents = 0, pages = 0;
        try {
          while (start < end) {
            const stop = new Date(Math.min(start.getTime() + 6 * 86400000, end.getTime()));
            let complete = false;
            for (let firstPage = 1; firstPage <= 5000 && !complete; firstPage += 2) {
              // Only independent reads overlap; database replacement and checkpoints remain sequential.
              const pending = await Promise.allSettled([firstPage, firstPage + 1].map(page => {
                const args = [page, 200, mysqlDateInShanghai(start).slice(0, 19), mysqlDateInShanghai(stop).slice(0, 19)] as const;
                return resource === 'transfer_in' ? this.client.listTransferInbound(...args) : resource === 'transfer_out' ? this.client.listTransferOutbound(...args) : this.client.listSalesReturn(...args);
              }));
              for (let offset = 0; offset < pending.length; offset++) {
                const result = pending[offset];
                // A prefetched page beyond the first short page is outside this window's results.
                if (complete) continue;
                if (result.status === 'rejected') throw result.reason;
                const records = result.value;
                documents += await writeClientMovements(db, company, resource, records, runId); pages++;
                console.log(JSON.stringify({ event: 'client_movement_page', resource, start: mysqlDateInShanghai(start).slice(0, 19), end: mysqlDateInShanghai(stop).slice(0, 19), page: firstPage + offset, records: records.length }));
                if (records.length < 200) complete = true;
              }
            }
            if (!complete) throw new Error('调拨退货同步达到分页上限，游标未越过该时间分片');
            const next: MovementCursor = { initialFrom: initialFrom.toISOString(), modifiedThrough: stop.toISOString(), completedAt: this.now().toISOString(), mode: cursor ? 'incremental' : 'full' };
            await db.execute(`INSERT INTO data_sync_cursors(connector_id,resource_name,cursor_json,last_success_at) VALUES('wanliniu',?,?,NOW(3))
              ON DUPLICATE KEY UPDATE cursor_json=VALUES(cursor_json),last_success_at=VALUES(last_success_at)`, [resource, JSON.stringify(next)]);
            start = stop;
          }
          await db.execute("UPDATE data_sync_runs SET status='success',finished_at=NOW(3),records_read=?,records_written=? WHERE id=?", [documents, documents, runId]);
          summaries.push({ resource, documents, pages });
        } catch (error) {
          await db.execute("UPDATE data_sync_runs SET status='failed',finished_at=NOW(3),error_message=? WHERE id=?", [String((error as Error).message).slice(0, 2000), runId]);
          throw error;
        }
      }
      return summaries;
    } finally {
      if (locked) await db.query("SELECT RELEASE_LOCK('gplan-client-stock-movements')").catch(() => undefined);
      db.release();
    }
  }
}

let sync: ClientMovementSync | undefined;
export async function syncClientMovements(company: string, from?: string) {
  if (process.env.DATA_DB_PROVIDER !== 'mysql') return;
  sync ??= new ClientMovementSync(mysql.createPool({ host: process.env.DATA_MYSQL_HOST, port: Number(process.env.DATA_MYSQL_PORT || 3306),
    user: process.env.DATA_MYSQL_USER, password: process.env.DATA_MYSQL_PASSWORD, database: process.env.DATA_MYSQL_DATABASE,
    dateStrings: true, decimalNumbers: true, connectionLimit: 2 }));
  return sync.sync(company, from);
}
