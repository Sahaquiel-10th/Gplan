import crypto from 'node:crypto';
import type {Pool,PoolConnection,Connection,RowDataPacket} from 'mysql2/promise';
type Db=Pool|PoolConnection|Connection;
export type InventoryQuality={status:'complete'|'partial'|'unavailable';source:string;missing_rows:number;message?:string};
export type InventoryPoint={storage_code:string;product_code:string|null;product_name:string;quantity:number|null;inventory_date:string;snapshot_time:string;source_spec_uid?:string;source_sku_code?:string;shop_id?:string;inbound_type?:string;movement_time?:string};
export const inventoryPolicy='stable-spec-v1';
export function validateInventoryPoints(rows:InventoryPoint[],quality:InventoryQuality){
  const keys=new Set<string>();
  for(const row of rows){
    if(!row.source_spec_uid||!row.storage_code||!/^\d{4}-\d{2}-\d{2}$/.test(row.inventory_date)||!Number.isFinite(Date.parse(row.snapshot_time)))throw new Error('库存快照身份或观察时间缺失');
    const key=JSON.stringify([row.storage_code,row.source_spec_uid]);
    if(keys.has(key))throw new Error('库存快照含重复系统规格，禁止发布');keys.add(key);
    if(row.quantity===null){if(quality.status!=='partial')throw new Error('完整库存快照含未知库存');}
    else if(!Number.isFinite(row.quantity))throw new Error('库存快照数量非法');
  }
}
export async function ensureInventorySnapshotSchema(db:Db){
  await db.query(`CREATE TABLE IF NOT EXISTS data_inventory_report_snapshots(
    company_id VARCHAR(128) NOT NULL,business_date DATE NOT NULL,rows_json JSON NOT NULL,
    quality_json JSON NOT NULL,revision CHAR(64) NOT NULL,created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY(company_id,business_date)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
export async function saveInventorySnapshot(db:Db,company:string,date:string,rows:InventoryPoint[],quality:InventoryQuality){
  validateInventoryPoints(rows,quality);
  const revision=crypto.createHash('sha256').update(JSON.stringify([inventoryPolicy,rows,quality])).digest('hex');
  // First observation is immutable. Corrections require the audited migration,
  // not a subsequent manual sync or today's inventory watermark.
  await db.execute(`INSERT IGNORE INTO data_inventory_report_snapshots(company_id,business_date,rows_json,quality_json,revision) VALUES(?,?,?,?,?)`,[company,date,JSON.stringify(rows),JSON.stringify(quality),revision]);
  return revision;
}
export async function loadInventorySnapshot(db:Db,company:string,date:string){
  const[found]=await db.execute<RowDataPacket[]>('SELECT rows_json,quality_json,revision FROM data_inventory_report_snapshots WHERE company_id=? AND business_date=?',[company,date]);
  if(!found[0])return{rows:[] as InventoryPoint[],quality:{status:'unavailable',source:'none',missing_rows:0,message:'该日期没有可核验的历史库存，未以当前库存代替'} as InventoryQuality,revision:'unavailable'};
  const parse=(v:any)=>typeof v==='string'?JSON.parse(v):v;
  const rows=parse(found[0].rows_json) as InventoryPoint[],quality=parse(found[0].quality_json) as InventoryQuality;
  validateInventoryPoints(rows,quality);
  return{rows,quality,revision:String(found[0].revision)};
}
export async function captureInventorySnapshot(db:Db,company:string,observedAt:string){
  const asOf=new Date(observedAt),local=new Date(asOf.getTime()+8*3600000).toISOString();
  const inventoryDate=local.slice(0,10),timestamp=local.replace('Z','+08:00');
  const date=new Date(asOf.getTime()+8*3600000-86400000).toISOString().slice(0,10);
  const[rows]=await db.execute<RowDataPacket[]>(`SELECT i.storage_code,i.sku_code source_sku_code,i.source_spec_uid,p.source_spec_uid product_spec_uid,
    COALESCE(NULLIF(i.bar_code,''),NULLIF(p.bar_code,'')) product_code,
    COALESCE(NULLIF(p.goods_name,''),i.spec_name,'') product_name,i.actual_quantity quantity
    FROM ods_wln_inventory_current i JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code
    WHERE i.company_id=? AND i.storage_code IN ('CK001','CK008') AND i.source_spec_uid IS NOT NULL
    AND JSON_UNQUOTE(JSON_EXTRACT(p.raw_payload,'$.goods.brand_name'))='薇诺娜'
    ORDER BY i.storage_code,i.source_spec_uid`,[company]);
  const keys=new Set<string>();
  for(const r of rows){if(r.source_spec_uid!==r.product_spec_uid)throw new Error('库存与商品规格身份不一致，需同步后再发布');const key=JSON.stringify([r.storage_code,r.source_spec_uid]);if(keys.has(key))throw new Error('当前库存身份重复，禁止保存日报');keys.add(key);}
  return saveInventorySnapshot(db,company,date,rows.map(({product_spec_uid,...r})=>({...r,quantity:Number(r.quantity),inventory_date:inventoryDate,snapshot_time:timestamp})) as InventoryPoint[],{status:'complete',source:'scheduled_observation',missing_rows:0});
}
