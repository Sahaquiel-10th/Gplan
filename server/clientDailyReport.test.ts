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
    [{storage_code:'CK001',product_code:'6901234567892',product_name:'产品',quantity:100,inventory_date:'2026-09-01',snapshot_time:'2026-09-01T03:00:00+08:00'}],
    [{inventory_date:'2026-10-15',inventory_as_of:'2026-10-15T03:00:00+08:00'}]
  ];
  const db={query:async()=>[sources.shift()]} as unknown as Connection;
  const result=await buildClientReport(db,'company_default','2026-10-14');
  const sale=result.rows.find(x=>x.record_type==='outbound')!;
  assert.equal(sale.outbound_quantity,5);
  assert.equal(sale.movement_times.length,2);
  assert.equal(sale.inventory_quantity,null);
  assert.equal(sale.inbound_type,null);
  const receipts=result.rows.filter(x=>x.record_type==='inbound');
  assert.equal(receipts.length,2);
  assert.equal(receipts.find(x=>x.inbound_type==='PURCHASE')!.inbound_quantity,8);
  assert.equal(receipts.find(x=>x.inbound_type==='SALES_RETURN')!.inbound_quantity,2);
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
