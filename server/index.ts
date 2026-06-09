import express, { Request, RequestHandler, Response } from "express";
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BailianCompanyKnowledgeService,
  BailianMemoryService,
  RetrievedItem,
  RetrievedMemory,
  companyKnowledgeConfig,
  memoryConfig,
  memoryUserId
} from "./bailian.js";
import { store } from "./db.js";
import { asyncRoute, auth, requireRole } from "./middleware.js";
import { MemorySyncScheduler } from "./memorySync.js";
import { callModel } from "./modelGateway.js";
import { buildPromptContext } from "./promptContext.js";
import { createPlainToken, hashPassword, hashToken, signToken, uid, verifyPassword } from "./security.js";
import { adminModel, publicModel, publicUser } from "./serializers.js";
import { Conversation, Message, MessageRecord, ModelConfig, RagRetrievalLog, User, UserSavedMemory, Workspace } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const app = express();
const port = Number(process.env.PORT ?? 3001);
const jwtSecret = process.env.JWT_SECRET ?? "dev-secret-change-me";
const companyKnowledgeService = new BailianCompanyKnowledgeService();
const memoryService = new BailianMemoryService();
const memorySyncScheduler = new MemorySyncScheduler(store, memoryService);
const userMemoryMaxItems = 10;
const userMemoryMaxChars = 200;
const userMemoryMaxTotalChars = 2000;

app.use(express.json({ limit: "2mb" }));

