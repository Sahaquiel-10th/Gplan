import assert from "node:assert/strict";
import test from "node:test";
import type { DataPlatformStore, DataResource, SyncCursor } from "../../dataPlatformDb.js";
import type { WanliniuClient } from "./client.js";
import { millisecondsUntilNextShanghaiTime, WanliniuSyncService } from "./sync.js";
import {MissingInventoryIdentityError} from '../../inventoryIdentity.js';

test('库存按规格全量核验通过后才保存采样与游标，并释放跨进程租约',async()=>{
 const events:string[]=[];
 const client={listShops:async()=>[],listProducts:async()=>[],listInventory:async()=>[],listSaleOutbound:async()=>[],listPurchaseInbound:async()=>[],listInventoryForSkus:async()=>[{sku_code:'new',storage_code:'CK001',quantity:9}],findProductBySku:async()=>[{goods_code:'g',specs:[{spec_code:'new',sys_spec_uid:'uid'}]}]} as unknown as WanliniuClient;
 let writes=0;
 const store={status:()=>({ready:true}),acquireSyncLease:async()=>{events.push('lease');return async()=>{events.push('release');};},startSyncRun:async()=>{},completeSyncRun:async()=>{},failSyncRun:async()=>assert.fail(),getCursor:async()=>undefined,saveCursor:async(r:string)=>events.push('cursor:'+r),upsertProducts:async()=>{events.push('resolve');return 1;},upsertInventory:async(_c:string,_r:unknown,run:string)=>{if(writes++===0)throw new MissingInventoryIdentityError(['new']);assert(run.endsWith(':full'));events.push('write');return 1;},inventoryReconciliationSkus:async()=>['new'],assertInventoryReconciled:async()=>events.push('verify'),captureInventorySnapshot:async()=>events.push('snapshot'),upsertShops:async()=>0,upsertOutbound:async()=>0,upsertInbound:async()=>0} as unknown as DataPlatformStore;
 // Empty incremental pages are valid and should not call the mocked writer.
 const original=(store as any).upsertInventory;(store as any).upsertInventory=async(c:string,r:unknown[],run:string)=>r.length?original(c,r,run):0;
 await new WanliniuSyncService(client,store).syncAll('c');
 assert(events.indexOf('resolve')<events.indexOf('write'));assert(events.indexOf('verify')<events.indexOf('snapshot'));assert(events.indexOf('snapshot')<events.indexOf('cursor:inventory'));assert.equal(events.at(-1),'release');
});

test('未返回的非零库存不能补零、发布采样或推进库存游标',async()=>{
 const events:string[]=[];
 const client={listShops:async()=>[],listProducts:async()=>[],listInventory:async()=>[],listSaleOutbound:async()=>[],listPurchaseInbound:async()=>[],listInventoryForSkus:async()=>[]} as unknown as WanliniuClient;
 const store={status:()=>({ready:true}),startSyncRun:async()=>{},completeSyncRun:async()=>{},failSyncRun:async()=>{},getCursor:async()=>undefined,saveCursor:async(r:string)=>events.push(r),upsertProducts:async()=>0,upsertInventory:async()=>0,inventoryReconciliationSkus:async()=>['missing'],assertInventoryReconciled:async()=>{throw new Error('missing positive inventory');},captureInventorySnapshot:async()=>events.push('snapshot'),upsertShops:async()=>0,upsertOutbound:async()=>0,upsertInbound:async()=>0} as unknown as DataPlatformStore;
 await assert.rejects(new WanliniuSyncService(client,store).syncAll('c'),/missing positive inventory/);assert(!events.includes('inventory'));assert(!events.includes('snapshot'));
});

test("首轮五类资源全部成功后分别保存游标和运行留痕", async () => {
  const cursors = new Map<DataResource, SyncCursor>();
  const completed: string[] = [];
  const started: string[] = [];
  const requests: Record<string, unknown[]> = {};
  const client = {
    listShops: async () => [{ shop_uid: "shop-1" }],
    listProducts: async (...args: unknown[]) => {
      requests.products = args;
      return [{ goods_code: "G-1", specs: [{ spec_code: "SKU-1" }] }];
    },
    listInventory: async (...args: unknown[]) => {
      requests.inventory = args;
      return [{ storage_code: "WH-1", sku_code: "SKU-1", quantity: 2 }];
    },
    listSaleOutbound: async (...args: unknown[]) => {
      requests.sale = args;
      return [{ inv_uid: "OUT-1", details: [{ sku_no: "SKU-1", nums: 1 }] }];
    },
    listPurchaseInbound: async (...args: unknown[]) => {
      requests.inbound = args;
      return [{ stock_code: "IN-1", details: [{ spec_code: "SKU-1", nums: 1 }] }];
    }
  } as unknown as WanliniuClient;
  const store: DataPlatformStore = {
    status: () => ({ configured: true, ready: true, provider: "mysql", database: "test", message: "ok" }),
    startSyncRun: async (run) => { started.push(run.resource); },
    completeSyncRun: async (id) => { completed.push(id); },
    failSyncRun: async () => { assert.fail("不应失败"); },
    getCursor: async (resource) => cursors.get(resource),
    saveCursor: async (resource, cursor) => { cursors.set(resource, cursor); },
    upsertShops: async (_companyId, records) => records.length,
    upsertProducts: async (_companyId, records) => records.length,
    upsertInventory: async (_companyId, records) => records.length,
    upsertOutbound: async (_companyId, records) => records.length,
    upsertInbound: async (_companyId, records) => records.length,
    getManagementDashboardFacts: async () => { throw new Error("unused"); }
  };

  const summary = await new WanliniuSyncService(client, store).syncAll("company-test");
  assert.deepEqual(started, ["shops", "products", "inventory", "sale_outbound", "purchase_inbound"]);
  assert.equal(completed.length, 5);
  assert.equal(cursors.size, 5);
  assert.equal(summary.recordsRead, 5);
  assert.equal(summary.recordsWritten, 5);
  assert.equal(requests.products[1], 20);
  assert.match(String(requests.products[2]), /^2000-01-01 /);
  assert.equal(requests.inventory[1], 200);
  assert.ok(requests.inventory[2]);
  assert.ok(requests.inventory[3]);
  assert.equal(requests.sale[1], 20);
  assert.equal(requests.inbound[1], 20);
});

