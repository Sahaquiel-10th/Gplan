import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import crypto from 'node:crypto';
import { buildClientReport, reportClientCode, reportDate, reportShops } from './clientDailyReport.js';
import { uid } from './security.js';

export class ReportNotAvailable extends Error {}
export function shanghaiDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0,10);
}
export function yesterdayShanghai(date = new Date()) {
  return shanghaiDate(new Date(date.getTime()-86400000));
}
export function publicationVersion(cursors: RowDataPacket[]) {
  // Include policy changes, so persisted reports never retain an obsolete grouping rule.
  return crypto.createHash('sha256').update(JSON.stringify(['daily-v2',reportShops,cursors])).digest('hex');
}
const schemaTasks=new WeakMap<Pool,Promise<void>>();
async function schema(pool: Pool) {
  let task=schemaTasks.get(pool);
  if(!task){
    task=(async()=>{
      await pool.query(`CREATE TABLE IF NOT EXISTS client_daily_report_batches (
        company_id VARCHAR(128) NOT NULL,client_code VARCHAR(64) NOT NULL,business_date DATE NOT NULL,
        batch_id VARCHAR(64) NOT NULL,rows_json JSON NOT NULL,created_at DATETIME(3) NOT NULL,
        source_version VARCHAR(64) NULL,
        PRIMARY KEY(company_id,client_code,business_date)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      const [columns]=await pool.query<RowDataPacket[]>("SHOW COLUMNS FROM client_daily_report_batches LIKE 'source_version'");
      if(!columns.length)await pool.query('ALTER TABLE client_daily_report_batches ADD COLUMN source_version VARCHAR(64) NULL');
    })().catch(error=>{schemaTasks.delete(pool);throw error;});
    schemaTasks.set(pool,task);
  }
  await task;
}
async function cursors(db: Pool | PoolConnection) {
  const [rows]=await db.query<RowDataPacket[]>(`SELECT resource_name,
    JSON_UNQUOTE(JSON_EXTRACT(cursor_json,'$.modifiedThrough')) modified_through
    FROM data_sync_cursors WHERE connector_id='wanliniu' ORDER BY resource_name`);
  return rows;
}
async function load(db: Pool | PoolConnection, company: string, client: string, date: string) {
  const [rows]=await db.execute<RowDataPacket[]>(`SELECT batch_id,rows_json,source_version,
    DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s+08:00') prepared_at
    FROM client_daily_report_batches WHERE company_id=? AND client_code=? AND business_date=?`,[company,client,date]);
  return rows[0];
}
export async function ensurePublishedReport(pool: Pool,company: string,client: string,date: string) {
  reportDate(date);
  if(client!==reportClientCode)throw new ReportNotAvailable('当前客户端没有此日报数据');
  if(date>shanghaiDate())throw new ReportNotAvailable('不能查询未来日期');
  await schema(pool);
  const stamp=publicationVersion(await cursors(pool));
  const cached=await load(pool,company,client,date);
  if(cached?.source_version===stamp)return cached;
  const db=await pool.getConnection();
  const lock='client-report:'+crypto.createHash('sha256').update(JSON.stringify([company,client,date])).digest('hex').slice(0,40);
  let locked=false;
  try{
    const [result]=await db.query<RowDataPacket[]>('SELECT GET_LOCK(?,10) acquired',[lock]);
    locked=Number(result[0]?.acquired)===1;
    if(!locked)throw new Error('数据正在生成，请稍后重试');
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await db.beginTransaction();
    const version=publicationVersion(await cursors(db));
    const latest=await load(db,company,client,date);
    if(latest?.source_version===version){await db.commit();return latest;}
    const [bounds]=await db.query<RowDataPacket[]>(`SELECT DATE_FORMAT(MIN(first_day),'%Y-%m-%d') earliest FROM (
      SELECT DATE(MIN(bill_date)) first_day FROM ods_wln_sale_outbound WHERE company_id=?
      UNION ALL SELECT DATE(MIN(bill_date)) first_day FROM ods_wln_purchase_inbound WHERE company_id=?
    ) dates`,[company,company]);
    const earliest=String(bounds[0]?.earliest||'').slice(0,10);
    if(!earliest || date<earliest)throw new ReportNotAvailable('该日期不在现有数据范围内');
    const resultRows=await buildClientReport(db,company,date);
    await db.execute(`INSERT INTO client_daily_report_batches
      (company_id,client_code,business_date,batch_id,rows_json,created_at,source_version)
      VALUES(?,?,?,?,?,NOW(3),?) ON DUPLICATE KEY UPDATE
      batch_id=VALUES(batch_id),rows_json=VALUES(rows_json),created_at=VALUES(created_at),source_version=VALUES(source_version)`,
      [company,client,date,uid('batch'),JSON.stringify(resultRows.rows),version]);
    await db.commit();
    return (await load(db,company,client,date))!;
  }catch(error){await db.rollback();throw error;}
  finally{
    if(locked)await db.query('SELECT RELEASE_LOCK(?)',[lock]).catch(()=>undefined);
    db.release();
  }
}

let publishingPool: Pool | undefined;
export async function publishLatestClientReport(company: string) {
  if(process.env.DATA_DB_PROVIDER!=='mysql')return;
  publishingPool ||= mysql.createPool({host:process.env.DATA_MYSQL_HOST,port:Number(process.env.DATA_MYSQL_PORT||3306),
    user:process.env.DATA_MYSQL_USER,password:process.env.DATA_MYSQL_PASSWORD,database:process.env.DATA_MYSQL_DATABASE,
    dateStrings:true,decimalNumbers:true,connectionLimit:2});
  const batch=await ensurePublishedReport(publishingPool,company,reportClientCode,yesterdayShanghai());
  console.log(JSON.stringify({event:'client_report_published',date:yesterdayShanghai(),batchId:batch.batch_id}));
}
