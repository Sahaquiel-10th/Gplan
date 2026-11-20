import mysql, {type Connection,type Pool,type PoolConnection,type RowDataPacket} from 'mysql2/promise';
import {wanliniuClient,type WanliniuClient,type WanliniuRecord} from './data-connectors/wanliniu/client.js';
import {mysqlDateInShanghai} from './data-connectors/wanliniu/mappers.js';
import {uid} from './security.js';
type Db=Pool|PoolConnection|Connection;
export const approvedScopePolicy='winona-approved-20261120-v1';
export const approvedStreamTypes:Record<string,{direction:'in'|'out'|'signed';type:string}>={
 '采购退货':{direction:'out',type:'PURCHASE_RETURN'},
 '盘盈盘亏':{direction:'signed',type:'INVENTORY_ADJUSTMENT'},
 '其他入库':{direction:'in',type:'OTHER'},'其他出库':{direction:'out',type:'OTHER'},
 '领料出库':{direction:'out',type:'PRODUCTION_MATERIAL'},'退料入库':{direction:'in',type:'PRODUCTION_MATERIAL_RETURN'},
 '成品入库':{direction:'in',type:'PRODUCTION_FINISHED'},'成品取消':{direction:'signed',type:'PRODUCTION_CANCEL'},
 '加工单':{direction:'signed',type:'PRODUCTION_ADJUSTMENT'},'调拨还回':{direction:'signed',type:'TRANSFER_RETURN'},
 '调拨入库':{direction:'in',type:'TRANSFER'},'调拨出库':{direction:'out',type:'TRANSFER'},'调拨':{direction:'signed',type:'TRANSFER'},
};
const companyConfigured=()=>process.env.WANLINIU_COMPANY_ID?.trim()||'company_default';
const parse=(value:any)=>typeof value==='string'?JSON.parse(value):value;
const text=(v:unknown)=>v===undefined||v===null?'':String(v);
function finite(value:unknown,label:string){if(value===null||value===undefined||value===''||!Number.isFinite(Number(value)))throw Error(label+'缺失或非法');return Number(value);}
export function scopeDate(value:unknown){
 let d:Date;if(typeof value==='number'||/^\d{13}$/.test(String(value)))d=new Date(Number(value));
 else {const s=String(value||'');d=new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)&&!/(Z|[+-]\d{2}:?\d{2})$/.test(s)?s.replace(' ','T')+'+08:00':s);}
 if(!Number.isFinite(d.getTime()))throw Error('源日期缺失或非法');return mysqlDateInShanghai(d);
}
export type ScopeCoverage={status:'complete'|'partial'|'unavailable';available_from:string|null;synced_through:string|null;message?:string;unresolved_rows?:number;unknown_receipt_rows?:number};
export async function ensureApprovedScopeSchema(db:Db){
 await db.query(`CREATE TABLE IF NOT EXISTS ods_wln_approved_stock_stream(
 company_id VARCHAR(128) NOT NULL,stream_id VARCHAR(128) NOT NULL,document_no VARCHAR(128) NOT NULL,
 bill_type_name VARCHAR(64) NOT NULL,bill_date DATETIME(3) NOT NULL,occurred_at DATETIME(3) NOT NULL,
 storage_code VARCHAR(128) NOT NULL,sku_code VARCHAR(255) NOT NULL,source_spec_uid VARCHAR(128) NULL,
 bar_code VARCHAR(128) NULL,goods_name VARCHAR(512) NULL,quantity_delta DECIMAL(20,6) NOT NULL,
 inventory_type VARCHAR(32) NULL,source_balance DECIMAL(20,6) NULL,sync_run_id VARCHAR(64) NOT NULL,
 ingested_at DATETIME(3) NOT NULL,PRIMARY KEY(company_id,stream_id),
 KEY idx_approved_stream_date(company_id,bill_date),KEY idx_approved_stream_spec(company_id,source_spec_uid,bill_date)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
 await db.query(`CREATE TABLE IF NOT EXISTS data_client_scope_sync_progress(
 company_id VARCHAR(128) NOT NULL,resource_name VARCHAR(64) NOT NULL,state_json JSON NOT NULL,
 updated_at DATETIME(3) NOT NULL,PRIMARY KEY(company_id,resource_name)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
 await db.query(`CREATE TABLE IF NOT EXISTS data_wln_client_production_orders(
 company_id VARCHAR(128) NOT NULL,document_no VARCHAR(128) NOT NULL,operation_mode INT NULL,
 ingested_at DATETIME(3) NOT NULL,PRIMARY KEY(company_id,document_no)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
 await db.query(`CREATE TABLE IF NOT EXISTS data_wln_client_stock_references(
 company_id VARCHAR(128) NOT NULL,document_no VARCHAR(128) NOT NULL,related_order_no VARCHAR(128) NULL,
 business_reason VARCHAR(512) NULL,ingested_at DATETIME(3) NOT NULL,PRIMARY KEY(company_id,document_no)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
 await db.query(`CREATE TABLE IF NOT EXISTS ods_wln_client_after_sales(
 company_id VARCHAR(128) NOT NULL,document_no VARCHAR(128) NOT NULL,line_key VARCHAR(191) NOT NULL,
 created_at_source DATETIME(3) NOT NULL,modified_at_source DATETIME(3) NOT NULL,
 storage_code VARCHAR(128) NULL,shop_id VARCHAR(128) NULL,sku_code VARCHAR(255) NOT NULL,
 source_spec_uid VARCHAR(128) NULL,bar_code VARCHAR(128) NULL,goods_name VARCHAR(512) NULL,
 request_type INT NOT NULL,request_status INT NOT NULL,request_quantity DECIMAL(20,6) NOT NULL,
 received_quantity DECIMAL(20,6) NULL,refund_status INT NULL,sync_run_id VARCHAR(64) NOT NULL,
 ingested_at DATETIME(3) NOT NULL,PRIMARY KEY(company_id,document_no,line_key),
 KEY idx_client_after_sales_date(company_id,created_at_source),KEY idx_client_after_sales_spec(company_id,source_spec_uid)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
type Identities={bySku:Map<string,Set<string>>;skus:string[]};
async function identities(db:Db,company:string):Promise<Identities>{
 const[products]=await db.query<RowDataPacket[]>(`SELECT sku_code,source_spec_uid,
 JSON_UNQUOTE(JSON_EXTRACT(raw_payload,'$.goods.brand_name')) brand FROM ods_wln_products
 WHERE company_id=? ORDER BY source_modified_at DESC,ingested_at DESC,sku_code DESC`,[company]);
 const[aliases]=await db.query<RowDataPacket[]>('SELECT sku_code,source_spec_uid FROM data_product_identity_aliases WHERE company_id=?',[company]);
 const bySku=new Map<string,Set<string>>(),brandById=new Map<string,string>();
 for(const p of products)if(p.source_spec_uid&&!brandById.has(p.source_spec_uid))brandById.set(p.source_spec_uid,p.brand);
 const skus=new Set<string>();
 for(const p of [...products,...aliases]){if(!p.source_spec_uid)continue;const ids=bySku.get(p.sku_code)||new Set<string>();ids.add(p.source_spec_uid);bySku.set(p.sku_code,ids);
  if(brandById.get(p.source_spec_uid)==='薇诺娜')skus.add(p.sku_code);
 }
 return{bySku,skus:[...skus].sort()};
}
function specId(ids:Identities,sku:string,direct?:unknown){if(direct)return String(direct);const set=ids.bySku.get(sku);return set?.size===1?[...set][0]:null;}
export function normalizeApprovedStream(source:WanliniuRecord){
 const id=text(source.pism_index),kind=text(source.bill_type_name),sku=text(source.sku_code),warehouse=text(source.storage_code),document=text(source.bill_code);
 if(!id||!kind||!sku||!warehouse||!document)throw Error('库存流水缺少身份、类型、商品、仓库或单号');
 const delta=finite(source.size,'库存变动数量');
 return{id,kind,sku,warehouse,document,delta,billDate:scopeDate(source.date),occurredAt:scopeDate(source.time),
  barCode:text(source.sku_bar_code)||null,goodsName:text(source.item_title)||text(source.sku_title)||null,
  inventoryType:source.inventory_type===undefined?null:String(source.inventory_type),
  balance:source.quantity===null||source.quantity===undefined?null:finite(source.quantity,'源库存余额')};
}
export function approvedMovement(kind:string,delta:number){
 const rule=approvedStreamTypes[kind];if(!rule||delta===0)return null;
 const inbound=rule.direction==='in'||(rule.direction==='signed'&&delta>0);
 const type=rule.type==='INVENTORY_ADJUSTMENT'?(delta>0?'INVENTORY_GAIN':'INVENTORY_LOSS'):rule.type;
 return{record_type:inbound?'inbound':'outbound',inbound_type:inbound?type:null,outbound_type:inbound?null:type,
  quantity:rule.direction==='signed'?Math.abs(delta):inbound?delta:-delta};
}
async function writeStream(db:PoolConnection,company:string,records:WanliniuRecord[],ids:Identities,run:string,from:string,to:string,end:string){
 const rows=[];
 for(const source of records){if(!approvedStreamTypes[text(source.bill_type_name)])continue;const r=normalizeApprovedStream(source);
  if(!approvedStreamTypes[r.kind]||!r.delta||!['CK001','CK008'].includes(r.warehouse)||r.billDate<from||r.billDate>=to||r.occurredAt>end)continue;
  rows.push([company,r.id,r.document,r.kind,r.billDate,r.occurredAt,r.warehouse,r.sku,specId(ids,r.sku),r.barCode,r.goodsName,r.delta,r.inventoryType,r.balance,run,mysqlDateInShanghai(new Date())]);
 }
 for(let at=0;at<rows.length;at+=200){const page=rows.slice(at,at+200);await db.query(`INSERT INTO ods_wln_approved_stock_stream
 (company_id,stream_id,document_no,bill_type_name,bill_date,occurred_at,storage_code,sku_code,source_spec_uid,bar_code,goods_name,quantity_delta,inventory_type,source_balance,sync_run_id,ingested_at)
 VALUES ${page.map(()=>'('+Array(16).fill('?').join(',')+')').join(',')} ON DUPLICATE KEY UPDATE document_no=VALUES(document_no),
 bill_type_name=VALUES(bill_type_name),bill_date=VALUES(bill_date),occurred_at=VALUES(occurred_at),storage_code=VALUES(storage_code),
 sku_code=VALUES(sku_code),source_spec_uid=VALUES(source_spec_uid),bar_code=VALUES(bar_code),goods_name=VALUES(goods_name),
 quantity_delta=VALUES(quantity_delta),inventory_type=VALUES(inventory_type),source_balance=VALUES(source_balance),sync_run_id=VALUES(sync_run_id),ingested_at=VALUES(ingested_at)`,page.flat());}
 return rows.length;
}
type Cursor={initialFrom:string;modifiedThrough:string;skus?:string[];ordered?:boolean};
async function cursor(db:Db,resource:string):Promise<Cursor|undefined>{const[rows]=await db.query<RowDataPacket[]>('SELECT cursor_json FROM data_sync_cursors WHERE connector_id=? AND resource_name=?',['wanliniu',resource]);return rows[0]?parse(rows[0].cursor_json):undefined;}
async function saveCursor(db:Db,resource:string,value:Cursor){await db.execute(`INSERT INTO data_sync_cursors(connector_id,resource_name,cursor_json,last_success_at) VALUES('wanliniu',?,?,NOW(3)) ON DUPLICATE KEY UPDATE cursor_json=VALUES(cursor_json),last_success_at=VALUES(last_success_at)`,[resource,JSON.stringify(value)]);}
export async function approvedCoverage(db:Db,company:string,date:string,resource='approved_stock_stream'):Promise<ScopeCoverage>{
 if(company!==companyConfigured())return{status:'unavailable',available_from:null,synced_through:null};
 const c=await cursor(db,resource);if(!c?.initialFrom||!c.modifiedThrough)return{status:'unavailable',available_from:null,synced_through:null,message:'客户新增口径尚未完成同步，未取得的数据不能视为零'};
 const first=mysqlDateInShanghai(new Date(c.initialFrom)).slice(0,10),through=mysqlDateInShanghai(new Date(c.modifiedThrough)).slice(0,10);
 const status=date<first?'unavailable':date>=through?'partial':'complete';
 return{status,available_from:first,synced_through:c.modifiedThrough,...(status==='complete'?{}:{message:date<first?'该日期早于新增口径可回补范围，缺失不能视为零':'当日新增口径数据可能尚未同步完整'})};
}
type StreamState={initialFrom:string;end:string;groups:Array<{from:string;to:string;skus:string[]}>;index:number;read:number;written:number;ordered:boolean;cohort:string[];nextPage?:number;groupOrdered?:boolean};
export class ApprovedStockSync{
 constructor(private pool:Pool,private client:WanliniuClient=wanliniuClient,private now=()=>new Date()){}
 async sync(company:string){
  if(company!==companyConfigured())throw Error('企业没有该连接器的同步权限');await ensureApprovedScopeSchema(this.pool);
  const db=await this.pool.getConnection();let locked=false;const run=uid('scope');
  try{const[lock]=await db.query<RowDataPacket[]>("SELECT GET_LOCK('gplan-approved-stock-stream',10) acquired");locked=Number(lock[0]?.acquired)===1;if(!locked)throw Error('客户库存口径同步正在运行');
   const ids=await identities(db,company);if(!ids.skus.length)throw Error('未找到已确认品牌商品，不能推进库存流水游标');
   const saved=await cursor(db,'approved_stock_stream');const[progress]=await db.query<RowDataPacket[]>('SELECT state_json FROM data_client_scope_sync_progress WHERE company_id=? AND resource_name=?',[company,'approved_stock_stream']);
   let state:StreamState=progress[0]?parse(progress[0].state_json):undefined;
   const now=this.now(),today=mysqlDateInShanghai(now).slice(0,10),oldest=new Date(Date.parse(today+'T00:00:00+08:00')-89*86400000);
   if(!state){const end=new Date(Math.floor(now.getTime()/1000)*1000),initialFrom=saved?.initialFrom||oldest.toISOString(),groups:StreamState['groups']=[];
    // Query spans stay below the upstream 30-day limit. It treats the end day inclusively.
    for(let start=new Date(initialFrom);start<end;){const stop=new Date(Math.min(start.getTime()+27*86400000,Date.parse(today+'T00:00:00+08:00')+86400000));
     // An upstream SKU lookup rejects retired/renamed codes. Scan the granted
     // warehouses instead so those historical postings cannot silently disappear.
     groups.push({from:mysqlDateInShanghai(start),to:mysqlDateInShanghai(stop),skus:[]});start=stop;}
    state={initialFrom,end:end.toISOString(),groups,index:0,read:0,written:0,ordered:true,cohort:ids.skus};}
   await db.execute(`INSERT INTO data_sync_runs(id,connector_id,resource_name,sync_mode,status,started_at) VALUES(?,'wanliniu','approved_stock_stream',?,'running',NOW(3))`,[run,saved?'incremental':'full']);
   try{for(;state.index<state.groups.length;state.index++){
     const g=state.groups[state.index];
     let complete=false,lastId:bigint|undefined,lastTime:string|undefined,ordered=state.groupOrdered??true,withoutSku=false;const seen=new Set<string>();
     const parallelPages=16;
     for(let first=state.nextPage||1;first<=50000&&!complete;first+=parallelPages){
      const result=await Promise.allSettled(Array.from({length:parallelPages},(_,i)=>this.client.listInventoryStream(first+i,100,g.from.slice(0,19),mysqlDateInShanghai(new Date(Date.parse(g.to.replace(' ','T')+'+08:00')-1000)).slice(0,19),withoutSku?[]:g.skus)));
      for(let offset=0;offset<result.length;offset++){const page=result[offset];if(complete)continue;
       if(page.status==='rejected'){
        if(first===1&&offset===0&&g.skus.length&&!withoutSku&&/1500/.test(String(page.reason))&&/不存在|没有找到编码/.test(String(page.reason))){withoutSku=true;first=1-parallelPages;seen.clear();lastId=undefined;lastTime=undefined;break;}
        throw page.reason;
       }
       const unique=page.value.filter(r=>{const id=text(r.pism_index);if(!id)throw Error('库存流水缺少pism_index');if(seen.has(id))return false;seen.add(id);return true;});
       for(const raw of unique){const id=text(raw.pism_index),occurredAt=scopeDate(raw.time),numeric=/^\d+$/.test(id)?BigInt(id):undefined;
        if(numeric===undefined||(lastId!==undefined&&numeric>lastId)||(lastTime!==undefined&&occurredAt>lastTime))ordered=false;
        if(numeric!==undefined)lastId=numeric;lastTime=occurredAt;
       }
       // The provider exposes no documented modification cursor for this feed.
       // Rescan the retained window to include backdated postings; never infer
       // completeness from an undocumented page order or an early empty type.
       const businessFrom=mysqlDateInShanghai(new Date(state.initialFrom));
       const businessTo=mysqlDateInShanghai(new Date(Date.parse(mysqlDateInShanghai(new Date(state.end)).slice(0,10)+'T00:00:00+08:00')+86400000));
       state.written+=await writeStream(db,company,unique,ids,run,businessFrom,businessTo,mysqlDateInShanghai(new Date(state.end)));
       state.read+=page.value.length;
       console.log(JSON.stringify({event:'approved_stock_page',group:state.index+1,groups:state.groups.length,page:first+offset,records:page.value.length,selected:state.written,from:g.from.slice(0,10),to:g.to.slice(0,10)}));
       if(page.value.length<100)complete=true;
      }
      if(!complete){state.nextPage=first+parallelPages;state.groupOrdered=ordered;await db.execute(`INSERT INTO data_client_scope_sync_progress(company_id,resource_name,state_json,updated_at) VALUES(?,'approved_stock_stream',?,NOW(3)) ON DUPLICATE KEY UPDATE state_json=VALUES(state_json),updated_at=VALUES(updated_at)`,[company,JSON.stringify(state)]);}
     }
     if(!complete)throw Error('库存流水达到分页上限，未推进覆盖游标');state.ordered&&=ordered;delete state.nextPage;delete state.groupOrdered;
     await db.execute(`INSERT INTO data_client_scope_sync_progress(company_id,resource_name,state_json,updated_at) VALUES(?,'approved_stock_stream',?,NOW(3)) ON DUPLICATE KEY UPDATE state_json=VALUES(state_json),updated_at=VALUES(updated_at)`,[company,JSON.stringify({...state,index:state.index+1})]);
    }
    await saveCursor(db,'approved_stock_stream',{initialFrom:state.initialFrom,modifiedThrough:state.end,skus:state.cohort,ordered:state.ordered});
    await db.execute("DELETE FROM data_client_scope_sync_progress WHERE company_id=? AND resource_name='approved_stock_stream'",[company]);
    await db.execute("UPDATE data_sync_runs SET status='success',finished_at=NOW(3),records_read=?,records_written=? WHERE id=?",[state.read,state.written,run]);
    return{read:state.read,written:state.written,through:state.end};
   }catch(error){await db.execute("UPDATE data_sync_runs SET status='failed',finished_at=NOW(3),error_message=? WHERE id=?",[String((error as Error).message).slice(0,2000),run]);throw error;}
  }finally{if(locked)await db.query("SELECT RELEASE_LOCK('gplan-approved-stock-stream')").catch(()=>undefined);db.release();}
 }
}

let stockSync:ApprovedStockSync|undefined;
export function scopePool(){return mysql.createPool({host:process.env.DATA_MYSQL_HOST,port:Number(process.env.DATA_MYSQL_PORT||3306),user:process.env.DATA_MYSQL_USER,password:process.env.DATA_MYSQL_PASSWORD,database:process.env.DATA_MYSQL_DATABASE,dateStrings:true,decimalNumbers:true,connectionLimit:2});}
export async function syncApprovedStock(company:string){if(process.env.DATA_DB_PROVIDER!=='mysql')return;stockSync??=new ApprovedStockSync(scopePool());return stockSync.sync(company);}

export function normalizeAfterSales(source:WanliniuRecord){
 const document=text(source.bill_code);if(!document||!Array.isArray(source.items))throw Error('售后单缺少单号或明细');
 const created=scopeDate(source.create_time),modified=scopeDate(source.modify_time),requestType=finite(source.type,'售后类型'),requestStatus=finite(source.status,'售后状态');
 const items=source.items.map((item:any,index:number)=>{
  const sku=text(item.sku_code);if(!sku&&!item.sys_spec_uid)throw Error('售后明细缺少规格身份');const quantity=finite(item.size,'售后申请数量');
  const received=item.return_item_size===undefined||item.return_item_size===null?null:finite(item.return_item_size,'售后实收数量');
  if(quantity<0||(received!==null&&received<0))throw Error('售后申请或实收数量不能为负数');
  return{lineKey:`${text(item.tp_off_id)||'line'}:${index}`,sku,specUid:text(item.sys_spec_uid)||null,quantity,received,
   barCode:text(item.bar_code)||null,name:text(item.item_name)||null,refundStatus:item.refund_status===undefined||item.refund_status===null?null:finite(item.refund_status,'退款状态')};
 });
 // Persist only inventory-relevant fields. Buyer contact details never enter the client tables.
 return{document,created,modified,requestType,requestStatus,storage:text(source.storage_code)||null,shop:text(source.sys_shop)||null,items};
}
export async function writeAfterSales(db:PoolConnection,company:string,records:WanliniuRecord[],ids:Identities,run:string){
 if(!records.length)return 0;const documents=records.map(normalizeAfterSales);
 await db.beginTransaction();try{
  await db.query('DELETE FROM ods_wln_client_after_sales WHERE company_id=? AND document_no IN (?)',[company,documents.map(d=>d.document)]);
  const rows=documents.flatMap(d=>d.items.map(i=>[company,d.document,i.lineKey,d.created,d.modified,d.storage,d.shop,i.sku,specId(ids,i.sku,i.specUid),i.barCode,i.name,d.requestType,d.requestStatus,i.quantity,i.received,i.refundStatus,run,mysqlDateInShanghai(new Date())]));
  for(let start=0;start<rows.length;start+=200){const page=rows.slice(start,start+200);await db.query(`INSERT INTO ods_wln_client_after_sales(company_id,document_no,line_key,created_at_source,modified_at_source,storage_code,shop_id,sku_code,source_spec_uid,bar_code,goods_name,request_type,request_status,request_quantity,received_quantity,refund_status,sync_run_id,ingested_at)
   VALUES ${page.map(()=>'('+Array(18).fill('?').join(',')+')').join(',')}`,page.flat());}
  await db.commit();return rows.length;
 }catch(error){await db.rollback();throw error;}
}
export class ClientAfterSalesSync{
 constructor(private pool:Pool,private client:WanliniuClient=wanliniuClient,private now=()=>new Date()){}
 async sync(company:string){
  if(company!==companyConfigured())throw Error('企业没有该连接器的同步权限');await ensureApprovedScopeSchema(this.pool);
  const db=await this.pool.getConnection();let locked=false;const run=uid('aftersales');
  try{const[lock]=await db.query<RowDataPacket[]>("SELECT GET_LOCK('gplan-client-after-sales',10) acquired");locked=Number(lock[0]?.acquired)===1;if(!locked)throw Error('客户售后同步正在运行');
   const ids=await identities(db,company),saved=await cursor(db,'client_after_sales');
   const[progress]=await db.query<RowDataPacket[]>("SELECT state_json FROM data_client_scope_sync_progress WHERE company_id=? AND resource_name='client_after_sales'",[company]);
   const pending=progress[0]?parse(progress[0].state_json):undefined;
   const end=pending?new Date(pending.end):new Date(Math.floor(this.now().getTime()/1000)*1000);
   const oldest=new Date(Date.parse(mysqlDateInShanghai(end).slice(0,10)+'T00:00:00+08:00')-89*86400000);
   const initialFrom=pending?.initialFrom||saved?.initialFrom||oldest.toISOString();let start=pending?new Date(pending.nextStart):saved?new Date(Math.max(oldest.getTime(),Date.parse(saved.modifiedThrough)-600000)):new Date(initialFrom);
   const checkpoint=async(nextStart:Date)=>db.execute(`INSERT INTO data_client_scope_sync_progress(company_id,resource_name,state_json,updated_at) VALUES(?,'client_after_sales',?,NOW(3)) ON DUPLICATE KEY UPDATE state_json=VALUES(state_json),updated_at=VALUES(updated_at)`,[company,JSON.stringify({initialFrom,end:end.toISOString(),nextStart:nextStart.toISOString()})]);
   await checkpoint(start);
   await db.execute(`INSERT INTO data_sync_runs(id,connector_id,resource_name,sync_mode,status,started_at) VALUES(?,'wanliniu','client_after_sales',?,'running',NOW(3))`,[run,saved?'incremental':'full']);
   let read=0,written=0;
   try{while(start<end){const stop=new Date(Math.min(start.getTime()+6*86400000,end.getTime()));let complete=false;
    for(let first=1;first<=10000&&!complete;first+=2){
     const pages=await Promise.allSettled([first,first+1].map(page=>this.client.listAfterSales(page,200,mysqlDateInShanghai(start).slice(0,19),mysqlDateInShanghai(stop).slice(0,19))));
     for(let offset=0;offset<pages.length;offset++){
      if(complete)continue;const page=pages[offset];if(page.status==='rejected')throw page.reason;
      const records=page.value;
     read+=records.length;written+=await writeAfterSales(db,company,records,ids,run);
     console.log(JSON.stringify({event:'client_after_sales_page',from:mysqlDateInShanghai(start).slice(0,19),to:mysqlDateInShanghai(stop).slice(0,19),page:first+offset,records:records.length}));
     const hasMore=(records as WanliniuRecord[]&{hasMore?:boolean}).hasMore;
     if(hasMore===true&&records.length===0)throw Error('售后空页仍标记有下一页，未推进游标');
     if(hasMore===false||(hasMore===undefined&&records.length<200))complete=true;
     }
    }
    if(!complete)throw Error('售后同步达到分页上限，未推进游标');
    await checkpoint(stop);start=stop;
   }
   // A modification-window checkpoint does not prove older applications are
   // current: they may have changed in a later window. Publish coverage only
   // after every window has succeeded, while retaining a resumable checkpoint.
   await saveCursor(db,'client_after_sales',{initialFrom,modifiedThrough:end.toISOString()});
   await db.execute("DELETE FROM data_client_scope_sync_progress WHERE company_id=? AND resource_name='client_after_sales'",[company]);
   await db.execute("UPDATE data_sync_runs SET status='success',finished_at=NOW(3),records_read=?,records_written=? WHERE id=?",[read,written,run]);return{read,written};
   }catch(error){await db.execute("UPDATE data_sync_runs SET status='failed',finished_at=NOW(3),error_message=? WHERE id=?",[String((error as Error).message).slice(0,2000),run]);throw error;}
  }finally{if(locked)await db.query("SELECT RELEASE_LOCK('gplan-client-after-sales')").catch(()=>undefined);db.release();}
 }
}
let afterSalesSync:ClientAfterSalesSync|undefined;
export async function syncClientAfterSales(company:string){if(process.env.DATA_DB_PROVIDER!=='mysql')return;afterSalesSync??=new ClientAfterSalesSync(scopePool());return afterSalesSync.sync(company);}

const canonicalProduct=`AND p.sku_code=(SELECT p2.sku_code FROM ods_wln_products p2 WHERE p2.company_id=p.company_id AND p2.source_spec_uid=p.source_spec_uid ORDER BY p2.source_modified_at DESC,p2.ingested_at DESC,p2.sku_code DESC LIMIT 1)`;
export async function loadApprovedStock(db:Db,company:string,date:string){
 const coverage=await approvedCoverage(db,company,date);
 const covered=!!coverage.available_from&&date>=coverage.available_from&&date<=mysqlDateInShanghai(new Date(coverage.synced_through!)).slice(0,10);
 if(!covered)return{coverage,coversTransfers:false,rows:[] as RowDataPacket[]};
 const[rows]=await db.query<RowDataPacket[]>(`SELECT m.bill_type_name,m.document_no,m.storage_code,m.quantity_delta,
 r.related_order_no,r.business_reason,CASE po.operation_mode WHEN 0 THEN 'ASSEMBLY' WHEN 1 THEN 'DISASSEMBLY' ELSE NULL END operation_type,
 COALESCE(NULLIF(m.bar_code,''),NULLIF(p.bar_code,'')) product_code,COALESCE(NULLIF(m.goods_name,''),p.goods_name) product_name,
 DATE_FORMAT(m.bill_date,'%Y-%m-%dT%H:%i:%s+08:00') movement_time
 FROM ods_wln_approved_stock_stream m JOIN ods_wln_products p ON p.company_id=m.company_id AND p.source_spec_uid=m.source_spec_uid ${canonicalProduct}
 LEFT JOIN data_wln_client_stock_references r ON r.company_id=m.company_id AND r.document_no=m.document_no
 LEFT JOIN data_wln_client_production_orders po ON po.company_id=m.company_id AND po.document_no=COALESCE(r.related_order_no,m.document_no)
 WHERE m.company_id=? AND m.bill_date>=? AND m.bill_date<DATE_ADD(?,INTERVAL 1 DAY) AND m.occurred_at<=?
 AND m.storage_code IN ('CK001','CK008') AND JSON_UNQUOTE(JSON_EXTRACT(p.raw_payload,'$.goods.brand_name'))='薇诺娜'
 ORDER BY m.bill_date,m.document_no,m.stream_id`,[company,date,date,mysqlDateInShanghai(new Date(coverage.synced_through!))]);
 const[missing]=await db.query<RowDataPacket[]>(`SELECT COUNT(*) unresolved_rows,
 SUM(m.bill_type_name IN ('调拨入库','调拨出库','调拨','调拨还回')) unresolved_transfers FROM ods_wln_approved_stock_stream m
 WHERE m.company_id=? AND m.bill_date>=? AND m.bill_date<DATE_ADD(?,INTERVAL 1 DAY) AND m.occurred_at<=? AND m.storage_code IN ('CK001','CK008')
 AND (m.source_spec_uid IS NULL OR NOT EXISTS(SELECT 1 FROM ods_wln_products p WHERE p.company_id=m.company_id AND p.source_spec_uid=m.source_spec_uid))`,[company,date,date,mysqlDateInShanghai(new Date(coverage.synced_through!))]);
 const missingCount=Number(missing[0]?.unresolved_rows||0);if(missingCount){coverage.status='partial';coverage.unresolved_rows=missingCount;coverage.message=`${missingCount}条新增库存明细无法确认商品品牌，未提供，缺失不能视为零`;}
 const coversTransfers=Number(missing[0]?.unresolved_transfers||0)===0;
 return{coverage,coversTransfers,rows:rows.flatMap(r=>{const m=approvedMovement(r.bill_type_name,Number(r.quantity_delta));if(!m||(!coversTransfers&&(m.inbound_type?.startsWith('TRANSFER')||m.outbound_type?.startsWith('TRANSFER'))))return[];return[{...r,...m,shop_id:null,source_document_no:r.document_no} as RowDataPacket];})};
}
export function mergeMovementCoverage(a:ScopeCoverage,b:ScopeCoverage):ScopeCoverage{
 const status=a.status==='unavailable'||b.status==='unavailable'?'unavailable':a.status==='partial'||b.status==='partial'?'partial':'complete';
 const message=[a.message,b.message].filter(Boolean).join('；');
 return{status,available_from:a.available_from&&b.available_from?[a.available_from,b.available_from].sort().at(-1)!:null,
 synced_through:a.synced_through&&b.synced_through?[a.synced_through,b.synced_through].sort()[0]:null,
 ...(message?{message}:{}),...((a.unresolved_rows||b.unresolved_rows)?{unresolved_rows:(a.unresolved_rows||0)+(b.unresolved_rows||0)}:{})};
}
export async function loadClientAfterSales(db:Db,company:string,date:string,shops:Record<string,string>){
 const coverage=await approvedCoverage(db,company,date,'client_after_sales');
 const[pending]=await db.query<RowDataPacket[]>("SELECT resource_name FROM data_client_scope_sync_progress WHERE company_id=? AND resource_name='client_after_sales'",[company]);
 if(pending.length&&coverage.status==='complete'){coverage.status='partial';coverage.message='售后状态正在更新，完整查询完成前不能将缺失视为零';}
 const[rows]=await db.query<RowDataPacket[]>(`SELECT a.document_no,a.shop_id,a.storage_code,a.request_type,a.request_status,a.request_quantity,a.received_quantity,a.refund_status,
 COALESCE(NULLIF(a.bar_code,''),NULLIF(p.bar_code,'')) product_code,COALESCE(NULLIF(a.goods_name,''),p.goods_name) product_name,
 DATE_FORMAT(a.created_at_source,'%Y-%m-%dT%H:%i:%s+08:00') created_at,DATE_FORMAT(a.modified_at_source,'%Y-%m-%dT%H:%i:%s+08:00') last_modified_at
 FROM ods_wln_client_after_sales a JOIN ods_wln_products p ON p.company_id=a.company_id AND p.source_spec_uid=a.source_spec_uid ${canonicalProduct}
 WHERE a.company_id=? AND a.created_at_source>=? AND a.created_at_source<DATE_ADD(?,INTERVAL 1 DAY)
 AND a.storage_code IN ('CK001','CK008') AND a.shop_id IN (?) AND JSON_UNQUOTE(JSON_EXTRACT(p.raw_payload,'$.goods.brand_name'))='薇诺娜'
 AND a.request_type IN (0,2,4) AND a.request_status NOT IN (2,3,4)
 AND (a.received_quantity IS NULL OR a.received_quantity<a.request_quantity)
 ORDER BY a.created_at_source,a.document_no,a.line_key`,[company,date,date,Object.keys(shops)]);
 const[missing]=await db.query<RowDataPacket[]>(`SELECT COUNT(*) unresolved_rows FROM ods_wln_client_after_sales a
 WHERE a.company_id=? AND a.created_at_source>=? AND a.created_at_source<DATE_ADD(?,INTERVAL 1 DAY)
 AND a.storage_code IN ('CK001','CK008') AND a.shop_id IN (?) AND a.request_type IN (0,2,4) AND a.request_status NOT IN (2,3,4)
 AND (a.received_quantity IS NULL OR a.received_quantity<a.request_quantity)
 AND (a.source_spec_uid IS NULL OR NOT EXISTS(SELECT 1 FROM ods_wln_products p WHERE p.company_id=a.company_id AND p.source_spec_uid=a.source_spec_uid))`,[company,date,date,Object.keys(shops)]);
 const missingCount=Number(missing[0]?.unresolved_rows||0),unknownReceipts=rows.filter(r=>r.received_quantity===null).length;
 if(missingCount||unknownReceipts){
  if(coverage.status==='complete')coverage.status='partial';
  if(missingCount)coverage.unresolved_rows=missingCount;if(unknownReceipts)coverage.unknown_receipt_rows=unknownReceipts;
  coverage.message=[coverage.message,missingCount?`${missingCount}条售后明细无法确认商品品牌，未提供`:null,unknownReceipts?`${unknownReceipts}条申请实收数量未知，不按零或已实收处理`:null].filter(Boolean).join('；');
 }
 return{coverage,rows:rows.map(r=>({record_type:'after_sales_request',business_date:date,document_no:r.document_no,
  shop_name:shops[String(r.shop_id)],storage_name:r.storage_code==='CK008'?'奕页仓库':'淘宝仓库',product_code:r.product_code||null,product_name:r.product_name||'',
  request_type:({0:'RETURN',2:'EXCHANGE',4:'REFUND_ONLY'} as Record<number,string>)[Number(r.request_type)],request_status:Number(r.request_status),
  request_quantity:Number(r.request_quantity),received_quantity:r.received_quantity===null?null:Number(r.received_quantity),
  unreceived_quantity:r.received_quantity===null?null:Math.max(0,Number(r.request_quantity)-Number(r.received_quantity)),
  receipt_status:r.received_quantity===null?'UNKNOWN':Number(r.received_quantity)===0?'NOT_RECEIVED':'PARTIALLY_RECEIVED',refund_status:r.refund_status===null?null:Number(r.refund_status),
  inventory_effect:false,created_at:r.created_at,last_modified_at:r.last_modified_at}))};
}

export async function syncClientStockReferences(pool:Pool,company:string,client:WanliniuClient=wanliniuClient){
 if(company!==companyConfigured())throw Error('企业没有该连接器的同步权限');await ensureApprovedScopeSchema(pool);
 const db=await pool.getConnection();let locked=false;const run=uid('stockref');
 try{const[got]=await db.query<RowDataPacket[]>("SELECT GET_LOCK('gplan-client-stock-references',10) acquired");locked=Number(got[0]?.acquired)===1;if(!locked)throw Error('客户出入库关联信息正在同步');
  await db.execute(`INSERT INTO data_sync_runs(id,connector_id,resource_name,sync_mode,status,started_at) VALUES(?,'wanliniu','client_stock_references','incremental','running',NOW(3))`,[run]);
  const now=new Date(),saved=await cursor(db,'client_stock_references'),oldest=new Date(Date.parse(mysqlDateInShanghai(now).slice(0,10)+'T00:00:00+08:00')-89*86400000);
  const initialFrom=saved?.initialFrom||oldest.toISOString();let read=0,written=0;
  try{
   let complete=false;for(let page=1;page<=5000;page++){
    const orders=await client.listProductionOrders(page,100);read+=orders.length;
    const rows=orders.map(o=>{const no=text(o.product_code);if(!no)throw Error('加工订单缺少单号');const mode=o.product_mode===null||o.product_mode===undefined?null:finite(o.product_mode,'加工模式');return[company,no,mode,mysqlDateInShanghai(now)];});
    if(rows.length)await db.query(`INSERT INTO data_wln_client_production_orders(company_id,document_no,operation_mode,ingested_at) VALUES ${rows.map(()=>'('+Array(4).fill('?').join(',')+')').join(',')} ON DUPLICATE KEY UPDATE operation_mode=VALUES(operation_mode),ingested_at=VALUES(ingested_at)`,rows.flat());written+=rows.length;
    if((orders as any).hasMore===false||((orders as any).hasMore===undefined&&orders.length<100)){complete=true;break;}
    if(!orders.length)throw Error('加工订单空页仍有后续，不能确定关联信息完整');
   }if(!complete)throw Error('加工订单关联达到分页上限');
   for(const resource of ['other_in','other_out','production_in','production_out'] as const){
    for(let start=saved?new Date(Math.max(oldest.getTime(),Date.parse(saved.modifiedThrough)-600000)):oldest;start<now;){
     const stop=new Date(Math.min(start.getTime()+6*86400000,now.getTime()));let done=false;
     for(let page=1;page<=5000;page++){
      const records=await client.listStockReferences(resource,page,200,mysqlDateInShanghai(start).slice(0,19),mysqlDateInShanghai(stop).slice(0,19));read+=records.length;
      const rows=records.map(r=>{const no=text(r.stock_code);if(!no)throw Error('实际出入库单缺少单号');return[company,no,text(r.stock_req_bill_code)||null,text(r.reason)||null,mysqlDateInShanghai(now)];});
      if(rows.length)await db.query(`INSERT INTO data_wln_client_stock_references(company_id,document_no,related_order_no,business_reason,ingested_at) VALUES ${rows.map(()=>'('+Array(5).fill('?').join(',')+')').join(',')} ON DUPLICATE KEY UPDATE related_order_no=VALUES(related_order_no),business_reason=VALUES(business_reason),ingested_at=VALUES(ingested_at)`,rows.flat());written+=rows.length;
      if(records.length<200){done=true;break;}
     }
     if(!done)throw Error('实际出入库关联达到分页上限');start=stop;
    }
   }
   await saveCursor(db,'client_stock_references',{initialFrom,modifiedThrough:now.toISOString()});
   await db.execute("UPDATE data_sync_runs SET status='success',finished_at=NOW(3),records_read=?,records_written=? WHERE id=?",[read,written,run]);return{read,written};
  }catch(error){await db.execute("UPDATE data_sync_runs SET status='failed',finished_at=NOW(3),error_message=? WHERE id=?",[String((error as Error).message).slice(0,2000),run]);throw error;}
 }finally{if(locked)await db.query("SELECT RELEASE_LOCK('gplan-client-stock-references')").catch(()=>undefined);db.release();}
}
let referencePool:Pool|undefined;
export async function syncClientStockReferenceMetadata(company:string){if(process.env.DATA_DB_PROVIDER!=='mysql')return;referencePool??=scopePool();return syncClientStockReferences(referencePool,company);}
