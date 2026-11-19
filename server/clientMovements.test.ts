import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { ClientMovementSync, loadMovementCoverage, normalizeClientMovement, writeClientMovements } from './clientMovements.js';
import { WanliniuClient } from './data-connectors/wanliniu/client.js';
const transfer=(stock_code='DR001',nums=7)=>({stock_code,bill_uid:'same-transfer-uid',inventory_change_bill_code:'DB001',storage_code:'CK008',bill_date:'2026-11-18 12:00:00',details:[{spec_code:'sku',nums,detail_id:'1'}]});
test('调拨以实际过账单和方向区分；负数保留，缺少数量拒绝',()=>{
  const incoming=normalizeClientMovement('transfer_in',transfer());
  const outgoing=normalizeClientMovement('transfer_out',transfer('DC001',-7));
  assert.equal(incoming.outboundUid,outgoing.outboundUid);
  assert.notEqual(incoming.documentNo,outgoing.documentNo);
  assert.equal(incoming.relatedTransferNo,'DB001');
  assert.equal(outgoing.items[0].quantity,-7);
  assert.throws(()=>normalizeClientMovement('transfer_in',{...transfer(),details:[{spec_code:'sku'}]}),/数量/);
  assert.throws(()=>normalizeClientMovement('transfer_in',{...transfer(),stock_code:''}),/单号/);
});
test('整单替换保证重拉不累加；规格别名歧义不按条码猜测；失败回滚',async()=>{
  const calls:any[]=[];let commits=0,rollbacks=0,fail=false;
  const db={query:async(sql:string,args:any[])=>{calls.push([sql,args]);if(sql.includes('FROM ods_wln_products'))return[[{sku_code:'sku',source_spec_uid:'id-a'}]];if(sql.includes('FROM data_product_identity_aliases'))return[[{sku_code:'sku',source_spec_uid:'id-b'}]];if(fail&&sql.startsWith('INSERT'))throw Error('write failed');return[[]];},beginTransaction:async()=>{},commit:async()=>{commits++;},rollback:async()=>{rollbacks++;}} as unknown as PoolConnection;
  for(let i=0;i<2;i++)await writeClientMovements(db,'company_default','transfer_in',[transfer()],'run');
  assert.equal(commits,2);assert.equal(calls.filter(x=>x[0].startsWith('DELETE')).length,2);
  const values=calls.find(x=>x[0].startsWith('INSERT'))[1];assert.equal(values[10],null);assert.equal(values[13],7);
  fail=true;await assert.rejects(writeClientMovements(db,'company_default','transfer_in',[transfer()],'run'),/write failed/);assert.equal(rollbacks,1);
});
test('覆盖范围不将未回补日期和当天数据视为完整',async()=>{
  const db={query:async()=>[['transfer_in','transfer_out','sales_return'].map(resource_name=>({resource_name,cursor_json:{initialFrom:'2026-08-21T16:00:00Z',modifiedThrough:'2026-11-19T03:00:00Z'}}))]} as unknown as Pool;
  assert.equal((await loadMovementCoverage(db,'company_default','2026-08-21')).status,'unavailable');
  assert.equal((await loadMovementCoverage(db,'company_default','2026-11-18')).status,'complete');
  assert.equal((await loadMovementCoverage(db,'company_default','2026-11-19')).status,'partial');
  assert.equal((await loadMovementCoverage(db,'other-company','2026-11-18')).status,'unavailable');
});
test('分页未完成时不推进游标，失败释放租约',async()=>{
  let checkpoint=0,released=false;
  const connection={query:async(sql:string)=>[sql.includes('GET_LOCK')?[{acquired:1}]:[]],execute:async(sql:string)=>{if(sql.startsWith('INSERT INTO data_sync_cursors'))checkpoint++;return[[]];},beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{released=true;}};
  const pool={query:async()=>[[]],getConnection:async()=>connection} as unknown as Pool;
  const client={listTransferInbound:async(page:number)=>{if(page===2)throw Error('page two failed');return Array.from({length:200},(_,i)=>({...transfer('DR'+i),details:[]}));}} as unknown as WanliniuClient;
  await assert.rejects(new ClientMovementSync(pool,client,()=>new Date('2026-11-19T03:00:00Z')).sync('company_default','2026-11-18'),/page two/);
  assert.equal(checkpoint,0);assert.equal(released,true);
});
test('三种接口使用各自的修改时间字段，退货保留拆分明细',async()=>{
  const requests:any[]=[];const client=new WanliniuClient();client.call=async(path,params)=>{requests.push({path,params});return[];};
  await client.listTransferInbound(1,200,'start','end');await client.listTransferOutbound(2,200,'start','end');await client.listSalesReturn(3,200,'start','end');
  assert.equal(requests[0].params.modify_end,'end');assert.equal(requests[1].params.modify_end,'end');
  assert.equal(requests[2].params.modify_end_time,'end');assert.equal(requests[2].params.is_split,true);
});