function now() {
  return new Date().toISOString();
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field}不能为空`);
  return value.trim();
}

function titleFrom(content: string) {
  return content.replace(/\s+/g, " ").slice(0, 32) || "新对话";
}

function hasExplicitMemoryIntent(content: string) {
  return /(?:请)?(?:记住|记得|帮我记|你要记)|我的名字(?:是|叫)|我叫/.test(content);
}

function estimateTokenCount(content: string) {
  return Math.ceil(content.length / 4);
}

function messageRecord(message: Message, params: { companyId: string; userId: string; conversationId: string }): MessageRecord {
  return {
    id: message.id ?? uid("msg"),
    companyId: params.companyId,
    userId: params.userId,
    conversationId: params.conversationId,
    role: message.role,
    content: message.content,
    imageUrl: message.imageUrl,
    modelId: message.modelId,
    tokenCount: estimateTokenCount(message.content),
    createdAt: message.createdAt
  };
}

async function logRetrieval(log: Omit<RagRetrievalLog, "id" | "createdAt">) {
  await store.mutate((db) => {
    db.ragRetrievalLogs.push({ ...log, id: uid("rag"), createdAt: now() });
    if (db.ragRetrievalLogs.length > 1000) db.ragRetrievalLogs.splice(0, db.ragRetrievalLogs.length - 1000);
  });
}

async function createUserMemory(params: {
  user: User;
  content: string;
  conversationId?: string;
  sourceMessageId?: string;
}) {
  const content = params.content.trim();
  if (!content) throw new Error("记忆内容不能为空");
  if (content.length > userMemoryMaxChars) throw new Error(`单条记忆不能超过 ${userMemoryMaxChars} 字`);
  const createdAt = now();
  return store.mutate((db) => {
    const active = db.userSavedMemories.filter(
      (memory) =>
        memory.companyId === params.user.companyId &&
        memory.userId === params.user.id &&
        memory.status === "active"
    );
    if (params.sourceMessageId) {
      const existing = active.find((memory) => memory.sourceMessageId === params.sourceMessageId);
      if (existing) return existing;
    }
    if (active.length >= userMemoryMaxItems) throw new Error(`最多保存 ${userMemoryMaxItems} 条记忆`);
    const totalChars = active.reduce((total, memory) => total + memory.content.length, 0);
    if (totalChars + content.length > userMemoryMaxTotalChars) {
      throw new Error(`记忆总字数不能超过 ${userMemoryMaxTotalChars} 字`);
    }
    const memory: UserSavedMemory = {
      id: uid("usm"),
      companyId: params.user.companyId,
      userId: params.user.id,
      conversationId: params.conversationId,
      sourceMessageId: params.sourceMessageId,
      content,
      memoryUserId: memoryUserId(params.user.companyId, params.user.id),
      status: "active",
      createdAt,
      updatedAt: createdAt
    };
    db.userSavedMemories.push(memory);
    return memory;
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const username = requiredString(req.body.username, "用户名");
  const password = requiredString(req.body.password, "密码");
  const db = await store.read();
  const user = db.users.find((item) => item.username === username && item.enabled);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "用户名或密码错误" });
  }
  const token = signToken({ sub: user.id, role: user.role }, jwtSecret);
  res.json({ token, user: publicUser(user) });
}));

app.get("/api/me", auth(jwtSecret), (req, res) => {
  res.json({ user: publicUser(req.user!) });
});

app.get("/api/models", auth(jwtSecret), asyncRoute(async (_req, res) => {
  const db = await store.read();
  const models = db.models.filter((model) => model.enabled && model.apiKey).map(publicModel);
  res.json({ models });
}));

app.get("/api/conversations", auth(jwtSecret), asyncRoute(async (req, res) => {
  const db = await store.read();
  const conversations = db.conversations
    .filter((conversation) => conversation.userId === req.user!.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ conversations });
}));

app.get("/api/workspaces", auth(jwtSecret), asyncRoute(async (req, res) => {
  const db = await store.read();
  const workspaces = db.workspaces
    .filter((workspace) => workspace.userId === req.user!.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  res.json({ workspaces });
}));

app.post("/api/workspaces", auth(jwtSecret), asyncRoute(async (req, res) => {
  const name = requiredString(req.body.name, "工作空间名称");
  const workspace = await store.mutate((db) => {
    const created: Workspace = {
      id: uid("wsp"),
      userId: req.user!.id,
      name,
      createdAt: now()
    };
    db.workspaces.push(created);
    return created;
  });
  res.json({ workspace });
}));

app.post(
  "/api/chat",
  auth(jwtSecret),
  asyncRoute(async (req, res) => {
    const content = requiredString(req.body.content, "消息");
    const modelId = requiredString(req.body.modelId, "模型");
    const conversationId = typeof req.body.conversationId === "string" ? req.body.conversationId : "";

    const db = await store.read();
    const existing = conversationId
      ? db.conversations.find((item) => item.id === conversationId && item.userId === req.user!.id)
      : undefined;
    const lockedModelId = existing?.modelId || modelId;
    const model = db.models.find((item) => item.id === lockedModelId && item.enabled);
    if (!model) return res.status(404).json({ error: "模型不存在或未启用" });

    const userMessage: Message = {
      id: uid("msg"),
      role: "user",
      content,
      modelId: model.id,
      createdAt: now()
    };
    const conversation = await store.mutate((mutableDb) => {
      if (existing) {
        const target = mutableDb.conversations.find((item) => item.id === existing.id && item.userId === req.user!.id)!;
        target.messages.push(userMessage);
        target.updatedAt = userMessage.createdAt;
        mutableDb.messages.push(messageRecord(userMessage, {
          companyId: req.user!.companyId,
          userId: req.user!.id,
          conversationId: target.id
        }));
        return target;
      }
      const created: Conversation = {
        id: uid("cnv"),
        userId: req.user!.id,
        modelId: model.id,
        workspaceId: typeof req.body.workspaceId === "string" ? req.body.workspaceId : undefined,
        archived: false,
        title: titleFrom(content),
        messages: [userMessage],
        createdAt: userMessage.createdAt,
        updatedAt: userMessage.createdAt
      };
      mutableDb.conversations.push(created);
      mutableDb.messages.push(messageRecord(userMessage, {
        companyId: req.user!.companyId,
        userId: req.user!.id,
        conversationId: created.id
      }));
      return created;
    });

    const [implicitMemories, companyKnowledge]: [RetrievedMemory[], RetrievedItem[]] = model.kind === "chat"
      ? await Promise.all([
          memoryService.searchMemory({ companyId: req.user!.companyId, userId: req.user!.id, query: content }).catch(() => []),
          companyKnowledgeService.retrieveCompanyKnowledge({ companyId: req.user!.companyId, userId: req.user!.id, query: content }).catch(() => [])
        ])
      : [[], []];

    const latestDb = await store.read();
    const explicitMemories: RetrievedMemory[] = latestDb.userSavedMemories
      .filter(
        (memory) =>
          memory.companyId === req.user!.companyId &&
          memory.userId === req.user!.id &&
          memory.status === "active"
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((memory) => ({
        text: memory.content,
        memoryId: memory.id,
        memoryType: "user_saved",
        createdAt: memory.createdAt,
        metadata: { visibility: "explicit" }
      }));
    const memories = [...explicitMemories, ...implicitMemories];
    const recentMessages = latestDb.messages
      .filter((message) => message.conversationId === conversation.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-12);
    const injectedContext = model.kind === "chat"
      ? buildPromptContext({ memories, companyKnowledge, recentMessages })
      : "";
    if (model.kind === "chat") {
      await Promise.all([
        logRetrieval({
          companyId: req.user!.companyId,
          userId: req.user!.id,
          conversationId: conversation.id,
          query: content,
          sourceType: "memory_library",
          matchedItemsJson: implicitMemories,
          injectedContext,
          threshold: memoryConfig.threshold,
          topK: memoryConfig.topK
        }),
        logRetrieval({
          companyId: req.user!.companyId,
          userId: req.user!.id,
          conversationId: conversation.id,
          query: content,
          sourceType: "company_kb",
          matchedItemsJson: companyKnowledge,
          injectedContext,
          threshold: companyKnowledgeConfig.threshold,
          topK: companyKnowledgeConfig.topK
        })
      ]);
    }

    const modelMessages: Message[] = model.kind === "chat"
      ? [
          { role: "system", content: injectedContext, modelId: model.id, createdAt: now() },
          userMessage
        ]
      : conversation.messages;
    const result = await callModel(model, modelMessages, db.settings.safetyRules);
    const assistantMessage: Message = {
      id: uid("msg"),
      role: "assistant",
      content: result.content,
      imageUrl: result.imageUrl,
      modelId: model.id,
      createdAt: now()
    };

    const savedConversation = await store.mutate((mutableDb) => {
      const target = mutableDb.conversations.find((item) => item.id === conversation.id && item.userId === req.user!.id);
      if (!target) throw new Error("对话不存在");
      target.messages.push(assistantMessage);
      target.updatedAt = assistantMessage.createdAt;
      mutableDb.messages.push(messageRecord(assistantMessage, {
        companyId: req.user!.companyId,
        userId: req.user!.id,
        conversationId: target.id
      }));
      return target;
    });

    let memoryNotice = "";
    if (model.kind === "chat" && hasExplicitMemoryIntent(content)) {
      try {
        await createUserMemory({
          user: req.user!,
          conversationId: savedConversation.id,
          sourceMessageId: userMessage.id!,
          content
        });
        memoryNotice = "已记录到我的记忆";
      } catch (err) {
        memoryNotice = err instanceof Error ? err.message : "记忆保存失败";
      }
    }

    res.json({ conversation: savedConversation, message: assistantMessage, memoryNotice });
  })
);

app.patch("/api/conversations/:id", auth(jwtSecret), asyncRoute(async (req, res) => {
  const conversation = await store.mutate((db) => {
    const target = db.conversations.find((item) => item.id === req.params.id && item.userId === req.user!.id);
    if (!target) throw new Error("对话不存在");
    if (typeof req.body.archived === "boolean") target.archived = req.body.archived;
    if (typeof req.body.workspaceId === "string") target.workspaceId = req.body.workspaceId || undefined;
    target.updatedAt = now();
    return target;
  });
  res.json({ conversation });
}));

app.delete("/api/conversations/:id", auth(jwtSecret), asyncRoute(async (req, res) => {
  await store.mutate((db) => {
    const index = db.conversations.findIndex((item) => item.id === req.params.id && item.userId === req.user!.id);
    if (index === -1) throw new Error("对话不存在");
    db.conversations.splice(index, 1);
    db.messages = db.messages.filter((message) => message.conversationId !== req.params.id || message.userId !== req.user!.id);
    db.memorySyncStates = db.memorySyncStates.filter((state) => state.conversationId !== req.params.id || state.userId !== req.user!.id);
  });
  res.json({ ok: true });
}));

app.get("/api/memories", auth(jwtSecret), asyncRoute(async (req, res) => {
  const db = await store.read();
  const memories = db.userSavedMemories
    .filter(
      (memory) =>
        memory.companyId === req.user!.companyId &&
        memory.userId === req.user!.id &&
        memory.status === "active"
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((memory) => ({
      id: memory.id,
      text: memory.content,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt
    }));
  res.json({
    memories,
    limits: {
      maxItems: userMemoryMaxItems,
      maxCharsPerItem: userMemoryMaxChars,
      maxTotalChars: userMemoryMaxTotalChars,
      usedItems: memories.length,
      usedChars: memories.reduce((total, memory) => total + memory.text.length, 0)
    }
  });
}));

app.post("/api/memories", auth(jwtSecret), asyncRoute(async (req, res) => {
  const memory = await createUserMemory({
    user: req.user!,
    content: requiredString(req.body.content, "记忆内容")
  });
  res.json({ memory });
}));

app.post("/api/memories/save", auth(jwtSecret), asyncRoute(async (req, res) => {
  const conversationId = requiredString(req.body.conversation_id ?? req.body.conversationId, "conversation_id");
  const content = requiredString(req.body.content, "记忆内容");
  const messageId = typeof (req.body.message_id ?? req.body.messageId) === "string" ? (req.body.message_id ?? req.body.messageId).trim() : "";
  const db = await store.read();
  const conversation = db.conversations.find((item) => item.id === conversationId && item.userId === req.user!.id);
  if (!conversation) return res.status(404).json({ error: "对话不存在" });
  if (messageId && !db.messages.some((message) => message.id === messageId && message.conversationId === conversationId && message.userId === req.user!.id)) {
    return res.status(403).json({ error: "无权保存该消息" });
  }

  const saved = await createUserMemory({
    user: req.user!,
    conversationId,
    sourceMessageId: messageId || undefined,
    content
  });
  res.json({ ok: true, memory: saved });
}));

app.patch("/api/memories/:id", auth(jwtSecret), asyncRoute(async (req, res) => {
  const content = requiredString(req.body.content, "记忆内容");
  if (content.length > userMemoryMaxChars) throw new Error(`单条记忆不能超过 ${userMemoryMaxChars} 字`);
  const memory = await store.mutate((db) => {
    const target = db.userSavedMemories.find(
      (item) =>
        item.id === req.params.id &&
        item.companyId === req.user!.companyId &&
        item.userId === req.user!.id &&
        item.status === "active"
    );
    if (!target) throw new Error("记忆不存在");
    const usedChars = db.userSavedMemories
      .filter(
        (item) =>
          item.id !== target.id &&
          item.companyId === req.user!.companyId &&
          item.userId === req.user!.id &&
          item.status === "active"
      )
      .reduce((total, item) => total + item.content.length, 0);
    if (usedChars + content.length > userMemoryMaxTotalChars) {
      throw new Error(`记忆总字数不能超过 ${userMemoryMaxTotalChars} 字`);
    }
    target.content = content;
    target.updatedAt = now();
    return target;
  });
  res.json({ memory });
}));

app.post("/api/conversations/:id/save-to-memory", auth(jwtSecret), asyncRoute(async (req, res) => {
  const db = await store.read();
  const conversation = db.conversations.find((item) => item.id === req.params.id && item.userId === req.user!.id);
  if (!conversation) return res.status(404).json({ error: "对话不存在" });
  await memorySyncScheduler.submitConversation(conversation.id, memoryConfig.maxMessagesPerBatch);
  res.json({ ok: true });
}));

app.delete("/api/memories/:id", auth(jwtSecret), asyncRoute(async (req, res) => {
  const memoryId = String(req.params.id);
  const memory = await store.mutate((db) => {
    const target = db.userSavedMemories.find(
      (item) =>
        item.id === memoryId &&
        item.userId === req.user!.id &&
        item.companyId === req.user!.companyId &&
        item.status === "active"
    );
    if (!target) throw new Error("记忆不存在");
    target.status = "deleted";
    target.updatedAt = now();
    return target;
  });
  if (memory.bailianMemoryId) {
    await memoryService.deleteMemory({
      companyId: req.user!.companyId,
      userId: req.user!.id,
      memoryId: memory.bailianMemoryId
    }).catch(() => undefined);
  }
  res.json({ ok: true });
}));

const admin: RequestHandler[] = [auth(jwtSecret), requireRole("admin")];

app.get("/api/admin/settings", ...admin, asyncRoute(async (_req, res) => {
  const db = await store.read();
  res.json({ settings: db.settings });
}));

app.patch("/api/admin/settings", ...admin, asyncRoute(async (req, res) => {
  const settings = await store.mutate((db) => {
    if (typeof req.body.safetyRules === "string") db.settings.safetyRules = req.body.safetyRules;
    return db.settings;
  });
  res.json({ settings });
}));

app.get("/api/admin/users", ...admin, asyncRoute(async (_req, res) => {
  const db = await store.read();
  res.json({ users: db.users.map(publicUser) });
}));

app.post("/api/admin/users", ...admin, asyncRoute(async (req, res) => {
  const username = requiredString(req.body.username, "用户名");
  const password = requiredString(req.body.password, "密码");
  const role = req.body.role === "admin" ? "admin" : "user";
  const user = await store.mutate((db) => {
    if (db.users.some((item) => item.username === username)) throw new Error("用户名已存在");
    const created: User = {
      id: uid("usr"),
      companyId: req.user!.companyId,
      username,
      passwordHash: hashPassword(password),
      role,
      enabled: true,
      createdAt: now()
    };
    db.users.push(created);
    return created;
  });
  res.json({ user: publicUser(user) });
}));

app.patch("/api/admin/users/:id", ...admin, asyncRoute(async (req, res) => {
  const user = await store.mutate((db) => {
    const target = db.users.find((item) => item.id === req.params.id);
    if (!target) throw new Error("用户不存在");
    if (typeof req.body.username === "string" && req.body.username.trim()) {
      const username = req.body.username.trim();
      if (db.users.some((item) => item.id !== target.id && item.username === username)) throw new Error("用户名已存在");
      target.username = username;
    }
    if (typeof req.body.enabled === "boolean") target.enabled = req.body.enabled;
    if (req.body.role === "admin" || req.body.role === "user") target.role = req.body.role;
    if (typeof req.body.password === "string" && req.body.password.trim()) {
      target.passwordHash = hashPassword(req.body.password.trim());
    }
    return target;
  });
  res.json({ user: publicUser(user) });
}));

app.delete("/api/admin/users/:id", ...admin, asyncRoute(async (req, res) => {
  if (req.params.id === req.user!.id) throw new Error("不能删除当前登录的管理员账号");
  await store.mutate((db) => {
    const index = db.users.findIndex((item) => item.id === req.params.id);
    if (index === -1) throw new Error("用户不存在");
    db.users.splice(index, 1);
    db.conversations = db.conversations.filter((conversation) => conversation.userId !== req.params.id);
    db.messages = db.messages.filter((message) => message.userId !== req.params.id);
    db.memorySyncStates = db.memorySyncStates.filter((state) => state.userId !== req.params.id);
    db.userSavedMemories = db.userSavedMemories.filter((memory) => memory.userId !== req.params.id);
  });
  res.json({ ok: true });
}));

app.get("/api/admin/models", ...admin, asyncRoute(async (_req, res) => {
  const db = await store.read();
  res.json({ models: db.models.map(adminModel) });
}));

app.post("/api/admin/models", ...admin, asyncRoute(async (req, res) => {
  const created = await store.mutate((db) => {
    const model: ModelConfig = {
      id: uid("mdl"),
      name: requiredString(req.body.name, "展示名称"),
      provider: typeof req.body.provider === "string" && req.body.provider.trim() ? req.body.provider.trim() : "yylx",
      kind: req.body.kind === "image" ? "image" : "chat",
      baseUrl: requiredString(req.body.baseUrl, "Base URL"),
      apiKey: typeof req.body.apiKey === "string" ? req.body.apiKey.trim() : "",
      model: requiredString(req.body.model, "模型 ID"),
      systemPrompt: typeof req.body.systemPrompt === "string" ? req.body.systemPrompt : "",
      enabled: Boolean(req.body.enabled),
      createdAt: now()
    };
    db.models.push(model);
    return model;
  });
  res.json({ model: publicModel(created) });
}));

app.patch("/api/admin/models/:id", ...admin, asyncRoute(async (req, res) => {
  const model = await store.mutate((db) => {
    const target = db.models.find((item) => item.id === req.params.id);
    if (!target) throw new Error("模型不存在");
    for (const field of ["name", "baseUrl", "model"] as const) {
      if (typeof req.body[field] === "string" && req.body[field].trim()) target[field] = req.body[field].trim();
    }
    if (typeof req.body.systemPrompt === "string") target.systemPrompt = req.body.systemPrompt;
    if (req.body.kind === "image" || req.body.kind === "chat") target.kind = req.body.kind;
    if (typeof req.body.apiKey === "string") target.apiKey = req.body.apiKey.trim();
    if (typeof req.body.enabled === "boolean") target.enabled = req.body.enabled;
    return target;
  });
  res.json({ model: publicModel(model) });
}));

app.delete("/api/admin/models/:id", ...admin, asyncRoute(async (req, res) => {
  await store.mutate((db) => {
    const index = db.models.findIndex((item) => item.id === req.params.id);
    if (index === -1) throw new Error("模型不存在");
    db.models.splice(index, 1);
  });
  res.json({ ok: true });
}));

app.get("/api/admin/conversations", ...admin, asyncRoute(async (req, res) => {
  const db = await store.read();
  const userId = typeof req.query.userId === "string" ? req.query.userId : "";
  const conversations = db.conversations
    .filter((conversation) => (userId ? conversation.userId === userId : true))
    .map((conversation) => ({
      ...conversation,
      user: publicUser(db.users.find((user) => user.id === conversation.userId)!)
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ conversations });
}));

app.get("/api/admin/integration-tokens", ...admin, asyncRoute(async (_req, res) => {
  const db = await store.read();
  const tokens = db.integrationTokens.map(({ tokenHash, ...token }) => token);
  res.json({ tokens });
}));

app.post("/api/admin/integration-tokens", ...admin, asyncRoute(async (req, res) => {
  const name = requiredString(req.body.name, "名称");
  const plainToken = createPlainToken();
  const token = await store.mutate((db) => {
    const created = {
      id: uid("tok"),
      name,
      token: plainToken,
      tokenHash: hashToken(plainToken),
      enabled: true,
      createdAt: now()
    };
    db.integrationTokens.push(created);
    return created;
  });
  const { tokenHash, ...safe } = token;
  res.json({ token: safe });
}));

app.patch("/api/admin/integration-tokens/:id", ...admin, asyncRoute(async (req, res) => {
  const token = await store.mutate((db) => {
    const target = db.integrationTokens.find((item) => item.id === req.params.id);
    if (!target) throw new Error("Token不存在");
    if (typeof req.body.enabled === "boolean") target.enabled = req.body.enabled;
    return target;
  });
  const { tokenHash, ...safe } = token;
  res.json({ token: safe });
}));

app.post(
  "/api/integrations/chat",
  asyncRoute(async (req: Request, res: Response) => {
    const header = req.headers.authorization;
    const plainToken = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const db = await store.read();
    const token = db.integrationTokens.find((item) => item.enabled && item.tokenHash === hashToken(plainToken));
    if (!token) return res.status(401).json({ error: "机器人 Token 无效" });

    const content = requiredString(req.body.content, "消息");
    const modelId = typeof req.body.modelId === "string" ? req.body.modelId : "";
    const model = db.models.find((item) => item.enabled && (modelId ? item.id === modelId : true));
    if (!model) return res.status(404).json({ error: "没有可用模型" });

    const result = await callModel(model, [
      {
        role: "user",
        content,
        modelId: model.id,
        createdAt: now()
      }
    ], db.settings.safetyRules);
    res.json({ reply: result.content, imageUrl: result.imageUrl, modelId: model.id });
  })
);

app.use((err: Error, _req: Request, res: Response, _next: unknown) => {
  res.status(400).json({ error: err.message || "请求处理失败" });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(root, "dist")));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(root, "dist", "index.html")));
}

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});

memorySyncScheduler.start();
