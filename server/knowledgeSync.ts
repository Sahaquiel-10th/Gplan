import crypto from "node:crypto";
import { BailianCompanyKnowledgeService } from "./bailian.js";
import {
  DingTalkKnowledgeDocument,
  DingTalkKnowledgeFile,
  DingTalkKnowledgeNode,
  DingTalkKnowledgeService,
  isDingTalkQuotaExceededMessage,
  isDingTalkDownloadableFile,
  isDingTalkTextDocument
} from "./dingtalk.js";
import { Store } from "./db.js";
import { KnowledgeSyncDocument } from "./types.js";
import { uid } from "./security.js";

export type KnowledgeSyncSummary = {
  scanned: number;
  attempted: number;
  synced: number;
  skipped: number;
  failed: number;
  errors: string[];
};

export const knowledgeSyncConfig = {
  enabled: envBoolean("KNOWLEDGE_SYNC_ENABLED", true),
  intervalMinutes: envNumber("KNOWLEDGE_SYNC_INTERVAL_MINUTES", 30),
  activeStartHour: envNumber("KNOWLEDGE_SYNC_ACTIVE_START_HOUR", 8),
  activeEndHour: envNumber("KNOWLEDGE_SYNC_ACTIVE_END_HOUR", 20),
  timezone: process.env.KNOWLEDGE_SYNC_TIMEZONE?.trim() || "Asia/Shanghai",
  scanMaxNodes: envNumber("KNOWLEDGE_SYNC_SCAN_MAX_NODES", 5000),
  progressLogEvery: envNumber("KNOWLEDGE_SYNC_PROGRESS_LOG_EVERY", 100),
  maxLoggedErrors: envNumber("KNOWLEDGE_SYNC_MAX_LOGGED_ERRORS", 20),
  failedRetryCooldownHours: envNumber("KNOWLEDGE_SYNC_FAILED_RETRY_COOLDOWN_HOURS", 24)
};

