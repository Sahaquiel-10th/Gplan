import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  Bot,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  Folder,
  KeyRound,
  LogOut,
  MoreHorizontal,
  MessageSquare,
  Plus,
  Save,
  Send,
  Settings,
  Shield,
  Trash2,
  UserPlus,
  Users
} from "lucide-react";
import "./styles.css";

type Role = "admin" | "user";

type User = {
  id: string;
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
  baseUrl: string;
  apiKey?: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: string;
};

type Message = {
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

const tokenKey = "enterprise-ai-token";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(tokenKey);
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "请求失败");
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

function Login({ onDone }: { onDone: (user: User) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin123");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ token: string; user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      localStorage.setItem(tokenKey, result.token);
      onDone(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand-row">
          <Shield size={28} />
          <div>
            <h1>企业 AI 工作台</h1>
            <p>统一接入多个外部大模型，内部账号登录使用。</p>
          </div>
        </div>
        <label>
          账号
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        <label>
          密码
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
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
  const [activeId, setActiveId] = useState<string>("");
  const [draftModelId, setDraftModelId] = useState("");
  const [draftWorkspaceId, setDraftWorkspaceId] = useState("");
  const [content, setContent] = useState("");
  const [loadingByConversation, setLoadingByConversation] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [view, setView] = useState<"chat" | "admin">("chat");
  const [showArchived, setShowArchived] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [waitIndex, setWaitIndex] = useState(0);

  const active = useMemo(() => conversations.find((item) => item.id === activeId), [activeId, conversations]);
  const activeModelId = active?.modelId || draftModelId;
  const activeLoadingKey = active?.id || "draft";
  const activeLoading = Boolean(loadingByConversation[activeLoadingKey]);
  const currentModel = models.find((model) => model.id === activeModelId);
  const visibleConversations = conversations.filter((conversation) => conversation.archived === showArchived);
  const groupedConversations = useMemo(
    () => [
      { id: "", name: "未分组", conversations: visibleConversations.filter((conversation) => !conversation.workspaceId) },
      ...workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        conversations: visibleConversations.filter((conversation) => conversation.workspaceId === workspace.id)
      }))
    ].filter((group) => group.conversations.length || (!group.id && !workspaces.length)),
    [visibleConversations, workspaces]
  );
  const waitMessages = [
    "AI疯狂翻书中 (ง •̀_•́)ง",
    "AI也会摸鱼哦 (￣▽￣)~*",
    "什么？刚睡醒，等我找找 (。-ω-)zzz",
    "答案正在路上 ( •̀ ω •́ )✧"
  ];

  async function refresh() {
    const [modelResult, conversationResult, workspaceResult] = await Promise.all([
      api<{ models: Model[] }>("/api/models"),
      api<{ conversations: Conversation[] }>("/api/conversations"),
      api<{ workspaces: Workspace[] }>("/api/workspaces")
    ]);
    setModels(modelResult.models);
    setConversations(conversationResult.conversations);
    setWorkspaces(workspaceResult.workspaces);
    setDraftModelId((current) => (modelResult.models.some((model) => model.id === current) ? current : modelResult.models[0]?.id || ""));
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const hasLoading = Object.values(loadingByConversation).some(Boolean);
    if (!hasLoading) return;
    const timer = window.setInterval(() => setWaitIndex((index) => index + 1), 1400);
    return () => window.clearInterval(timer);
  }, [loadingByConversation]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const modelId = active?.modelId || draftModelId;
    if (!content.trim() || !modelId) return;
    const isNewConversation = !active;
    const tempId = isNewConversation ? localId("tmp") : "";
    const loadingKey = active?.id || tempId;
    if (loadingByConversation[loadingKey]) return;
    setLoadingByConversation((items) => ({ ...items, [loadingKey]: true }));
    setError("");
    const text = content;
    const userMessage: Message = {
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
        archived: false,
        title: titleFrom(text),
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
      const result = await api<{ conversation: Conversation }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ content: text, modelId, conversationId: isNewConversation ? "" : active.id, workspaceId: draftWorkspaceId })
      });
      setConversations((items) => {
        const rest = items.filter((item) => item.id !== result.conversation.id && item.id !== tempId);
        return [result.conversation, ...rest];
      });
      setActiveId((current) => (current === tempId || current === active?.id ? result.conversation.id : current));
    } catch (err) {
      setContent(text);
      if (tempId) setConversations((items) => items.filter((item) => item.id !== tempId));
      setError(err instanceof Error ? err.message : "发送失败");
    } finally {
      setLoadingByConversation((items) => ({ ...items, [loadingKey]: false }));
    }
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

  async function moveConversationWithPrompt(conversation: Conversation) {
    const options = ["未分组", ...workspaces.map((workspace) => workspace.name)].join("\n");
    const name = prompt(`移动到哪个工作空间？\n${options}`);
    if (name === null) return;
    const targetName = name.trim();
    const workspace = workspaces.find((item) => item.name === targetName);
    if (targetName && !workspace) {
      alert("没有找到这个工作空间，请先新建。");
      return;
    }
    await moveConversation(conversation, workspace?.id || "");
  }

  async function copyMarkdown(content: string) {
    await navigator.clipboard.writeText(content);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="side-top">
          <div className="product">
            <Bot size={24} />
            <span>企业 AI</span>
          </div>
          <button
            className="icon-btn"
            title="新对话"
            onClick={() => {
              setActiveId("");
              setContent("");
              setError("");
              setView("chat");
            }}
          >
            <Plus size={18} />
          </button>
        </div>
        <button className={`nav-item ${!activeId && view === "chat" ? "active" : ""}`} onClick={() => { setActiveId(""); setView("chat"); }}>
          <MessageSquare size={17} />
          新聊天
        </button>
        {user.role === "admin" ? (
          <button className={`nav-item ${view === "admin" ? "active" : ""}`} onClick={() => setView("admin")}>
            <Settings size={16} />
            管理后台
          </button>
        ) : null}
        <div className="sidebar-section">
          <div className="section-title">
            <span>工作空间</span>
            <button className="section-icon" title="新建工作空间" onClick={createWorkspace}><Plus size={14} /></button>
          </div>
        </div>
        <div className="conversation-list">
          {groupedConversations.map((group) => (
            <div className="workspace-group" key={group.id || "default"}>
              <div className="workspace-name"><Folder size={13} />{group.name}</div>
              {group.conversations.map((conversation) => (
                <div className={`conversation-row ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}>
                  <button
                    className="conversation-main"
                    onClick={() => {
                      setActiveId(conversation.id);
                      setView("chat");
                      setError("");
                    }}
                  >
                    <MessageSquare size={16} />
                    <span>{conversation.title}</span>
                  </button>
                  <button className="icon-inline" title="移动" onClick={() => moveConversationWithPrompt(conversation)}>
                    <MoreHorizontal size={14} />
                  </button>
                  <button className="icon-inline" title={conversation.archived ? "取消归档" : "归档"} onClick={() => archiveConversation(conversation)}>
                    <Archive size={14} />
                  </button>
                  <button className="icon-inline danger-inline" title="删除" onClick={() => deleteConversation(conversation)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="side-bottom">
          <button className="nav-item" onClick={() => setShowArchived(!showArchived)}>
            <Archive size={16} />
            {showArchived ? "未归档对话" : "归档对话"}
          </button>
          <button className="ghost" onClick={onLogout}>
            <LogOut size={17} />
            退出
          </button>
        </div>
      </aside>

      {view === "admin" && user.role === "admin" ? (
        <AdminPanel refreshModels={refresh} />
      ) : (
      <section className="chat">
        <header className="chat-header">
          <div className="chat-title">
            <strong>{active?.title || "新对话"}</strong>
            <span>{user.username}</span>
          </div>
          <div className="chat-controls">
          {!active ? (
            <select value={draftWorkspaceId} onChange={(event) => setDraftWorkspaceId(event.target.value)}>
              <option value="">未分组</option>
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
                <div className="avatar">{message.role === "user" ? user.username.slice(0, 1).toUpperCase() : "AI"}</div>
                <div className="bubble">
                  {message.role === "assistant" ? (
                    <>
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      </div>
                      <button className="copy-message" onClick={() => copyMarkdown(message.content)}>
                        <Copy size={14} />
                      </button>
                    </>
                  ) : (
                    <pre>{message.content}</pre>
                  )}
                  {message.imageUrl ? <img className="generated-image" src={message.imageUrl} alt={message.content} /> : null}
                  <small>{dateTime(message.createdAt)}</small>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state">
              <Bot size={44} />
              <h2>选择模型后开始提问</h2>
            </div>
          )}
          {activeLoading ? <div className="typing">{waitMessages[waitIndex % waitMessages.length]}</div> : null}
        </div>

        <form className="composer" onSubmit={send}>
          {error ? <div className="error">{error}</div> : null}
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

function AdminPanel({ refreshModels }: { refreshModels: () => Promise<void> }) {
  const [tab, setTab] = useState<"settings" | "users" | "models" | "tokens" | "records">("settings");
  const [users, setUsers] = useState<User[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [tokens, setTokens] = useState<IntegrationToken[]>([]);
  const [records, setRecords] = useState<(Conversation & { user: User })[]>([]);
  const [settings, setSettings] = useState<SystemSettings>({ safetyRules: "" });
  const [notice, setNotice] = useState("");

  async function load() {
    const [settingsResult, userResult, modelResult, tokenResult, recordResult] = await Promise.all([
      api<{ settings: SystemSettings }>("/api/admin/settings"),
      api<{ users: User[] }>("/api/admin/users"),
      api<{ models: Model[] }>("/api/admin/models"),
      api<{ tokens: IntegrationToken[] }>("/api/admin/integration-tokens"),
      api<{ conversations: (Conversation & { user: User })[] }>("/api/admin/conversations")
    ]);
    setSettings(settingsResult.settings);
    setUsers(userResult.users);
    setModels(modelResult.models);
    setTokens(tokenResult.tokens);
    setRecords(recordResult.conversations);
  }

  useEffect(() => {
    load().catch((err) => setNotice(err.message));
  }, []);

  return (
      <section className="admin-page">
        <header className="admin-header">
          <div>
            <h2>管理后台</h2>
            <p>账号、模型、机器人 API 和对话审计</p>
          </div>
        </header>
        <nav className="tabs">
          <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Shield size={16} />规则</button>
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}><Users size={16} />账号</button>
          <button className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}><Bot size={16} />模型</button>
          <button className={tab === "tokens" ? "active" : ""} onClick={() => setTab("tokens")}><KeyRound size={16} />API Token</button>
          <button className={tab === "records" ? "active" : ""} onClick={() => setTab("records")}><MessageSquare size={16} />记录</button>
        </nav>
        {notice ? <div className="notice">{notice}</div> : null}
        <div className="admin-body">
          {tab === "settings" ? <SettingsTab settings={settings} setNotice={setNotice} reload={load} /> : null}
          {tab === "users" ? <UsersTab users={users} reload={load} /> : null}
          {tab === "models" ? <ModelsTab models={models} reload={async () => { await load(); await refreshModels(); }} /> : null}
          {tab === "tokens" ? <TokensTab tokens={tokens} reload={load} setNotice={setNotice} /> : null}
          {tab === "records" ? <RecordsTab records={records} users={users} /> : null}
        </div>
      </section>
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

  async function createUser(event: FormEvent) {
    event.preventDefault();
    await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username, password, role: "user" }) });
    setUsername("");
    setPassword("");
    await reload();
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

  return (
    <div className="admin-grid">
      <form className="admin-form" onSubmit={createUser}>
        <h3><UserPlus size={17} />开通账号</h3>
        <input placeholder="用户名" value={username} onChange={(event) => setUsername(event.target.value)} />
        <input placeholder="初始密码" value={password} onChange={(event) => setPassword(event.target.value)} />
        <button className="primary"><Plus size={16} />创建</button>
      </form>
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
                <label className="field-label">新密码<input placeholder="留空不改" value={editing[user.id].password} onChange={(event) => setEditing({ ...editing, [user.id]: { ...editing[user.id], password: event.target.value } })} /></label>
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
    baseUrl: "https://app.yylx.io/v1",
    apiKey: "",
    model: "",
    systemPrompt: "",
    enabled: true
  });
  const [editing, setEditing] = useState<Record<string, { name: string; kind: "chat" | "image"; baseUrl: string; model: string; apiKey: string; systemPrompt: string; enabled: boolean }>>({});

  async function createModel(event: FormEvent) {
    event.preventDefault();
    await api("/api/admin/models", { method: "POST", body: JSON.stringify(form) });
    setForm({ name: "", kind: "chat", baseUrl: "https://app.yylx.io/v1", apiKey: "", model: "", systemPrompt: "", enabled: true });
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
        <h3><Bot size={17} />接入模型</h3>
        <input placeholder="展示名称，如 通义千问" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as "chat" | "image" })}>
          <option value="chat">聊天模型</option>
          <option value="image">图片模型</option>
        </select>
        <input placeholder="Base URL，如 https://dashscope.aliyuncs.com/compatible-mode/v1" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        <input placeholder="API Key" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
        <input placeholder="模型 ID，如 qwen-plus / gpt-image-2" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} />
        <textarea placeholder="模型默认 System Prompt，可留空" value={form.systemPrompt} rows={4} onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })} />
        <label className="check"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />启用</label>
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
                <label className="field-label">Base URL<input value={editing[model.id].baseUrl} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], baseUrl: event.target.value } })} /></label>
                <label className="field-label">模型 ID<input value={editing[model.id].model} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], model: event.target.value } })} /></label>
                <label className="field-label">API Key<input value={editing[model.id].apiKey} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], apiKey: event.target.value } })} /></label>
                <label className="field-label model-prompt-field">System Prompt<textarea rows={4} value={editing[model.id].systemPrompt} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], systemPrompt: event.target.value } })} /></label>
                <label className="inline-check"><input type="checkbox" checked={editing[model.id].enabled} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], enabled: event.target.checked } })} />启用</label>
                <button className="secondary" onClick={() => saveModel(model)}><Save size={15} />保存</button>
              </>
            ) : (
              <>
                <span>{model.name}<small>{model.kind === "image" ? "图片" : "聊天"} · {model.model}</small></span>
                <span>{model.hasApiKey ? "已配置 Key" : "缺少 Key"}</span>
                <button className="secondary" onClick={() => setEditing({ ...editing, [model.id]: { name: model.name, kind: model.kind, baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey || "", systemPrompt: model.systemPrompt || "", enabled: model.enabled } })}><Edit3 size={15} />编辑</button>
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

function RecordsTab({ records, users }: { records: (Conversation & { user: User })[]; users: User[] }) {
  const [userId, setUserId] = useState("");
  const filtered = userId ? records.filter((record) => record.userId === userId) : records;

  return (
    <div className="records">
      <div className="record-filter">
        <select value={userId} onChange={(event) => setUserId(event.target.value)}>
          <option value="">全部账号</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>{user.username}</option>
          ))}
        </select>
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

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    api<{ user: User }>("/api/me")
      .then((result) => setUser(result.user))
      .catch(() => localStorage.removeItem(tokenKey))
      .finally(() => setBooting(false));
  }, []);

  if (booting) return <div className="boot">加载中...</div>;
  if (!user) return <Login onDone={setUser} />;
  return (
    <ChatApp
      user={user}
      onLogout={() => {
        localStorage.removeItem(tokenKey);
        setUser(null);
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
