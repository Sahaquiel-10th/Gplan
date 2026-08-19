import assert from "node:assert/strict";
import test from "node:test";
import type { DataPlatformStore, DataResource, SyncCursor } from "../../dataPlatformDb.js";
import type { WanliniuClient } from "./client.js";
import { WanliniuSyncService } from "./sync.js";

test("首轮五类资源全部成功后分别保存游标和运行留痕", async () => {
  const cursors = new Map<DataResource, SyncCursor>();
  const completed: string[] = [];
  const started: string[] = [];
  const client = {
    listShops: async () => [{ shop_uid: "shop-1" }],
    listProducts: async () => [{ goods_code: "G-1", specs: [{ spec_code: "SKU-1" }] }],
    listInventory: async () => [{ storage_code: "WH-1", sku_code: "SKU-1", quantity: 2 }],
    listSaleOutbound: async () => [{ inv_uid: "OUT-1", details: [{ sku_no: "SKU-1", nums: 1 }] }],
    listPurchaseInbound: async () => [{ stock_code: "IN-1", details: [{ spec_code: "SKU-1", nums: 1 }] }]
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
    upsertInbound: async (_companyId, records) => records.length
  };

  const summary = await new WanliniuSyncService(client, store).syncAll("company-test");
  assert.deepEqual(started, ["shops", "products", "inventory", "sale_outbound", "purchase_inbound"]);
  assert.equal(completed.length, 5);
  assert.equal(cursors.size, 5);
  assert.equal(summary.recordsRead, 5);
  assert.equal(summary.recordsWritten, 5);
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
    upsertInbound: async () => 0
  } as DataPlatformStore;

  await assert.rejects(() => new WanliniuSyncService(client, store).syncAll("company-test"), /模拟网络故障/);
  assert.equal(cursors.has("shops"), false);
  assert.equal(failed.length, 1);
});
