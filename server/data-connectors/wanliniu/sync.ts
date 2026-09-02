import { dataPlatformStore, type DataPlatformStore, type DataResource, type SyncCursor, type SyncMode } from "../../dataPlatformDb.js";
import { uid } from "../../security.js";
import { wanliniuClient, type WanliniuClient, type WanliniuRecord } from "./client.js";
import {
  mysqlDateInShanghai,
  normalizeInbound,
  normalizeInventory,
  normalizeOutbound,
  normalizeProducts,
  normalizeShop
} from "./mappers.js";

const resources: DataResource[] = [
  "shops",
  "products",
  "inventory",
  "sale_outbound",
  "purchase_inbound"
];

export type WanliniuResourceSummary = {
  resource: DataResource;
  mode: SyncMode;
  recordsRead: number;
  recordsWritten: number;
  pages: number;
  startedAt: string;
  finishedAt: string;
};

export type WanliniuSyncSummary = {
  resources: WanliniuResourceSummary[];
  recordsRead: number;
  recordsWritten: number;
  startedAt: string;
  finishedAt: string;
};

type SyncWindow = {
  mode: SyncMode;
  startedAt: string;
  modifiedAfter?: string;
  modifiedBefore: string;
  cursor: SyncCursor;
};

export class WanliniuSyncService {
  private running = false;

  constructor(
    private client: WanliniuClient = wanliniuClient,
    private dataStore: DataPlatformStore = dataPlatformStore,
    private now: () => Date = () => new Date()
  ) {}

  isRunning() {
    return this.running;
  }

