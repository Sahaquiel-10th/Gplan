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
  FileSpreadsheet,
  Folder,
  FolderInput,
  KeyRound,
  LockKeyhole,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  RotateCcw,
  Save,
  Send,
  Settings,
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
  createdAt: string;
  modelId?: string;
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
  id: "wanliniu" | "alipay";
  name: string;
  sourceType: "erp" | "payment";
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
    status: "success" | "blocked" | "failed";
    message: string;
    startedAt: string;
    finishedAt: string;
  }>;
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
  const [models, setModels] = useState<Model[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
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
  const [view, setView] = useState<"chat" | "admin" | "memories" | "account" | "agents">("chat");
  const [showArchived, setShowArchived] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [waitIndex, setWaitIndex] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [failedMessage, setFailedMessage] = useState("");
  const [workspaceSectionOpen, setWorkspaceSectionOpen] = useState(true);
  const [conversationSectionOpen, setConversationSectionOpen] = useState(true);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(() => new Set());

  const active = useMemo(() => conversations.find((item) => item.id === activeId), [activeId, conversations]);
  const activeModelId = active?.modelId || draftModelId;
  const activeLoadingKey = active?.id || "draft";
  const activeLoading = Boolean(loadingByConversation[activeLoadingKey]);
  const currentModel = models.find((model) => model.id === activeModelId);
  const activeAgentId = active?.agentId || draftAgentId;
  const activeAgent = agents.find((agent) => agent.id === activeAgentId);
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
    const [modelResult, conversationResult, workspaceResult, agentResult] = await Promise.all([
      api<{ models: Model[]; defaultModelId: string }>("/api/models"),
      api<{ conversations: Conversation[] }>("/api/conversations"),
      api<{ workspaces: Workspace[] }>("/api/workspaces"),
      api<{ agents: Agent[] }>("/api/agents")
    ]);
    setModels(modelResult.models);
    setDefaultModelId(modelResult.defaultModelId);
    setConversations(conversationResult.conversations);
    setWorkspaces(workspaceResult.workspaces);
    setAgents(agentResult.agents);
    setDraftModelId((current) => (
      modelResult.models.some((model) => model.id === current)
        ? current
        : modelResult.defaultModelId || modelResult.models[0]?.id || ""
    ));
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") refresh().catch(() => undefined);
    }
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, []);

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
    setView("chat");
    setSidebarOpen(false);
  }

  function startAgentChat(agent: Agent) {
    setActiveId("");
    setDraftAgentId(agent.id);
    setDraftModelId(defaultModelId || models.find((model) => model.kind === "chat")?.id || models[0]?.id || "");
    setContent("");
    setError("");
    setView("chat");
    setSidebarOpen(false);
  }

  async function sendMessage(rawText: string) {
    const modelId = active?.modelId || draftModelId;
    const text = rawText.trim();
    if (!text || !modelId) return;
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
      content: text,
      modelId,
      createdAt: new Date().toISOString()
    };
    setContent("");
    if (isNewConversation) {
      const optimistic: Conversation = {
        id: tempId,
        userId: user.id,
        modelId,
        workspaceId: draftWorkspaceId || undefined,
        agentId: draftAgentId || undefined,
        archived: false,
        title: activeAgent ? `${activeAgent.name} · ${titleFrom(text)}` : titleFrom(text),
        messages: [userMessage],
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
        body: JSON.stringify({ content: text, modelId, conversationId: isNewConversation ? "" : active.id, workspaceId: draftWorkspaceId, agentId: isNewConversation ? draftAgentId : active.agentId })
      });
      setConversations((items) => {
        const rest = items.filter((item) => item.id !== result.conversation.id && item.id !== tempId);
        return [result.conversation, ...rest];
      });
      setActiveId((current) => (current === tempId || current === active?.id ? result.conversation.id : current));
      if (result.memoryNotice) {
        setNotice(result.memoryNotice);
        window.setTimeout(() => setNotice(""), 2800);
      }
    } catch (err) {
      setFailedMessage(text);
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
    if (!text.trim()) return;
    setContent("");
    await sendMessage(text);
  }

  async function retryFailedMessage() {
    const text = failedMessage;
    if (!text || activeLoading) return;
    await sendMessage(text);
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !isComposing && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
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
          <button className={`nav-item ${view === "admin" ? "active" : ""}`} onClick={() => { setView("admin"); setSidebarOpen(false); }}>
            <Settings size={16} />
            管理后台
          </button>
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
                    onClick={() => {
                      setActiveId(conversation.id);
                      setView("chat");
                      setError("");
                      setSidebarOpen(false);
                    }}
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
                  <button className="conversation-main" onClick={() => { setActiveId(conversation.id); setView("chat"); setError(""); setSidebarOpen(false); }}>
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
      ) : view === "memories" ? (
        <MemoriesPage onOpenSidebar={() => setSidebarOpen(true)} />
      ) : view === "agents" ? (
        <AgentsPage user={user} agents={agents} reload={refresh} onStartChat={startAgentChat} onOpenSidebar={() => setSidebarOpen(true)} />
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
          <select value={activeModelId} onChange={(event) => setDraftModelId(event.target.value)} disabled={Boolean(active)}>
            {models.length ? null : <option>暂无可用模型</option>}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.kind === "image" ? "图片" : "聊天"} · {model.name} · {model.model}
              </option>
            ))}
          </select>
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
              <img src="/brand/xiaoxiang-mark.png" alt="" />
              <h2>今天想一起解决什么？</h2>
              <p>选择模型，开始新的对话</p>
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
          <div className="composer-row">
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={handleComposerKeyDown}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              rows={2}
            />
            <button className="primary send" type="submit" disabled={!activeModelId || activeLoading}>
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
}: {
  agent: Agent;
  official?: boolean;
  canEdit: boolean;
  onStartChat: (agent: Agent) => void;
  onCopyLink: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
}) {
  return (
    <article className={`agent-card ${official ? "official" : ""}`}>
      <div className="agent-card-top">
        <span className="agent-mark"><Bot size={18} /></span>
        <div>
          <h3>{agent.name}</h3>
          <small>{official ? "官方发布" : agent.published ? "已发布链接" : "仅自己可见"} · {agent.authorName}</small>
        </div>
      </div>
      <p>{agent.description}</p>
      <div className="agent-card-actions">
        <button className="agent-action primary-action" onClick={() => onStartChat(agent)}><Send size={14} />使用</button>
        {agent.published ? <button className="agent-action" onClick={() => onCopyLink(agent)}><Copy size={14} />复制链接</button> : null}
        {canEdit ? <button className="agent-icon-action" title="编辑" onClick={() => onEdit(agent)}><Edit3 size={14} /></button> : null}
        {canEdit ? <button className="agent-icon-action danger-icon-action" title="删除" onClick={() => onDelete(agent)}><Trash2 size={14} /></button> : null}
      </div>
    </article>
  );
}

