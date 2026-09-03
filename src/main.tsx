import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  BarChart3,
  Brain,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  FileSpreadsheet,
  Folder,
  FolderInput,
  Globe2,
  Image,
  KeyRound,
  LockKeyhole,
  Lock,
  LogOut,
  LayoutDashboard,
  Menu,
  MessageSquare,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Save,
  Send,
  Settings,
  Star,
  Shield,
  Trash2,
  Upload,
  UserRound,
  UserPlus,
  Users,
  X
} from "lucide-react";
import "./styles.css";

type Role = "admin" | "user";

type User = {
  id: string;
  companyId: string;
  username: string;
  role: Role;
  enabled: boolean;
  createdAt: string;
};

type Model = {
  id: string;
  name: string;
  provider: string;
  kind: "chat" | "image";
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKey?: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
  isDefault: boolean;
  hasApiKey: boolean;
  createdAt: string;
};

type Message = {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  imageUrl?: string;
  attachments?: AttachmentSummary[];
  sources?: SearchSource[];
  createdAt: string;
  modelId?: string;
};

type AttachmentSummary = {
  id: string;
  originalName: string;
  mimeType: string;
  kind: "image" | "document" | "spreadsheet" | "presentation" | "text";
  size: number;
};

type SearchSource = {
  title: string;
  url: string;
  snippet: string;
};

type AppCapabilities = {
  attachments: { enabled: boolean; maxFiles: number; maxBytes: number; extensions: string[] };
  webSearch: { enabled: boolean; provider: string };
};

type Conversation = {
  id: string;
  userId: string;
  modelId: string;
  agentId?: string;
  workspaceId?: string;
  archived: boolean;
  title: string;
  messages: Message[];
  messageCount?: number;
  messagesLoaded?: boolean;
  createdAt: string;
  updatedAt: string;
};

type Workspace = {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
};

type Agent = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  modelId: string;
  group: string;
  avatar: string;
  color: string;
  favoriteCount: number;
  favorited: boolean;
  useCount: number;
  allowFileUpload: boolean;
  allowImageInput: boolean;
  allowWebSearch: boolean;
  published: boolean;
  publicSlug: string;
  authorName: string;
  authorRole: Role;
  createdAt: string;
  updatedAt: string;
};

type IntegrationToken = {
  id: string;
  name: string;
  token?: string;
  enabled: boolean;
  createdAt: string;
};

type SystemSettings = {
  safetyRules: string;
};

