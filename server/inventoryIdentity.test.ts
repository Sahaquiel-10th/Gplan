import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalInventoryRows,repairCachedInventory,MissingInventoryIdentityError} from './inventoryIdentity.js';
import {loadInventorySnapshot,saveInventorySnapshot} from './inventorySnapshots.js';
import {buildClientReport} from './clientDailyReport.js';
import {MySqlDataPlatformStore} from './dataPlatformDb.js';
import {normalizeInventory} from './data-connectors/wanliniu/mappers.js';

const old={company_id:'c',storage_code:'w',sku_code:'old',resolved_uid:'uid',product_modified:'2026-05-01',snapshot_at:'2026-10-15',actual_quantity:26530};
const fresh={...old,sku_code:'new',product_modified:'2026-10-15',snapshot_at:'2026-10-31',actual_quantity:27441};
test('SKU 改码按稳定规格替换，既不相加也不除以二',()=>{
 const r=canonicalInventoryRows([old,fresh]);assert.equal(r.kept.length,1);assert.equal(r.retired.length,1);assert.equal(r.kept[0].actual_quantity,27441);
 assert.equal(canonicalInventoryRows([{...old,snapshot_at:'2026-11-05'},fresh]).kept[0].sku_code,'new');
});
test('同条码不同系统规格、不同仓库、不同企业不合并',()=>{
 const r=canonicalInventoryRows([fresh,{...fresh,resolved_uid:'other'}, {...fresh,storage_code:'w2'}, {...fresh,company_id:'other'}]);assert.equal(r.kept.length,4);
});
test('缺少稳定身份或同序冲突必须失败，零库存删除占位单独保留',()=>{
 assert.throws(()=>canonicalInventoryRows([{...old,resolved_uid:null}]),MissingInventoryIdentityError);
 assert.throws(()=>canonicalInventoryRows([fresh,{...fresh,sku_code:'x',actual_quantity:999}]));
 assert.equal(canonicalInventoryRows([{...old,resolved_uid:null,sku_code:'已删除商品',actual_quantity:0}]).tombstones.length,1);
});
test('真实事故的旧缓存被修正，原库存观察日期不改写',()=>{
 const products=[{sku_code:'old',bar_code:'6958717812680',goods_name:'旧名',source_spec_uid:'uid',source_modified_at:'2026-05-01'}, {sku_code:'new',bar_code:'6958717812680',goods_name:'新名',source_spec_uid:'uid',source_modified_at:'2026-10-15'}];
 const base={record_type:'inventory',product_code:'6958717812680',inventory_date:'2026-11-01',inventory_as_of:'2026-11-01T03:00:10+08:00'};
 const result=repairCachedInventory([{...base,product_name:'旧名',inventory_quantity:26530,storage_name:'淘宝仓库'},{...base,product_name:'新名',inventory_quantity:27441,storage_name:'淘宝仓库'},{...base,product_name:'旧名',inventory_quantity:17141,storage_name:'奕页仓库'},{...base,product_name:'新名',inventory_quantity:15951,storage_name:'奕页仓库'}],products);
 assert.equal(result.rows.reduce((n,r)=>n+r.inventory_quantity,0),43392);assert.equal(result.removed,2);assert(result.rows.every(r=>r.inventory_date==='2026-11-01'));
});
test('没有历史库存不准回退今天的库存；旧时点快照不可被重跑覆盖',async()=>{
 const sql:string[]=[];const db={execute:async(q:string)=>{sql.push(q);return [[]];}} as any;
 assert.equal((await loadInventorySnapshot(db,'c','2026-10-30')).quality.status,'unavailable');
 await saveInventorySnapshot(db,'c','2026-10-30',[],{status:'complete',source:'test',missing_rows:0});
 assert(sql.at(-1)!.includes('INSERT IGNORE'));assert(sql.every(q=>!q.includes('ods_wln_inventory_current')));
});
test('历史缺口是 null，不得在日报内变成 0',async()=>{
 const db={query:async()=>[[]],execute:async()=>[[{revision:'r',quality_json:{status:'partial',missing_rows:1},rows_json:[{storage_code:'CK001',source_spec_uid:'uid',product_code:'69',product_name:'缺口',quantity:null,inventory_date:'2026-10-21',snapshot_time:'2026-10-21T23:59:59+08:00'}]}]]} as any;
 const r=await buildClientReport(db,'c','2026-10-21');assert.equal(r.rows[0].inventory_quantity,null);assert.equal(r.inventoryStatus.status,'partial');
});
test('库存数量缺失不能伪造零，有效零值及负库存仍保留',()=>{
 for(const value of [undefined,null,'','bad',Infinity])assert.throws(()=>normalizeInventory({sku_code:'s',storage_code:'w',quantity:value},'t'));
 assert.equal(normalizeInventory({sku_code:'s',storage_code:'w',quantity:0},'t').actualQuantity,0);
 assert.equal(normalizeInventory({sku_code:'s',storage_code:'w',quantity:-2},'t').actualQuantity,-2);
});
test('真实写入路径按稳定 UID upsert，改码先留审计且不删除历史商品主数据',async()=>{
 const calls:string[]=[];const oldRow={company_id:'c',storage_code:'w',sku_code:'old',source_spec_uid:'uid',snapshot_at:'2026-10-30 03:00:00.000000',product_modified:'2026-05-01'};
 const connection={query:async(q:string)=>{calls.push(q);if(q.includes('GET_LOCK'))return [[{acquired:1}]];if(q.includes('FOR UPDATE'))return [[oldRow]];return [[]];},execute:async(q:string)=>{calls.push(q);return [{affectedRows:1}];},beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}};
 const pool={query:async()=>[[{requested_sku:'new',sku_code:'new',source_spec_uid:'uid',source_modified_at:'2026-10-15'}]],getConnection:async()=>connection} as any;
 const store=new MySqlDataPlatformStore(pool,'test');
 await store.upsertInventory('c',[normalizeInventory({sku_code:'new',storage_code:'w',quantity:27441},'2026-10-31 03:00:00.000')],'run');
 assert(calls.some(q=>q.includes('data_inventory_identity_archive')));assert(calls.some(q=>q.includes('sku_code=VALUES(sku_code),source_spec_uid=VALUES(source_spec_uid)')));
 assert(calls.every(q=>!q.includes('DELETE FROM ods_wln_products')));
});