function AgentsPage({
  user,
  agents,
  reload,
  onStartChat,
  onOpenSidebar
}: {
  user: User;
  agents: Agent[];
  reload: () => Promise<void>;
  onStartChat: (agent: Agent) => void;
  onOpenSidebar: () => void;
}) {
  const [editingId, setEditingId] = useState<string | "new" | "">("");
  const [draft, setDraft] = useState({ name: "", description: "", prompt: "", published: false });
  const [notice, setNotice] = useState("");
  const officialAgents = agents.filter((agent) => agent.published && agent.authorRole === "admin");
  const myAgents = user.role === "admin"
    ? []
    : agents.filter((agent) => agent.authorName === user.username && agent.authorRole !== "admin");

  function startCreate() {
    setEditingId("new");
    setDraft({ name: "", description: "", prompt: "", published: true });
    setNotice("");
  }

  function startEdit(agent: Agent) {
    setEditingId(agent.id);
    setDraft({ name: agent.name, description: agent.description, prompt: agent.prompt || "", published: agent.published });
    setNotice("");
  }

  async function saveAgent(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    if (!draft.name.trim() || !draft.description.trim()) return;
    const body = JSON.stringify({
      name: draft.name.trim(),
      description: draft.description.trim(),
      prompt: draft.prompt.trim(),
      published: true
    });
    try {
      if (editingId === "new") {
        await api("/api/agents", { method: "POST", body });
      } else if (editingId) {
        await api(`/api/agents/${editingId}`, { method: "PATCH", body });
      }
      setEditingId("");
      setNotice(editingId === "new" ? "智能体已发布" : "智能体已更新");
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "保存失败");
    }
  }

  async function makePrivate(agent: Agent) {
    try {
      await api(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ published: false }) });
      setEditingId("");
      setNotice("已转为私有，旧分享链接已作废");
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "操作失败");
    }
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
      {notice ? <div className={notice.includes("失败") || notice.includes("不存在") ? "error agent-notice" : "notice agent-notice"}>{notice}</div> : null}
      {editingId ? (
        <form className="agent-editor" onSubmit={saveAgent}>
          <div className="agent-editor-heading">
            <h3>{editingId === "new" ? "创建智能体" : "编辑智能体"}</h3>
            <button className="secondary" type="button" onClick={() => setEditingId("")}>取消</button>
          </div>
          <label>智能体名字<input maxLength={40} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：详情页策划助手" /></label>
          <label>功能描述<textarea maxLength={220} rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="说明这个智能体适合处理什么任务" /></label>
          <label>提示词<textarea rows={7} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder="可选。不填就是普通对话智能体。这里适合写角色、流程、边界和输出格式。" /></label>
          <div className="agent-editor-actions">
            <button className="primary" type="submit" disabled={!draft.name.trim() || !draft.description.trim()}>
              <Save size={16} />
              {editingId === "new" ? "发布智能体" : "保存修改"}
            </button>
            {editingId !== "new" && draft.published ? (
              <button className="secondary" type="button" onClick={() => {
                const agent = agents.find((item) => item.id === editingId);
                if (agent) makePrivate(agent);
              }}>
                转为私有智能体
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
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

function AdminPanel({ refreshModels, onOpenSidebar }: { refreshModels: () => Promise<void>; onOpenSidebar: () => void }) {
  const [tab, setTab] = useState<"settings" | "users" | "tokens" | "secure">("settings");
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
          <button className={`secure-tab ${tab === "secure" ? "active" : ""}`} onClick={() => setTab("secure")}><Lock size={16} />模型充值后台</button>
        </nav>
        {notice ? <div className="notice">{notice}</div> : null}
        <div className="admin-body">
          {tab === "settings" ? <SettingsTab settings={settings} setNotice={setNotice} reload={load} /> : null}
          {tab === "users" ? <UsersTab users={users} reload={load} /> : null}
          {tab === "tokens" ? <TokensTab tokens={tokens} reload={load} setNotice={setNotice} /> : null}
          {tab === "secure" ? <SecureAdminTab users={users} refreshModels={refreshModels} /> : null}
        </div>
      </section>
  );
}

function SecureAdminTab({ users, refreshModels }: { users: User[]; refreshModels: () => Promise<void> }) {
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [subtab, setSubtab] = useState<"models" | "records" | "data">("models");
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
        <button className={subtab === "data" ? "active" : ""} onClick={() => setSubtab("data")}><FileSpreadsheet size={16} />数据接入</button>
      </nav>
      {subtab === "models" ? (
        <ModelsTab models={models} reload={async () => { await loadProtected(); await refreshModels(); }} />
      ) : subtab === "records" ? (
        <RecordsTab records={records} users={users} />
      ) : (
        <DataPlatformTab />
      )}
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
          <p className="hint no-margin">支持 CSV、XLSX。账号放在第一列，统一密码在这里填写。</p>
          <a className="template-download" href="/api/admin/users/import-template">
            <Download size={15} />
            下载 CSV 模板
          </a>
          <label className="file-picker">
            <Upload size={16} />
            <span>{importFile?.name || "选择账号文件"}</span>
            <input type="file" accept=".csv,.xlsx" onChange={(event) => setImportFile(event.target.files?.[0] || null)} />
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

  if (loading && !state) return <div className="secure-loading">正在加载数据接入状态...</div>;

  return (
    <div className="data-platform">
      <section className="data-platform-hero">
        <div>
          <h3>AI 问数数据接入</h3>
          <p>先把万里牛和企业支付宝接成受控数据能力：每个数据源、每次检测、每次同步都会留痕。</p>
        </div>
        <a className="secondary" href="/api/admin/data-platform/plan" target="_blank" rel="noreferrer">
          <FileSpreadsheet size={15} />查看方案文档
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
                    <p>{connector.sourceType === "erp" ? "ERP 经营数据" : "支付资金数据"}</p>
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

function RecordsTab({ records, users }: { records: (Conversation & { user: User })[]; users: User[] }) {
  const [userId, setUserId] = useState(users[0]?.id || "");
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
    .filter((record) => record.userId === userId)
    .map((record) => ({
      ...record,
      messages: record.messages.filter((message) => {
        const key = localDateKey(new Date(message.createdAt));
        return (!range.from || key >= range.from) && (!range.to || key <= range.to);
      })
    }))
    .filter((record) => record.messages.length);

  useEffect(() => {
    if (!userId && users[0]) setUserId(users[0].id);
  }, [userId, users]);

  useEffect(() => {
    if (!userId) {
      setStats(null);
      return;
    }
    setStatsError("");
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
              <pre>{message.content}</pre>
              {message.imageUrl ? <img className="audit-image" src={message.imageUrl} alt={message.content} /> : null}
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
        body: JSON.stringify({ content: text, messages: history })
      });
      setMessages((items) => [...items, result.message]);
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
                <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
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