type UsageStats = {
  user: User;
  summary: {
    conversations: number;
    totalTurns: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    activeDays: number;
    averageTurnsPerConversation: number;
    providerUsageRecords: number;
  };
  dailyUsage: Array<{
    date: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
  modelUsage: Array<{ name: string; turns: number }>;
};

type DataConnector = {
  id: "wanliniu" | "alipay" | "dingtalk_knowledge";
  name: string;
  sourceType: "erp" | "payment" | "knowledge";
  enabled: boolean;
  status: "waiting_credentials" | "ready" | "syncing" | "error";
  requiredEnvVars: string[];
  hasCredentials: boolean;
  missingEnvVars: string[];
  lastCheckedAt?: string;
  lastSyncedAt?: string;
  message?: string;
};

type DataPlatformState = {
  layers: Array<{ id: string; name: string; description: string; status: string }>;
  connectors: DataConnector[];
  metrics: Array<{
    id: string;
    name: string;
    connectorIds: DataConnector["id"][];
    description: string;
    status: "planned" | "available";
  }>;
  syncLogs: Array<{
    id: string;
    connectorId: DataConnector["id"];
    action: "check_credentials" | "manual_sync" | "scheduled_sync";
    status: "running" | "success" | "blocked" | "failed";
    message: string;
    startedAt: string;
    finishedAt: string;
  }>;
};

type ManagementBriefDimension = {
  id: string;
  name: string;
  description: string;
  fields: string[];
};

type ManagementBriefDefinition = {
  id: string;
  source: "system" | "custom";
  name: string;
  description: string;
  dimensionIds: string[];
  prompt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type ManagementBriefReport = {
  id: string;
  definitionId: string;
  definitionName: string;
  reportDate: string;
  content: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
};

type ManagementDashboardFacts = {
  reportDate: string;
  summary: {
    gmv: number;
    actualPayment: number;
    orders: number;
    units: number;
    averageOrderValue: number;
    inboundOrders: number;
    inboundUnits: number;
    inventoryUnits: number;
    inventorySkus: number;
    lockedInventoryUnits: number;
    thirtyDayDailyAverageGmv: number;
    thirtyDayDailyAverageOrders: number;
  };
  dailyTrend: Array<{ date: string; gmv: number; orders: number }>;
  shops: Array<{ name: string; source: string; gmv: number; orders: number; units: number }>;
  products: Array<{ skuCode: string; name: string; gmv: number; units: number }>;
  inventory: Array<{ skuCode: string; name: string; units: number; lockedUnits: number; inTransitUnits: number }>;
  dataStatus: Array<{ resource: string; modifiedThrough: string; lastSuccessAt: string }>;
};

type HupunSkillStatus = {
  ready: boolean;
  hasCredentials: boolean;
  cliPath: string;
  cliAvailable: boolean;
  missingEnvVars: string[];
};

type HupunApiDescriptor = {
  name: string;
  docUrl: string;
  path: string;
};

type HupunDebugExecution = {
  api: HupunApiDescriptor;
  params: Record<string, unknown>;
  durationMs: number;
  result: unknown;
};

type MemoryItem = {
  id: string;
  text: string;
  createdAt?: string;
  updatedAt?: string;
};

type MemoryLimits = {
  maxItems: number;
  maxCharsPerItem: number;
  maxTotalChars: number;
  usedItems: number;
  usedChars: number;
};

class ApiError extends Error {
  constructor(message: string, readonly requestId?: string) {
    super(message);
  }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(!isFormData ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const requestId = payload.requestId || response.headers.get("x-request-id") || undefined;
    const message = payload.error || (response.status === 504 ? "模型响应超时，请稍后重试" : `请求失败（${response.status}）`);
    throw new ApiError(requestId ? `${message} · 编号 ${requestId}` : message, requestId);
  }
  return payload as T;
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function localId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function titleFrom(content: string) {
  return content.replace(/\s+/g, " ").slice(0, 32) || "新对话";
}

function publicAgentUrl(slug: string) {
  return `${window.location.origin}/agents/${slug}`;
}

function readableFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentIcon({ kind, size = 15 }: { kind: AttachmentSummary["kind"]; size?: number }) {
  if (kind === "image") return <Image size={size} />;
  if (kind === "spreadsheet") return <FileSpreadsheet size={size} />;
  return <FileText size={size} />;
}

function AttachmentList({ attachments, removable, onRemove }: {
  attachments: AttachmentSummary[];
  removable?: boolean;
  onRemove?: (attachment: AttachmentSummary) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className={`attachment-list ${removable ? "pending" : ""}`}>
      {attachments.map((attachment) => (
        <div className="attachment-chip" key={attachment.id}>
          {attachment.kind === "image" ? (
            <img src={`/api/attachments/${encodeURIComponent(attachment.id)}/content`} alt="" />
          ) : <span className="attachment-file-icon"><AttachmentIcon kind={attachment.kind} /></span>}
          <span className="attachment-meta">
            <strong title={attachment.originalName}>{attachment.originalName}</strong>
            <small>{readableFileSize(attachment.size)}</small>
          </span>
          {removable ? (
            <button type="button" title="移除附件" onClick={() => onRemove?.(attachment)}><X size={13} /></button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function MessageSources({ sources }: { sources?: SearchSource[] }) {
  if (!sources?.length) return null;
  return (
    <div className="message-sources">
      <span><Globe2 size={13} />参考来源</span>
      <div>
        {sources.map((source, index) => (
          <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer" title={source.snippet}>
            <strong>{index + 1}</strong>{source.title}
          </a>
        ))}
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      onDone(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-brand">
          <img src="/brand/xiaoxiang-wordmark.png" alt="小象优选" />
          <div className="login-divider" />
          <div>
            <h1>AI 工作台</h1>
            <p>企业内部智能协作平台</p>
          </div>
        </div>
        <label>
          账号
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
            name="workspace-account"
            spellCheck={false}
          />
        </label>
        <label>
          密码
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="off"
            name="workspace-passcode"
          />
        </label>
        {error ? <div className="error">{error}</div> : null}
        <button className="primary" type="submit">
          <KeyRound size={18} />
          登录
        </button>
      </form>
    </main>
  );
}

function ChatApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const conversationPageSize = 30;
  const [models, setModels] = useState<Model[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationPage, setConversationPage] = useState(1);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [draftModelId, setDraftModelId] = useState("");
  const [draftAgentId, setDraftAgentId] = useState("");
  const [defaultModelId, setDefaultModelId] = useState("");
  const [draftWorkspaceId, setDraftWorkspaceId] = useState("");
  const [content, setContent] = useState("");
  const [loadingByConversation, setLoadingByConversation] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"chat" | "admin" | "dashboard" | "memories" | "account" | "agents" | "agentEditor">("chat");
  const [editingAgentId, setEditingAgentId] = useState<string | "new">("new");
  const [showArchived, setShowArchived] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [waitIndex, setWaitIndex] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [failedMessage, setFailedMessage] = useState("");
  const [workspaceSectionOpen, setWorkspaceSectionOpen] = useState(true);
  const [conversationSectionOpen, setConversationSectionOpen] = useState(true);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(() => new Set());
  const [capabilities, setCapabilities] = useState<AppCapabilities>({
    attachments: { enabled: true, maxFiles: 4, maxBytes: 10 * 1024 * 1024, extensions: [] },
    webSearch: { enabled: false, provider: "tavily" }
  });
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentSummary[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);

  const active = useMemo(() => conversations.find((item) => item.id === activeId), [activeId, conversations]);
  const activeModelId = active?.modelId || draftModelId;
  const activeLoadingKey = active?.id || "draft";
  const activeLoading = Boolean(loadingByConversation[activeLoadingKey]);
  const currentModel = models.find((model) => model.id === activeModelId);
  const activeAgentId = active?.agentId || draftAgentId;
  const activeAgent = agents.find((agent) => agent.id === activeAgentId);
  const canAttach = Boolean(currentModel) && (!activeAgent || activeAgent.allowFileUpload);
  const attachmentAccept = currentModel?.kind === "image"
    ? ".png,.jpg,.jpeg,.webp"
    : capabilities.attachments.extensions.map((extension) => `.${extension}`).join(",");
  const canSearch = currentModel?.kind === "chat" && capabilities.webSearch.enabled && (!activeAgent || activeAgent.allowWebSearch);
  const visibleConversations = conversations.filter((conversation) => conversation.archived === showArchived);
  const ungroupedConversations = visibleConversations.filter((conversation) => !conversation.workspaceId);
  const waitMessages = [
    "AI 疯狂翻书中 (ง •̀_•́)ง",
    "什么？刚睡醒，等我找找 (。-ω-)zzz",
    "答案正在路上，请勿催单 ( •̀ ω •́ )✧",
    "正在知识库里东翻西找 (￣▽￣)~*",
    "脑子转得有点快，先别打断我 (¬‿¬)",
    "让我再想得像样一点 ( • ̀ω•́ )",
    "正在努力避免一本正经地胡说八道 (._.)",
    "这个问题有点东西，我再琢磨琢磨 (˘･_･˘)",
    "AI 临时加班中，马上回来 (ง'̀-'́)ง",
    "正在组织语言，争取不像机器人 (￣﹃￣)",
    "别急，好的答案值得多等两秒 (๑•̀ㅂ•́)و",
    "上下文有点多，我正在认真捋顺 (＠_＠;)"
  ];

  async function refresh() {
    const [modelResult, conversationResult, workspaceResult, agentResult, capabilityResult] = await Promise.all([
      api<{ models: Model[]; defaultModelId: string }>("/api/models"),
      api<{ conversations: Conversation[]; pagination: { page: number; hasMore: boolean } }>(
        `/api/conversations?summary=1&page=1&pageSize=${conversationPageSize}&archived=${showArchived}`
      ),
      api<{ workspaces: Workspace[] }>("/api/workspaces"),
      api<{ agents: Agent[] }>("/api/agents"),
      api<AppCapabilities>("/api/capabilities")
    ]);
    setModels(modelResult.models);
    setDefaultModelId(modelResult.defaultModelId);
    setConversations((current) => {
      const firstPage = conversationResult.conversations.map((summary) => {
        const loaded = current.find((item) => item.id === summary.id && item.messagesLoaded);
        return loaded
          ? { ...summary, messages: loaded.messages, messagesLoaded: true }
          : { ...summary, messagesLoaded: false };
      });
      const activeLoaded = current.find(
        (item) => item.id === activeId && item.messagesLoaded && item.archived === showArchived
      );
      return activeLoaded && !firstPage.some((item) => item.id === activeLoaded.id)
        ? [...firstPage, activeLoaded]
        : firstPage;
    });
    setConversationPage(1);
    setHasMoreConversations(conversationResult.pagination.hasMore);
    setWorkspaces(workspaceResult.workspaces);
    setAgents(agentResult.agents);
    setCapabilities(capabilityResult);
    setDraftModelId((current) => (
      modelResult.models.some((model) => model.id === current)
        ? current
        : modelResult.defaultModelId || modelResult.models[0]?.id || ""
    ));
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, [showArchived]);

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") refresh().catch(() => undefined);
    }
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [showArchived, activeId]);

  async function loadMoreConversations() {
    if (loadingMoreConversations || !hasMoreConversations) return;
    const nextPage = conversationPage + 1;
    setLoadingMoreConversations(true);
    try {
      const result = await api<{ conversations: Conversation[]; pagination: { page: number; hasMore: boolean } }>(
        `/api/conversations?summary=1&page=${nextPage}&pageSize=${conversationPageSize}&archived=${showArchived}`
      );
      setConversations((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        for (const summary of result.conversations) {
          if (!byId.has(summary.id)) byId.set(summary.id, { ...summary, messagesLoaded: false });
        }
        return [...byId.values()];
      });
      setConversationPage(result.pagination.page);
      setHasMoreConversations(result.pagination.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载对话失败");
    } finally {
      setLoadingMoreConversations(false);
    }
  }

  async function openConversation(conversation: Conversation) {
    setActiveId(conversation.id);
    setView("chat");
    setError("");
    setSidebarOpen(false);
    if (conversation.messagesLoaded) return;
    setLoadingByConversation((items) => ({ ...items, [conversation.id]: true }));
    try {
      const result = await api<{ conversation: Conversation }>(
        `/api/conversations/${encodeURIComponent(conversation.id)}`
      );
      setConversations((items) => items.map((item) => (
        item.id === conversation.id ? { ...result.conversation, messagesLoaded: true } : item
      )));
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载对话失败");
    } finally {
      setLoadingByConversation((items) => ({ ...items, [conversation.id]: false }));
    }
  }

  useEffect(() => {
    const hasLoading = Object.values(loadingByConversation).some(Boolean);
    if (!hasLoading) return;
    const timer = window.setInterval(() => setWaitIndex((index) => index + 1), 3200);
    return () => window.clearInterval(timer);
  }, [loadingByConversation]);

  function startNewChat() {
    setActiveId("");
    setDraftAgentId("");
    setDraftModelId(defaultModelId || models[0]?.id || "");
    setContent("");
    setError("");
    setPendingAttachments([]);
    setWebSearch(false);
    setView("chat");
    setSidebarOpen(false);
  }

  function startAgentChat(agent: Agent) {
    setActiveId("");
    setDraftAgentId(agent.id);
    setDraftModelId(agent.modelId);
    setContent("");
    setError("");
    setPendingAttachments([]);
    setWebSearch(false);
    setView("chat");
    setSidebarOpen(false);
  }

  async function uploadAttachments(files: FileList | File[] | null) {
    if (!files?.length || uploadingAttachments) return;
    const remaining = capabilities.attachments.maxFiles - pendingAttachments.length;
    if (remaining <= 0) {
      setError(`每次最多上传 ${capabilities.attachments.maxFiles} 个附件`);
      return;
    }
    const selected = Array.from(files).slice(0, remaining);
    if (currentModel?.kind === "image" && selected.some((file) => !["image/png", "image/jpeg", "image/webp"].includes(file.type))) {
      setError("图生图仅支持 PNG、JPG、JPEG 或 WebP 图片");
      return;
    }
    if (activeAgent && !activeAgent.allowFileUpload) {
      setError("这个智能体没有开启文件上传");
      return;
    }
    if (activeAgent && !activeAgent.allowImageInput && selected.some((file) => file.type.startsWith("image/"))) {
      setError("这个智能体没有开启图片理解");
      return;
    }
    const form = new FormData();
    selected.forEach((file) => form.append("files", file));
    setUploadingAttachments(true);
    setError("");
    try {
      const result = await api<{ attachments: AttachmentSummary[] }>("/api/attachments", { method: "POST", body: form });
      setPendingAttachments((items) => [...items, ...result.attachments].slice(0, capabilities.attachments.maxFiles));
    } catch (err) {
      setError(err instanceof Error ? err.message : "附件上传失败");
    } finally {
      setUploadingAttachments(false);
    }
  }

  async function removePendingAttachment(attachment: AttachmentSummary) {
    setPendingAttachments((items) => items.filter((item) => item.id !== attachment.id));
    await api(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: "DELETE" }).catch(() => undefined);
  }

  async function sendMessage(rawText: string) {
    const modelId = active?.modelId || draftModelId;
    const text = rawText.trim();
    const attachments = [...pendingAttachments];
    const useWebSearch = webSearch;
    if ((!text && !attachments.length) || !modelId) return;
    const isNewConversation = !active;
    const tempId = isNewConversation ? localId("tmp") : "";
    const loadingKey = active?.id || tempId;
    if (loadingByConversation[loadingKey]) return;
    setLoadingByConversation((items) => ({ ...items, [loadingKey]: true }));
    setError("");
    setFailedMessage("");
    const userMessage: Message = {
      id: localId("msg"),
      role: "user",
      content: text || (currentModel?.kind === "image" ? "请基于上传的图片进行编辑。" : "请分析上传的附件。"),
      attachments,
      modelId,
      createdAt: new Date().toISOString()
    };
    setContent("");
    setPendingAttachments([]);
    if (isNewConversation) {
      const optimistic: Conversation = {
        id: tempId,
        userId: user.id,
        modelId,
        workspaceId: draftWorkspaceId || undefined,
        agentId: draftAgentId || undefined,
        archived: false,
        title: activeAgent ? `${activeAgent.name} · ${titleFrom(text || attachments[0]?.originalName || "附件")}` : titleFrom(text || attachments[0]?.originalName || "附件"),
        messages: [userMessage],
        messagesLoaded: true,
        createdAt: userMessage.createdAt,
        updatedAt: userMessage.createdAt
      };
      setConversations((items) => [optimistic, ...items]);
      setActiveId(tempId);
    } else {
      setConversations((items) =>
        items.map((item) =>
          item.id === active.id
            ? { ...item, messages: [...item.messages, userMessage], updatedAt: userMessage.createdAt }
            : item
        )
      );
    }
    try {
      const result = await api<{ conversation: Conversation; memoryNotice?: string }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          content: text,
          modelId,
          conversationId: isNewConversation ? "" : active.id,
          workspaceId: draftWorkspaceId,
          agentId: isNewConversation ? draftAgentId : active.agentId,
          attachmentIds: attachments.map((attachment) => attachment.id),
          webSearch: useWebSearch
        })
      });
      setConversations((items) => {
        const rest = items.filter((item) => item.id !== result.conversation.id && item.id !== tempId);
        return [{ ...result.conversation, messagesLoaded: true }, ...rest];
      });
      setActiveId((current) => (current === tempId || current === active?.id ? result.conversation.id : current));
      setPendingAttachments([]);
      setWebSearch(false);
      if (result.memoryNotice) {
        setNotice(result.memoryNotice);
        window.setTimeout(() => setNotice(""), 2800);
      }
    } catch (err) {
      setPendingAttachments(attachments);
      setFailedMessage(text || " ");
      setConversations((items) =>
        tempId
          ? items.filter((item) => item.id !== tempId)
          : items.map((item) =>
              item.id === active?.id
                ? { ...item, messages: item.messages.filter((message) => message.id !== userMessage.id) }
                : item
            )
      );
      if (tempId) setActiveId("");
      setError(err instanceof Error ? err.message : "发送失败");
    } finally {
      setLoadingByConversation((items) => ({ ...items, [loadingKey]: false }));
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = content;
    if (!text.trim() && !pendingAttachments.length) return;
    setContent("");
    await sendMessage(text);
  }

  async function retryFailedMessage() {
    const text = failedMessage;
    if ((!text && !pendingAttachments.length) || activeLoading) return;
    await sendMessage(text);
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !isComposing && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardFiles = Array.from(event.clipboardData.files);
    const pastedFiles = clipboardFiles.length
      ? clipboardFiles
      : Array.from(event.clipboardData.items)
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file));
    if (!pastedFiles.length) return;

    event.preventDefault();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const normalizedFiles = pastedFiles.map((file, index) => {
      if (file.name && file.name !== "image.png") return file;
      const extension = file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : "png";
      return new File([file], `剪贴板图片-${timestamp}-${index + 1}.${extension}`, { type: file.type || `image/${extension}` });
    });
    void uploadAttachments(normalizedFiles);
  }

  async function archiveConversation(conversation: Conversation) {
    const result = await api<{ conversation: Conversation }>(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: !conversation.archived })
    });
    setConversations((items) => items.map((item) => (item.id === conversation.id ? result.conversation : item)));
    if (activeId === conversation.id && !showArchived) setActiveId("");
  }

  async function deleteConversation(conversation: Conversation) {
    if (!confirm(`确认删除对话「${conversation.title}」？`)) return;
    await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    setConversations((items) => items.filter((item) => item.id !== conversation.id));
    if (activeId === conversation.id) setActiveId("");
  }

  async function moveConversation(conversation: Conversation, workspaceId: string) {
    const result = await api<{ conversation: Conversation }>(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      body: JSON.stringify({ workspaceId })
    });
    setConversations((items) => items.map((item) => (item.id === conversation.id ? result.conversation : item)));
  }

  async function createWorkspace() {
    const name = prompt("工作空间名称");
    if (!name?.trim()) return;
    const result = await api<{ workspace: Workspace }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() })
    });
    setWorkspaces((items) => [...items, result.workspace]);
    setDraftWorkspaceId(result.workspace.id);
  }

  function toggleWorkspace(workspaceId: string) {
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }

  async function copyMarkdown(content: string) {
    await navigator.clipboard.writeText(content);
  }

  async function saveMessageToMemory(conversation: Conversation, message: Message) {
    if (!message.content.trim()) return;
    try {
      await api("/api/memories/save", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: conversation.id,
          message_id: message.id,
          content: message.content
        })
      });
      setNotice("已提交到个人记忆，百炼提取后会在“我的记忆”里显示。");
      window.setTimeout(() => setNotice(""), 2800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  return (
    <main className="app-shell">
      {sidebarOpen ? <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} /> : null}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="side-top">
          <div className="product">
            <img src="/brand/xiaoxiang-wordmark.png" alt="小象优选" />
          </div>
          <button className="mobile-close" title="关闭导航" onClick={() => setSidebarOpen(false)}>
            <X size={19} />
          </button>
          <button
            className="icon-btn"
            title="新对话"
            onClick={startNewChat}
          >
            <Plus size={18} />
          </button>
        </div>
        <button className={`nav-item ${!activeId && view === "chat" ? "active" : ""}`} onClick={startNewChat}>
          <MessageSquare size={17} />
          新聊天
        </button>
        <button className={`nav-item ${view === "memories" ? "active" : ""}`} onClick={() => { setView("memories"); setActiveId(""); setSidebarOpen(false); }}>
          <Brain size={16} />
          我的记忆
        </button>
        <button className={`nav-item ${view === "agents" ? "active" : ""}`} onClick={() => { setView("agents"); setActiveId(""); setSidebarOpen(false); }}>
          <Bot size={16} />
          智能体
        </button>
        {user.role === "admin" ? (
          <>
            <button className={`nav-item ${view === "dashboard" ? "active" : ""}`} onClick={() => { setView("dashboard"); setActiveId(""); setSidebarOpen(false); }}>
              <LayoutDashboard size={16} />
              经营驾驶舱
            </button>
            <button className={`nav-item ${view === "admin" ? "active" : ""}`} onClick={() => { setView("admin"); setSidebarOpen(false); }}>
              <Settings size={16} />
              管理后台
            </button>
          </>
        ) : null}
        <div className="sidebar-navigation">
        <div className="conversation-list">
          <div className="workspace-root">
            <div className="sidebar-heading">
              <button className="workspace-toggle root-toggle" onClick={() => setWorkspaceSectionOpen((open) => !open)}>
                {workspaceSectionOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>工作空间</span>
              </button>
              <button className="section-icon" title="新建工作空间" onClick={createWorkspace}><Plus size={14} /></button>
            </div>
            {workspaceSectionOpen ? workspaces.map((workspace) => {
              const collapsed = collapsedWorkspaceIds.has(workspace.id);
              const workspaceConversations = visibleConversations.filter((conversation) => conversation.workspaceId === workspace.id);
              return (
                <div className="workspace-group" key={workspace.id}>
                  <button className="workspace-toggle group-toggle" onClick={() => toggleWorkspace(workspace.id)}>
                    {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <Folder size={13} />
                    <span>{workspace.name}</span>
                    <small>{workspaceConversations.length}</small>
                  </button>
                  {!collapsed ? workspaceConversations.map((conversation) => (
                <div className={`conversation-row ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}>
                  <button
                    className="conversation-main"
                    onClick={() => openConversation(conversation)}
                  >
                    <MessageSquare size={16} />
                    <span>{conversation.title}</span>
                  </button>
                  <label className="icon-inline move-control" title="移动到分组">
                    <FolderInput size={14} />
                    <select
                      aria-label={`移动对话 ${conversation.title}`}
                      value={conversation.workspaceId || ""}
                      onChange={(event) => moveConversation(conversation, event.target.value)}
                    >
                      <option value="">对话</option>
                      {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </label>
                  <button className="icon-inline" title={conversation.archived ? "取消归档" : "归档"} onClick={() => archiveConversation(conversation)}>
                    <Archive size={14} />
                  </button>
                  <button className="icon-inline danger-inline" title="删除" onClick={() => deleteConversation(conversation)}>
                    <Trash2 size={14} />
                  </button>
                </div>
                  )) : null}
                </div>
              );
            }) : null}
          </div>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-heading">
            <button className="workspace-toggle root-toggle" onClick={() => setConversationSectionOpen((open) => !open)}>
              {conversationSectionOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <MessageSquare size={14} />
              <span>对话</span>
              <small>{ungroupedConversations.length}</small>
            </button>
          </div>
          {conversationSectionOpen ? (
            <div className="workspace-conversations">
              {ungroupedConversations.map((conversation) => (
                <div className={`conversation-row ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}>
                  <button className="conversation-main" onClick={() => openConversation(conversation)}>
                    <MessageSquare size={15} />
                    <span>{conversation.title}</span>
                  </button>
                  <label className="icon-inline move-control" title="移动到分组">
                    <FolderInput size={14} />
                    <select
                      aria-label={`移动对话 ${conversation.title}`}
                      value={conversation.workspaceId || ""}
                      onChange={(event) => moveConversation(conversation, event.target.value)}
                    >
                      <option value="">对话</option>
                      {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                    </select>
                  </label>
                  <button className="icon-inline" title={conversation.archived ? "取消归档" : "归档"} onClick={() => archiveConversation(conversation)}><Archive size={14} /></button>
                  <button className="icon-inline danger-inline" title="删除" onClick={() => deleteConversation(conversation)}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          ) : null}
          {hasMoreConversations ? (
            <button
              className="conversation-load-more"
              type="button"
              disabled={loadingMoreConversations}
              onClick={loadMoreConversations}
            >
              {loadingMoreConversations ? "加载中…" : "加载更多对话"}
            </button>
          ) : null}
        </div>
        </div>
        <div className="side-bottom">
          <button className="nav-item" onClick={() => setShowArchived(!showArchived)}>
            <Archive size={16} />
            {showArchived ? "未归档对话" : "归档对话"}
          </button>
          <button className={`nav-item ${view === "account" ? "active" : ""}`} onClick={() => { setView("account"); setActiveId(""); setSidebarOpen(false); }}>
            <UserRound size={16} />
            账号设置
          </button>
          <button className="ghost" onClick={onLogout}>
            <LogOut size={17} />
            退出
          </button>
        </div>
      </aside>

      {view === "admin" && user.role === "admin" ? (
        <AdminPanel refreshModels={refresh} onOpenSidebar={() => setSidebarOpen(true)} />
      ) : view === "dashboard" && user.role === "admin" ? (
        <ManagementDashboardPage onOpenSidebar={() => setSidebarOpen(true)} />
      ) : view === "memories" ? (
        <MemoriesPage onOpenSidebar={() => setSidebarOpen(true)} />
      ) : view === "agents" ? (
        <AgentsPage user={user} agents={agents} reload={refresh} onStartChat={startAgentChat} onEdit={(id) => { setEditingAgentId(id); setView("agentEditor"); }} onOpenSidebar={() => setSidebarOpen(true)} />
      ) : view === "agentEditor" ? (
        <AgentEditorPage agent={editingAgentId === "new" ? undefined : agents.find((item) => item.id === editingAgentId)} agents={agents} models={models} onCancel={() => setView("agents")} onSaved={async () => { await refresh(); setView("agents"); }} />
      ) : view === "account" ? (
        <AccountPage user={user} onOpenSidebar={() => setSidebarOpen(true)} />
      ) : (
      <section className="chat">
        <header className="chat-header">
          <button className="mobile-menu" title="打开导航" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="chat-title">
            <strong>{active?.title || "新对话"}</strong>
            <span>{activeAgent ? `${activeAgent.name} · ${user.username}` : user.username}</span>
          </div>
          <div className="chat-controls">
          {!active ? (
            <select value={draftWorkspaceId} onChange={(event) => setDraftWorkspaceId(event.target.value)}>
              <option value="">对话</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
              ))}
            </select>
          ) : null}
          {!activeAgent ? <select value={activeModelId} onChange={(event) => setDraftModelId(event.target.value)} disabled={Boolean(active)}>
            {models.length ? null : <option>暂无可用模型</option>}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.kind === "image" ? "图片" : "聊天"} · {model.name} · {model.model}
              </option>
            ))}
          </select> : <span className="locked-model"><Lock size={13} />{currentModel?.name || "固定模型"}</span>}
          </div>
        </header>

        <div className="messages">
          {(active?.messages ?? []).length ? (
            active!.messages.map((message, index) => (
              <article key={`${message.createdAt}-${index}`} className={`message ${message.role}`}>
                {message.role === "assistant" ? (
                  <div className="avatar"><img src="/brand/xiaoxiang-mark.png" alt="小象 AI" /></div>
                ) : null}
                <div className="bubble">
                  {message.attachments?.length ? <AttachmentList attachments={message.attachments} /> : null}
                  {message.role === "assistant" ? (
                    <>
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      </div>
                      <div className="message-actions">
                        <button title="复制" onClick={() => copyMarkdown(message.content)}>
                          <Copy size={14} />
                        </button>
                        {active ? (
                          <button title="记录这句对话" onClick={() => saveMessageToMemory(active, message)}>
                            <Brain size={14} />
                          </button>
                        ) : null}
                      </div>
                      <MessageSources sources={message.sources} />
                    </>
                  ) : (
                    <pre>{message.content}</pre>
                  )}
                  {message.imageUrl ? <img className="generated-image" src={message.imageUrl} alt={message.content} /> : null}
                  <small className="message-time">{dateTime(message.createdAt)}</small>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state">
              <div className="empty-agent-avatar" style={{ background: activeAgent?.color }}>{activeAgent?.avatar || <img src="/brand/xiaoxiang-mark.png" alt="" />}</div>
              <h2>{activeAgent?.name || "今天想一起解决什么？"}</h2>
              <p>{activeAgent?.description || "选择模型，开始新的对话"}</p>
            </div>
          )}
          {activeLoading ? <div className="typing">{waitMessages[waitIndex % waitMessages.length]}</div> : null}
        </div>

        <form className="composer" onSubmit={send}>
          {notice ? <div className="notice">{notice}</div> : null}
          {error ? (
            <div className="chat-error" role="status">
              <span>{error}</span>
              {failedMessage ? (
                <button type="button" onClick={retryFailedMessage} disabled={activeLoading}>
                  <RotateCcw size={14} />
                  重试
                </button>
              ) : null}
            </div>
          ) : null}
          {pendingAttachments.length ? (
            <div className="composer-attachments">
              <AttachmentList attachments={pendingAttachments} removable onRemove={removePendingAttachment} />
            </div>
          ) : null}
          <div className="composer-row">
            <div className="composer-tools">
              <label className={`composer-tool ${!canAttach || activeLoading || uploadingAttachments ? "disabled" : ""}`} title={canAttach ? (currentModel?.kind === "image" ? "上传参考图片进行图生图" : "上传图片或文件") : "当前模型或智能体不支持附件"}>
                {uploadingAttachments ? <span className="tool-spinner" /> : <Paperclip size={18} />}
                <input
                  type="file"
                  multiple
                  accept={attachmentAccept}
                  disabled={!canAttach || activeLoading || uploadingAttachments}
                  onChange={(event) => {
                    uploadAttachments(event.target.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <button
                className={`composer-tool ${webSearch ? "active" : ""}`}
                type="button"
                title={capabilities.webSearch.enabled ? (canSearch ? "联网搜索" : "当前智能体未开启联网搜索") : "联网搜索待管理员配置"}
                disabled={!canSearch || activeLoading}
                onClick={() => setWebSearch((value) => !value)}
              >
                <Globe2 size={18} />
              </button>
            </div>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
              placeholder={currentModel?.kind === "image" ? "输入修改要求，也可直接粘贴剪贴板图片" : "输入消息，Enter 发送，Shift+Enter 换行；支持粘贴附件"}
              rows={2}
            />
            <button className="primary send" type="submit" disabled={!activeModelId || activeLoading || (!content.trim() && !pendingAttachments.length)}>
              <Send size={18} />
            </button>
          </div>
        </form>
      </section>
      )}
    </main>
  );
}

function AgentCard({
  agent,
  official,
  canEdit,
  onStartChat,
  onCopyLink,
  onEdit,
  onDelete
  , onFavorite
}: {
  agent: Agent;
  official?: boolean;
  canEdit: boolean;
  onStartChat: (agent: Agent) => void;
  onCopyLink: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
  onFavorite: (agent: Agent) => void;
}) {
  return (
    <article className={`agent-card ${official ? "official" : ""}`}>
      <div className="agent-card-top">
        <span className="agent-mark" style={{ background: agent.color }}>{agent.avatar || "🤖"}</span>
        <div>
          <h3>{agent.name}</h3>
          <small>{official ? "官方发布" : agent.published ? "已发布链接" : "仅自己可见"} · {agent.authorName}</small>
        </div>
      </div>
      <p className="agent-description">{agent.description}</p>
      <div className="agent-capabilities">
        {agent.allowFileUpload ? <span><Paperclip size={12} />文件</span> : null}
        {agent.allowImageInput ? <span><Image size={12} />图片</span> : null}
        {agent.allowWebSearch ? <span><Globe2 size={12} />联网</span> : null}
      </div>
      <div className="agent-card-actions">
        <button className="agent-action primary-action" onClick={() => onStartChat(agent)}><Send size={14} />使用</button>
        {agent.published ? <button className="agent-action" onClick={() => onCopyLink(agent)}><Copy size={14} />复制链接</button> : null}
        {canEdit ? <button className="agent-icon-action" title="编辑" onClick={() => onEdit(agent)}><Edit3 size={14} /></button> : null}
        {canEdit ? <button className="agent-icon-action danger-icon-action" title="删除" onClick={() => onDelete(agent)}><Trash2 size={14} /></button> : null}
        <button className={`agent-icon-action favorite-action ${agent.favorited ? "active" : ""}`} title={agent.favorited ? "取消收藏" : "收藏"} onClick={() => onFavorite(agent)}><Star size={14} fill={agent.favorited ? "currentColor" : "none"} /></button>
      </div>
      <div className="agent-stats"><span><Star size={12} />{agent.favoriteCount}</span><span><MessageSquare size={12} />{agent.useCount} 次使用</span></div>
    </article>
  );
}

function AgentsPage({
  user,
  agents,
  reload,
  onStartChat,
  onEdit,
  onOpenSidebar
}: {
  user: User;
  agents: Agent[];
  reload: () => Promise<void>;
  onStartChat: (agent: Agent) => void;
  onEdit: (id: string | "new") => void;
  onOpenSidebar: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState("全部");
  const [notice, setNotice] = useState("");
  const groups = ["全部", "收藏", ...Array.from(new Set(agents.map((agent) => agent.group || "未分组")))];
  const filteredAgents = agents.filter((agent) => {
    const matchesGroup = activeGroup === "全部" || (activeGroup === "收藏" ? agent.favorited : (agent.group || "未分组") === activeGroup);
    const needle = query.trim().toLowerCase();
    return matchesGroup && (!needle || `${agent.name} ${agent.description} ${agent.group}`.toLowerCase().includes(needle));
  });
  const officialAgents = filteredAgents.filter((agent) => agent.published && agent.authorRole === "admin");
  const myAgents = user.role === "admin"
    ? []
    : filteredAgents.filter((agent) => agent.authorName === user.username && agent.authorRole !== "admin");

  function startCreate() {
    onEdit("new");
  }

  function startEdit(agent: Agent) {
    onEdit(agent.id);
  }

  async function makePrivate(agent: Agent) {
    try {
      await api(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ published: false }) });
      setNotice("已转为私有，旧分享链接已作废");
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "操作失败");
    }
  }

  async function toggleFavorite(agent: Agent) {
    try { await api(`/api/agents/${agent.id}/favorite`, { method: "POST" }); await reload(); }
    catch (err) { setNotice(err instanceof Error ? err.message : "收藏失败"); }
  }

  async function deleteAgent(agent: Agent) {
    if (!confirm(`确认删除智能体「${agent.name}」？`)) return;
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "删除失败");
    }
  }

  async function copyAgentLink(agent: Agent) {
    await navigator.clipboard.writeText(publicAgentUrl(agent.publicSlug));
    setNotice("公开链接已复制");
  }

  function canEdit(agent: Agent) {
    return agent.authorName === user.username || user.role === "admin";
  }

  return (
    <section className="agents-page">
      <header className="admin-header">
        <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
        <div>
          <h2>智能体</h2>
          <p>把常用任务封装成固定角色、流程和输出风格</p>
        </div>
      </header>
      <div className="agent-toolbar">
        <label className="agent-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索智能体、描述或分组" /></label>
        <button className="primary" onClick={startCreate}><Plus size={16} />创建智能体</button>
      </div>
      <div className="agent-group-tabs">{groups.map((group) => <button key={group} className={activeGroup === group ? "active" : ""} onClick={() => setActiveGroup(group)}>{group}</button>)}</div>
      {notice ? <div className={notice.includes("失败") || notice.includes("不存在") ? "error agent-notice" : "notice agent-notice"}>{notice}</div> : null}
      <div className="agents-board">
        <section className="agent-section">
          <div className="agent-section-title"><h3>官方发布</h3><span>{officialAgents.length} 个</span></div>
          <div className="agent-grid">
            {officialAgents.length ? officialAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                official
                canEdit={canEdit(agent)}
                onStartChat={onStartChat}
                onCopyLink={copyAgentLink}
                onEdit={startEdit}
                onDelete={deleteAgent}
                onFavorite={toggleFavorite}
              />
            )) : null}
            {user.role === "admin" ? (
              <button className="agent-card create-card" onClick={startCreate}>
                <Plus size={24} />
                <strong>创建官方智能体</strong>
                <span>发布后所有员工可见，并自动生成分享链接</span>
              </button>
            ) : null}
            {!officialAgents.length && user.role !== "admin" ? <div className="agent-empty">暂无官方智能体</div> : null}
          </div>
        </section>
        {user.role !== "admin" ? <section className="agent-section">
          <div className="agent-section-title"><h3>我的智能体</h3><span>{myAgents.length} 个</span></div>
          <div className="agent-grid">
            {myAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                canEdit={canEdit(agent)}
                onStartChat={onStartChat}
                onCopyLink={copyAgentLink}
                onEdit={startEdit}
                onDelete={deleteAgent}
                onFavorite={toggleFavorite}
              />
            ))}
            <button className="agent-card create-card" onClick={startCreate}>
              <Plus size={24} />
              <strong>创建智能体</strong>
              <span>保存一套常用提示词和使用入口</span>
            </button>
          </div>
        </section> : null}
      </div>
    </section>
  );
}

