export type DingTalkKnowledgeNode = {
  nodeId: string;
  title: string;
  type?: string;
  url?: string;
  updatedAt?: string;
  parentNodeId?: string;
};

export type DingTalkKnowledgeDocument = DingTalkKnowledgeNode & {
  markdown: string;
};

const dingtalkBaseUrl = "https://api.dingtalk.com";

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

function optionalEnv(name: string) {
  return process.env[name]?.trim() || "";
}

function asString(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
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
    parentNodeId: asString(item?.parentNodeId ?? item?.parentId) || undefined
  };
}

function isDocumentNode(node: DingTalkKnowledgeNode) {
  const type = node.type?.toLowerCase() ?? "";
  return !type || /doc|file|wiki|sheet|page|document/.test(type);
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
    const nodes = await this.listNodes(workspaceId, Math.max(limit * 20, 200));
    const documents: DingTalkKnowledgeDocument[] = [];
    for (const node of nodes.filter(isDocumentNode)) {
      const markdown = await this.getNodeMarkdown(workspaceId, node);
      if (!markdown.trim()) continue;
      documents.push({ ...node, markdown });
      if (documents.length >= limit) break;
    }
    return documents;
  }

  private async getAccessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await fetch(`${dingtalkBaseUrl}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: requiredEnv("DINGTALK_CLIENT_ID"),
        appSecret: requiredEnv("DINGTALK_CLIENT_SECRET")
      })
    });
    const payload = await response.json().catch(() => ({}));
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
    const response = await fetch(`${dingtalkBaseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
        ...(init.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`钉钉接口调用失败：${payload?.message || payload?.errmsg || payload?.errorMessage || response.statusText}`);
    }
    return payload;
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
    const query = new URLSearchParams({ operatorId });
    const paths = [
      `/v1.0/doc/suites/documents/${encodeURIComponent(node.nodeId)}/blocks?${new URLSearchParams({ operatorId, maxResults: "200" })}`,
      `/v2.0/wiki/nodes/content?${new URLSearchParams({ operatorId, workspaceId, nodeId: node.nodeId })}`
    ];
    let lastError: Error | undefined;
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
