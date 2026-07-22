import { MessageRecord } from "./types.js";
import crypto from "node:crypto";

export type RetrievedItem = {
  text: string;
  score: number;
  sourceType: "company_kb";
  source?: string;
  metadata?: Record<string, unknown>;
};

export type RetrievedMemory = {
  text: string;
  score?: number;
  memoryId?: string;
  memoryType?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type ListedMemory = RetrievedMemory & {
  memoryId: string;
};

const dashScopeBaseUrl = "https://dashscope.aliyuncs.com";

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function timeoutMs(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const memoryConfig = {
  scanIntervalMinutes: numberEnv("MEMORY_SCAN_INTERVAL_MINUTES", 10),
  minNewMessages: numberEnv("MEMORY_MIN_NEW_MESSAGES", 6),
  minNewChars: numberEnv("MEMORY_MIN_NEW_CHARS", 1200),
  maxMessagesPerBatch: numberEnv("MEMORY_MAX_MESSAGES_PER_BATCH", 40),
  topK: numberEnv("MEMORY_TOP_K", 5),
  threshold: numberEnv("MEMORY_SIMILARITY_THRESHOLD", 0.6),
  rewrite: booleanEnv("MEMORY_REWRITE", true),
  rerank: booleanEnv("MEMORY_RERANK", true)
};

export const companyKnowledgeConfig = {
  topK: numberEnv("COMPANY_RAG_TOP_K", 5),
  threshold: numberEnv("COMPANY_RAG_SCORE_THRESHOLD", 0.72),
  writeTimeoutMs: timeoutMs("BAILIAN_WRITE_TIMEOUT_MS", 45_000)
};

export function memoryUserId(companyId: string, userId: string) {
  return `${companyId}:${userId}`;
}

function bailianApiKey() {
  return process.env.BAILIAN_API_KEY?.trim() || "";
}

function workspaceId() {
  return process.env.BAILIAN_WORKSPACE_ID?.trim() || "";
}

async function createKnowledgeClient() {
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim();
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim();
  if (!accessKeyId || !accessKeySecret) return null;
  const [
    {
      default: BailianClient,
      RetrieveRequest,
      ApplyFileUploadLeaseRequest,
      AddFileRequest,
      DeleteIndexDocumentRequest,
      DeleteFileRequest,
      SubmitIndexAddDocumentsJobRequest,
      SubmitIndexAddDocumentsJobRequestExtra
    },
    { Config }
  ] = await Promise.all([
    import("@alicloud/bailian20231229"),
    import("@alicloud/openapi-client")
  ]);
  const BailianClientConstructor = (
    (BailianClient as unknown as { default?: typeof BailianClient }).default ?? BailianClient
  ) as typeof BailianClient;
  const config = new Config({
    accessKeyId,
    accessKeySecret,
    endpoint: process.env.BAILIAN_OPENAPI_ENDPOINT?.trim() || "bailian.cn-beijing.aliyuncs.com"
  });
  return {
    client: new BailianClientConstructor(config),
    RetrieveRequest,
    ApplyFileUploadLeaseRequest,
    AddFileRequest,
    DeleteIndexDocumentRequest,
    DeleteFileRequest,
    SubmitIndexAddDocumentsJobRequest,
    SubmitIndexAddDocumentsJobRequestExtra
  };
}

async function requestBailian(path: string, body: unknown, method = "POST") {
  const apiKey = bailianApiKey();
  if (!apiKey) throw new Error("缺少 BAILIAN_API_KEY");
  const response = await fetch(`${dashScopeBaseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: method === "GET" ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.error?.message === "string"
          ? payload.error.message
          : response.statusText;
    throw new Error(`百炼接口调用失败：${message}`);
  }
  return payload;
}

function asArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray((payload as any)?.data)) return (payload as any).data;
  if (Array.isArray((payload as any)?.data?.memories)) return (payload as any).data.memories;
  if (Array.isArray((payload as any)?.data?.items)) return (payload as any).data.items;
  if (Array.isArray((payload as any)?.memories)) return (payload as any).memories;
  if (Array.isArray((payload as any)?.items)) return (payload as any).items;
  if (Array.isArray((payload as any)?.output?.results)) return (payload as any).output.results;
  if (Array.isArray((payload as any)?.output?.chunks)) return (payload as any).output.chunks;
  if (Array.isArray((payload as any)?.memory_nodes)) return (payload as any).memory_nodes;
  return [];
}

function textOf(item: any) {
  return String(item?.text ?? item?.content ?? item?.memory ?? item?.chunk_text ?? item?.page_content ?? item?.contentText ?? "").trim();
}

function scoreOf(item: any) {
  const score = Number(item?.score ?? item?.similarity ?? item?.similarity_score ?? item?.rerank_score);
  return Number.isFinite(score) ? score : undefined;
}

function dateOf(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === "string" && value) return value;
  return undefined;
}

export class BailianCompanyKnowledgeService {
  async retrieveCompanyKnowledge(params: { companyId: string; userId: string; query: string }): Promise<RetrievedItem[]> {
    const indexId = process.env.BAILIAN_COMPANY_KB_ID?.trim();
    const ws = workspaceId();
    const knowledgeClient = await createKnowledgeClient();
    if (!knowledgeClient || !indexId || !ws) return [];
    const response = await knowledgeClient.client.retrieve(ws, new knowledgeClient.RetrieveRequest({
      indexId,
      query: params.query,
      denseSimilarityTopK: companyKnowledgeConfig.topK,
      rerankTopN: companyKnowledgeConfig.topK,
      rerankMinScore: companyKnowledgeConfig.threshold,
      enableReranking: true
    }));
    if (response.body?.success === false || (response.body?.code && response.body.code !== "Success")) {
      throw new Error(`百炼知识库检索失败：${response.body.code || "UnknownError"} ${response.body.message || ""}`.trim());
    }
    const nodes = response.body?.data?.nodes ?? [];
    return nodes
      .map((node): RetrievedItem | null => {
        const text = node.text?.trim() ?? "";
        const score = node.score ?? 0;
        if (!text || score < companyKnowledgeConfig.threshold) return null;
        const metadata = node.metadata && typeof node.metadata === "object"
          ? node.metadata as Record<string, unknown>
          : undefined;
        return {
          text,
          score,
          sourceType: "company_kb",
          source: String(metadata?.source ?? metadata?.doc_name ?? metadata?.document_name ?? metadata?.file_name ?? "") || undefined,
          metadata
        };
      })
      .filter((item): item is RetrievedItem => Boolean(item))
      .slice(0, companyKnowledgeConfig.topK);
  }

  async addMarkdownDocument(params: {
    title: string;
    markdown: string;
    uniqueId: string;
    tags?: string[];
  }) {
    const indexId = process.env.BAILIAN_COMPANY_KB_ID?.trim();
    const ws = workspaceId();
    const categoryId = process.env.BAILIAN_DATA_CATEGORY_ID?.trim() || "default";
    const knowledgeClient = await createKnowledgeClient();
    if (!knowledgeClient || !indexId || !ws) {
      throw new Error("缺少百炼知识库写入配置");
    }

    const filename = `${safeFileStem(params.title)}.md`;
    const content = Buffer.from(params.markdown, "utf8");
    const leaseResponse = await withTimeout(
      knowledgeClient.client.applyFileUploadLease(
        categoryId,
        ws,
        new knowledgeClient.ApplyFileUploadLeaseRequest({
          categoryType: "UNSTRUCTURED",
          fileName: filename,
          md5: crypto.createHash("md5").update(content).digest("hex"),
          sizeInBytes: String(content.byteLength)
        })
      ),
      companyKnowledgeConfig.writeTimeoutMs,
      "申请百炼文件上传租约超时"
    );
    assertBailianSuccess(leaseResponse.body, "申请百炼文件上传租约失败");

    const lease = leaseResponse.body?.data;
    const uploadUrl = lease?.param?.url;
    if (!lease?.fileUploadLeaseId || !uploadUrl) throw new Error("百炼未返回有效上传租约");
    const uploadController = new AbortController();
    const uploadTimer = setTimeout(() => uploadController.abort(), companyKnowledgeConfig.writeTimeoutMs);
    const uploadResponse = await fetch(uploadUrl, {
      method: lease.param?.method || "PUT",
      headers: lease.param?.headers && typeof lease.param.headers === "object" ? lease.param.headers : {},
      body: content,
      signal: uploadController.signal
    }).finally(() => clearTimeout(uploadTimer));
    if (!uploadResponse.ok) {
      throw new Error(`上传百炼临时文件失败：${uploadResponse.status} ${uploadResponse.statusText}`);
    }

    const fileResponse = await withTimeout(
      knowledgeClient.client.addFile(
        ws,
        new knowledgeClient.AddFileRequest({
          categoryId,
          categoryType: "UNSTRUCTURED",
          leaseId: lease.fileUploadLeaseId,
          parser: "DASHSCOPE_DOCMIND",
          tags: params.tags?.slice(0, 10)
        })
      ),
      companyKnowledgeConfig.writeTimeoutMs,
      "登记百炼文件超时"
    );
    assertBailianSuccess(fileResponse.body, "登记百炼文件失败");
    const fileId = fileResponse.body?.data?.fileId;
    if (!fileId) throw new Error("百炼未返回文件 ID");

    const jobResponse = await withTimeout(
      knowledgeClient.client.submitIndexAddDocumentsJob(
        ws,
        new knowledgeClient.SubmitIndexAddDocumentsJobRequest({
          indexId,
          sourceType: "DATA_CENTER_FILE",
          documentIds: [fileId],
          extra: new knowledgeClient.SubmitIndexAddDocumentsJobRequestExtra({
            uniqueId: params.uniqueId
          })
        })
      ),
      companyKnowledgeConfig.writeTimeoutMs,
      "提交百炼知识库导入任务超时"
    );
    assertBailianSuccess(jobResponse.body, "提交百炼知识库导入任务失败");
    return {
      documentId: fileId,
      jobId: jobResponse.body?.data?.id
    };
  }

  async deleteIndexDocuments(documentIds: string[]) {
    const indexId = process.env.BAILIAN_COMPANY_KB_ID?.trim();
    const ws = workspaceId();
    const knowledgeClient = await createKnowledgeClient();
    const ids = documentIds.map((item) => item.trim()).filter(Boolean);
    if (!ids.length) return;
    if (!knowledgeClient || !indexId || !ws) throw new Error("缺少百炼知识库删除配置");
    const response = await withTimeout(
      knowledgeClient.client.deleteIndexDocument(
        ws,
        new knowledgeClient.DeleteIndexDocumentRequest({
          indexId,
          documentIds: ids
        })
      ),
      companyKnowledgeConfig.writeTimeoutMs,
      "删除百炼旧索引文档超时"
    );
    assertBailianSuccess(response.body, "删除百炼旧索引文档失败");
  }

  async deleteDataCenterFiles(fileIds: string[]) {
    const ws = workspaceId();
    const knowledgeClient = await createKnowledgeClient();
    const ids = fileIds.map((item) => item.trim()).filter(Boolean);
    if (!ids.length) return;
    if (!knowledgeClient || !ws) throw new Error("缺少百炼数据中心文件删除配置");
    for (const fileId of ids) {
      const response = await withTimeout(
        knowledgeClient.client.deleteFile(
          fileId,
          ws,
          new knowledgeClient.DeleteFileRequest({})
        ),
        companyKnowledgeConfig.writeTimeoutMs,
        "删除百炼旧源文件超时"
      );
      assertBailianSuccess(response.body, "删除百炼旧源文件失败");
    }
  }
}

function safeFileStem(value: string) {
  const cleaned = value
    .replace(/[\\/:*?"<>|#{}[\]^~`]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);
  const stem = cleaned || "dingtalk-document";
  return stem.length >= 3 ? stem : `${stem}_doc`;
}

function assertBailianSuccess(body: any, prefix: string) {
  if (body?.success === false || (body?.code && body.code !== "Success")) {
    throw new Error(`${prefix}：${body?.message || body?.code || "UnknownError"}`);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function companyKnowledgeReady() {
  return Boolean(
    process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim() &&
    process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim() &&
    process.env.BAILIAN_WORKSPACE_ID?.trim() &&
    process.env.BAILIAN_COMPANY_KB_ID?.trim()
  );
}

export class BailianMemoryService {
  async searchMemory(params: { companyId: string; userId: string; query: string }): Promise<RetrievedMemory[]> {
    const memoryId = process.env.BAILIAN_MEMORY_ID?.trim();
    if (!bailianApiKey() || !memoryId) return [];
    const payload = await requestBailian("/api/v2/apps/memory/memory_nodes/search", {
      memory_library_id: memoryId,
      user_id: memoryUserId(params.companyId, params.userId),
      messages: [{ role: "user", content: params.query }],
      min_score: memoryConfig.threshold,
      enable_rewrite: memoryConfig.rewrite,
      enable_rerank: memoryConfig.rerank,
      rerank_threshold: memoryConfig.threshold,
      rerank_top_n: memoryConfig.topK
    });
    return this.parseMemories(payload).filter((item) => item.score === undefined || item.score >= memoryConfig.threshold);
  }

  async addMemory(params: {
    companyId: string;
    userId: string;
    messages: Pick<MessageRecord, "role" | "content" | "createdAt">[];
    metadata?: Record<string, unknown>;
  }) {
    const memoryId = process.env.BAILIAN_MEMORY_ID?.trim();
    if (!memoryId) throw new Error("缺少 BAILIAN_MEMORY_ID");
    const payload = await requestBailian("/api/v2/apps/memory/add", {
      memory_library_id: memoryId,
      user_id: memoryUserId(params.companyId, params.userId),
      messages: params.messages.map((message) => ({
        role: message.role,
        content: message.content
      })),
      meta_data: params.metadata
    });
    return {
      raw: payload,
      memoryId:
        typeof payload?.data?.memory_id === "string"
          ? payload.data.memory_id
          : typeof payload?.memory_nodes?.[0]?.memory_node_id === "string"
            ? payload.memory_nodes[0].memory_node_id
          : typeof payload?.memory_id === "string"
            ? payload.memory_id
            : undefined
    };
  }

  async listMemory(params: { companyId: string; userId: string }): Promise<ListedMemory[]> {
    const memoryId = process.env.BAILIAN_MEMORY_ID?.trim();
    if (!bailianApiKey() || !memoryId) return [];
    const query = new URLSearchParams({
      user_id: memoryUserId(params.companyId, params.userId),
      memory_library_id: memoryId,
      page_size: "50",
      page_num: "1"
    });
    const payload = await requestBailian(`/api/v2/apps/memory/memory_nodes?${query}`, {}, "GET");
    return this.parseMemories(payload)
      .map((item) => ({ ...item, memoryId: item.memoryId || "" }))
      .filter((item): item is ListedMemory => Boolean(item.memoryId && item.text));
  }

  async deleteMemory(params: { companyId: string; userId: string; memoryId: string }) {
    const libraryId = process.env.BAILIAN_MEMORY_ID?.trim();
    if (!libraryId) throw new Error("缺少 BAILIAN_MEMORY_ID");
    const query = new URLSearchParams({ memory_library_id: libraryId });
    await requestBailian(`/api/v2/apps/memory/memory_nodes/${encodeURIComponent(params.memoryId)}?${query}`, {
      user_id: memoryUserId(params.companyId, params.userId),
    }, "DELETE");
  }

  private parseMemories(payload: unknown): RetrievedMemory[] {
    return asArray(payload)
      .map((item: any): RetrievedMemory | null => {
        const text = textOf(item);
        if (!text) return null;
        return {
          text,
          score: scoreOf(item),
          memoryId: item?.id ?? item?.memory_id ?? item?.memoryId ?? item?.memory_node_id,
          memoryType: item?.memory_type ?? item?.memoryType ?? item?.type,
          createdAt: dateOf(item?.created_at ?? item?.createdAt),
          metadata: item?.meta_data ?? item?.metadata
        };
      })
      .filter((item): item is RetrievedMemory => Boolean(item))
      .slice(0, memoryConfig.topK);
  }
}
