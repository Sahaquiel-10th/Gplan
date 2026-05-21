import express, { Request, RequestHandler, Response } from "express";
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./db.js";
import { asyncRoute, auth, requireRole } from "./middleware.js";
import { callModel } from "./modelGateway.js";
import { createPlainToken, hashPassword, hashToken, signToken, uid, verifyPassword } from "./security.js";
import { adminModel, publicModel, publicUser } from "./serializers.js";
import { Conversation, Message, ModelConfig, User, Workspace } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const app = express();
const port = Number(process.env.PORT ?? 3001);
const jwtSecret = process.env.JWT_SECRET ?? "dev-secret-change-me";

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
      role: "user",
      content,
      modelId: model.id,
      createdAt: now()
    };
    const messages = [...(existing?.messages ?? []), userMessage];
    const result = await callModel(model, messages, db.settings.safetyRules);
    const assistantMessage: Message = {
      role: "assistant",
      content: result.content,
      imageUrl: result.imageUrl,
      modelId: model.id,
      createdAt: now()
    };

    const conversation = await store.mutate((mutableDb) => {
      if (existing) {
        const target = mutableDb.conversations.find((item) => item.id === existing.id)!;
        target.messages.push(userMessage, assistantMessage);
        target.updatedAt = now();
        return target;
      }
      const created: Conversation = {
        id: uid("cnv"),
        userId: req.user!.id,
        modelId: model.id,
        workspaceId: typeof req.body.workspaceId === "string" ? req.body.workspaceId : undefined,
        archived: false,
        title: titleFrom(content),
        messages: [userMessage, assistantMessage],
        createdAt: now(),
        updatedAt: now()
      };
      mutableDb.conversations.push(created);
      return created;
    });

    res.json({ conversation, message: assistantMessage });
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
  });
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