function AgentEditorPage({ agent, agents, models, onCancel, onSaved }: {
  agent?: Agent;
  agents: Agent[];
  models: Model[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const chatModels = models.filter((model) => model.kind === "chat" && model.enabled);
  const [draft, setDraft] = useState({
    name: agent?.name || "",
    description: agent?.description || "",
    prompt: agent?.prompt || "",
    modelId: agent?.modelId || chatModels.find((model) => model.isDefault)?.id || chatModels[0]?.id || "",
    group: agent?.group || "未分组",
    avatar: agent?.avatar || "🤖",
    color: agent?.color || "#E8F1FB",
    allowFileUpload: agent?.allowFileUpload ?? true,
    allowImageInput: agent?.allowImageInput ?? true,
    allowWebSearch: agent?.allowWebSearch ?? false
  });
  const [debugInput, setDebugInput] = useState("");
  const [debugMessages, setDebugMessages] = useState<Message[]>([]);
  const [debugging, setDebugging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [groupOptionsOpen, setGroupOptionsOpen] = useState(false);
  const [groupQuery, setGroupQuery] = useState("");
  const emojis = ["🤖", "✍️", "📊", "🧠", "🔍", "🎨", "💼", "🚀"];
  const colors = ["#E8F1FB", "#F1EAFE", "#E5F5EC", "#FFF1D8", "#FDE9EC", "#E6F4F4"];
  const groupOptions = useMemo(() => Array.from(new Set(
    agents.map((item) => item.group.trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b, "zh-CN")), [agents]);
  const filteredGroupOptions = groupOptions.filter((group) => group.toLocaleLowerCase().includes(groupQuery.trim().toLocaleLowerCase()));
  const hasExactGroup = groupOptions.some((group) => group.toLocaleLowerCase() === draft.group.trim().toLocaleLowerCase());

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim() || !draft.description.trim() || !draft.modelId) return;
    setSaving(true); setError("");
    try {
      await api(agent ? `/api/agents/${agent.id}` : "/api/agents", {
        method: agent ? "PATCH" : "POST",
        body: JSON.stringify({ ...draft, name: draft.name.trim(), description: draft.description.trim(), prompt: draft.prompt.trim(), published: true })
      });
      await onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败"); }
    finally { setSaving(false); }
  }

  async function debug(event: FormEvent) {
    event.preventDefault();
    const content = debugInput.trim();
    if (!content || !draft.modelId || debugging) return;
    const userMessage: Message = { role: "user", content, modelId: draft.modelId, createdAt: new Date().toISOString() };
    setDebugMessages((items) => [...items, userMessage]); setDebugInput(""); setDebugging(true); setError("");
    try {
      const result = await api<{ message: Message }>("/api/agents/debug", { method: "POST", body: JSON.stringify({ content, prompt: draft.prompt, modelId: draft.modelId }) });
      setDebugMessages((items) => [...items, result.message]);
    } catch (err) { setError(err instanceof Error ? err.message : "调试失败"); }
    finally { setDebugging(false); }
  }

  return <section className="agent-workbench">
    <header className="agent-workbench-header">
      <button className="secondary" type="button" onClick={onCancel}><ChevronLeft size={16} />返回</button>
      <div><h2>{agent ? "编辑智能体" : "创建智能体"}</h2><p>配置和调试同步进行，保存后模型将对使用者锁定</p></div>
      <div className="workbench-actions"><button className="secondary" type="button" onClick={onCancel}>取消</button><button className="primary" type="submit" form="agent-config" disabled={saving || !draft.name.trim() || !draft.description.trim() || !draft.modelId}><Save size={16} />{saving ? "保存中" : "保存智能体"}</button></div>
    </header>
    <div className="agent-workbench-body">
      <form id="agent-config" className="agent-config" onSubmit={save}>
        <section><h3>基本信息</h3><div className="agent-identity-preview"><span style={{ background: draft.color }}>{draft.avatar}</span><div><strong>{draft.name || "未命名智能体"}</strong><small>{draft.group || "未分组"}</small></div></div>
          <label>名称<input maxLength={40} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：详情页策划助手" /></label>
          <label>描述<textarea maxLength={220} rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="告诉使用者它擅长什么、该怎么用" /></label>
          <div className="agent-group-field">
            <label htmlFor="agent-group">分组</label>
            <div className="agent-group-combobox" onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setGroupOptionsOpen(false);
            }}>
              <input
                id="agent-group"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={groupOptionsOpen}
                aria-controls="agent-group-options"
                autoComplete="off"
                maxLength={24}
                value={draft.group}
                onFocus={() => { setGroupQuery(""); setGroupOptionsOpen(true); }}
                onChange={(event) => { setDraft({ ...draft, group: event.target.value }); setGroupQuery(event.target.value); setGroupOptionsOpen(true); }}
                placeholder="搜索现有分组或输入新分组"
              />
              <button type="button" className="agent-group-toggle" aria-label="展开分组选项" onClick={() => { setGroupQuery(""); setGroupOptionsOpen((open) => !open); }}><ChevronDown size={16} /></button>
              {groupOptionsOpen ? (
                <div className="agent-group-options" id="agent-group-options" role="listbox">
                  {filteredGroupOptions.map((group) => (
                    <button type="button" role="option" aria-selected={draft.group === group} key={group} onClick={() => { setDraft({ ...draft, group }); setGroupOptionsOpen(false); }}>{group}</button>
                  ))}
                  {groupQuery.trim() && !hasExactGroup ? <button type="button" className="create-group-option" onClick={() => setGroupOptionsOpen(false)}><Plus size={14} />使用新分组“{draft.group.trim()}”</button> : null}
                  {!filteredGroupOptions.length && (!groupQuery.trim() || hasExactGroup) ? <span>暂无匹配的分组</span> : null}
                </div>
              ) : null}
            </div>
            <small>可选择已有分组，也可直接输入新分组</small>
          </div>
          <label>固定模型<select value={draft.modelId} onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}><option value="">请选择聊天模型</option>{chatModels.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.model}</option>)}</select><small>保存后，使用者无法更改此智能体的模型</small></label>
        </section>
        <section><h3>外观</h3><div className="appearance-options"><div>{emojis.map((emoji) => <button type="button" key={emoji} className={draft.avatar === emoji ? "active" : ""} onClick={() => setDraft({ ...draft, avatar: emoji })}>{emoji}</button>)}</div><div>{colors.map((color) => <button type="button" aria-label={color} key={color} className={draft.color === color ? "active" : ""} style={{ background: color }} onClick={() => setDraft({ ...draft, color })} />)}</div></div></section>
        <section><h3>指令</h3><label>系统提示词<textarea rows={10} maxLength={6000} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} placeholder="定义角色、工作流程、边界和输出格式。右侧可随时调试。" /><small>{draft.prompt.length} / 6000</small></label></section>
        <fieldset className="agent-tool-settings"><legend>可用能力</legend><label><input type="checkbox" checked={draft.allowFileUpload} onChange={(e) => setDraft({ ...draft, allowFileUpload: e.target.checked, allowImageInput: e.target.checked ? draft.allowImageInput : false })} /><span><Paperclip size={16} />文件上传</span></label><label><input type="checkbox" checked={draft.allowImageInput} disabled={!draft.allowFileUpload} onChange={(e) => setDraft({ ...draft, allowImageInput: e.target.checked })} /><span><Image size={16} />图片理解</span></label><label><input type="checkbox" checked={draft.allowWebSearch} onChange={(e) => setDraft({ ...draft, allowWebSearch: e.target.checked })} /><span><Globe2 size={16} />联网搜索</span></label></fieldset>
        {error ? <div className="error">{error}</div> : null}
      </form>
      <section className="agent-debug"><header><div><strong>预览与调试</strong><small>{chatModels.find((model) => model.id === draft.modelId)?.name || "尚未选择模型"}</small></div><button className="secondary" onClick={() => setDebugMessages([])}>清空</button></header><div className="debug-messages">{debugMessages.length ? debugMessages.map((message, index) => <div key={index} className={`debug-message ${message.role}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>) : <div className="debug-empty"><span style={{ background: draft.color }}>{draft.avatar}</span><h3>{draft.name || "你的智能体"}</h3><p>{draft.description || "在左侧填写描述，然后发一条消息测试提示词和模型效果。"}</p></div>}{debugging ? <div className="typing">正在生成测试回答…</div> : null}</div><form className="debug-composer" onSubmit={debug}><textarea rows={2} value={debugInput} onChange={(e) => setDebugInput(e.target.value)} placeholder="输入一条测试消息" /><button className="primary send" disabled={!debugInput.trim() || !draft.modelId || debugging}><Send size={17} /></button></form></section>
    </div>
  </section>;
}

function AccountPage({ user, onOpenSidebar }: { user: User; onOpenSidebar: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState("");

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    if (newPassword !== confirmPassword) {
      setNotice("两次输入的新密码不一致");
      return;
    }
    try {
      await api("/api/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword })
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice("密码已更新");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "密码修改失败");
    }
  }

  return (
    <section className="account-page">
      <header className="admin-header">
        <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
        <div>
          <h2>账号设置</h2>
          <p>{user.username} · {user.role === "admin" ? "管理员" : "员工账号"}</p>
        </div>
      </header>
      <div className="account-body">
        <form className="account-panel" onSubmit={changePassword}>
          <div className="account-panel-title"><LockKeyhole size={18} /><h3>修改密码</h3></div>
          <label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          <label>新密码<input type="password" autoComplete="new-password" placeholder="至少 8 个字符" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label>确认新密码<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
          {notice ? <div className="notice">{notice}</div> : null}
          <button className="primary" type="submit" disabled={!currentPassword || newPassword.length < 8 || !confirmPassword}>更新密码</button>
        </form>
      </div>
    </section>
  );
}

function MemoriesPage({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [limits, setLimits] = useState<MemoryLimits>({
    maxItems: 10,
    maxCharsPerItem: 200,
    maxTotalChars: 2000,
    usedItems: 0,
    usedChars: 0
  });
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");

  async function load() {
    setLoading(true);
    try {
      const result = await api<{ memories: MemoryItem[]; limits: MemoryLimits }>("/api/memories");
      setMemories(result.memories);
      setLimits(result.limits);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function addMemory(event: FormEvent) {
    event.preventDefault();
    if (!content.trim()) return;
    try {
      await api("/api/memories", {
        method: "POST",
        body: JSON.stringify({ content: content.trim() })
      });
      setContent("");
      setNotice("记忆已添加");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "添加失败");
    }
  }

  async function saveMemory(memory: MemoryItem) {
    const value = editing[memory.id]?.trim();
    if (!value) return;
    try {
      await api(`/api/memories/${encodeURIComponent(memory.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ content: value })
      });
      setEditing(({ [memory.id]: _removed, ...rest }) => rest);
      setNotice("记忆已更新");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "更新失败");
    }
  }

  async function deleteMemory(memory: MemoryItem) {
    if (!confirm("确认删除这条个人记忆？")) return;
    try {
      await api(`/api/memories/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
      setNotice("记忆已删除");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <section className="memory-page">
      <header className="admin-header">
        <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}>
          <Menu size={20} />
        </button>
        <div>
          <h2>我的记忆</h2>
          <p>{limits.usedItems}/{limits.maxItems} 条 · {limits.usedChars}/{limits.maxTotalChars} 字</p>
        </div>
        <button className="secondary" onClick={load}>
          <Brain size={16} />
          刷新
        </button>
      </header>
      {notice ? <div className="notice">{notice}</div> : null}
      <form className="memory-create" onSubmit={addMemory}>
        <textarea
          value={content}
          maxLength={limits.maxCharsPerItem}
          rows={3}
          placeholder="添加一条希望 AI 长期记住的内容"
          onChange={(event) => setContent(event.target.value)}
        />
        <div className="memory-create-actions">
          <small>{content.length}/{limits.maxCharsPerItem}</small>
          <button className="primary" type="submit" disabled={!content.trim() || limits.usedItems >= limits.maxItems}>
            <Plus size={16} />
            添加
          </button>
        </div>
      </form>
      {loading ? (
        <div className="empty-state compact">加载中...</div>
      ) : memories.length ? (
        <div className="memory-list">
          {memories.map((memory) => (
            <article className="memory-card" key={memory.id}>
              {editing[memory.id] !== undefined ? (
                <textarea
                  value={editing[memory.id]}
                  maxLength={limits.maxCharsPerItem}
                  rows={3}
                  onChange={(event) => setEditing({ ...editing, [memory.id]: event.target.value })}
                />
              ) : (
                <pre>{memory.text}</pre>
              )}
              <div className="memory-meta">
                <small>{memory.updatedAt ? dateTime(memory.updatedAt) : memory.createdAt ? dateTime(memory.createdAt) : ""}</small>
                {editing[memory.id] !== undefined ? <small>{editing[memory.id].length}/{limits.maxCharsPerItem}</small> : null}
              </div>
              <div className="memory-card-actions">
                {editing[memory.id] !== undefined ? (
                  <button className="secondary" onClick={() => saveMemory(memory)}>
                    <Save size={15} />
                    保存
                  </button>
                ) : (
                  <button className="secondary" onClick={() => setEditing({ ...editing, [memory.id]: memory.text })}>
                    <Edit3 size={15} />
                    编辑
                  </button>
                )}
                <button className="danger" onClick={() => deleteMemory(memory)}>
                  <Trash2 size={15} />
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state compact">
          <Brain size={36} />
          <h2>暂无个人记忆</h2>
        </div>
      )}
    </section>
  );
}

function currencyText(value: number) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 }).format(value);
}

function comparisonText(value: number, baseline: number) {
  if (!baseline) return "暂无 30 天基准";
  const percent = (value - baseline) / baseline * 100;
  return `${percent >= 0 ? "高于" : "低于"}近 30 天日均 ${Math.abs(percent).toFixed(1)}%`;
}

function ManagementDashboardPage({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [date, setDate] = useState(dateDaysAgo(1));
  const [facts, setFacts] = useState<ManagementDashboardFacts | null>(null);
  const [definitions, setDefinitions] = useState<ManagementBriefDefinition[]>([]);
  const [reports, setReports] = useState<ManagementBriefReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState("");
  const [notice, setNotice] = useState("");

  async function load(targetDate = date) {
    setLoading(true);
    setNotice("");
    try {
      const result = await api<{
        reportDate: string;
        facts: ManagementDashboardFacts;
        definitions: ManagementBriefDefinition[];
        reports: ManagementBriefReport[];
      }>(`/api/admin/management-dashboard?date=${encodeURIComponent(targetDate)}`);
      setDate(result.reportDate);
      setFacts(result.facts);
      setDefinitions(result.definitions);
      setReports(result.reports);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "驾驶舱加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  async function generate(definition: ManagementBriefDefinition) {
    setGenerating(definition.id);
    setNotice(`正在生成“${definition.name}”，AI 会先阅读所选经营数据...`);
    try {
      const result = await api<{ report: ManagementBriefReport }>("/api/admin/management-dashboard/generate", {
        method: "POST",
        body: JSON.stringify({ reportDate: date, definitionId: definition.id })
      });
      setReports((current) => [result.report, ...current.filter((item) => item.id !== result.report.id)]);
      setNotice(`“${definition.name}”已生成。`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "简报生成失败");
    } finally {
      setGenerating("");
    }
  }

  const currentReports = new Map(
    reports.filter((item) => item.reportDate === date).map((item) => [item.definitionId, item])
  );
  const historicalReports = reports.filter((item) => item.reportDate !== date).slice(0, 12);
  const maxTrendGmv = Math.max(1, ...(facts?.dailyTrend.map((item) => item.gmv) ?? []));

  return (
    <section className="admin-page dashboard-page">
      <header className="admin-header dashboard-header">
        <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
        <div>
          <h2>经营驾驶舱</h2>
          <p>从经营数据出发，给管理层结论、证据和下一步动作。</p>
        </div>
        <div className="dashboard-date-control">
          <label>经营日期<input type="date" max={dateDaysAgo(1)} value={date} onChange={(event) => { setDate(event.target.value); load(event.target.value).catch(() => undefined); }} /></label>
          <button className="secondary" disabled={loading} onClick={() => load()}><RotateCcw size={15} />刷新</button>
        </div>
      </header>
      <div className="admin-body dashboard-body">
        {notice ? <div className="import-notice">{notice}</div> : null}
        {loading && !facts ? <div className="secure-loading">正在汇总经营数据...</div> : facts ? (
          <>
            <section className="dashboard-kpis">
              <article><small>GMV</small><strong>{currencyText(facts.summary.gmv)}</strong><span>{comparisonText(facts.summary.gmv, facts.summary.thirtyDayDailyAverageGmv)}</span></article>
              <article><small>出库订单</small><strong>{numberText(facts.summary.orders)}</strong><span>{comparisonText(facts.summary.orders, facts.summary.thirtyDayDailyAverageOrders)}</span></article>
              <article><small>销售件数</small><strong>{numberText(facts.summary.units)}</strong><span>实付 {currencyText(facts.summary.actualPayment)}</span></article>
              <article><small>客单价</small><strong>{currencyText(facts.summary.averageOrderValue)}</strong><span>GMV ÷ 出库订单数</span></article>
              <article><small>当前库存</small><strong>{numberText(facts.summary.inventoryUnits)}</strong><span>{numberText(facts.summary.inventorySkus)} 个 SKU · 锁定 {numberText(facts.summary.lockedInventoryUnits)}</span></article>
              <article><small>采购入库</small><strong>{numberText(facts.summary.inboundUnits)}</strong><span>{numberText(facts.summary.inboundOrders)} 张入库单</span></article>
            </section>

            <section className="dashboard-grid">
              <article className="dashboard-panel trend-panel">
                <div className="records-heading"><h3>近 30 天 GMV 趋势</h3><span>{facts.dailyTrend.length} 天有数据</span></div>
                <div className="dashboard-trend-bars">
                  {facts.dailyTrend.map((item) => (
                    <div key={item.date} title={`${item.date} · ${currencyText(item.gmv)}`}>
                      <i style={{ height: `${Math.max(3, item.gmv / maxTrendGmv * 100)}%` }} />
                      <small>{item.date.slice(5)}</small>
                    </div>
                  ))}
                </div>
              </article>
              <article className="dashboard-panel">
                <div className="records-heading"><h3>店铺表现</h3><span>按 GMV 排序</span></div>
                <div className="dashboard-ranking">
                  {facts.shops.slice(0, 8).map((shop, index) => (
                    <div key={`${shop.name}-${shop.source}`}><b>{index + 1}</b><span><strong>{shop.name}</strong><small>{shop.source || "未知平台"} · {numberText(shop.orders)} 单 · {numberText(shop.units)} 件</small></span><em>{currencyText(shop.gmv)}</em></div>
                  ))}
                </div>
              </article>
              <article className="dashboard-panel">
                <div className="records-heading"><h3>商品销售排行</h3><span>前 8 项</span></div>
                <div className="dashboard-ranking product-ranking">
                  {facts.products.slice(0, 8).map((product, index) => (
                    <div key={`${product.skuCode}-${product.name}`}><b>{index + 1}</b><span><strong>{product.name}</strong><small>{product.skuCode} · {numberText(product.units)} 件</small></span><em>{currencyText(product.gmv)}</em></div>
                  ))}
                </div>
              </article>
              <article className="dashboard-panel">
                <div className="records-heading"><h3>库存量较高商品</h3><span>前 8 项</span></div>
                <div className="dashboard-ranking product-ranking">
                  {facts.inventory.slice(0, 8).map((product, index) => (
                    <div key={`${product.skuCode}-${product.name}`}><b>{index + 1}</b><span><strong>{product.name}</strong><small>{product.skuCode} · 锁定 {numberText(product.lockedUnits)} · 在途 {numberText(product.inTransitUnits)}</small></span><em>{numberText(product.units)}</em></div>
                  ))}
                </div>
              </article>
            </section>

            <section className="dashboard-brief-section">
              <div className="dashboard-section-title">
                <div><h3>AI 管理简报</h3><p>每份简报只使用它在后台选定的数据维度和提示词。</p></div>
                <span>{date}</span>
              </div>
              <div className="dashboard-brief-list">
                {definitions.map((definition) => {
                  const report = currentReports.get(definition.id);
                  return (
                    <article className="dashboard-brief-card" key={definition.id}>
                      <header><div><h4>{definition.name}</h4><p>{definition.description}</p></div><button className="primary" disabled={Boolean(generating)} onClick={() => generate(definition)}><Brain size={15} />{generating === definition.id ? "生成中..." : report ? "重新生成" : "生成简报"}</button></header>
                      {report ? <><div className="dashboard-report-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{report.content}</ReactMarkdown></div><small>生成于 {dateTime(report.updatedAt)}</small></> : <div className="dashboard-empty-brief">这一天还没有生成这份简报。</div>}
                    </article>
                  );
                })}
              </div>
            </section>

            {historicalReports.length ? (
              <section className="dashboard-panel dashboard-history">
                <div className="records-heading"><h3>最近生成记录</h3><span>{historicalReports.length} 条</span></div>
                {historicalReports.map((report) => <button key={report.id} onClick={() => { setDate(report.reportDate); load(report.reportDate).catch(() => undefined); }}><span><strong>{report.definitionName}</strong><small>{dateTime(report.updatedAt)}</small></span><b>{report.reportDate}</b><ChevronRight size={15} /></button>)}
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function AdminPanel({ refreshModels, onOpenSidebar }: { refreshModels: () => Promise<void>; onOpenSidebar: () => void }) {
  const [tab, setTab] = useState<"settings" | "users" | "tokens" | "aiQuery" | "data" | "secure">("settings");
  const [users, setUsers] = useState<User[]>([]);
  const [tokens, setTokens] = useState<IntegrationToken[]>([]);
  const [settings, setSettings] = useState<SystemSettings>({ safetyRules: "" });
  const [notice, setNotice] = useState("");

  async function load() {
    const [settingsResult, userResult, tokenResult] = await Promise.all([
      api<{ settings: SystemSettings }>("/api/admin/settings"),
      api<{ users: User[] }>("/api/admin/users"),
      api<{ tokens: IntegrationToken[] }>("/api/admin/integration-tokens")
    ]);
    setSettings(settingsResult.settings);
    setUsers(userResult.users);
    setTokens(tokenResult.tokens);
  }

  useEffect(() => {
    load().catch((err) => setNotice(err.message));
  }, []);

  return (
      <section className="admin-page">
        <header className="admin-header">
          <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}>
            <Menu size={20} />
          </button>
          <div>
            <h2>管理后台</h2>
            <p>规则、员工账号与企业机器人接入</p>
          </div>
        </header>
        <nav className="tabs">
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Shield size={16} />规则</button>
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}><Users size={16} />账号</button>
          <button className={tab === "tokens" ? "active" : ""} onClick={() => setTab("tokens")}><KeyRound size={16} />外接机器人设置</button>
          <button className={tab === "aiQuery" ? "active" : ""} onClick={() => setTab("aiQuery")}><BarChart3 size={16} />AI问数测试</button>
          <button className={tab === "data" ? "active" : ""} onClick={() => setTab("data")}><FileSpreadsheet size={16} />数据接入</button>
          <button className={`secure-tab ${tab === "secure" ? "active" : ""}`} onClick={() => setTab("secure")}><Lock size={16} />模型充值后台</button>
        </nav>
        {notice ? <div className="notice">{notice}</div> : null}
        <div className="admin-body">
          {tab === "settings" ? <SettingsTab settings={settings} setNotice={setNotice} reload={load} /> : null}
          {tab === "users" ? <UsersTab users={users} reload={load} /> : null}
          {tab === "tokens" ? <TokensTab tokens={tokens} reload={load} setNotice={setNotice} /> : null}
          {tab === "aiQuery" ? <AiQueryTestTab /> : null}
          {tab === "data" ? <DataPlatformTab /> : null}
          {tab === "secure" ? <SecureAdminTab users={users} refreshModels={refreshModels} /> : null}
        </div>
      </section>
  );
}

function AiQueryTestTab() {
  const [mode, setMode] = useState<"debug" | "ai">("debug");
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState("");
  const [status, setStatus] = useState<HupunSkillStatus | null>(null);
  const [interfaces, setInterfaces] = useState<HupunApiDescriptor[]>([]);
  const [debugPath, setDebugPath] = useState("");
  const [debugParams, setDebugParams] = useState('{\n  "page": 1,\n  "limit": 20\n}');
  const [debugResult, setDebugResult] = useState<HupunDebugExecution | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isComposing, setIsComposing] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ models: Model[]; defaultModelId: string }>("/api/models"),
      api<{ status: HupunSkillStatus }>("/api/admin/ai-query/status"),
      api<{ interfaces: HupunApiDescriptor[] }>("/api/admin/ai-query/interfaces")
    ]).then(([modelResult, statusResult, interfaceResult]) => {
      const chatModels = modelResult.models.filter((model) => model.kind === "chat");
      setModels(chatModels);
      setModelId(
        chatModels.find((model) => model.id === modelResult.defaultModelId)?.id
          || chatModels[0]?.id
          || ""
      );
      setStatus(statusResult.status);
      setInterfaces(interfaceResult.interfaces);
      setDebugPath(
        interfaceResult.interfaces.find((item) => item.path === "/erp/base/shop/page/get")?.path
          || interfaceResult.interfaces[0]?.path
          || ""
      );
    }).catch((err) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  const selectedInterface = interfaces.find((item) => item.path === debugPath);

  async function executeDebug(event: FormEvent) {
    event.preventDefault();
    setError("");
    let params: Record<string, unknown>;
    try {
      const parsed = JSON.parse(debugParams);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      params = parsed;
    } catch {
      setError("请求参数必须是合法的 JSON 对象");
      return;
    }
    if (!debugPath) {
      setError("请选择接口");
      return;
    }
    setDebugLoading(true);
    setDebugResult(null);
    try {
      const result = await api<{ execution: HupunDebugExecution }>("/api/admin/ai-query/debug", {
        method: "POST",
        body: JSON.stringify({ path: debugPath, params })
      });
      setDebugResult(result.execution);
    } catch (err) {
      setError(err instanceof Error ? err.message : "接口调用失败");
    } finally {
      setDebugLoading(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = content.trim();
    if (!text || !modelId || loading) return;
    const userMessage: Message = {
      role: "user",
      content: text,
      modelId,
      createdAt: new Date().toISOString()
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setContent("");
    setLoading(true);
    setError("");
    try {
      const result = await api<{ message: Message; skill: { status: HupunSkillStatus } }>("/api/admin/ai-query/chat", {
        method: "POST",
        body: JSON.stringify({
          modelId,
          messages: nextMessages.map((message) => ({ role: message.role, content: message.content }))
        })
      });
      setMessages((items) => [...items, result.message]);
      setStatus(result.skill.status);
    } catch (err) {
      setMessages((items) => items.filter((message) => message !== userMessage));
      setContent(text);
      setError(err instanceof Error ? err.message : "问数失败");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !isComposing && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="ai-query-test">
      <div className="ai-query-toolbar">
        <div>
          <h3>万里牛数据调试</h3>
          <p>{mode === "debug" ? "直接调用官方只读 API，不经过大模型，不消耗模型 Token。" : "保留原 AI 问数链路，用于后续指标语义层联调。"}</p>
        </div>
        <div className="ai-query-controls">
          <span className={`skill-status ${status?.ready ? "ready" : "blocked"}`}>
            {status?.ready ? "万里牛 Skill 已就绪" : status ? "万里牛 Skill 待配置" : "正在检查 Skill"}
          </span>
          {mode === "ai" ? (
            <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={loading}>
              {models.length ? null : <option value="">暂无可用聊天模型</option>}
              {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.model}</option>)}
            </select>
          ) : null}
          {mode === "ai" && messages.length ? <button className="secondary" onClick={() => { setMessages([]); setError(""); }}>新测试</button> : null}
        </div>
      </div>
      <nav className="ai-query-mode-tabs">
        <button className={mode === "debug" ? "active" : ""} onClick={() => { setMode("debug"); setError(""); }}>
          接口调试 · 0 Token
        </button>
        <button className={mode === "ai" ? "active" : ""} onClick={() => { setMode("ai"); setError(""); }}>
          AI问数
        </button>
      </nav>
      {status && !status.ready ? (
        <div className="ai-query-config-note">
          {status.missingEnvVars.length ? `缺少环境变量：${status.missingEnvVars.join("、")}。` : null}
          {!status.cliAvailable ? ` 未找到 CLI：${status.cliPath}。` : null}
        </div>
      ) : null}
      {mode === "debug" ? (
        <div className="api-debugger">
          <form className="api-debug-form" onSubmit={executeDebug}>
            <label>
              官方只读接口
              <select value={debugPath} onChange={(event) => { setDebugPath(event.target.value); setDebugResult(null); }}>
                {interfaces.length ? null : <option value="">正在加载接口列表...</option>}
                {interfaces.map((item) => <option key={item.path} value={item.path}>{item.name} · {item.path}</option>)}
              </select>
            </label>
            <label>
              接口路径
              <input value={debugPath} readOnly />
            </label>
            {selectedInterface ? (
              <a className="api-doc-link" href={selectedInterface.docUrl} target="_blank" rel="noreferrer">
                查看万里牛官方接口文档
              </a>
            ) : null}
            <label className="api-params-field">
              请求参数（JSON）
              <textarea value={debugParams} onChange={(event) => setDebugParams(event.target.value)} rows={12} spellCheck={false} />
            </label>
            {error ? <div className="chat-error"><span>{error}</span></div> : null}
            <button className="primary" type="submit" disabled={!status?.ready || !debugPath || debugLoading}>
              <Send size={16} />{debugLoading ? "正在调用..." : "调用接口"}
            </button>
          </form>
          <section className="api-debug-result">
            <div className="api-debug-result-head">
              <div>
                <h4>原始响应</h4>
                <p>错误码和返回字段保持万里牛原始内容，不经过 AI 解释。</p>
              </div>
              {debugResult ? <span>{debugResult.durationMs} ms</span> : null}
            </div>
            {debugResult ? (
              <pre>{JSON.stringify(debugResult, null, 2)}</pre>
            ) : (
              <div className="empty-state compact">
                <FileSpreadsheet size={38} />
                <h2>选择接口并填写参数</h2>
                <p>调用结果会原样显示在这里。</p>
              </div>
            )}
          </section>
        </div>
      ) : (
        <>
          <div className="ai-query-messages">
            {messages.length ? messages.map((message, index) => (
              <article className={`message ${message.role}`} key={`${message.createdAt}-${index}`}>
                {message.role === "assistant" ? <div className="avatar"><img src="/brand/xiaoxiang-mark.png" alt="小象 AI" /></div> : null}
                <div className="bubble">
                  {message.role === "assistant" ? (
                    <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
                  ) : <pre>{message.content}</pre>}
                  <small className="message-time">{dateTime(message.createdAt)}</small>
                </div>
              </article>
            )) : (
              <div className="empty-state compact">
                <BarChart3 size={38} />
                <h2>AI问数链路暂时保留</h2>
                <p>等接口和指标口径验证后，再用它测试完整问数效果。</p>
              </div>
            )}
            {loading ? <div className="typing">正在规划只读接口、查询万里牛并整理结果...</div> : null}
          </div>
          <form className="ai-query-composer" onSubmit={send}>
            {error ? <div className="chat-error"><span>{error}</span></div> : null}
            <div className="composer-row">
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                onCompositionStart={() => setIsComposing(true)}
                onCompositionEnd={() => setIsComposing(false)}
                onKeyDown={handleKeyDown}
                placeholder="输入经营数据问题，Enter 发送，Shift+Enter 换行"
                rows={2}
              />
              <button className="primary send" type="submit" disabled={!content.trim() || !modelId || loading}><Send size={18} /></button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function SecureAdminTab({ users, refreshModels }: { users: User[]; refreshModels: () => Promise<void> }) {
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [subtab, setSubtab] = useState<"models" | "records">("models");
  const [models, setModels] = useState<Model[]>([]);
  const [records, setRecords] = useState<(Conversation & { user: User })[]>([]);

  async function loadProtected() {
    const [modelResult, recordResult] = await Promise.all([
      api<{ models: Model[] }>("/api/admin/models"),
      api<{ conversations: (Conversation & { user: User })[] }>("/api/admin/conversations")
    ]);
    setModels(modelResult.models);
    setRecords(recordResult.conversations);
  }

  useEffect(() => {
    api("/api/admin/tools/lock", { method: "POST" })
      .catch(() => undefined)
      .then(() => setUnlocked(false))
      .finally(() => setChecking(false));
  }, []);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/admin/tools/unlock", { method: "POST", body: JSON.stringify({ password }) });
      setUnlocked(true);
      setPassword("");
      await loadProtected();
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证失败");
    }
  }

  if (checking) return <div className="secure-loading">正在检查访问权限...</div>;
  if (!unlocked) {
    return (
      <form className="secure-gate" onSubmit={unlock}>
        <div className="secure-gate-icon"><LockKeyhole size={24} /></div>
        <h3>模型充值后台</h3>
        <p>用于配置模型服务和充值所需的 API Key。</p>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="输入后台访问密码"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? <div className="error">{error}</div> : null}
        <button className="primary" disabled={!password}>验证并进入</button>
      </form>
    );
  }

  return (
    <div className="secure-admin">
      <nav className="subtabs">
        <button className={subtab === "models" ? "active" : ""} onClick={() => setSubtab("models")}><Bot size={16} />模型配置</button>
        <button className={subtab === "records" ? "active" : ""} onClick={() => setSubtab("records")}><BarChart3 size={16} />记录与用量</button>
      </nav>
      {subtab === "models" ? (
        <ModelsTab models={models} reload={async () => { await loadProtected(); await refreshModels(); }} />
      ) : <RecordsTab records={records} users={users} />}
    </div>
  );
}

function SettingsTab({
  settings,
  reload,
  setNotice
}: {
  settings: SystemSettings;
  reload: () => Promise<void>;
  setNotice: (notice: string) => void;
}) {
  const [safetyRules, setSafetyRules] = useState(settings.safetyRules);

  useEffect(() => {
    setSafetyRules(settings.safetyRules);
  }, [settings.safetyRules]);

  async function save(event: FormEvent) {
    event.preventDefault();
    await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ safetyRules })
    });
    setNotice("系统内置安全规则已保存");
    await reload();
  }

  return (
    <form className="settings-panel" onSubmit={save}>
      <label className="field-label">
        系统内置安全规则
        <textarea
          value={safetyRules}
          onChange={(event) => setSafetyRules(event.target.value)}
          rows={8}
          placeholder="这段内容会作为最高优先级系统提示词，自动加到每次模型调用前。"
        />
      </label>
      <button className="primary settings-save" type="submit"><Save size={16} />保存规则</button>
    </form>
  );
}

function UsersTab({ users, reload }: { users: User[]; reload: () => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [editing, setEditing] = useState<Record<string, { username: string; role: Role; enabled: boolean; password: string }>>({});
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPassword, setImportPassword] = useState("");
  const [importNotice, setImportNotice] = useState("");
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState("");

  async function createUser(event: FormEvent) {
    event.preventDefault();
    if (password.length < 8) {
      setCreateNotice("初始密码至少需要 8 个字符");
      return;
    }
    setCreating(true);
    setCreateNotice("");
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username, password, role: "user" }) });
      setUsername("");
      setPassword("");
      setCreateNotice("账号已开通");
      await reload();
    } catch (err) {
      setCreateNotice(err instanceof Error ? err.message : "账号开通失败");
    } finally {
      setCreating(false);
    }
  }

  async function toggle(user: User) {
    await api(`/api/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !user.enabled }) });
    await reload();
  }

  async function saveUser(user: User) {
    const draft = editing[user.id];
    if (!draft) return;
    await api(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        username: draft.username,
        role: draft.role,
        enabled: draft.enabled,
        password: draft.password
      })
    });
    setEditing(({ [user.id]: _removed, ...rest }) => rest);
    await reload();
  }

  async function deleteUser(user: User) {
    if (!confirm(`确认删除账号 ${user.username}？该账号的聊天记录也会删除。`)) return;
    await api(`/api/admin/users/${user.id}`, { method: "DELETE" });
    await reload();
  }

  async function importUsers(event: FormEvent) {
    event.preventDefault();
    if (!importFile) return;
    if (importPassword.length < 8) {
      setImportNotice("统一初始密码至少需要 8 个字符");
      return;
    }
    setImporting(true);
    setImportNotice("");
    const body = new FormData();
    body.append("file", importFile);
    body.append("password", importPassword);
    try {
      const result = await api<{
        createdCount: number;
        skippedCount: number;
        skipped: Array<{ row: number; username: string; reason: string }>;
      }>("/api/admin/users/import", { method: "POST", body });
      const skippedDetail = result.skipped.slice(0, 5).map((item) => `第 ${item.row} 行 ${item.username}：${item.reason}`).join("；");
      setImportNotice(`已创建 ${result.createdCount} 个账号，跳过 ${result.skippedCount} 个${skippedDetail ? `。${skippedDetail}` : ""}`);
      setImportFile(null);
      setImportPassword("");
      await reload();
    } catch (err) {
      setImportNotice(err instanceof Error ? err.message : "批量导入失败");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="admin-grid">
      <div className="admin-form-stack">
        <form className="admin-form" onSubmit={createUser}>
          <h3><UserPlus size={17} />开通账号</h3>
          <input placeholder="用户名" value={username} onChange={(event) => setUsername(event.target.value)} />
          <input type="password" autoComplete="new-password" placeholder="初始密码（至少 8 位）" value={password} onChange={(event) => setPassword(event.target.value)} />
          {createNotice ? <div className={createNotice === "账号已开通" ? "notice import-notice" : "error import-notice"}>{createNotice}</div> : null}
          <button className="primary" type="submit" disabled={!username.trim() || !password || creating}>
            <Plus size={16} />{creating ? "正在创建" : "创建"}
          </button>
        </form>
        <form className="admin-form import-form" onSubmit={importUsers}>
          <h3><FileSpreadsheet size={17} />批量开通</h3>
          <p className="hint no-margin">支持 CSV、XLS、XLSX。账号放在第一列，统一密码在这里填写。</p>
          <a className="template-download" href="/api/admin/users/import-template">
            <Download size={15} />
            下载 CSV 模板
          </a>
          <label className="file-picker">
            <Upload size={16} />
            <span>{importFile?.name || "选择账号文件"}</span>
            <input type="file" accept=".csv,.xls,.xlsx" onChange={(event) => setImportFile(event.target.files?.[0] || null)} />
          </label>
          <input type="password" autoComplete="new-password" placeholder="统一初始密码（至少 8 位）" value={importPassword} onChange={(event) => setImportPassword(event.target.value)} />
          {importNotice ? <div className="notice import-notice">{importNotice}</div> : null}
          <button className="primary" disabled={!importFile || !importPassword || importing}>
            <Upload size={16} />
            {importing ? "正在导入" : "开始导入"}
          </button>
        </form>
      </div>
      <div className="table">
        {users.map((user) => (
          <div className="table-row editable-row" key={user.id}>
            {editing[user.id] ? (
              <>
                <label className="field-label">用户名<input value={editing[user.id].username} onChange={(event) => setEditing({ ...editing, [user.id]: { ...editing[user.id], username: event.target.value } })} /></label>
                <label className="field-label">角色<select value={editing[user.id].role} onChange={(event) => setEditing({ ...editing, [user.id]: { ...editing[user.id], role: event.target.value as Role } })}>
                    <option value="user">普通用户</option>
                    <option value="admin">管理员</option>
                  </select></label>
                <label className="field-label">新密码<input type="password" autoComplete="new-password" placeholder="留空不改，至少 8 位" value={editing[user.id].password} onChange={(event) => setEditing({ ...editing, [user.id]: { ...editing[user.id], password: event.target.value } })} /></label>
                <label className="inline-check"><input type="checkbox" checked={editing[user.id].enabled} onChange={(event) => setEditing({ ...editing, [user.id]: { ...editing[user.id], enabled: event.target.checked } })} />启用</label>
                <button className="secondary" onClick={() => saveUser(user)}><Save size={15} />保存</button>
              </>
            ) : (
              <>
                <span>{user.username}<small>{user.enabled ? "启用" : "停用"}</small></span>
                <span>{user.role === "admin" ? "管理员" : "普通用户"}</span>
                <button className="secondary" onClick={() => setEditing({ ...editing, [user.id]: { username: user.username, role: user.role, enabled: user.enabled, password: "" } })}><Edit3 size={15} />编辑</button>
                <button className="secondary" onClick={() => toggle(user)}>{user.enabled ? "停用" : "启用"}</button>
                <button className="danger" onClick={() => deleteUser(user)}><Trash2 size={15} />删除</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelsTab({ models, reload }: { models: Model[]; reload: () => Promise<void> }) {
  const [form, setForm] = useState({
    name: "",
    kind: "chat" as "chat" | "image",
    protocol: "openai" as "openai" | "anthropic",
    baseUrl: "https://app.yylx.io/v1",
    apiKey: "",
    model: "",
    systemPrompt: "",
    enabled: true,
    isDefault: false
  });
  const [editing, setEditing] = useState<Record<string, { name: string; kind: "chat" | "image"; protocol: "openai" | "anthropic"; baseUrl: string; model: string; apiKey: string; systemPrompt: string; enabled: boolean; isDefault: boolean }>>({});

  async function createModel(event: FormEvent) {
    event.preventDefault();
    await api("/api/admin/models", { method: "POST", body: JSON.stringify(form) });
    setForm({ name: "", kind: "chat", protocol: "openai", baseUrl: "https://app.yylx.io/v1", apiKey: "", model: "", systemPrompt: "", enabled: true, isDefault: false });
    await reload();
  }

  async function toggle(model: Model) {
    await api(`/api/admin/models/${model.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !model.enabled }) });
    await reload();
  }

  async function saveModel(model: Model) {
    const draft = editing[model.id];
    if (!draft) return;
    await api(`/api/admin/models/${model.id}`, {
      method: "PATCH",
      body: JSON.stringify(draft)
    });
    setEditing(({ [model.id]: _removed, ...rest }) => rest);
    await reload();
  }

  async function deleteModel(model: Model) {
    if (!confirm(`确认删除模型 ${model.name}？`)) return;
    await api(`/api/admin/models/${model.id}`, { method: "DELETE" });
    await reload();
  }

  return (
    <div className="admin-grid wide">
      <form className="admin-form" onSubmit={createModel}>
        <h3><img className="section-mark" src="/brand/xiaoxiang-mark.png" alt="" />接入模型</h3>
        <input placeholder="展示名称，如 通义千问" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as "chat" | "image", protocol: event.target.value === "image" ? "openai" : form.protocol })}>
          <option value="chat">聊天模型</option>
          <option value="image">图片模型</option>
        </select>
        {form.kind === "chat" ? (
          <select value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value as "openai" | "anthropic" })}>
            <option value="openai">OpenAI 兼容协议</option>
            <option value="anthropic">Claude / Anthropic 协议</option>
          </select>
        ) : null}
        <input placeholder="Base URL，如 https://dashscope.aliyuncs.com/compatible-mode/v1" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        <input type="password" autoComplete="new-password" placeholder="API Key" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
        <input placeholder="模型 ID，如 qwen-plus / gpt-image-2" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} />
        <textarea placeholder="模型默认 System Prompt，可留空" value={form.systemPrompt} rows={4} onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })} />
        <label className="check"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />启用</label>
        <label className="check"><input type="checkbox" checked={form.isDefault} disabled={form.kind !== "chat" || !form.enabled} onChange={(event) => setForm({ ...form, isDefault: event.target.checked })} />设为新聊天默认模型</label>
        <button className="primary"><Plus size={16} />保存模型</button>
      </form>
      <div className="table">
        {models.map((model) => (
          <div className="table-row model-row editable-row" key={model.id}>
            {editing[model.id] ? (
              <>
                <label className="field-label">展示名称<input value={editing[model.id].name} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], name: event.target.value } })} /></label>
                <label className="field-label">类型<select value={editing[model.id].kind} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], kind: event.target.value as "chat" | "image" } })}>
                    <option value="chat">聊天模型</option>
                    <option value="image">图片模型</option>
                  </select></label>
                {editing[model.id].kind === "chat" ? (
                  <label className="field-label">接口协议<select value={editing[model.id].protocol} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], protocol: event.target.value as "openai" | "anthropic" } })}>
                    <option value="openai">OpenAI 兼容协议</option>
                    <option value="anthropic">Claude / Anthropic 协议</option>
                  </select></label>
                ) : null}
                <label className="field-label">Base URL<input value={editing[model.id].baseUrl} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], baseUrl: event.target.value } })} /></label>
                <label className="field-label">模型 ID<input value={editing[model.id].model} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], model: event.target.value } })} /></label>
                <label className="field-label">替换 API Key<input type="password" autoComplete="new-password" placeholder="留空则保持原 Key" value={editing[model.id].apiKey} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], apiKey: event.target.value } })} /></label>
                <label className="field-label model-prompt-field">System Prompt<textarea rows={4} value={editing[model.id].systemPrompt} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], systemPrompt: event.target.value } })} /></label>
                <label className="inline-check"><input type="checkbox" checked={editing[model.id].enabled} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], enabled: event.target.checked } })} />启用</label>
                <label className="inline-check"><input type="radio" checked={editing[model.id].isDefault} disabled={editing[model.id].kind !== "chat" || !editing[model.id].enabled} onChange={() => setEditing({ ...editing, [model.id]: { ...editing[model.id], isDefault: true } })} />新聊天默认</label>
                <button className="secondary" onClick={() => saveModel(model)}><Save size={15} />保存</button>
              </>
            ) : (
              <>
                <span>{model.name}<small>{model.kind === "image" ? "图片" : model.protocol === "anthropic" ? "聊天 · Anthropic" : "聊天 · OpenAI"} · {model.model}{model.isDefault ? " · 新聊天默认" : ""}</small></span>
                <span>{model.hasApiKey ? "已配置 Key" : "缺少 Key"}</span>
                <button className="secondary" onClick={() => setEditing({ ...editing, [model.id]: { name: model.name, kind: model.kind, protocol: model.protocol, baseUrl: model.baseUrl, model: model.model, apiKey: "", systemPrompt: model.systemPrompt || "", enabled: model.enabled, isDefault: model.isDefault } })}><Edit3 size={15} />编辑</button>
                <button className="secondary" onClick={() => toggle(model)}>{model.enabled ? "停用" : "启用"}</button>
                <button className="danger" onClick={() => deleteModel(model)}><Trash2 size={15} />删除</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function TokensTab({
  tokens,
  reload,
  setNotice
}: {
  tokens: IntegrationToken[];
  reload: () => Promise<void>;
  setNotice: (notice: string) => void;
}) {
  const [name, setName] = useState("");
  const [visible, setVisible] = useState<Record<string, boolean>>({});

  async function createToken(event: FormEvent) {
    event.preventDefault();
    const result = await api<{ token: IntegrationToken }>("/api/admin/integration-tokens", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    setNotice(`已生成 Token：${result.token.name}`);
    setVisible({ ...visible, [result.token.id]: true });
    setName("");
    await reload();
  }

  async function copyToken(token: IntegrationToken) {
    if (!token.token) {
      setNotice("旧 Token 没有保存明文，请重新生成一个新的 Token。");
      return;
    }
    await navigator.clipboard.writeText(token.token);
    setNotice(`已复制 Token：${token.name}`);
  }

  function maskToken(value?: string) {
    if (!value) return "旧 Token 无明文";
    return `${value.slice(0, 8)}${"*".repeat(24)}${value.slice(-6)}`;
  }

  return (
    <div className="admin-grid">
      <form className="admin-form" onSubmit={createToken}>
        <h3><KeyRound size={17} />机器人接入</h3>
        <p className="hint no-margin">API Token 不是给网页登录用户用的，是给钉钉、飞书、企业微信等机器人服务端调用 `/api/integrations/chat` 时做鉴权用的。</p>
        <input placeholder="Token 名称，如 钉钉机器人" value={name} onChange={(event) => setName(event.target.value)} />
        <button className="primary"><Plus size={16} />生成 Token</button>
        <p className="hint">外部办公软件可 POST /api/integrations/chat，并在 Authorization 中带 Bearer Token。</p>
      </form>
      <div className="table">
        {tokens.map((token) => (
          <div className="table-row token-row" key={token.id}>
            <span>{token.name}</span>
            <code>{visible[token.id] ? token.token || "旧 Token 无明文" : maskToken(token.token)}</code>
            <span>{token.enabled ? "启用" : "停用"}</span>
            <span>{dateTime(token.createdAt)}</span>
            <button className="secondary" onClick={() => setVisible({ ...visible, [token.id]: !visible[token.id] })}>
              {visible[token.id] ? <EyeOff size={15} /> : <Eye size={15} />}
              {visible[token.id] ? "隐藏" : "显示"}
            </button>
            <button className="secondary" onClick={() => copyToken(token)}><Copy size={15} />复制</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function numberText(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateDaysAgo(days: number) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return localDateKey(date);
}

function DataPlatformTab() {
  const [page, setPage] = useState<"overview" | "briefs">("overview");
  const [state, setState] = useState<DataPlatformState | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [busyConnector, setBusyConnector] = useState("");

  async function load() {
    setLoading(true);
    try {
      const result = await api<DataPlatformState>("/api/admin/data-platform");
      setState(result);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch((err) => setNotice(err instanceof Error ? err.message : "数据接入状态加载失败"));
  }, []);

  const hasRunningSync = state?.connectors.some((connector) => connector.status === "syncing") ?? false;
  useEffect(() => {
    if (!hasRunningSync) return;
    const timer = window.setInterval(() => {
      load().catch((err) => setNotice(err instanceof Error ? err.message : "同步状态刷新失败"));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [hasRunningSync]);

  async function runConnectorAction(connector: DataConnector, action: "check" | "sync") {
    setNotice("");
    setBusyConnector(`${connector.id}:${action}`);
    try {
      const result = await api<{ result: { hasCredentials: boolean; missingEnvVars: string[]; log: { message: string } } }>(
        `/api/admin/data-platform/connectors/${connector.id}/${action}`,
        { method: "POST" }
      );
      setNotice(result.result.log.message);
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyConnector("");
    }
  }

  const connectorName = (id: DataConnector["id"]) => state?.connectors.find((connector) => connector.id === id)?.name ?? id;
  const connectorKind = (connector: DataConnector) => {
    if (connector.sourceType === "erp") return "ERP 经营数据";
    if (connector.sourceType === "payment") return "支付资金数据";
    return "企业知识库内容";
  };

  if (page === "briefs") return <ManagementBriefSettings onBack={() => setPage("overview")} />;

  if (loading && !state) return <div className="secure-loading">正在加载数据接入状态...</div>;

  return (
    <div className="data-platform">
      <section className="data-platform-hero">
        <div>
          <h3>AI 问数数据接入</h3>
          <p>先把万里牛和企业支付宝接成受控数据能力：每个数据源、每次检测、每次同步都会留痕。</p>
        </div>
        <a className="secondary" href="/api/admin/data-platform/plan" target="_blank" rel="noreferrer">
          <FileSpreadsheet size={15} />查看内部方案
        </a>
      </section>
      {notice ? <div className="import-notice">{notice}</div> : null}
      <section className="data-layers">
        {state?.layers.map((layer, index) => (
          <article key={layer.id}>
            <span>{index + 1}</span>
            <div>
              <h4>{layer.name}</h4>
              <p>{layer.description}</p>
              <small>{layer.status}</small>
            </div>
          </article>
        ))}
      </section>
      <section className="data-section-grid">
        <div className="data-section">
          <div className="records-heading">
            <h3>数据源连接器</h3>
            <span>{state?.connectors.length ?? 0} 个</span>
          </div>
          <div className="connector-list">
            {state?.connectors.map((connector) => (
              <article className="connector-card" key={connector.id}>
                <div className="connector-card-head">
                  <div>
                    <h4>{connector.name}</h4>
                    <p>{connectorKind(connector)}</p>
                  </div>
                  <span className={connector.hasCredentials ? "status-pill ready" : "status-pill waiting"}>
                    {connector.hasCredentials ? "凭证已配置" : "等待凭证"}
                  </span>
                </div>
                <div className="env-list">
                  {connector.requiredEnvVars.map((envName) => (
                    <code className={connector.missingEnvVars.includes(envName) ? "missing" : "ready"} key={envName}>
                      {envName}
                    </code>
                  ))}
                </div>
                {connector.message ? <p className="hint no-margin">{connector.message}</p> : null}
                <div className="connector-meta">
                  <span>最后检测：{connector.lastCheckedAt ? dateTime(connector.lastCheckedAt) : "暂无"}</span>
                  <span>最后同步：{connector.lastSyncedAt ? dateTime(connector.lastSyncedAt) : "暂无"}</span>
                </div>
                <div className="connector-actions">
                  <button className="secondary" disabled={busyConnector === `${connector.id}:check`} onClick={() => runConnectorAction(connector, "check")}>
                    <RotateCcw size={15} />检测凭证
                  </button>
                  <button className="primary" disabled={busyConnector === `${connector.id}:sync`} onClick={() => runConnectorAction(connector, "sync")}>
                    <Upload size={15} />手动同步
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
        <div className="data-section">
          <div className="records-heading">
            <h3>指标工具</h3>
            <span>{state?.metrics.length ?? 0} 个</span>
          </div>
          <div className="metric-tool-list">
            {state?.metrics.map((metric) => (
              <article key={metric.id}>
                <div>
                  <h4>{metric.name}</h4>
                  <p>{metric.description}</p>
                  <small>{metric.id}</small>
                </div>
                <span>{metric.connectorIds.map(connectorName).join(" + ")}</span>
              </article>
            ))}
          </div>
        </div>
      </section>
      <section className="data-section brief-settings-entry">
        <div>
          <small>内部管理配置</small>
          <h3>管理简报</h3>
          <p>查看系统预设，或新增企业自己的 AI 简报。这里的配置不会展示给普通员工。</p>
        </div>
        <button className="secondary" onClick={() => setPage("briefs")}>
          <Settings size={16} />进入简报设置<ChevronRight size={16} />
        </button>
      </section>
      <ClientApiDocumentation />
      <section className="data-section">
        <div className="records-heading">
          <h3>接入留痕</h3>
          <span>{state?.syncLogs.length ?? 0} 条</span>
        </div>
        <div className="data-log-list">
          {state?.syncLogs.length ? state.syncLogs.map((log) => (
            <article key={log.id}>
              <span className={`status-dot ${log.status}`} />
              <div>
                <strong>{connectorName(log.connectorId)} · {log.action === "check_credentials" ? "检测凭证" : log.action === "manual_sync" ? "手动同步" : "定时同步"}</strong>
                <p>{log.message}</p>
              </div>
              <time>{dateTime(log.finishedAt)}</time>
            </article>
          )) : <p className="hint">暂无留痕。点击“检测凭证”或“手动同步”后会生成记录。</p>}
        </div>
      </section>
    </div>
  );
}

function ManagementBriefSettings({ onBack }: { onBack: () => void }) {
  const [dimensions, setDimensions] = useState<ManagementBriefDimension[]>([]);
  const [definitions, setDefinitions] = useState<ManagementBriefDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selectedDimensions, setSelectedDimensions] = useState<string[]>([""]);

  async function load() {
    const result = await api<{ dimensions: ManagementBriefDimension[]; definitions: ManagementBriefDefinition[] }>(
      "/api/admin/management-briefs"
    );
    setDimensions(result.dimensions);
    setDefinitions(result.definitions);
  }

  useEffect(() => {
    load()
      .catch((err) => setNotice(err instanceof Error ? err.message : "简报设置加载失败"))
      .finally(() => setLoading(false));
  }, []);

  const dimensionById = new Map(dimensions.map((item) => [item.id, item]));
  const systemDefinitions = definitions.filter((item) => item.source === "system");
  const customDefinitions = definitions.filter((item) => item.source === "custom");

  function updateDimension(index: number, value: string) {
    setSelectedDimensions((current) => current.map((item, itemIndex) => itemIndex === index ? value : item));
  }

  function addDimensionRow() {
    if (selectedDimensions.length >= dimensions.length) return;
    setSelectedDimensions((current) => [...current, ""]);
  }

  function removeDimensionRow(index: number) {
    setSelectedDimensions((current) => current.length === 1 ? [""] : current.filter((_, itemIndex) => itemIndex !== index));
  }

  function resetForm() {
    setName("");
    setDescription("");
    setPrompt("");
    setSelectedDimensions([""]);
    setShowCreate(false);
  }

  async function createBrief(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    const dimensionIds = selectedDimensions.filter(Boolean);
    if (!dimensionIds.length) return setNotice("请至少选择一个数据维度");
    setSaving(true);
    try {
      await api("/api/admin/management-briefs", {
        method: "POST",
        body: JSON.stringify({ name, description, prompt, dimensionIds })
      });
      resetForm();
      setNotice("自定义简报已新增。后续生成任务会按这份配置准备数据并调用 AI。");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "新增简报失败");
    } finally {
      setSaving(false);
    }
  }

  async function toggleBrief(definition: ManagementBriefDefinition) {
    setNotice("");
    try {
      await api(`/api/admin/management-briefs/${definition.id}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !definition.enabled })
      });
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "简报状态更新失败");
    }
  }

  async function deleteBrief(definition: ManagementBriefDefinition) {
    if (!window.confirm(`确定删除“${definition.name}”吗？`)) return;
    setNotice("");
    try {
      await api(`/api/admin/management-briefs/${definition.id}`, { method: "DELETE" });
      setNotice("自定义简报已删除。");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "删除简报失败");
    }
  }

  if (loading) return <div className="secure-loading">正在加载管理简报设置...</div>;

  const renderBrief = (definition: ManagementBriefDefinition) => (
    <article className={`brief-definition-card ${definition.enabled ? "" : "disabled"}`} key={definition.id}>
      <div className="brief-definition-head">
        <div>
          <div className="brief-title-row">
            <h4>{definition.name}</h4>
            <span className={`status-pill ${definition.source === "system" ? "ready" : "waiting"}`}>
              {definition.source === "system" ? "系统预设 · 只读" : definition.enabled ? "企业自定义" : "已停用"}
            </span>
          </div>
          <p>{definition.description || "暂无说明"}</p>
        </div>
        {definition.source === "custom" ? (
          <div className="brief-card-actions">
            <button className="secondary compact" onClick={() => toggleBrief(definition)}>
              {definition.enabled ? "停用" : "启用"}
            </button>
            <button className="danger compact" onClick={() => deleteBrief(definition)}><Trash2 size={14} />删除</button>
          </div>
        ) : null}
      </div>
      <div className="brief-dimension-chips">
        {definition.dimensionIds.map((id) => <span key={id}>{dimensionById.get(id)?.name ?? id}</span>)}
      </div>
      <details>
        <summary>查看提示词</summary>
        <p className="brief-prompt-preview">{definition.prompt}</p>
      </details>
    </article>
  );

  return (
    <div className="data-platform management-brief-settings">
      <header className="brief-settings-header">
        <button className="secondary" onClick={onBack}><ChevronLeft size={16} />返回数据接入</button>
        <div>
          <small>管理后台 / 数据接入 / 管理简报设置</small>
          <h2>管理简报设置</h2>
          <p>系统预设不可修改；如需不同观察角度，请新增一份企业自定义简报。</p>
        </div>
      </header>
      {notice ? <div className="import-notice">{notice}</div> : null}

      <section className="data-section brief-dimension-catalog">
        <div className="records-heading">
          <div><h3>可选数据维度</h3><p>当前经营数据库能够提供的全部简报数据范围。</p></div>
          <span>{dimensions.length} 类</span>
        </div>
        <div className="brief-dimension-grid">
          {dimensions.map((dimension) => (
            <article key={dimension.id}>
              <h4>{dimension.name}</h4>
              <p>{dimension.description}</p>
              <small>{dimension.fields.join(" · ")}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="data-section">
        <div className="records-heading">
          <div><h3>系统预设简报</h3><p>作为管理驾驶舱的基础简报，固定保留且不允许修改。</p></div>
          <span>{systemDefinitions.length} 份</span>
        </div>
        <div className="brief-definition-list">{systemDefinitions.map(renderBrief)}</div>
      </section>

      <section className="data-section">
        <div className="records-heading">
          <div><h3>企业自定义简报</h3><p>新增独立简报，不影响系统预设内容。</p></div>
          <button className="primary" onClick={() => setShowCreate((value) => !value)}>
            {showCreate ? <X size={16} /> : <Plus size={16} />}{showCreate ? "取消新增" : "新增简报"}
          </button>
        </div>

        {showCreate ? (
          <form className="brief-create-form" onSubmit={createBrief}>
            <label>简报名称<input required maxLength={40} placeholder="例如：重点店铺周末复盘" value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>简报说明（选填）<input maxLength={160} placeholder="说明这份简报给谁看、解决什么问题" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            <fieldset>
              <legend>数据维度</legend>
              <p>每次点击小加号增加一个维度；同一维度不会重复出现。</p>
              <div className="brief-dimension-selectors">
                {selectedDimensions.map((selected, index) => (
                  <div className="brief-dimension-selector" key={index}>
                    <select required value={selected} onChange={(event) => updateDimension(index, event.target.value)}>
                      <option value="">请选择数据维度</option>
                      {dimensions.map((dimension) => (
                        <option key={dimension.id} value={dimension.id} disabled={selectedDimensions.includes(dimension.id) && selected !== dimension.id}>
                          {dimension.name}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="secondary icon-only" title="增加一个数据维度" disabled={selectedDimensions.length >= dimensions.length} onClick={addDimensionRow}><Plus size={16} /></button>
                    <button type="button" className="secondary icon-only" title="移除这个数据维度" onClick={() => removeDimensionRow(index)}><X size={16} /></button>
                  </div>
                ))}
              </div>
            </fieldset>
            <label>提示词<textarea required minLength={20} maxLength={4000} rows={8} placeholder="告诉 AI 应该关注什么、如何比较、用什么结构输出。数据会由系统按上方维度准备，无需在提示词里写 SQL。" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
            <div className="brief-form-footer">
              <span>{prompt.length}/4000</span>
              <button className="primary" disabled={saving}><Save size={16} />{saving ? "正在保存..." : "保存并启用"}</button>
            </div>
          </form>
        ) : null}

        <div className="brief-definition-list">
          {customDefinitions.length ? customDefinitions.map(renderBrief) : <p className="hint">还没有企业自定义简报。</p>}
        </div>
      </section>
    </div>
  );
}

function ClientApiDocumentation() {
  const [copied, setCopied] = useState(false);
  const curlExample = `curl -sS 'https://ai.miwuj.cn/api/open/v1/shipments?start_date=2026-08-19&end_date=2026-08-19&page=1&page_size=100' \\
  -H 'Authorization: Bearer <API_TOKEN>'`;

  async function copyExample() {
    await navigator.clipboard.writeText(curlExample);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <section className="data-section client-api-doc">
      <div className="client-api-doc-heading">
        <div>
          <div className="client-api-title-row">
            <h3>甲方经营数据开放 API</h3>
            <span className="status-pill ready">V1 · 可联调</span>
          </div>
          <p>甲方服务端通过 HTTPS 定时拉取；平台鉴权后读取授权数据，再以分页 JSON 返回约定字段。</p>
        </div>
        <a className="secondary" href="/api/admin/data-platform/client-api-doc" target="_blank" rel="noreferrer">
          <FileText size={15} />打开完整联调文档
        </a>
      </div>

      <div className="client-api-basics">
        <div><small>基础地址</small><code>https://ai.miwuj.cn/api/open/v1</code></div>
        <div><small>鉴权</small><code>Authorization: Bearer &lt;API_TOKEN&gt;</code></div>
        <div><small>格式</small><code>application/json · UTF-8</code></div>
      </div>

      <div className="client-api-flow" aria-label="API 数据流程">
        <span>甲方发起 GET 请求</span><b>→</b><span>Token 鉴权</span><b>→</b><span>读取授权数据</span><b>→</b><span>返回分页 JSON</span>
      </div>

      <div className="client-api-endpoints">
        <article>
          <div><code>GET /shipments</code><span>出货明细</span></div>
          <p><strong>必填：</strong><code>start_date</code>、<code>end_date</code></p>
          <p><strong>返回：</strong>出货时间、店铺名称、产品编码、产品名称、数量、GMV</p>
        </article>
        <article>
          <div><code>GET /inventory</code><span>当前库存</span></div>
          <p><strong>日期：</strong>无需传入，读取最新库存</p>
          <p><strong>返回：</strong>产品编码、产品名称、库存数量</p>
        </article>
        <article>
          <div><code>GET /inbounds</code><span>入库明细</span></div>
          <p><strong>必填：</strong><code>start_date</code>、<code>end_date</code></p>
          <p><strong>返回：</strong>入库时间、产品编码、产品名称、入库数量</p>
        </article>
      </div>

      <details className="client-api-example">
        <summary>请求示例与分页规则</summary>
        <div className="code-sample-heading">
          <span>出货接口请求示例</span>
          <button className="secondary compact" onClick={copyExample}><Copy size={14} />{copied ? "已复制" : "复制"}</button>
        </div>
        <pre><code>{curlExample}</code></pre>
        <p>默认每页 100 条，最大 200 条。持续请求下一页，直到响应中的 <code>pagination.has_more</code> 为 <code>false</code>。出货和入库单次最多查询 31 个自然日。</p>
      </details>

      <div className="client-api-policy">
        <strong>数据更新约定：</strong>
        <span>出货和入库建议按自然日重新拉取并覆盖对应日期，库存建议每次读取完整结果并替换上次快照，避免因重复追加产生重复数据。</span>
      </div>
    </section>
  );
}

function RecordsTab({ records, users }: { records: (Conversation & { user: User })[]; users: User[] }) {
  const [userId, setUserId] = useState("all");
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [statsError, setStatsError] = useState("");
  const [period, setPeriod] = useState<"all" | "7" | "30" | "90" | "custom">("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(localDateKey(new Date()).slice(0, 7));
  const range = useMemo(() => {
    if (period === "all") return { from: "", to: "" };
    if (period === "custom") return { from: fromDate, to: toDate };
    return { from: dateDaysAgo(Number(period) - 1), to: localDateKey(new Date()) };
  }, [period, fromDate, toDate]);
  const rangeQuery = [
    range.from ? `from=${encodeURIComponent(range.from)}` : "",
    range.to ? `to=${encodeURIComponent(range.to)}` : ""
  ].filter(Boolean).join("&");
  const filtered = records
    .filter((record) => userId === "all" || record.userId === userId)
    .map((record) => ({
      ...record,
      messages: record.messages.filter((message) => {
        const key = localDateKey(new Date(message.createdAt));
        return (!range.from || key >= range.from) && (!range.to || key <= range.to);
      })
    }))
    .filter((record) => record.messages.length);

  useEffect(() => {
    if (userId !== "all" && !users.some((user) => user.id === userId)) setUserId("all");
  }, [userId, users]);

  useEffect(() => {
    if (!userId) {
      setStats(null);
      return;
    }
    setStatsError("");
    setStats(null);
    const query = `userId=${encodeURIComponent(userId)}${rangeQuery ? `&${rangeQuery}` : ""}`;
    api<{ stats: UsageStats }>(`/api/admin/usage-stats?${query}`)
      .then((result) => setStats(result.stats))
      .catch((err) => setStatsError(err instanceof Error ? err.message : "用量数据加载失败"));
  }, [userId, rangeQuery]);

  const calendarDays = useMemo(() => {
    const usage = new Map(stats?.dailyUsage.map((item) => [item.date, item]) ?? []);
    const [year, month] = calendarMonth.split("-").map(Number);
    const firstDay = new Date(year, month - 1, 1, 12);
    const offset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month, 0).getDate();
    return [
      ...Array.from({ length: offset }, () => null),
      ...Array.from({ length: daysInMonth }, (_, index) => {
      const date = new Date(year, month - 1, index + 1, 12);
      const key = localDateKey(date);
      return { ...(usage.get(key) ?? { date: key, turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }), day: index + 1 };
      })
    ];
  }, [stats, calendarMonth]);
  const maxDailyTokens = Math.max(1, ...calendarDays.filter((item) => item !== null).map((item) => item.totalTokens));
  const recentUsage = stats?.dailyUsage.slice(-14) ?? [];
  const maxRecentTokens = Math.max(1, ...recentUsage.map((item) => item.totalTokens));
  const maxModelTurns = Math.max(1, ...(stats?.modelUsage.map((item) => item.turns) ?? []));
  const exportQuery = `userId=${encodeURIComponent(userId)}${rangeQuery ? `&${rangeQuery}` : ""}`;

  function shiftCalendarMonth(offset: number) {
    const [year, month] = calendarMonth.split("-").map(Number);
    const target = new Date(year, month - 1 + offset, 1, 12);
    setCalendarMonth(localDateKey(target).slice(0, 7));
  }

  return (
    <div className="records">
      <div className="records-toolbar">
        <label>员工
          <select value={userId} onChange={(event) => setUserId(event.target.value)}>
            <option value="all">全部员工</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>{user.username}</option>
            ))}
          </select>
        </label>
        <label>统计周期
          <select value={period} onChange={(event) => setPeriod(event.target.value as typeof period)}>
            <option value="all">全部时间</option>
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
            <option value="90">近 90 天</option>
            <option value="custom">自定义日期</option>
          </select>
        </label>
        {period === "custom" ? (
          <div className="custom-range">
            <label>开始日期<input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} /></label>
            <label>结束日期<input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} /></label>
          </div>
        ) : null}
        {userId ? (
          <a className="secondary export-link" href={`/api/admin/usage-stats/export?${exportQuery}`}>
            <Download size={15} />导出 Excel
          </a>
        ) : null}
      </div>
      {statsError ? <div className="error">{statsError}</div> : null}
      {stats ? (
        <section className="usage-dashboard">
          <div className="metric-grid">
            <article><span>总对话轮次</span><strong>{numberText(stats.summary.totalTurns)}</strong><small>{numberText(stats.summary.conversations)} 个对话</small></article>
            <article><span>输入 Token</span><strong>{numberText(stats.summary.inputTokens)}</strong><small>仅统计供应商返回数据</small></article>
            <article><span>输出 Token</span><strong>{numberText(stats.summary.outputTokens)}</strong><small>总计 {numberText(stats.summary.totalTokens)}</small></article>
            <article><span>活跃天数</span><strong>{numberText(stats.summary.activeDays)}</strong><small>平均 {stats.summary.averageTurnsPerConversation} 轮 / 对话</small></article>
          </div>
          <div className="analytics-grid">
            <article className="analytics-panel heatmap-panel">
              <div className="panel-heading calendar-heading">
                <div><h3>月度使用热力</h3><p>颜色综合当天轮次和 Token 用量</p></div>
                <div className="calendar-switcher">
                  <button title="上个月" onClick={() => shiftCalendarMonth(-1)}><ChevronLeft size={15} /></button>
                  <input aria-label="热力图月份" type="month" value={calendarMonth} onChange={(event) => setCalendarMonth(event.target.value)} />
                  <button title="下个月" onClick={() => shiftCalendarMonth(1)}><ChevronRight size={15} /></button>
                </div>
              </div>
              <div className="calendar-weekdays">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>{day}</span>)}</div>
              <div className="calendar-heatmap">
                {calendarDays.map((item, index) => {
                  if (!item) return <span className="calendar-empty" key={`empty-${index}`} />;
                  const ratio = item.totalTokens / maxDailyTokens;
                  const level = item.turns === 0 ? 0 : ratio > 0.72 ? 4 : ratio > 0.42 ? 3 : ratio > 0.18 ? 2 : 1;
                  return (
                    <span key={item.date} className={`calendar-day level-${level}`} title={`${item.date}：${item.turns} 轮，输入 ${numberText(item.inputTokens)}，输出 ${numberText(item.outputTokens)}，合计 ${numberText(item.totalTokens)} Token`}>
                      {item.day}
                    </span>
                  );
                })}
              </div>
              <div className="heat-legend"><span>少</span>{[0, 1, 2, 3, 4].map((level) => <i className={`heat-cell level-${level}`} key={level} />)}<span>多</span></div>
            </article>
            <article className="analytics-panel">
              <div className="panel-heading"><div><h3>最近用量</h3><p>最近 14 个有使用记录的日期</p></div></div>
              <div className="daily-bars">
                {recentUsage.length ? recentUsage.map((item) => (
                  <div className="daily-bar-item" key={item.date} title={`${item.date}：${numberText(item.totalTokens)} Token`}>
                    <div><span style={{ height: `${Math.max(4, (item.totalTokens / maxRecentTokens) * 100)}%` }} /></div>
                    <small>{item.date.slice(5)}</small>
                  </div>
                )) : <p className="hint">暂无使用数据</p>}
              </div>
            </article>
            <article className="analytics-panel model-panel">
              <div className="panel-heading"><div><h3>模型使用分布</h3><p>按对话轮次统计</p></div></div>
              <div className="model-bars">
                {stats.modelUsage.map((item) => (
                  <div className="model-bar-row" key={item.name}>
                    <span>{item.name}</span>
                    <div><i style={{ width: `${(item.turns / maxModelTurns) * 100}%` }} /></div>
                    <strong>{item.turns}</strong>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </section>
      ) : null}
      <div className="records-heading">
        <h3>聊天记录</h3>
        <span>{filtered.length} 个对话</span>
      </div>
      {filtered.map((record) => (
        <details key={record.id}>
          <summary>
            <span>{record.title}</span>
            <small>{record.user?.username || "未知用户"} · {dateTime(record.updatedAt)}</small>
          </summary>
          {record.messages.map((message, index) => (
            <article className={`audit-message ${message.role}`} key={`${record.id}-${index}`}>
              <strong>{message.role}</strong>
              {message.attachments?.length ? <AttachmentList attachments={message.attachments} /> : null}
              <pre>{message.content}</pre>
              {message.imageUrl ? <img className="audit-image" src={message.imageUrl} alt={message.content} /> : null}
              <MessageSources sources={message.sources} />
            </article>
          ))}
        </details>
      ))}
    </div>
  );
}

function PublicAgentPage({ slug }: { slug: string }) {
  const [agent, setAgent] = useState<Omit<Agent, "prompt"> | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [webSearch, setWebSearch] = useState(false);

  useEffect(() => {
    api<{ agent: Omit<Agent, "prompt"> }>(`/api/public/agents/${encodeURIComponent(slug)}`)
      .then((result) => setAgent(result.agent))
      .catch((err) => setError(err instanceof Error ? err.message : "智能体加载失败"))
      .finally(() => setLoading(false));
  }, [slug]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = content.trim();
    if (!text || sending) return;
    const userMessage: Message = { id: localId("msg"), role: "user", content: text, createdAt: new Date().toISOString() };
    const history = messages.slice(-10);
    setMessages((items) => [...items, userMessage]);
    setContent("");
    setSending(true);
    setError("");
    try {
      const result = await api<{ message: Message }>(`/api/public/agents/${encodeURIComponent(slug)}/chat`, {
        method: "POST",
        body: JSON.stringify({ content: text, messages: history, webSearch })
      });
      setMessages((items) => [...items, result.message]);
      setWebSearch(false);
    } catch (err) {
      setMessages((items) => items.filter((message) => message.id !== userMessage.id));
      setError(err instanceof Error ? err.message : "发送失败");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !isComposing && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  if (loading) return <div className="boot">加载中...</div>;
  if (!agent) return <div className="boot">{error || "智能体不存在"}</div>;

  return (
    <main className="public-agent-shell">
      <header className="public-agent-header">
        <img src="/brand/xiaoxiang-wordmark.png" alt="小象优选" />
        <div>
          <h1>{agent.name}</h1>
          <p>{agent.description}</p>
          <small>{agent.authorName} 发布</small>
        </div>
      </header>
      <section className="public-agent-chat">
        {messages.length ? messages.map((message, index) => (
          <article className={`message ${message.role}`} key={`${message.createdAt}-${index}`}>
            {message.role === "assistant" ? <div className="avatar"><img src="/brand/xiaoxiang-mark.png" alt="" /></div> : null}
            <div className="bubble">
              {message.role === "assistant" ? (
                <>
                  <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
                  <MessageSources sources={message.sources} />
                </>
              ) : <pre>{message.content}</pre>}
              <small className="message-time">{dateTime(message.createdAt)}</small>
            </div>
          </article>
        )) : (
          <div className="empty-state">
            <img src="/brand/xiaoxiang-mark.png" alt="" />
            <h2>开始使用这个智能体</h2>
            <p>{agent.description}</p>
          </div>
        )}
        {sending ? <div className="typing">正在认真琢磨这个问题 (˘･_･˘)</div> : null}
      </section>
      <form className="composer public-composer" onSubmit={send}>
        {error ? <div className="chat-error"><span>{error}</span></div> : null}
        <div className="composer-row">
          {agent.allowWebSearch ? (
            <button className={`composer-tool ${webSearch ? "active" : ""}`} type="button" title="联网搜索" disabled={sending} onClick={() => setWebSearch((value) => !value)}><Globe2 size={18} /></button>
          ) : null}
          <textarea value={content} rows={2} placeholder="输入消息，Enter 发送" onChange={(event) => setContent(event.target.value)} onCompositionStart={() => setIsComposing(true)} onCompositionEnd={() => setIsComposing(false)} onKeyDown={handleKeyDown} />
          <button className="primary send" type="submit" disabled={!content.trim() || sending}><Send size={18} /></button>
        </div>
      </form>
    </main>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const publicAgentSlug = window.location.pathname.match(/^\/agents\/([^/]+)\/?$/)?.[1] || "";

  useEffect(() => {
    if (publicAgentSlug) {
      setBooting(false);
      return;
    }
    localStorage.removeItem("enterprise-ai-token");
    api<{ user: User }>("/api/me")
      .then((result) => setUser(result.user))
      .catch(() => undefined)
      .finally(() => setBooting(false));
  }, [publicAgentSlug]);

  if (publicAgentSlug) return <PublicAgentPage slug={decodeURIComponent(publicAgentSlug)} />;
  if (booting) return <div className="boot">加载中...</div>;
  if (!user) return <Login onDone={setUser} />;
  return (
    <ChatApp
      user={user}
      onLogout={() => {
        api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        setUser(null);
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
