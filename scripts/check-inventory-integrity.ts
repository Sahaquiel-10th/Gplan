import {config} from 'dotenv';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import mysql,{type RowDataPacket} from 'mysql2/promise';
import {loadInventorySnapshot} from '../server/inventorySnapshots.js';
config({path:process.env.GPLAN_ENV_FILE||'.env',quiet:true});
const e=process.env;
const credential=JSON.parse(await fs.readFile(e.CLIENT_API_CREDENTIAL_FILE||'/root/winona-trial-20261015.json','utf8'));
const token=e.CLIENT_API_TOKEN||credential.token;
const base=e.CLIENT_API_BASE_URL||credential.base_url;
const dates=(e.INVENTORY_CHECK_DATES||new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10)).split(',');
const db=await mysql.createConnection({host:e.DATA_MYSQL_HOST,port:Number(e.DATA_MYSQL_PORT||3306),user:e.DATA_MYSQL_USER,password:e.DATA_MYSQL_PASSWORD,database:e.DATA_MYSQL_DATABASE,decimalNumbers:true,dateStrings:true});
try{
 const[clients]=await db.execute<RowDataPacket[]>('SELECT company_id FROM data_api_clients WHERE token_hash=? AND enabled=1',[crypto.createHash('sha256').update(token).digest('hex')]);
 assert.equal(clients.length,1);const company=clients[0].company_id;
 const[duplicates]=await db.execute<RowDataPacket[]>('SELECT storage_code,source_spec_uid FROM ods_wln_inventory_current WHERE company_id=? AND source_spec_uid IS NOT NULL GROUP BY storage_code,source_spec_uid HAVING COUNT(*)>1',[company]);
 assert.equal(duplicates.length,0,'Stable inventory IDs must be unique');
 for(const date of dates){
  const source=await loadInventorySnapshot(db,company,date),expected=new Map<string,number|null>();
  for(const r of source.rows){
   const key=JSON.stringify([r.storage_code==='CK008'?'奕页仓库':'淘宝仓库',r.product_code,r.product_name,r.inventory_date]);
   const previous=expected.has(key)?expected.get(key)!:0;
   expected.set(key,previous===null||r.quantity===null?null:previous+r.quantity);
  }
  const observed=new Map<string,number|null>();let batch:string|undefined,rows=0,pages=0;
  for(let page=1;;page++){
   const query=new URLSearchParams({date,page:String(page),page_size:'200',...(batch?{batch_id:batch}:{})});
   const response=await fetch(base+'/daily-report?'+query,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(60000)});
   assert.equal(response.status,200);const body=await response.json() as any;
   assert.equal(body.code,0);assert.deepEqual(body.inventory_status,{status:source.quality.status,missing_rows:source.quality.missing_rows,...(source.quality.message?{message:source.quality.message}:{})});
   batch ||= body.batch_id;assert.equal(body.batch_id,batch);
   for(const r of body.data.filter((r:any)=>r.record_type==='inventory')){
    const key=JSON.stringify([r.storage_name,r.product_code,r.product_name,r.inventory_date]);
    assert(!observed.has(key),'Duplicate public inventory key');observed.set(key,r.inventory_quantity);
   }
   rows+=body.data.length;pages++;
   if(!body.pagination.has_more){assert.equal(rows,body.pagination.total);break;}
   assert(page<1000);await new Promise(resolve=>setTimeout(resolve,550));
  }
  assert.deepEqual([...observed].sort(),[...expected].sort(),'API inventory must reconcile exactly with the saved observation');
  console.log(JSON.stringify({inventoryIntegrity:'ok',date,status:source.quality.status,inventoryRows:observed.size,rows,pages,batchId:batch}));
 }
}finally{await db.end();}
