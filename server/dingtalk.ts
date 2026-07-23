export type DingTalkKnowledgeNode = {
  nodeId: string;
  title: string;
  type?: string;
  url?: string;
  updatedAt?: string;
  parentNodeId?: string;
  size?: number;
};

export type DingTalkKnowledgeDocument = DingTalkKnowledgeNode & {
  markdown: string;
};

export type DingTalkKnowledgeFile = DingTalkKnowledgeNode & {
  filename: string;
  content: Buffer;
};

const dingtalkBaseUrl = "https://api.dingtalk.com";

const textExtensions = new Set(["adoc", "md", "markdown", "txt"]);
const downloadableExtensions = new Set(["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "png", "jpg", "jpeg", "bmp", "gif"]);

class DingTalkApiError extends Error {
  constructor(
    message: string,
    readonly retryable = false
  ) {
    super(message);
  }
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

function asString(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDingTalkMessage(message: string) {
  return /fetch failed|timeout|temporary failure|rate.?limit|限流|次数过多|temporarily restricted|Invoke remote method timeout/i.test(message);
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === "AbortError";
    throw new DingTalkApiError(isAbort ? `钉钉接口请求超时：${timeoutMs}ms` : message, true);
  } finally {
    clearTimeout(timeout);
  }
}

function pickArray(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  for (const key of ["nodes", "items", "list", "data", "result"]) {
    const value = payload?.[key];
    if (Array.isArray(value)) return value;
  }
  for (const key of ["data", "result"]) {
    const nested = payload?.[key];
    if (nested && typeof nested === "object") {
      const value = pickArray(nested);
      if (value.length) return value;
    }
  }
  return [];
}

function pickNextToken(payload: any) {
  return asString(payload?.nextToken ?? payload?.result?.nextToken ?? payload?.data?.nextToken);
}

export function dingtalkFileExtension(title: string) {
  const match = title.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

export function isDingTalkTextDocument(node: DingTalkKnowledgeNode) {
  const extension = dingtalkFileExtension(node.title);
  if (extension) return textExtensions.has(extension);
  const type = node.type?.toLowerCase() ?? "";
  return !type || /doc|wiki|sheet|page|document/.test(type);
}

export function isDingTalkDownloadableFile(node: DingTalkKnowledgeNode) {
  return downloadableExtensions.has(dingtalkFileExtension(node.title));
}

function normalizeNode(item: any): DingTalkKnowledgeNode | null {
  const nodeId = asString(item?.nodeId ?? item?.id ?? item?.node_id ?? item?.resourceId ?? item?.docKey);
  const title = asString(item?.title ?? item?.name ?? item?.nodeName ?? item?.docName);
  if (!nodeId || !title) return null;
  return {
    nodeId,
    title,
    type: asString(item?.type ?? item?.nodeType ?? item?.resourceType) || undefined,
    url: asString(item?.url ?? item?.link ?? item?.webUrl) || undefined,
    updatedAt: asString(item?.updatedAt ?? item?.modifiedTime ?? item?.updateTime ?? item?.gmtModified) || undefined,
    parentNodeId: asString(item?.parentNodeId ?? item?.parentId) || undefined,
    size: Number.isFinite(Number(item?.size ?? item?.fileSize)) ? Number(item?.size ?? item?.fileSize) : undefined
  };
}

function isSyncableNode(node: DingTalkKnowledgeNode) {
  return isDingTalkTextDocument(node) || isDingTalkDownloadableFile(node);
}

export function dingtalkKnowledgeReady() {
  return Boolean(
    process.env.DINGTALK_CLIENT_ID?.trim() &&
    process.env.DINGTALK_CLIENT_SECRET?.trim() &&
    process.env.DINGTALK_WORKSPACE_ID?.trim() &&
    process.env.DINGTALK_OPERATOR_ID?.trim()
  );
}

export class DingTalkKnowledgeService {
  private token?: { value: string; expiresAt: number };

  async checkCredentials() {
    const token = await this.getAccessToken();
    return { ok: Boolean(token), operatorId: requiredEnv("DINGTALK_OPERATOR_ID") };
  }

  async listDocuments(limit = 200): Promise<DingTalkKnowledgeDocument[]> {
    const workspaceId = requiredEnv("DINGTALK_WORKSPACE_ID");
    const nodes = await this.listDocumentNodes(Math.max(limit * 20, 200));
    const documents: DingTalkKnowledgeDocument[] = [];
    for (const node of nodes) {
      const document = await this.getDocument(node);
      if (!document.markdown.trim()) continue;
      documents.push(document);
      if (documents.length >= limit) break;
    }
    return documents;
  }

  async listDocumentNodes(limit = 5000): Promise<DingTalkKnowledgeNode[]> {
    const workspaceId = requiredEnv("DINGTALK_WORKSPACE_ID");
    const nodes = await this.listNodes(workspaceId, limit);
    return nodes.filter(isSyncableNode);
  }

  async getDocument(node: DingTalkKnowledgeNode): Promise<DingTalkKnowledgeDocument> {
    const workspaceId = requiredEnv("DINGTALK_WORKSPACE_ID");
    const markdown = await this.getNodeMarkdown(workspaceId, node);
    return { ...node, markdown };
  }

  async getFile(node: DingTalkKnowledgeNode): Promise<DingTalkKnowledgeFile> {
    const operatorId = requiredEnv("DINGTALK_OPERATOR_ID");
    const maxBytes = envNumber("DINGTALK_DOWNLOAD_MAX_BYTES", 150 * 1024 * 1024);
    if (node.size && node.size > maxBytes) {
      throw new Error(`钉钉文件超过下载上限：${node.size} > ${maxBytes}`);
    }
    const { spaceId, dentryId } = await this.getDentryStorageId(node.nodeId, operatorId);
    const downloadInfo = await this.getFileDownloadInfo(spaceId, dentryId, operatorId);
    const url = downloadInfo.resourceUrls[0];
    if (!url) throw new Error("钉钉未返回文件下载地址");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), envNumber("DINGTALK_DOWNLOAD_TIMEOUT_MS", 120_000));
    try {
      const response = await fetch(url, {
        headers: downloadInfo.headers,
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`钉钉文件下载失败：${response.status} ${response.statusText}`);
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length && length > maxBytes) throw new Error(`钉钉文件超过下载上限：${length} > ${maxBytes}`);
      const content = Buffer.from(await response.arrayBuffer());
      if (content.byteLength > maxBytes) throw new Error(`钉钉文件超过下载上限：${content.byteLength} > ${maxBytes}`);
      return { ...node, filename: node.title, content };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      throw new Error(isAbort ? "钉钉文件下载超时" : err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getAccessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const { response, payload } = await this.requestWithRetry("/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: requiredEnv("DINGTALK_CLIENT_ID"),
        appSecret: requiredEnv("DINGTALK_CLIENT_SECRET")
      })
    }, false);
    if (!response.ok || !payload?.accessToken) {
      throw new Error(`获取钉钉 accessToken 失败：${payload?.message || payload?.errmsg || response.statusText}`);
    }
    this.token = {
      value: String(payload.accessToken),
      expiresAt: Date.now() + Math.max(60, Number(payload.expireIn ?? payload.expiresIn ?? 7200) - 120) * 1000
    };
    return this.token.value;
  }

  private async request(path: string, init: RequestInit = {}) {
    const token = await this.getAccessToken();
    const { response, payload } = await this.requestWithRetry(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
        ...(init.headers || {})
      }
    });
    if (!response.ok) {
      throw new Error(`钉钉接口调用失败：${payload?.message || payload?.errmsg || payload?.errorMessage || response.statusText}`);
    }
    return payload;
  }

  private async requestWithRetry(path: string, init: RequestInit = {}, withToken = true) {
    const timeoutMs = envNumber("DINGTALK_API_TIMEOUT_MS", 30_000);
    const retries = Math.max(0, Math.floor(envNumber("DINGTALK_API_RETRIES", 2)));
    const retryDelayMs = envNumber("DINGTALK_API_RETRY_DELAY_MS", 1_000);
    const url = `${dingtalkBaseUrl}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const result = await fetchJsonWithTimeout(url, init, timeoutMs);
        if (result.response.ok) return result;

        const message = result.payload?.message || result.payload?.errmsg || result.payload?.errorMessage || result.response.statusText;
        const retryable = result.response.status >= 500 || result.response.status === 429 || isRetryableDingTalkMessage(String(message));
        if (!retryable || attempt >= retries) return result;
        lastError = new DingTalkApiError(`${withToken ? "钉钉接口调用失败" : "获取钉钉 accessToken 失败"}：${message}`, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retryable = err instanceof DingTalkApiError ? err.retryable : isRetryableDingTalkMessage(message);
        lastError = err instanceof Error ? err : new Error(message);
        if (!retryable || attempt >= retries) throw lastError;
      }

      await sleep(retryDelayMs * (attempt + 1));
    }

    throw lastError ?? new Error("钉钉接口调用失败");
  }

  private async getDentryStorageId(dentryUuid: string, operatorId: string) {
    const payload = await this.request(`/v2.0/doc/dentries/${encodeURIComponent(dentryUuid)}/queryDentryId?${new URLSearchParams({ operatorId })}`);
    const data = payload?.data ?? payload?.result ?? payload;
    const spaceId = asString(data?.spaceId);
    const dentryId = asString(data?.dentryId);
    if (!spaceId || !dentryId) throw new Error("钉钉未返回有效的 spaceId/dentryId");
    return { spaceId, dentryId };
  }

  private async getFileDownloadInfo(spaceId: string, dentryId: string, unionId: string) {
    const payload = await this.request(
      `/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/${encodeURIComponent(dentryId)}/downloadInfos/query?${new URLSearchParams({ unionId })}`,
      {
        method: "POST",
        body: JSON.stringify({
          option: {
            version: 1,
            preferIntranet: false
          }
        })
      }
    );
    const info = payload?.headerSignatureInfo ?? payload?.data?.headerSignatureInfo ?? payload?.result?.headerSignatureInfo ?? payload;
    const resourceUrls = Array.isArray(info?.resourceUrls) ? info.resourceUrls.map(asString).filter(Boolean) : [];
    const headers = info?.headers && typeof info.headers === "object" ? info.headers as Record<string, string> : {};
    return { resourceUrls, headers };
  }

  private async listNodes(workspaceId: string, limit: number) {
    const operatorId = requiredEnv("DINGTALK_OPERATOR_ID");
    const result: DingTalkKnowledgeNode[] = [];
    const rootNodeId = requiredEnv("DINGTALK_ROOT_NODE_ID");
    const queue: string[] = [rootNodeId];
    const seen = new Set<string>();

    while (queue.length && result.length < limit) {
      const parentNodeId = queue.shift();
      if (!parentNodeId) continue;
      let nextToken = "";
      do {
        const query = new URLSearchParams({
          operatorId,
          workspaceId,
          parentNodeId,
          maxResults: "100"
        });
        if (nextToken) query.set("nextToken", nextToken);
        const payload = await this.request(`/v2.0/wiki/nodes?${query}`);
        for (const raw of pickArray(payload)) {
          const node = normalizeNode(raw);
          if (!node || seen.has(node.nodeId)) continue;
          seen.add(node.nodeId);
          result.push(node);
          if (result.length >= limit) break;
          if (raw?.hasChildren || /folder|dir|catalog|category/.test(node.type?.toLowerCase() ?? "")) queue.push(node.nodeId);
        }
        nextToken = pickNextToken(payload);
      } while (nextToken && result.length < limit);
    }

    return result;
  }

  private async getNodeMarkdown(workspaceId: string, node: DingTalkKnowledgeNode) {
    const operatorId = requiredEnv("DINGTALK_OPERATOR_ID");
    const paths = [`/v2.0/wiki/nodes/content?${new URLSearchParams({ operatorId, workspaceId, nodeId: node.nodeId })}`];
    let lastError: Error | undefined;
    try {
      const blocksContent = await this.getDocumentBlocksContent(node.nodeId, operatorId);
      if (blocksContent) return formatMarkdown(node, blocksContent);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    for (const path of paths) {
      try {
        const payload = await this.request(path);
        const content = extractContent(payload);
        if (content) return formatMarkdown(node, content);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (lastError) throw lastError;
    return formatMarkdown(node, node.title);
  }

  private async getDocumentBlocksContent(nodeId: string, operatorId: string) {
    const lines: string[] = [];
    let nextToken = "";
    let page = 0;
    do {
      const query = new URLSearchParams({ operatorId, maxResults: "200" });
      if (nextToken) query.set("nextToken", nextToken);
      const payload = await this.request(`/v1.0/doc/suites/documents/${encodeURIComponent(nodeId)}/blocks?${query}`);
      const blocks = payload?.blocks ?? payload?.data?.blocks ?? payload?.result?.blocks ?? payload?.result?.data;
      if (Array.isArray(blocks)) lines.push(...blocks.map(blockText).filter(Boolean));
      nextToken = pickNextToken(payload);
      page += 1;
    } while (nextToken && page < 200);
    return lines.join("\n").trim();
  }
}

function extractContent(payload: any) {
  const blocks = payload?.blocks ?? payload?.data?.blocks ?? payload?.result?.blocks ?? payload?.result?.data;
  if (Array.isArray(blocks)) {
    const text = blocks.map(blockText).filter(Boolean).join("\n");
    if (text.trim()) return text.trim();
  }
  const candidates = [
    payload?.markdown,
    payload?.content,
    payload?.text,
    payload?.html,
    payload?.result?.markdown,
    payload?.result?.content,
    payload?.result?.text,
    payload?.result?.html,
    payload?.data?.markdown,
    payload?.data?.content,
    payload?.data?.text,
    payload?.data?.html
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function blockText(block: any): string {
  const text =
    asString(block?.text) ||
    asString(block?.content) ||
    asString(block?.markdown) ||
    asString(block?.paragraph?.text) ||
    asString(block?.heading?.text) ||
    asString(block?.title?.text) ||
    asString(block?.data?.text);
  if (text) return text;
  const elements = block?.elements ?? block?.children ?? block?.textRunList ?? block?.runs;
  if (Array.isArray(elements)) {
    return elements.map(blockText).filter(Boolean).join("");
  }
  if (block && typeof block === "object") {
    const nested = ["paragraph", "heading", "bullet", "ordered", "code", "quote", "callout", "table"].flatMap((key) => {
      const value = block[key];
      return Array.isArray(value) ? value : value ? [value] : [];
    });
    if (nested.length) return nested.map(blockText).filter(Boolean).join("\n");
  }
  return "";
}

function formatMarkdown(node: DingTalkKnowledgeNode, content: string) {
  const metadata = [
    `# ${node.title}`,
    "",
    node.url ? `来源：${node.url}` : "",
    node.updatedAt ? `钉钉更新时间：${node.updatedAt}` : "",
    ""
  ].filter(Boolean);
  return `${metadata.join("\n")}\n${content.trim()}\n`;
}
