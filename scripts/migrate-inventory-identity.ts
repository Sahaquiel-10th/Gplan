import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql,{type RowDataPacket} from 'mysql2/promise';
import {config} from 'dotenv';
import {canonicalInventoryRows,repairCachedInventory} from '../server/inventoryIdentity.js';
import {ensureInventorySnapshotSchema,saveInventorySnapshot,captureInventorySnapshot,type InventoryPoint} from '../server/inventorySnapshots.js';

config({path:process.env.GPLAN_ENV_FILE||'.env',quiet:true});
const e=process.env,company=e.WANLINIU_COMPANY_ID||'company_default';
const apply=process.argv.includes('--apply');
const db=await mysql.createConnection({host:e.DATA_MYSQL_HOST,port:Number(e.DATA_MYSQL_PORT||3306),user:e.DATA_MYSQL_USER,password:e.DATA_MYSQL_PASSWORD,database:e.DATA_MYSQL_DATABASE,dateStrings:true,decimalNumbers:true});
const parse=(v:any)=>typeof v==='string'?JSON.parse(v):v;
const hash=(v:string)=>crypto.createHash('sha256').update(v).digest('hex');
const nextDay=(date:string)=>new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
try{
 const[rows]=await db.query<RowDataPacket[]>(`SELECT i.*,p.source_spec_uid resolved_uid,p.source_modified_at product_modified FROM ods_wln_inventory_current i LEFT JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code WHERE i.company_id=?`,[company]);
 const[cached]=await db.query<RowDataPacket[]>('SELECT * FROM client_daily_report_batches WHERE company_id=? AND client_code=?',[company,'winona_daily_trial']);
 const[products]=await db.query<RowDataPacket[]>('SELECT sku_code,goods_name,bar_code,source_spec_uid,source_modified_at FROM ods_wln_products WHERE company_id=?',[company]);
 for(const row of rows)row.resolved_uid=row.source_spec_uid||row.resolved_uid;
 const canonical=canonicalInventoryRows(rows as any[]);
 const points:Array<{date:string;rows:InventoryPoint[];removed:number;missing:number}>=[];
 for(const batch of cached){
   const inventory=parse(batch.rows_json).filter((r:any)=>r.record_type==='inventory');
   if(!inventory.length)continue;
   const date=String(batch.business_date).slice(0,10);
   // A report generated much later with today's inventory is not historical
   // evidence for its business date. Do not silently relabel it.
   if(inventory.some((r:any)=>![date,nextDay(date)].includes(r.inventory_date)))continue;
   const repaired=repairCachedInventory(inventory,products as any[],false);
   points.push({date,missing:repaired.unresolved.length,removed:repaired.removed,rows:repaired.rows.map((r:any)=>({storage_code:r.storage_name==='奕页仓库'?'CK008':'CK001',product_code:r.product_code,product_name:r.product_name,quantity:r.inventory_quantity,inventory_date:r.inventory_date,snapshot_time:r.inventory_as_of,source_spec_uid:r.source_spec_uid,source_sku_code:r.source_sku_code}))});
 }
 console.log(JSON.stringify({migration:'inventory-identity-v1',apply,before:rows.length,canonical:canonical.kept.length,tombstones:canonical.tombstones.length,retire:canonical.retired.length,historicalReports:points.length,cacheDuplicateRows:points.reduce((n,p)=>n+p.removed,0),unresolvedCacheRows:points.reduce((n,p)=>n+p.missing,0)}));
 if(!apply)process.exit(0);
 const lease='wanliniu-sync:'+hash(company).slice(0,40);
 const[acquired]=await db.query<RowDataPacket[]>('SELECT GET_LOCK(?,15) acquired',[lease]);
 if(Number(acquired[0]?.acquired)!==1)throw new Error('Inventory synchronization is running; migration must wait');
 const root=process.env.INVENTORY_BACKUP_DIR||path.resolve('data/backups');
 await fs.mkdir(root,{recursive:true,mode:0o700});
 const backup=await fs.mkdtemp(path.join(root.endsWith('/')?root:root+'/', 'inventory-identity-'));
 await fs.chmod(backup,0o700);
 await fs.writeFile(path.join(backup,'before.json'),JSON.stringify({company,rows,cached,products}),{mode:0o600,flag:'wx'});
 await db.query(`CREATE TABLE IF NOT EXISTS data_inventory_identity_archive(
   company_id VARCHAR(128) NOT NULL,storage_code VARCHAR(128) NOT NULL,source_spec_uid VARCHAR(128) NULL,
   sku_code VARCHAR(128) NOT NULL,payload_sha256 CHAR(64) NOT NULL,row_json JSON NOT NULL,reason VARCHAR(64) NOT NULL,
   archived_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),PRIMARY KEY(company_id,storage_code,sku_code,payload_sha256)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
 await db.query(`CREATE TABLE IF NOT EXISTS data_product_identity_aliases(
   company_id VARCHAR(128) NOT NULL,source_spec_uid VARCHAR(128) NOT NULL,alias_sha256 CHAR(64) NOT NULL,
   sku_code VARCHAR(128) NOT NULL,bar_code VARCHAR(128) NULL,goods_name VARCHAR(255) NULL,source_modified_at DATETIME(3) NULL,
   observed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),PRIMARY KEY(company_id,source_spec_uid,alias_sha256)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
 await db.execute(`INSERT IGNORE INTO data_product_identity_aliases(company_id,source_spec_uid,alias_sha256,sku_code,bar_code,goods_name,source_modified_at)
   SELECT company_id,source_spec_uid,SHA2(CAST(JSON_ARRAY(sku_code,bar_code,goods_name) AS CHAR),256),sku_code,bar_code,goods_name,source_modified_at FROM ods_wln_products WHERE company_id=? AND source_spec_uid IS NOT NULL AND source_spec_uid<>''`,[company]);
 const[col]=await db.query<RowDataPacket[]>("SHOW COLUMNS FROM ods_wln_inventory_current LIKE 'source_spec_uid'");
 if(!col.length)await db.query('ALTER TABLE ods_wln_inventory_current ADD COLUMN source_spec_uid VARCHAR(128) NULL');
 await ensureInventorySnapshotSchema(db);
 const[existingPoints]=await db.execute<RowDataPacket[]>('SELECT business_date FROM data_inventory_report_snapshots WHERE company_id=?',[company]);
 const preservedDates=new Set(existingPoints.map(r=>String(r.business_date).slice(0,10)));
 await db.beginTransaction();
 try{
  for(const row of canonical.retired){
    const raw=JSON.stringify(row);
    await db.execute('INSERT IGNORE INTO data_inventory_identity_archive(company_id,storage_code,source_spec_uid,sku_code,payload_sha256,row_json,reason) VALUES(?,?,?,?,?,?,?)',[company,row.storage_code,row.resolved_uid,row.sku_code,hash(raw),raw,'migration_superseded_sku']);
    const[deleted]=await db.execute<mysql.ResultSetHeader>('DELETE FROM ods_wln_inventory_current WHERE company_id=? AND storage_code=? AND sku_code=? AND snapshot_at=? AND actual_quantity=?',[company,row.storage_code,row.sku_code,row.snapshot_at,row.actual_quantity]);
    if(deleted.affectedRows!==1)throw new Error('Inventory changed during migration; refusing to retire a different row');
  }
  await db.execute(`UPDATE ods_wln_inventory_current i JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code SET i.source_spec_uid=p.source_spec_uid WHERE i.company_id=? AND i.source_spec_uid IS NULL AND p.source_spec_uid IS NOT NULL AND p.source_spec_uid<>''`,[company]);
  // Preserve verified day-end recovery, including explicit nulls for gaps.
  const[hasRecovery]=await db.query<RowDataPacket[]>("SHOW TABLES LIKE 'dwd_wln_inventory_daily'");
  if(hasRecovery.length){
    const[daily]=await db.execute<RowDataPacket[]>(`SELECT inventory_date,storage_code,sku_code,source_spec_uid,bar_code,product_name,quantity,DATE_FORMAT(inventory_as_of,'%Y-%m-%dT%H:%i:%s.%f+08:00') snapshot_time FROM dwd_wln_inventory_daily WHERE company_id=? ORDER BY inventory_date,storage_code,source_spec_uid`,[company]);
    const[hasRuns]=await db.query<RowDataPacket[]>("SHOW TABLES LIKE 'data_inventory_recovery_runs'");
    const[runs]=hasRuns.length?await db.execute<RowDataPacket[]>('SELECT manifest_json FROM data_inventory_recovery_runs WHERE company_id=? ORDER BY created_at DESC',[company]):[[]];
    for(const date of [...new Set(daily.map(r=>String(r.inventory_date).slice(0,10)))]){
      if(preservedDates.has(date))continue;
      const recovered=daily.filter(r=>String(r.inventory_date).slice(0,10)===date);
      const missingSkus=new Set<string>();
      for(const run of runs){const m=parse(run.manifest_json);if(m.dates?.includes(date))for(const issue of m.issues||[])missingSkus.add(issue.sku);}
      const gaps=canonical.kept.filter(r=>missingSkus.has(r.sku_code)&&['CK001','CK008'].includes(r.storage_code)).map(r=>({storage_code:r.storage_code,source_spec_uid:String(r.resolved_uid),source_sku_code:r.sku_code,product_code:String(r.bar_code||''),product_name:products.find(p=>p.sku_code===r.sku_code)?.goods_name||r.sku_code,quantity:null,inventory_date:date,snapshot_time:date+'T23:59:59.999+08:00'}));
      await saveInventorySnapshot(db,company,date,[...recovered.map(r=>({storage_code:r.storage_code,source_spec_uid:r.source_spec_uid,source_sku_code:r.sku_code,product_code:r.bar_code,product_name:r.product_name,quantity:Number(r.quantity),inventory_date:date,snapshot_time:r.snapshot_time})),...gaps],{status:gaps.length?'partial':'complete',source:'verified_day_end',missing_rows:gaps.length});
    }
  }
  for(const p of points){
    if(preservedDates.has(p.date))continue;
    const missing=p.missing+p.rows.filter(r=>r.quantity===null).length;
    await saveInventorySnapshot(db,company,p.date,p.rows,{status:missing?'partial':'complete',source:'saved_observation',missing_rows:missing,...(missing?{message:'部分历史库存无法核验，未以当前库存或零补齐'}:{})});
  }
  await db.commit();
 }catch(error){await db.rollback();throw error;}
 const[indexes]=await db.query<RowDataPacket[]>("SHOW INDEX FROM ods_wln_inventory_current WHERE Key_name='uniq_wln_inventory_spec'");
 if(!indexes.length)await db.query('ALTER TABLE ods_wln_inventory_current ADD UNIQUE INDEX uniq_wln_inventory_spec(company_id,storage_code,source_spec_uid)');
 const[productIndex]=await db.query<RowDataPacket[]>("SHOW INDEX FROM ods_wln_products WHERE Key_name='idx_wln_products_spec_uid'");
 if(!productIndex.length)await db.query('ALTER TABLE ods_wln_products ADD INDEX idx_wln_products_spec_uid(company_id,source_spec_uid)');
 const[watermark]=await db.query<RowDataPacket[]>("SELECT cursor_json FROM data_sync_cursors WHERE connector_id='wanliniu' AND resource_name='inventory'");
 if(watermark[0])await captureInventorySnapshot(db,company,parse(watermark[0].cursor_json).modifiedThrough);
 const[duplicates]=await db.query<RowDataPacket[]>('SELECT source_spec_uid FROM ods_wln_inventory_current WHERE company_id=? AND source_spec_uid IS NOT NULL GROUP BY storage_code,source_spec_uid HAVING COUNT(*)>1',[company]);
 if(duplicates.length)throw new Error('Stable inventory identity is still duplicated');
 console.log(JSON.stringify({migration:'applied',backup,archived:canonical.retired.length,remaining:canonical.kept.length+canonical.tombstones.length,duplicates:0}));
}finally{await db.end();}
