import crypto from "node:crypto";
import { BailianCompanyKnowledgeService } from "./bailian.js";
import { DingTalkKnowledgeDocument, DingTalkKnowledgeNode, DingTalkKnowledgeService } from "./dingtalk.js";
import { Store } from "./db.js";
import { KnowledgeSyncDocument } from "./types.js";
import { uid } from "./security.js";

export type KnowledgeSyncSummary = {
  scanned: number;
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
  scanMaxNodes: envNumber("KNOWLEDGE_SYNC_SCAN_MAX_NODES", 5000)
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

function syncKey(doc: DingTalkKnowledgeDocument) {
  return `${doc.nodeId}`;
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

export class KnowledgeSyncService {
  constructor(
    private store: Store,
    private dingtalk: DingTalkKnowledgeService,
    private bailian: BailianCompanyKnowledgeService
  ) {}

  async runManualSync(limit = Number(process.env.KNOWLEDGE_SYNC_MAX_DOCUMENTS ?? 200)): Promise<KnowledgeSyncSummary> {
    const workspaceId = process.env.DINGTALK_WORKSPACE_ID?.trim() || "";
    const maxUploads = Math.max(1, limit);
    const nodes = await this.dingtalk.listDocumentNodes(knowledgeSyncConfig.scanMaxNodes);
    const summary: KnowledgeSyncSummary = {
      scanned: nodes.length,
      synced: 0,
      skipped: 0,
      failed: 0,
      errors: []
    };

    for (const node of nodes) {
      const existing = (await this.store.read()).knowledgeSyncDocuments.find(
        (item) => item.source === "dingtalk" && item.sourceWorkspaceId === workspaceId && item.sourceNodeId === node.nodeId
      );
      if (unchangedByModifiedTime(existing, node)) {
        summary.skipped += 1;
        await this.markUnchanged(existing!.id, node);
        continue;
      }

      let document: DingTalkKnowledgeDocument;
      let contentHash = "";
      try {
        document = await this.dingtalk.getDocument(node);
        contentHash = sha256(document.markdown);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.failed += 1;
        summary.errors.push(`${node.title}: ${message}`);
        continue;
      }

      if (isAlreadySynced(existing, contentHash)) {
        summary.skipped += 1;
        await this.markUnchanged(existing!.id, node);
        continue;
      }

      if (summary.synced >= maxUploads) break;

      try {
        const result = await this.bailian.addMarkdownDocument({
          title: document.title,
          markdown: document.markdown,
          uniqueId: `dingtalk:${workspaceId}:${document.nodeId}`,
          tags: ["dingtalk", "knowledge"]
        });
        await this.upsertDocument(document, {
          contentHash,
          bailianDocumentId: result.documentId,
          bailianJobId: result.jobId,
          status: "synced"
        });
        if (existing?.bailianDocumentId && existing.bailianDocumentId !== result.documentId) {
          await this.bailian.deleteIndexDocuments([existing.bailianDocumentId]).catch((err) => {
            summary.errors.push(`${document.title}: 旧百炼索引文档删除失败：${err instanceof Error ? err.message : String(err)}`);
          });
        }
        summary.synced += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.upsertDocument(document, {
          contentHash,
          status: "failed",
          lastError: message
        });
        summary.failed += 1;
        summary.errors.push(`${document.title}: ${message}`);
      }
    }

    return summary;
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
    document: DingTalkKnowledgeDocument,
    update: {
      contentHash: string;
      status: KnowledgeSyncDocument["status"];
      bailianDocumentId?: string;
      bailianJobId?: string;
      lastError?: string;
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
      item.updatedAt = timestamp;
    });
  }
}

export class KnowledgeSyncScheduler {
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private service: KnowledgeSyncService) {}

  start() {
    if (this.timer || !knowledgeSyncConfig.enabled) return;
    this.timer = setInterval(() => void this.scan(), Math.max(1, knowledgeSyncConfig.intervalMinutes) * 60_000);
  }

  async scan() {
    if (this.running || !this.inActiveWindow()) return;
    this.running = true;
    const startedAt = now();
    try {
      const summary = await this.service.runManualSync();
      console.log(JSON.stringify({
        event: "knowledge_sync_scheduled",
        startedAt,
        finishedAt: now(),
        summary
      }));
    } catch (err) {
      console.error(JSON.stringify({
        event: "knowledge_sync_scheduled_failed",
        startedAt,
        finishedAt: now(),
        error: err instanceof Error ? err.message : String(err)
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
