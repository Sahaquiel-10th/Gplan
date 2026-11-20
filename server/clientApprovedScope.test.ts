import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool,PoolConnection} from 'mysql2/promise';
import {ApprovedStockSync,ClientAfterSalesSync,approvedMovement,normalizeApprovedStream,normalizeAfterSales,writeAfterSales,mergeMovementCoverage,loadApprovedStock,loadClientAfterSales,syncClientStockReferences} from './clientApprovedScope.js';
import type {WanliniuClient} from './data-connectors/wanliniu/client.js';

test('客户选定的库存类型按变动量统计，期末余额不能代替发生量',()=>{
 const source={pism_index:'1795079008080000076',bill_type_name:'其他出库',bill_code:'CK1',sku_code:'sku',storage_code:'CK001',date:1794931200000,time:1794982221000,size:-2,quantity:999};
 const row=normalizeApprovedStream(source);assert.equal(row.id,'1795079008080000076');assert.equal(row.delta,-2);assert.equal(row.balance,999);
 assert.deepEqual(approvedMovement(row.kind,row.delta),{record_type:'outbound',inbound_type:null,outbound_type:'OTHER',quantity:2});
 assert.equal(approvedMovement('其他出库',2)!.quantity,-2,'冲回时保留相反方向，不用绝对值再减一次');
 assert.equal(approvedMovement('采购退货',-3)!.outbound_type,'PURCHASE_RETURN');
 assert.equal(approvedMovement('盘盈盘亏',3)!.inbound_type,'INVENTORY_GAIN');
 assert.equal(approvedMovement('盘盈盘亏',-3)!.outbound_type,'INVENTORY_LOSS');
 assert.equal(approvedMovement('领料出库',-2)!.quantity,2);
 assert.equal(approvedMovement('退料入库',1)!.inbound_type,'PRODUCTION_MATERIAL_RETURN');
 assert.equal(approvedMovement('成品入库',10)!.quantity,10);
 assert.equal(approvedMovement('成品取消',-10)!.outbound_type,'PRODUCTION_CANCEL');
 assert.equal(approvedMovement('加工单',3)!.inbound_type,'PRODUCTION_ADJUSTMENT');
 for(const delta of [-7,7])assert.equal(approvedMovement('调拨还回',delta)!.quantity,7);
 for(const kind of ['报损报溢单','正次转换','门店交易单','收款','销售出库冲账'])assert.equal(approvedMovement(kind,5),null,'未选项目不因枚举相似而放开');
 assert.equal(approvedMovement('其他入库',0),null);
 assert.throws(()=>normalizeApprovedStream({...source,size:null}),/变动数量/);
});

const request=(received:unknown=0)=>({bill_code:'SH1',create_time:'2026-11-18 10:00:00',modify_time:'2026-11-19 12:00:00',storage_code:'CK001',sys_shop:'shop',type:4,status:1,buyer_name:'private buyer',phone:'private phone',items:[{size:2,return_item_size:received,sku_code:'sku',sys_spec_uid:'spec',item_name:'产品',refund_status:6}]});
test('未收货售后单只持久化所需字段，未知实收不伪造为零',()=>{
 const r=normalizeAfterSales(request());assert.equal(r.items[0].received,0);assert.equal(r.requestType,4);
 assert(!JSON.stringify(r).includes('private'));assert.equal(normalizeAfterSales(request(null)).items[0].received,null);
 assert.throws(()=>normalizeAfterSales({...request(),items:[{size:null,sku_code:'sku'}]}),/申请数量/);
});

test('售后整单替换可重放，插入失败会回滚，不把退款写成入库',async()=>{
 const calls:any[]=[];let commits=0,rollbacks=0,fail=false;
 const db={query:async(sql:string,args:any[])=>{calls.push({sql,args});if(fail&&sql.startsWith('INSERT'))throw Error('insert failed');return[[]];},beginTransaction:async()=>{},commit:async()=>{commits++;},rollback:async()=>{rollbacks++;}} as unknown as PoolConnection;
 const ids={bySku:new Map<string,Set<string>>(),skus:[]};
 for(let i=0;i<2;i++)await writeAfterSales(db,'company_default',[request()],ids,'run');
 assert.equal(commits,2);assert.equal(calls.filter(c=>c.sql.startsWith('DELETE')).length,2);
 assert(calls.every(c=>!c.sql.includes('ods_wln_stock_movements')));assert(!JSON.stringify(calls).includes('private'));
 fail=true;await assert.rejects(writeAfterSales(db,'company_default',[request()],ids,'run'),/insert failed/);assert.equal(rollbacks,1);
});

test('新增库存覆盖未完成时不替换既有调拨，范围缺口不能被合并为完整',async()=>{
 const db={query:async()=>[[]]} as unknown as Pool;
 const result=await loadApprovedStock(db,'company_default','2026-11-18');assert.equal(result.coversTransfers,false);assert.equal(result.rows.length,0);
 const a={status:'complete' as const,available_from:'2026-08-22',synced_through:'2026-11-20T03:00:00Z'};
 assert.equal(mergeMovementCoverage(a,result.coverage).status,'unavailable');
 assert.equal(mergeMovementCoverage(a,{...a,status:'partial'}).status,'partial');
});