  async syncAll(companyId: string): Promise<WanliniuSyncSummary> {
    if (this.running) throw new Error("万里牛同步任务正在运行，请勿重复提交");
    if (!this.dataStore.status().ready) throw new Error(this.dataStore.status().message);
    this.running = true;
    const startedAt = new Date().toISOString();
    try {
      const summaries: WanliniuResourceSummary[] = [];
      const failures: string[] = [];
      for (const resource of resources) {
        try {
          summaries.push(await this.syncResource(resource, companyId));
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (failures.length) {
        throw new Error(`万里牛同步有 ${failures.length} 类资源失败：${failures.join("；")}`);
      }
      return {
        resources: summaries,
        recordsRead: summaries.reduce((sum, item) => sum + item.recordsRead, 0),
        recordsWritten: summaries.reduce((sum, item) => sum + item.recordsWritten, 0),
        startedAt,
        finishedAt: new Date().toISOString()
      };
    } finally {
      this.running = false;
    }
  }

  private async syncResource(resource: DataResource, companyId: string): Promise<WanliniuResourceSummary> {
    const window = await this.syncWindow(resource);
    const windows = splitSyncWindows(resource, window);
    const runId = uid("dsr");
    let recordsRead = 0;
    let recordsWritten = 0;
    let pages = 0;
    await this.dataStore.startSyncRun({
      id: runId,
      resource,
      mode: window.mode,
      startedAt: window.startedAt
    });

    try {
      const maxPages = positiveInteger("WANLINIU_SYNC_MAX_PAGES", 5000);
      let completedCursor = window.cursor;
      for (const currentWindow of windows) {
        for (let page = 1; page <= maxPages; page += 1) {
          const { sourceRecords, written, hasMore } = await this.syncPage({
            resource,
            companyId,
            runId,
            page,
            window: currentWindow
          });
          pages += 1;
          recordsRead += sourceRecords;
          recordsWritten += written;
          if (!hasMore) break;
          if (page === maxPages) throw new Error(`${resource} 单个时间分片已达到最大分页数 ${maxPages}，本次任务停在 ${currentWindow.modifiedAfter || "起点"}`);
        }
        completedCursor = currentWindow.cursor;
        // 大数据量资源每完成一个时间分片就保存断点；中途失败时无需从头重扫。
        await this.dataStore.saveCursor(resource, completedCursor);
      }
      await this.dataStore.completeSyncRun(runId, {
        recordsRead,
        recordsWritten,
        cursor: completedCursor
      });
      return {
        resource,
        mode: window.mode,
        recordsRead,
        recordsWritten,
        pages,
        startedAt: window.startedAt,
        finishedAt: new Date().toISOString()
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.dataStore.failSyncRun(runId, message).catch(() => undefined);
      throw new Error(`${resource} 同步失败：${message}`);
    }
  }

  private async syncPage(input: {
    resource: DataResource;
    companyId: string;
    runId: string;
    page: number;
    window: SyncWindow;
  }) {
    const { resource, companyId, runId, page, window } = input;
    if (resource === "shops") {
      const pageSize = 50;
      const records = await this.client.listShops(page, pageSize, window.modifiedAfter);
      const normalized = records.map(normalizeShop);
      return pageResult(records, await this.dataStore.upsertShops(companyId, normalized, runId), pageSize);
    }
    if (resource === "products") {
      const pageSize = 20;
      const records = await this.client.listProducts(page, pageSize, window.modifiedAfter, window.modifiedBefore);
      const normalized = records.flatMap(normalizeProducts);
      return pageResult(records, await this.dataStore.upsertProducts(companyId, normalized, runId), pageSize);
    }
    if (resource === "inventory") {
      const pageSize = 200;
      const records = await this.client.listInventory(page, pageSize, window.modifiedAfter, window.modifiedAfter ? window.modifiedBefore : undefined);
      const snapshotAt = mysqlDateInShanghai(window.startedAt);
      const normalized = records.map((record) => normalizeInventory(record, snapshotAt));
      return pageResult(records, await this.dataStore.upsertInventory(companyId, normalized, runId), pageSize);
    }
    if (resource === "sale_outbound") {
      const pageSize = 20;
      const records = await this.client.listSaleOutbound(page, pageSize, requiredWindowStart(window), window.modifiedBefore);
      const normalized = records.map(normalizeOutbound);
      return pageResult(records, await this.dataStore.upsertOutbound(companyId, normalized, runId), pageSize);
    }
    const pageSize = 20;
    const records = await this.client.listPurchaseInbound(page, pageSize, requiredWindowStart(window), window.modifiedBefore);
    const normalized = records.map(normalizeInbound);
    return pageResult(records, await this.dataStore.upsertInbound(companyId, normalized, runId), pageSize);
  }

  private async syncWindow(resource: DataResource): Promise<SyncWindow> {
    const started = this.now();
    const startedAt = started.toISOString();
    const cursor = await this.dataStore.getCursor(resource);
    const overlapMs = positiveNumber("WANLINIU_SYNC_OVERLAP_MINUTES", 10) * 60_000;
    // 首次在线同步只建立最近 1 天的游标；历史数据使用独立的按日分片回补任务，
    // 避免高订单量客户在单次任务中触发最大分页数或长时间占用连接器。
    const lookbackMs = positiveNumber("WANLINIU_INITIAL_LOOKBACK_DAYS", 1) * 86_400_000;
    let modifiedAfter: Date | undefined;
    let mode: SyncMode = "full";

    if (cursor?.modifiedThrough) {
      const cursorDate = new Date(cursor.modifiedThrough);
      if (Number.isNaN(cursorDate.getTime())) throw new Error(`${resource} 的同步游标时间无效`);
      modifiedAfter = new Date(cursorDate.getTime() - overlapMs);
      mode = "incremental";
    } else if (resource === "products") {
      modifiedAfter = new Date(process.env.WANLINIU_PRODUCT_INITIAL_START?.trim() || "2000-01-01T00:00:00+08:00");
    } else if (resource === "inventory") {
      modifiedAfter = new Date(started.getTime() - 7 * 86_400_000 + 60_000);
    } else if (resource === "sale_outbound" || resource === "purchase_inbound") {
      modifiedAfter = new Date(started.getTime() - lookbackMs);
    }

    // 万里牛库存修改时间接口单次查询跨度最多 7 天；增量中断过久时从最近 7 天恢复。
    if (resource === "inventory" && modifiedAfter) {
      const oldestAllowed = new Date(started.getTime() - 7 * 86_400_000);
      if (modifiedAfter < oldestAllowed) modifiedAfter = oldestAllowed;
    }

    const completedAt = started.toISOString();
    return {
      mode,
      startedAt,
      modifiedAfter: modifiedAfter ? apiDate(modifiedAfter) : undefined,
      modifiedBefore: apiDate(started),
      cursor: { modifiedThrough: completedAt, completedAt, mode }
    };
  }
}

export class WanliniuSyncScheduler {
  private timer?: NodeJS.Timeout;

  constructor(
    private service: WanliniuSyncService,
    private companyId: () => Promise<string | undefined>,
    private onComplete: (result: { ok: boolean; summary?: WanliniuSyncSummary; error?: string }) => Promise<void>
  ) {}

  start() {
    if (!envBoolean("WANLINIU_SYNC_ENABLED", false) || this.timer) return;
    this.scheduleNext();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleNext() {
    const dailyTime = process.env.WANLINIU_SYNC_DAILY_TIME?.trim() || "03:00";
    const delayMs = millisecondsUntilNextShanghaiTime(new Date(), dailyTime);
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      try {
        await this.tick();
      } finally {
        if (envBoolean("WANLINIU_SYNC_ENABLED", false)) this.scheduleNext();
      }
    }, delayMs);
    this.timer.unref();
  }

  private async tick() {
    if (this.service.isRunning()) return;
    const companyId = await this.companyId();
    if (!companyId) return;
    try {
      const summary = await this.service.syncAll(companyId);
      await this.onComplete({ ok: true, summary });
    } catch (error) {
      await this.onComplete({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function pageResult(records: WanliniuRecord[], written: number, pageSize: number) {
  return { sourceRecords: records.length, written, hasMore: records.length === pageSize };
}

function requiredWindowStart(window: SyncWindow) {
  if (!window.modifiedAfter) throw new Error("该接口必须提供同步起始时间");
  return window.modifiedAfter;
}

function splitSyncWindows(resource: DataResource, window: SyncWindow) {
  if (!window.modifiedAfter || (resource !== "sale_outbound" && resource !== "purchase_inbound")) {
    return [window];
  }
  const start = parseApiDateInShanghai(window.modifiedAfter);
  const end = parseApiDateInShanghai(window.modifiedBefore);
  const sliceMs = Math.max(1, positiveNumber("WANLINIU_SYNC_SLICE_HOURS", 24)) * 3_600_000;
  const result: SyncWindow[] = [];
  let cursor = start;
  while (cursor < end) {
    const sliceEnd = new Date(Math.min(cursor.getTime() + sliceMs, end.getTime()));
    const completedAt = sliceEnd.toISOString();
    result.push({
      ...window,
      modifiedAfter: apiDate(cursor),
      modifiedBefore: apiDate(sliceEnd),
      cursor: { modifiedThrough: completedAt, completedAt, mode: window.mode }
    });
    cursor = sliceEnd;
  }
  return result.length ? result : [window];
}

function parseApiDateInShanghai(value: string) {
  const parsed = new Date(`${value.replace(" ", "T")}+08:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`万里牛同步时间无效：${value}`);
  return parsed;
}

export function millisecondsUntilNextShanghaiTime(now: Date, dailyTime: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(dailyTime);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) throw new Error(`WANLINIU_SYNC_DAILY_TIME 格式无效：${dailyTime}`);
  const shanghaiOffsetMs = 8 * 3_600_000;
  const local = new Date(now.getTime() + shanghaiOffsetMs);
  let target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - shanghaiOffsetMs;
  if (target <= now.getTime()) target += 86_400_000;
  return target - now.getTime();
}

function apiDate(value: Date) {
  return mysqlDateInShanghai(value).slice(0, 19);
}

function positiveNumber(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(name: string, fallback: number) {
  return Math.max(1, Math.trunc(positiveNumber(name, fallback)));
}

function envBoolean(name: string, fallback: boolean) {
  const value = process.env[name];
  return value === undefined ? fallback : value.toLowerCase() === "true";
}

export const wanliniuSyncService = new WanliniuSyncService();
export { resources as wanliniuSyncResources };
