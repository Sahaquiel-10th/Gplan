import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClientReport,reportDate,reportShops } from './clientDailyReport.js';
import type { Connection } from 'mysql2/promise';
test('拒绝无效自然日，避免跨日数据错位',()=>{
  assert.equal(reportDate('2026-10-14'),'2026-10-14');
  for(const value of ['2026-02-30','2026-13-01','2026-1-1','',undefined])assert.throws(()=>reportDate(value));
});
test('合并指定来源的出库并保留仓库库存与独立业务日期',async()=>{
  const sources=[
    [{shop_id:'3B9FA6FA29993AA2A18DDCA355FD787A',storage_code:'CK001',product_code:'6901234567892',product_name:'产品',quantity:2,movement_time:'2026-10-14T12:00:00+08:00'},
     {shop_id:'1D0EB38BF5003BE59100A3D6F069190A',storage_code:'CK001',product_code:'6901234567892',product_name:'产品',quantity:3,movement_time:'2026-10-14T13:00:00+08:00'}],
    [{storage_code:'CK001',inbound_type:'PURCHASE',product_code:null,product_name:'未提供条码商品',quantity:8,movement_time:'2026-10-14T00:00:00+08:00'},
    {storage_code:'CK001',inbound_type:'SALES_RETURN',product_code:null,product_name:'未提供条码商品',quantity:2,movement_time:'2026-10-14T12:00:00+08:00'}],
    [{resource:'transfer_out',storage_code:'CK001',product_code:'6901234567892',product_name:'产品',quantity:7,movement_time:'2026-10-14T14:00:00+08:00'},
     {resource:'transfer_in',storage_code:'CK008',product_code:'6901234567892',product_name:'产品',quantity:7,movement_time:'2026-10-14T14:00:00+08:00'},
     {resource:'sales_return',storage_code:'CK008',product_code:'6901234567892',product_name:'产品',quantity:1,movement_time:'2026-10-14T15:00:00+08:00'}],
    [{rows_json:[{storage_code:'CK001',source_spec_uid:'uid',product_code:'6901234567892',product_name:'产品',quantity:100,inventory_date:'2026-10-15',snapshot_time:'2026-10-15T03:00:00+08:00'}],quality_json:{status:'complete'},revision:'test'}],
    ['transfer_in','transfer_out','sales_return'].map(resource_name=>({resource_name,cursor_json:{initialFrom:'2026-08-22T16:00:00.000Z',modifiedThrough:'2026-11-19T03:00:00.000Z'}})),
    [{unresolved_rows:0}]
  ];
  const db={query:async()=>[sources.shift()],execute:async()=>[sources.shift()]} as unknown as Connection;
  const result=await buildClientReport(db,'company_default','2026-10-14');
  const sale=result.rows.find(x=>x.record_type==='outbound'&&x.outbound_type==='SALES')!;
  assert.equal(sale.outbound_quantity,5);
  assert.equal(sale.movement_times.length,2);
  assert.equal(sale.inventory_quantity,null);
  assert.equal(sale.inbound_type,null);
  const receipts=result.rows.filter(x=>x.record_type==='inbound');
  assert.equal(receipts.length,4);
  const transfer=result.rows.find(x=>x.outbound_type==='TRANSFER')!;
  assert.equal(transfer.outbound_quantity,7);
  assert.equal(transfer.shop_name,null);
  assert.equal(receipts.find(x=>x.inbound_type==='TRANSFER')!.inbound_quantity,7);
  assert.equal(result.movementStatus.status,'complete');
  assert.equal(receipts.find(x=>x.inbound_type==='PURCHASE')!.inbound_quantity,8);
  assert.equal(receipts.filter(x=>x.inbound_type==='SALES_RETURN').reduce((sum,x)=>sum+x.inbound_quantity!,0),3);
  const inventory=result.rows.find(x=>x.record_type==='inventory')!;
  assert.equal(inventory.shop_name,null);
  assert.equal(inventory.inventory_date,'2026-10-15');
  assert.equal(inventory.business_date,'2026-10-14');
  assert.equal(result.missingBarcodes,2);
});
test('只归并指定三个来源，不纳入其他抖店',()=>{
  assert.equal(reportShops['3B9FA6FA29993AA2A18DDCA355FD787A'],'[微信视频号]小象优选家');
  assert.equal(reportShops['1D0EB38BF5003BE59100A3D6F069190A'],reportShops['9CE3621FFA5F355CB3CDEB82D0C98CDF']);
  assert.equal(reportShops['54B539EC22913949BB548C8A34A78D67'],undefined);
  assert.equal(Object.keys(reportShops).length,13);
});
test('未能确认商品身份的仓库记录不外泄，并明确标注数据缺口',async()=>{
 const sources=[[],[],[],[],['transfer_in','transfer_out','sales_return'].map(resource_name=>({resource_name,cursor_json:{initialFrom:'2026-08-22T16:00:00Z',modifiedThrough:'2026-11-19T03:00:00Z'}})),[{unresolved_rows:2}]];
 const db={query:async()=>[sources.shift()],execute:async()=>[sources.shift()]} as unknown as Connection;
 const result=await buildClientReport(db,'company_default','2026-11-18');
 assert.equal(result.rows.length,0);assert.equal(result.movementStatus.status,'partial');assert.equal(result.movementStatus.unresolved_rows,2);assert.match(result.movementStatus.message!,/无法确认品牌/);
});
