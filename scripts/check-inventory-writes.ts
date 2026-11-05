// Native-MySQL regression using connection-local temporary tables only.
import {config} from 'dotenv';
import mysql from 'mysql2/promise';
import assert from 'node:assert/strict';
config({path:process.env.GPLAN_ENV_FILE||'.env',quiet:true});
process.env.DATA_DB_PROVIDER='disabled';
const{MySqlDataPlatformStore}=await import('../server/dataPlatformDb.js');
const{normalizeInventory,normalizeProducts}=await import('../server/data-connectors/wanliniu/mappers.js');
const e=process.env;
const db=await mysql.createConnection({host:e.DATA_MYSQL_HOST,port:Number(e.DATA_MYSQL_PORT||3306),user:e.DATA_MYSQL_USER,password:e.DATA_MYSQL_PASSWORD,database:e.DATA_MYSQL_DATABASE,dateStrings:true,decimalNumbers:true,charset:'utf8mb4'});
try{
 for(const table of ['ods_wln_products','ods_wln_inventory_current']){
   const[ddl]=await db.query<any[]>('SHOW CREATE TABLE '+table);
   await db.query(String(ddl[0]['Create Table']).replace(/^CREATE TABLE/,'CREATE TEMPORARY TABLE'));
 }
 const[col]=await db.query<any[]>("SHOW COLUMNS FROM ods_wln_inventory_current LIKE 'source_spec_uid'");
 if(!col.length)await db.query('ALTER TABLE ods_wln_inventory_current ADD COLUMN source_spec_uid VARCHAR(128) NULL,ADD UNIQUE INDEX uniq_test_spec(company_id,storage_code,source_spec_uid)');
 await db.query('CREATE TEMPORARY TABLE data_product_identity_aliases(company_id VARCHAR(128),source_spec_uid VARCHAR(128),alias_sha256 CHAR(64),sku_code VARCHAR(128),bar_code VARCHAR(128),goods_name VARCHAR(255),source_modified_at DATETIME(3),PRIMARY KEY(company_id,source_spec_uid,alias_sha256))');
 await db.query('CREATE TEMPORARY TABLE data_inventory_identity_archive(company_id VARCHAR(128),storage_code VARCHAR(128),source_spec_uid VARCHAR(128),sku_code VARCHAR(128),payload_sha256 CHAR(64),row_json JSON,reason VARCHAR(64),PRIMARY KEY(company_id,storage_code,sku_code,payload_sha256))');
 const connection={query:db.query.bind(db),execute:db.execute.bind(db),beginTransaction:db.beginTransaction.bind(db),commit:db.commit.bind(db),rollback:db.rollback.bind(db),release:()=>{}};
 const store=new MySqlDataPlatformStore({query:db.query.bind(db),execute:db.execute.bind(db),getConnection:async()=>connection} as any,'test');
 const company='inventory-regression';
 async function product(sku:string,uid:string,date:string){await store.upsertProducts(company,normalizeProducts({goods_code:sku,goods_name:sku,modify_time:date,specs:[{spec_code:sku,sys_spec_uid:uid,barcode:'6958717812680',status:1}]}),'test');}
 async function inventory(sku:string,quantity:number,date:string){return store.upsertInventory(company,[normalizeInventory({sku_code:sku,storage_code:'CK001',quantity},date)],'test');}
 await product('old','uid-1','2026-10-01 00:00:00');await inventory('old',26530,'2026-10-15 03:00:00.000');
 await product('new','uid-1','2026-10-15 12:00:00');await inventory('new',27441,'2026-10-31 03:00:00.000');
 let[rows]=await db.query<any[]>('SELECT * FROM ods_wln_inventory_current');assert.equal(rows.length,1);assert.equal(rows[0].actual_quantity,27441);assert.equal(rows[0].sku_code,'new');
 assert.equal(await inventory('old',999999,'2026-11-05 03:00:00.000'),0);
 await product('other','uid-2','2026-10-01 00:00:00');await inventory('other',5,'2026-10-31 03:00:00.000');
 [rows]=await db.query<any[]>('SELECT * FROM ods_wln_inventory_current');assert.equal(rows.length,2);
 await product('width(M)','uid-3','2026-10-01 00:00:00');await inventory('width(M)',8,'2026-10-30 03:00:00.000');
 await product('width（M）','uid-3','2026-10-31 00:00:00');await inventory('width(M)',6,'2026-10-31 03:00:00.000');
 [rows]=await db.query<any[]>("SELECT * FROM ods_wln_inventory_current WHERE source_spec_uid='uid-3'");assert.equal(rows.length,1);assert.equal(rows[0].actual_quantity,6);
 await product('new','uid-4','2026-11-01 00:00:00');await inventory('new',3,'2026-11-01 03:00:00.000');
 [rows]=await db.query<any[]>("SELECT * FROM ods_wln_inventory_current WHERE sku_code='new'");assert.equal(rows.length,1);assert.equal(rows[0].source_spec_uid,'uid-4');assert.equal(rows[0].actual_quantity,3);
 const[archived]=await db.query<any[]>('SELECT COUNT(*) n FROM data_inventory_identity_archive');assert(archived[0].n>=2);
 console.log(JSON.stringify({nativeInventoryWrites:'ok',temporaryTablesOnly:true,checks:['rename','stale-replay','same-barcode-independent-specs','character-width','sku-reuse','audit']}));
}finally{await db.end();}
