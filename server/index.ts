import express, { Request, RequestHandler, Response } from "express";
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { readSheet } from "read-excel-file/node";
import { parse as parseCsv } from "csv-parse/sync";
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
const jwtSecret = process.env.JWT_SECRET?.trim() || "dev-secret-change-me";
const companyKnowledgeService = new BailianCompanyKnowledgeService();
const memoryService = new BailianMemoryService();
const memorySyncScheduler = new MemorySyncScheduler(store, memoryService);
const userMemoryMaxItems = 10;
const userMemoryMaxChars = 200;
const userMemoryMaxTotalChars = 2000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const userImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

if (process.env.NODE_ENV === "production" && jwtSecret === "dev-secret-change-me") {
  throw new Error("生产环境必须配置安全的 JWT_SECRET");
}

app.use(express.json({ limit: "2mb" }));
app.set("trust proxy", "loopback");
app.disable("x-powered-by");
app.use((req, res, next) => {
  const requestId = req.headers["x-request-id"]?.toString().trim() || uid("req");
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin;
  const allowedOrigin = process.env.APP_ORIGIN?.trim();
  if (req.method !== "GET" && req.method !== "HEAD" && origin && allowedOrigin && origin !== allowedOrigin) {
    return res.status(403).json({ error: "请求来源无效" });
  }
  next();
});

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
  const attemptKey = req.ip || req.socket.remoteAddress || "unknown";
  const currentTime = Date.now();
  const attempt = loginAttempts.get(attemptKey);
  if (attempt && attempt.resetAt > currentTime && attempt.count >= 8) {
    return res.status(429).json({ error: "登录尝试过多，请 15 分钟后再试" });
  }
  if (attempt && attempt.resetAt <= currentTime) loginAttempts.delete(attemptKey);
  const username = requiredString(req.body.username, "用户名");
  const password = requiredString(req.body.password, "密码");
  const db = await store.read();
  const user = db.users.find((item) => item.username === username && item.enabled);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    const latest = loginAttempts.get(attemptKey);
    loginAttempts.set(attemptKey, {
      count: (latest?.count ?? 0) + 1,
      resetAt: latest?.resetAt && latest.resetAt > currentTime ? latest.resetAt : currentTime + 15 * 60 * 1000
    });
    return res.status(401).json({ error: "用户名或密码错误" });
  }
  loginAttempts.delete(attemptKey);
  const token = signToken({ sub: user.id, role: user.role }, jwtSecret);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `gplan_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`);
  res.json({ user: publicUser(user) });
}));

app.get("/api/me", auth(jwtSecret), (req, res) => {
  res.json({ user: publicUser(req.user!) });
});

app.post("/api/me/password", auth(jwtSecret), asyncRoute(async (req, res) => {
  const currentPassword = requiredString(req.body.currentPassword, "当前密码");
  const newPassword = requiredString(req.body.newPassword, "新密码");
  if (newPassword.length < 8) throw new Error("新密码至少需要 8 个字符");
  if (currentPassword === newPassword) throw new Error("新密码不能与当前密码相同");
  await store.mutate((db) => {
    const target = db.users.find((item) => item.id === req.user!.id && item.enabled);
    if (!target || !verifyPassword(currentPassword, target.passwordHash)) throw new Error("当前密码错误");
    target.passwordHash = hashPassword(newPassword);
  });
  res.json({ ok: true });
}));