function now() {
  return new Date().toISOString();
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envBoolean(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Buffer(value: Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableNodeHash(node: DingTalkKnowledgeNode) {
  return sha256([node.nodeId, node.title, node.updatedAt ?? "", node.size ?? ""].join(":"));
}

function isAlreadySynced(existing: KnowledgeSyncDocument | undefined, contentHash: string) {
  return Boolean(existing?.contentHash === contentHash && existing.bailianDocumentId);
}

function unchangedByModifiedTime(existing: KnowledgeSyncDocument | undefined, node: DingTalkKnowledgeNode) {
  return Boolean(
    existing?.bailianDocumentId &&
    existing.contentHash &&
    existing.sourceUpdatedAt &&
    node.updatedAt &&
    existing.sourceUpdatedAt === node.updatedAt
  );
}

function knownFailureStillApplies(existing: KnowledgeSyncDocument | undefined, node: DingTalkKnowledgeNode) {
  if (!existing) return false;
  if (existing.sourceUpdatedAt && node.updatedAt && existing.sourceUpdatedAt !== node.updatedAt) return false;
  if (existing.status === "unsupported") return true;
  if (existing.retryAfter && new Date(existing.retryAfter).getTime() > Date.now()) return true;
  return false;
}

function isUnsupportedError(message: string) {
  return /暂不支持该钉钉文件类型|file size is too large|max size|SizeInBytes content cant be empty|钉钉文件超过下载上限/i.test(message);
}

function retryAfterIso() {
  return new Date(Date.now() + Math.max(1, knowledgeSyncConfig.failedRetryCooldownHours) * 60 * 60 * 1000).toISOString();
}

function addSyncError(summary: KnowledgeSyncSummary, message: string) {
  if (summary.errors.length < Math.max(0, knowledgeSyncConfig.maxLoggedErrors)) {
    summary.errors.push(message);
  }
}

function summaryForLog(summary: KnowledgeSyncSummary, includeErrors = false) {
  return {
    scanned: summary.scanned,
    attempted: summary.attempted,
    synced: summary.synced,
    skipped: summary.skipped,
    failed: summary.failed,
    errors: includeErrors ? summary.errors : summary.errors.length
  };
}

export class KnowledgeSyncService {
  constructor(
    private store: Store,
    private dingtalk: DingTalkKnowledgeService,
    private bailian: BailianCompanyKnowledgeService
  ) {}

  async runManualSync(limit = Number(process.env.KNOWLEDGE_SYNC_MAX_DOCUMENTS ?? 200)): Promise<KnowledgeSyncSummary> {
    const workspaceId = process.env.DINGTALK_WORKSPACE_ID?.trim() || "";
    const maxUploads = Math.max(1, limit);
    const startedAt = now();
    const nodes = await this.dingtalk.listDocumentNodes(knowledgeSyncConfig.scanMaxNodes);
    const summary: KnowledgeSyncSummary = {
      scanned: nodes.length,
      attempted: 0,
      synced: 0,
      skipped: 0,
      failed: 0,
      errors: []
    };
    console.log(JSON.stringify({
      event: "knowledge_sync_run_started",
      startedAt,
      scanned: nodes.length,
      maxUploads,
      scanMaxNodes: knowledgeSyncConfig.scanMaxNodes
    }));

    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const existing = (await this.store.read()).knowledgeSyncDocuments.find(
        (item) => item.source === "dingtalk" && item.sourceWorkspaceId === workspaceId && item.sourceNodeId === node.nodeId
      );
      if (knownFailureStillApplies(existing, node)) {
        summary.skipped += 1;
        this.logProgress(index + 1, nodes.length, summary);
        continue;
      }
      if (unchangedByModifiedTime(existing, node)) {
        summary.skipped += 1;
        this.logProgress(index + 1, nodes.length, summary);
        continue;
      }

      if (summary.attempted >= maxUploads) {
        console.log(JSON.stringify({
          event: "knowledge_sync_attempt_limit_reached",
          processed: index,
          total: nodes.length,
          summary: summaryForLog(summary)
        }));
        break;
      }
      summary.attempted += 1;

      let document: DingTalkKnowledgeDocument | DingTalkKnowledgeFile;
      let contentHash = "";
      try {
        document = await this.getSyncContent(node);
        contentHash = "markdown" in document ? sha256(document.markdown) : sha256Buffer(document.content);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.upsertNodeFailure(node, {
          contentHash: existing?.contentHash || stableNodeHash(node),
          status: isUnsupportedError(message) ? "unsupported" : "failed",
          lastError: message,
          retryAfter: isUnsupportedError(message) ? undefined : retryAfterIso()
        });
        summary.failed += 1;
        addSyncError(summary, `${node.title}: ${message}`);
        this.logProgress(index + 1, nodes.length, summary);
        continue;
      }

      if (isAlreadySynced(existing, contentHash)) {
        summary.skipped += 1;
        await this.markUnchanged(existing!.id, node);
        this.logProgress(index + 1, nodes.length, summary);
        continue;
      }

      try {
        const uniqueId = `dingtalk:${workspaceId}:${document.nodeId}`;
        const result = "markdown" in document
          ? await this.bailian.addMarkdownDocument({
            title: document.title,
            markdown: document.markdown,
            uniqueId,
            tags: ["dingtalk", "knowledge", "text"]
          })
          : await this.bailian.addFileDocument({
            filename: document.filename,
            content: document.content,
            uniqueId,
            tags: ["dingtalk", "knowledge", "file"]
          });
        await this.upsertDocument(document, {
          contentHash,
          bailianDocumentId: result.documentId,
          bailianJobId: result.jobId,
          status: "synced"
        });
        if (existing?.bailianDocumentId && existing.bailianDocumentId !== result.documentId) {
          await this.deleteOldBailianDocument(document, existing.bailianDocumentId, summary);
        }
        summary.synced += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.upsertDocument(document, {
          contentHash,
          status: isUnsupportedError(message) ? "unsupported" : "failed",
          lastError: message,
          retryAfter: isUnsupportedError(message) ? undefined : retryAfterIso()
        });
        summary.failed += 1;
        addSyncError(summary, `${document.title}: ${message}`);
      }
      this.logProgress(index + 1, nodes.length, summary);
    }

    console.log(JSON.stringify({
      event: "knowledge_sync_run_completed",
      startedAt,
      finishedAt: now(),
      summary: summaryForLog(summary, true)
    }));
    return summary;
  }

  private async getSyncContent(node: DingTalkKnowledgeNode) {
    if (isDingTalkDownloadableFile(node)) return this.dingtalk.getFile(node);
    if (isDingTalkTextDocument(node)) return this.dingtalk.getDocument(node);
    throw new Error("暂不支持该钉钉文件类型");
  }

  private logProgress(processed: number, total: number, summary: KnowledgeSyncSummary) {
    const every = Math.max(1, knowledgeSyncConfig.progressLogEvery);
    if (processed !== total && processed % every !== 0) return;
    console.log(JSON.stringify({
      event: "knowledge_sync_progress",
      processed,
      total,
      summary: summaryForLog(summary)
    }));
  }

  private async deleteOldBailianDocument(document: DingTalkKnowledgeDocument | DingTalkKnowledgeFile, documentId: string, summary: KnowledgeSyncSummary) {
    await this.bailian.deleteIndexDocuments([documentId]).catch((err) => {
      addSyncError(summary, `${document.title}: 旧百炼索引文档删除失败：${err instanceof Error ? err.message : String(err)}`);
    });
    await this.bailian.deleteDataCenterFiles([documentId]).catch((err) => {
      addSyncError(summary, `${document.title}: 旧百炼源文件删除失败：${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async markUnchanged(id: string, node: DingTalkKnowledgeNode) {
    await this.store.mutate((db) => {
      const item = db.knowledgeSyncDocuments.find((doc) => doc.id === id);
      if (!item) return;
      item.title = node.title;
      item.sourceUrl = node.url;
      item.sourceUpdatedAt = node.updatedAt;
      if (item.status !== "synced") item.status = "synced";
      item.updatedAt = now();
    });
  }

  private async upsertDocument(
    document: DingTalkKnowledgeDocument | DingTalkKnowledgeFile,
    update: {
      contentHash: string;
      status: KnowledgeSyncDocument["status"];
      bailianDocumentId?: string;
      bailianJobId?: string;
      lastError?: string;
      retryAfter?: string;
    }
  ) {
    const timestamp = now();
    const sourceWorkspaceId = process.env.DINGTALK_WORKSPACE_ID?.trim() || "";
    await this.store.mutate((db) => {
      let item = db.knowledgeSyncDocuments.find(
        (doc) => doc.source === "dingtalk" && doc.sourceWorkspaceId === sourceWorkspaceId && doc.sourceNodeId === document.nodeId
      );
      if (!item) {
        item = {
          id: uid("ksd"),
          source: "dingtalk",
          sourceWorkspaceId,
          sourceNodeId: document.nodeId,
          title: document.title,
          sourceUrl: document.url,
          contentHash: update.contentHash,
          sourceUpdatedAt: document.updatedAt,
          status: update.status,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        db.knowledgeSyncDocuments.push(item);
      }
      item.title = document.title;
      item.sourceUrl = document.url;
      item.contentHash = update.contentHash;
      item.sourceUpdatedAt = document.updatedAt;
      item.status = update.status;
      item.bailianDocumentId = update.bailianDocumentId ?? item.bailianDocumentId;
      item.bailianJobId = update.bailianJobId ?? item.bailianJobId;
      item.lastSyncedAt = update.status === "synced" ? timestamp : item.lastSyncedAt;
      item.lastError = update.lastError;
      item.retryAfter = update.retryAfter;
      item.unsupportedReason = update.status === "unsupported" ? update.lastError : undefined;
      item.updatedAt = timestamp;
    });
  }

  private async upsertNodeFailure(
    node: DingTalkKnowledgeNode,
    update: {
      contentHash: string;
      status: "failed" | "unsupported";
      lastError: string;
      retryAfter?: string;
    }
  ) {
    const timestamp = now();
    const sourceWorkspaceId = process.env.DINGTALK_WORKSPACE_ID?.trim() || "";
    await this.store.mutate((db) => {
      let item = db.knowledgeSyncDocuments.find(
        (doc) => doc.source === "dingtalk" && doc.sourceWorkspaceId === sourceWorkspaceId && doc.sourceNodeId === node.nodeId
      );
      if (!item) {
        item = {
          id: uid("ksd"),
          source: "dingtalk",
          sourceWorkspaceId,
          sourceNodeId: node.nodeId,
          title: node.title,
          sourceUrl: node.url,
          contentHash: update.contentHash,
          sourceUpdatedAt: node.updatedAt,
          status: update.status,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        db.knowledgeSyncDocuments.push(item);
      }
      item.title = node.title;
      item.sourceUrl = node.url;
      item.contentHash = update.contentHash;
      item.sourceUpdatedAt = node.updatedAt;
      item.status = update.status;
      item.lastError = update.lastError;
      item.retryAfter = update.retryAfter;
      item.unsupportedReason = update.status === "unsupported" ? update.lastError : undefined;
      item.updatedAt = timestamp;
    });
  }
}

export class KnowledgeSyncScheduler {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private quotaPausedUntil: Date | undefined;

  constructor(private service: KnowledgeSyncService) {}

  start() {
    if (this.timer || !knowledgeSyncConfig.enabled) return;
    this.timer = setInterval(() => void this.scan(), Math.max(1, knowledgeSyncConfig.intervalMinutes) * 60_000);
  }

  async scan() {
    if (this.running || !this.inActiveWindow()) return;
    if (this.quotaPausedUntil && this.quotaPausedUntil.getTime() > Date.now()) {
      console.warn(JSON.stringify({
        event: "knowledge_sync_skipped",
        reason: "dingtalk_quota_circuit_open",
        pausedUntil: this.quotaPausedUntil.toISOString()
      }));
      return;
    }
    this.running = true;
    const startedAt = now();
    try {
      console.log(JSON.stringify({
        event: "knowledge_sync_scheduled_started",
        startedAt
      }));
      const summary = await this.service.runManualSync();
      console.log(JSON.stringify({
        event: "knowledge_sync_scheduled",
        startedAt,
        finishedAt: now(),
        summary: summaryForLog(summary, true)
      }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (isDingTalkQuotaExceededMessage(error)) {
        this.quotaPausedUntil = nextQuotaRetryAt();
      }
      console.error(JSON.stringify({
        event: "knowledge_sync_scheduled_failed",
        startedAt,
        finishedAt: now(),
        error,
        pausedUntil: this.quotaPausedUntil?.toISOString()
      }));
    } finally {
      this.running = false;
    }
  }

  private inActiveWindow() {
    const hour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: knowledgeSyncConfig.timezone,
      hour: "2-digit",
      hour12: false
    }).format(new Date()));
    const start = Math.max(0, Math.min(24, knowledgeSyncConfig.activeStartHour));
    const end = Math.max(0, Math.min(24, knowledgeSyncConfig.activeEndHour));
    if (start === end) return true;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }
}

function nextQuotaRetryAt() {
  const configuredHours = Number(process.env.KNOWLEDGE_SYNC_QUOTA_PAUSE_HOURS);
  if (Number.isFinite(configuredHours) && configuredHours > 0) {
    return new Date(Date.now() + configuredHours * 60 * 60 * 1000);
  }
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth() + 1, 1, 8, 0, 0, 0);
}
