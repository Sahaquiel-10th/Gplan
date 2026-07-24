import { dataPlatformStore } from "../../dataPlatformDb.js";
import { uid } from "../../security.js";
import { wanliniuClient } from "./client.js";
import type { WanliniuClient } from "./client.js";

export type WanliniuShopSyncSummary = {
  runId: string;
  pages: number;
  recordsRead: number;
  recordsWritten: number;
  totalStored: number;
};

export type WanliniuScheduledSyncEvent = {
  status: "success" | "failed";
  message: string;
  startedAt: string;
  finishedAt: string;
};

const configuredIntervalMinutes = Number(process.env.WANLINIU_SHOP_SYNC_INTERVAL_MINUTES ?? 360);

export const wanliniuShopSyncConfig = {
  enabled: process.env.WANLINIU_SHOP_SYNC_ENABLED?.trim().toLowerCase() === "true",
  intervalMinutes: Number.isFinite(configuredIntervalMinutes)
    ? Math.max(5, configuredIntervalMinutes)
    : 360
};

export class WanliniuSyncService {
  private running = false;

  constructor(private client: WanliniuClient) {}

  async syncShops(companyId = "company_default"): Promise<WanliniuShopSyncSummary> {
    if (this.running) throw new Error("万里牛店铺同步正在进行，请勿重复启动");
    const databaseStatus = dataPlatformStore.status();
    if (!databaseStatus.ready) throw new Error(databaseStatus.message);
    this.running = true;
    const runId = uid("dsr");
    const startedAt = new Date().toISOString();
    let recordsRead = 0;
    let recordsWritten = 0;
    let pages = 0;
    await dataPlatformStore.startSyncRun({
      id: runId,
      connectorId: "wanliniu",
      resource: "shops",
      mode: "full",
      startedAt
    });
    try {
      const pageSize = 50;
      for (let page = 1; page <= 1000; page += 1) {
        const shops = await this.client.listShops(page, pageSize);
        pages += 1;
        recordsRead += shops.length;
        recordsWritten += await dataPlatformStore.upsertWanliniuShops(companyId, shops, runId);
        if (shops.length < pageSize) break;
        if (page === 1000) throw new Error("万里牛店铺同步超过 1000 页安全上限，请检查分页返回");
      }
      const cursor = { completedAt: new Date().toISOString(), mode: "full" };
      await dataPlatformStore.saveCursor("wanliniu", "shops", cursor);
      await dataPlatformStore.completeSyncRun(runId, { recordsRead, recordsWritten, cursor });
      return {
        runId,
        pages,
        recordsRead,
        recordsWritten,
        totalStored: await dataPlatformStore.countWanliniuShops(companyId)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await dataPlatformStore.failSyncRun(runId, message).catch(() => undefined);
      throw error;
    } finally {
      this.running = false;
    }
  }
}

export const wanliniuSyncService = new WanliniuSyncService(wanliniuClient);

export class WanliniuSyncScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private service: WanliniuSyncService,
    private onEvent: (event: WanliniuScheduledSyncEvent) => Promise<void>
  ) {}

  start() {
    if (this.timer || !wanliniuShopSyncConfig.enabled) return;
    this.timer = setInterval(
      () => void this.scan(),
      wanliniuShopSyncConfig.intervalMinutes * 60_000
    );
  }

  async scan() {
    if (this.running) return;
    this.running = true;
    const startedAt = new Date().toISOString();
    let event: WanliniuScheduledSyncEvent;
    try {
      const summary = await this.service.syncShops("company_default");
      event = {
        status: "success",
        message: `定时同步完成：读取 ${summary.recordsRead} 条店铺，当前共 ${summary.totalStored} 个店铺。`,
        startedAt,
        finishedAt: new Date().toISOString()
      };
    } catch (error) {
      event = {
        status: "failed",
        message: error instanceof Error ? error.message : "万里牛店铺定时同步失败",
        startedAt,
        finishedAt: new Date().toISOString()
      };
    } finally {
      this.running = false;
    }
    await this.onEvent(event).catch((error) => {
      console.error(JSON.stringify({
        event: "wanliniu_scheduled_sync_log_failed",
        error: error instanceof Error ? error.message : String(error)
      }));
    });
  }
}