app.post("/api/auth/logout", (_req, res) => {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `gplan_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
  res.json({ ok: true });
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
        const staleMessageIds: string[] = [];
        while (target.messages.at(-1)?.role === "user") {
          const stale = target.messages.pop();
          if (stale?.id) staleMessageIds.push(stale.id);
        }
        if (staleMessageIds.length) {
          mutableDb.messages = mutableDb.messages.filter((message) => !staleMessageIds.includes(message.id));
        }
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
      .filter((message) => message.conversationId === conversation.id && message.id !== userMessage.id)
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
    let result;
    try {
      result = await callModel(model, modelMessages, db.settings.safetyRules, res.locals.requestId);
    } catch (error) {
      await store.mutate((mutableDb) => {
        const target = mutableDb.conversations.find((item) => item.id === conversation.id && item.userId === req.user!.id);
        if (!target) return;
        target.messages = target.messages.filter((message) => message.id !== userMessage.id);
        mutableDb.messages = mutableDb.messages.filter((message) => message.id !== userMessage.id);
        const lastMessage = target.messages.at(-1);
        if (lastMessage) target.updatedAt = lastMessage.createdAt;
        if (!target.messages.length) {
          mutableDb.conversations = mutableDb.conversations.filter((item) => item.id !== target.id);
        }
      });
      throw error;
    }
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
  if (password.length < 8) throw new Error("密码至少需要 8 个字符");
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

app.get("/api/admin/users/import-template", ...admin, (_req, res) => {
  const template = "\uFEFF用户名\nzhangsan\nlisi\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''xiaoxiang-user-import-template.csv");
  res.send(template);
});

app.post(
  "/api/admin/users/import",
  ...admin,
  userImportUpload.single("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) throw new Error("请选择 CSV 或 XLSX 文件");
    const password = requiredString(req.body.password, "统一初始密码");
    if (password.length < 8) throw new Error("统一初始密码至少需要 8 个字符");
    const extension = path.extname(req.file.originalname).toLowerCase();
    let rows: unknown[][];
    if (extension === ".xlsx") {
      rows = await readSheet(req.file.buffer);
    } else if (extension === ".csv") {
      rows = parseCsv(req.file.buffer, {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true
      }) as unknown[][];
    } else {
      throw new Error("仅支持 .csv 和 .xlsx 文件");
    }
    if (!rows.length) throw new Error("文件中没有可导入的账号");
    if (rows.length > 1001) throw new Error("单次最多导入 1000 个账号");

    const headerAliases = new Set(["用户名", "账号", "username", "account", "user"]);
    const firstValue = String(rows[0]?.[0] ?? "").trim().toLowerCase();
    const dataRows = headerAliases.has(firstValue) ? rows.slice(1) : rows;
    const candidates = dataRows
      .map((row, index) => ({
        row: index + (headerAliases.has(firstValue) ? 2 : 1),
        username: String(row?.[0] ?? "").trim()
      }))
      .filter((item) => item.username);
    if (!candidates.length) throw new Error("没有识别到账号，请把账号放在第一列");

    const result = await store.mutate((db) => {
      const existingNames = new Set(db.users.map((item) => item.username.toLowerCase()));
      const seen = new Set<string>();
      const created: string[] = [];
      const skipped: Array<{ row: number; username: string; reason: string }> = [];
      for (const candidate of candidates) {
        const normalized = candidate.username.toLowerCase();
        if (candidate.username.length > 64) {
          skipped.push({ ...candidate, reason: "账号超过 64 个字符" });
          continue;
        }
        if (existingNames.has(normalized)) {
          skipped.push({ ...candidate, reason: "账号已存在" });
          continue;
        }
        if (seen.has(normalized)) {
          skipped.push({ ...candidate, reason: "文件内重复" });
          continue;
        }
        seen.add(normalized);
        db.users.push({
          id: uid("usr"),
          companyId: req.user!.companyId,
          username: candidate.username,
          passwordHash: hashPassword(password),
          role: "user",
          enabled: true,
          createdAt: now()
        });
        existingNames.add(normalized);
        created.push(candidate.username);
      }
      return { created, skipped };
    });
    res.json({
      createdCount: result.created.length,
      skippedCount: result.skipped.length,
      created: result.created,
      skipped: result.skipped
    });
  })
);

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
      if (req.body.password.trim().length < 8) throw new Error("密码至少需要 8 个字符");
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
    if (typeof req.body.apiKey === "string" && req.body.apiKey.trim()) target.apiKey = req.body.apiKey.trim();
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
      tokenHash: hashToken(plainToken),
      enabled: true,
      createdAt: now()
    };
    db.integrationTokens.push(created);
    return { ...created, token: plainToken };
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
    ], db.settings.safetyRules, res.locals.requestId);
    res.json({ reply: result.content, imageUrl: result.imageUrl, modelId: model.id });
  })
);

app.use((err: Error, req: Request, res: Response, _next: unknown) => {
  const message = err.message || "请求处理失败";
  const status = /响应超时|无法连接模型服务/.test(message) ? 504 : 400;
  console.error(JSON.stringify({
    event: "request_failed",
    requestId: res.locals.requestId,
    method: req.method,
    path: req.path,
    status,
    error: message
  }));
  res.status(status).json({ error: message, requestId: res.locals.requestId });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(root, "dist"), {
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (/\.(?:png|webp|ico)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=604800");
      } else if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    }
  }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(root, "dist", "index.html")));
}

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});

memorySyncScheduler.start();