function fakePool(){
 const calls:any[]=[];let released=false;
 const state={initialFrom:'2026-11-17T16:00:00Z',end:'2026-11-19T03:00:00Z',groups:[{from:'2026-11-18 00:00:00',to:'2026-11-19 00:00:00',skus:[]}],index:0,read:0,written:0,ordered:true,cohort:['sku']};
 const query=async(sql:string,args:any[])=>{calls.push({sql,args});if(sql.includes('GET_LOCK'))return[[{acquired:1}]];if(sql.includes('FROM ods_wln_products')&&sql.includes('brand'))return[[{sku_code:'sku',source_spec_uid:'spec',brand:'薇诺娜'}]];if(sql.includes('SELECT state_json')&&args?.[1]==='approved_stock_stream')return[[{state_json:state}]];return[[]];};
 const db={query,execute:query,release:()=>{released=true;},beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{}};
 const pool={query,execute:query,getConnection:async()=>db} as unknown as Pool;
 return{pool,calls,get released(){return released;}};
}
test('库存流分页失败不推进覆盖游标，释放跨进程租约，可从保存进度重试',async()=>{
 const f=fakePool();const client={listInventoryStream:async(page:number)=>{if(page===2)throw Error('page two failed');return page===1?Array.from({length:100},(_,i)=>({pism_index:String(10000-i),bill_type_name:'其他出库',bill_code:'CK1',sku_code:'sku',storage_code:'CK001',date:1794931200000,time:1794982221000,size:-1,quantity:999})):[];}} as unknown as WanliniuClient;
 await assert.rejects(new ApprovedStockSync(f.pool,client,()=>new Date('2026-11-20T03:00:00Z')).sync('company_default'),/page two failed/);
 assert.equal(f.calls.filter(c=>c.sql.startsWith('INSERT INTO data_sync_cursors')).length,0);assert(f.released);
 const inserted=f.calls.find(c=>c.sql.includes('INSERT INTO ods_wln_approved_stock_stream'));assert(inserted);assert(inserted.sql.includes('ON DUPLICATE KEY UPDATE'));
});
test('售后空页仍称有后续页时失败，不虚报同步完整',async()=>{
 const f=fakePool();const client={listAfterSales:async()=>Object.assign([],{hasMore:true})} as unknown as WanliniuClient;
 await assert.rejects(new ClientAfterSalesSync(f.pool,client,()=>new Date('2026-11-20T03:00:00Z')).sync('company_default'),/空页/);
 assert.equal(f.calls.filter(c=>c.sql.startsWith('INSERT INTO data_sync_cursors')).length,0);assert(f.released);
});
test('售后后续修改窗口失败时只保存进度，不把早期申请虚报为当前完整',async()=>{
 const f=fakePool();const client={listAfterSales:async(_page:number,_limit:number,start:string)=>{
  if(start.startsWith('2026-08-23'))return Object.assign([],{hasMore:false});
  throw Error('later window failed');
 }} as unknown as WanliniuClient;
 await assert.rejects(new ClientAfterSalesSync(f.pool,client,()=>new Date('2026-11-20T03:00:00Z')).sync('company_default'),/later window failed/);
 assert.equal(f.calls.filter(c=>c.sql.startsWith('INSERT INTO data_sync_cursors')).length,0);
 assert(f.calls.filter(c=>c.sql.startsWith('INSERT INTO data_client_scope_sync_progress')).length>=2);
 assert(f.released);
});
test('客户售后列表不提供买家信息或实际入库量，未知实收仍为null',async()=>{
 const db={query:async(sql:string)=>sql.includes('SELECT cursor_json')?[[{cursor_json:{initialFrom:'2026-08-22T16:00:00Z',modifiedThrough:'2026-11-20T03:00:00Z'}}]]:[[{
  document_no:'SH1',shop_id:'shop',storage_code:'CK001',request_type:4,request_status:1,request_quantity:2,received_quantity:null,refund_status:6,product_code:'69',product_name:'产品',created_at:'2026-11-18T10:00:00+08:00',last_modified_at:'2026-11-19T12:00:00+08:00'
 }]]} as unknown as Pool;
 const result=await loadClientAfterSales(db,'company_default','2026-11-18',{shop:'约定店铺'});
 assert.equal(result.rows[0].inventory_effect,false);assert.equal(result.rows[0].received_quantity,null);assert.equal(result.rows[0].unreceived_quantity,null);
 assert.equal(result.rows[0].receipt_status,'UNKNOWN');assert(!('inbound_quantity' in result.rows[0]));
});
test('加工模式0仍标识组装，关联资料只补标签，不把计划数量重复计为出入库',async()=>{
 const f=fakePool();const client={listProductionOrders:async()=>Object.assign([{product_code:'JG1',product_mode:0,details:[{plan_nums:9999,actual_nums:9999}]}],{hasMore:false}),listStockReferences:async()=>[]} as unknown as WanliniuClient;
 await syncClientStockReferences(f.pool,'company_default',client);
 const insert=f.calls.find(c=>c.sql.startsWith('INSERT INTO data_wln_client_production_orders'));assert(insert);assert.equal(insert.args[2],0);
 assert(!f.calls.some(c=>c.sql.startsWith('INSERT INTO ods_wln_approved_stock_stream')));
 assert(!JSON.stringify(insert.args).includes('9999'));
});