test("某资源失败时不推进该资源游标", async () => {
  const cursors = new Map<DataResource, SyncCursor>();
  const failed: string[] = [];
  const client = {
    listShops: async () => { throw new Error("模拟网络故障"); },
    listProducts: async () => [],
    listInventory: async () => [],
    listSaleOutbound: async () => [],
    listPurchaseInbound: async () => []
  } as unknown as WanliniuClient;
  const store = {
    status: () => ({ configured: true, ready: true, provider: "mysql", database: "test", message: "ok" }),
    startSyncRun: async () => undefined,
    completeSyncRun: async () => undefined,
    failSyncRun: async (_id: string, message: string) => { failed.push(message); },
    getCursor: async (resource: DataResource) => cursors.get(resource),
    saveCursor: async (resource: DataResource, cursor: SyncCursor) => { cursors.set(resource, cursor); },
    upsertShops: async () => 0,
    upsertProducts: async () => 0,
    upsertInventory: async () => 0,
    upsertOutbound: async () => 0,
    upsertInbound: async () => 0,
    getManagementDashboardFacts: async () => { throw new Error("unused"); }
  } as DataPlatformStore;

  await assert.rejects(() => new WanliniuSyncService(client, store).syncAll("company-test"), /模拟网络故障/);
  assert.equal(cursors.has("shops"), false);
  assert.equal(failed.length, 1);
});

test("销售出库跨多天时按24小时分片并逐段保存游标", async () => {
  const cursors = new Map<DataResource, SyncCursor>([["sale_outbound", {
    modifiedThrough: "2026-08-20T08:00:00.000Z",
    completedAt: "2026-08-20T08:00:00.000Z",
    mode: "incremental"
  }]]);
  const saleWindows: Array<[string, string]> = [];
  const savedSaleCursors: string[] = [];
  const client = {
    listShops: async () => [],
    listProducts: async () => [],
    listInventory: async () => [],
    listSaleOutbound: async (_page: number, _limit: number, start: string, end: string) => {
      saleWindows.push([start, end]);
      return [];
    },
    listPurchaseInbound: async () => []
  } as unknown as WanliniuClient;
  const store = {
    status: () => ({ configured: true, ready: true, provider: "mysql", database: "test", message: "ok" }),
    startSyncRun: async () => undefined,
    completeSyncRun: async () => undefined,
    failSyncRun: async () => assert.fail("不应失败"),
    getCursor: async (resource: DataResource) => cursors.get(resource),
    saveCursor: async (resource: DataResource, cursor: SyncCursor) => {
      cursors.set(resource, cursor);
      if (resource === "sale_outbound") savedSaleCursors.push(cursor.modifiedThrough);
    },
    upsertShops: async () => 0,
    upsertProducts: async () => 0,
    upsertInventory: async () => 0,
    upsertOutbound: async () => 0,
    upsertInbound: async () => 0,
    getManagementDashboardFacts: async () => { throw new Error("unused"); }
  } as DataPlatformStore;

  await new WanliniuSyncService(client, store, () => new Date("2026-08-23T08:00:00.000Z")).syncAll("company-test");
  assert.equal(saleWindows.length, 4);
  assert.deepEqual(saleWindows[0], ["2026-08-20 15:50:00", "2026-08-21 15:50:00"]);
  assert.deepEqual(saleWindows.at(-1), ["2026-08-23 15:50:00", "2026-08-23 16:00:00"]);
  assert.equal(savedSaleCursors.length, 4);
  assert.equal(savedSaleCursors.at(-1), "2026-08-23T08:00:00.000Z");
});

test("固定调度始终对准下一个北京时间03:00", () => {
  assert.equal(
    millisecondsUntilNextShanghaiTime(new Date("2026-09-02T01:00:00.000Z"), "03:00"),
    18 * 3_600_000
  );
  assert.equal(
    millisecondsUntilNextShanghaiTime(new Date("2026-09-02T18:59:00.000Z"), "03:00"),
    60_000
  );
});
