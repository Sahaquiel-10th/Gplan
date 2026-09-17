import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashPassword, signToken } from "./security.js";
import { defaultOperationsRules, scopeKey } from "./operationsPolicy.js";
import type { Agent, User } from "./types.js";

test(
  "HTTP boundaries: tenant, public link, ordinary chat, revoked history, notifications and admin mutation",
  { timeout: 60000 },
  async () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gplan-operations-test-"),
    );
    await fs.cp(path.join(root, "server"), path.join(dir, "server"), {
      recursive: true,
    });
    await fs.symlink(
      path.join(root, "node_modules"),
      path.join(dir, "node_modules"),
    );
    await fs.mkdir(path.join(dir, "data"));
    await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
    const timestamp = new Date().toISOString();
    const passwordHash = hashPassword("test-password");
    const users = [
      {
        id: "admin",
        companyId: "c1",
        username: "admin",
        role: "admin",
        enabled: true,
        passwordHash,
        createdAt: timestamp,
      },
      {
        id: "allowed",
        companyId: "c1",
        username: "allowed",
        role: "user",
        enabled: true,
        passwordHash,
        createdAt: timestamp,
      },
      {
        id: "denied",
        companyId: "c1",
        username: "denied",
        role: "user",
        enabled: true,
        passwordHash,
        createdAt: timestamp,
      },
      {
        id: "other",
        companyId: "c2",
        username: "other",
        role: "admin",
        enabled: true,
        passwordHash,
        createdAt: timestamp,
      },
    ] as User[];
    const base = {
      companyId: "c1",
      ownerId: "admin",
      description: "test",
      prompt: "",
      modelId: "model",
      group: "test",
      avatar: "",
      color: "#ffffff",
      favoriteUserIds: [],
      useCount: 0,
      allowFileUpload: false,
      allowImageInput: false,
      allowWebSearch: false,
      published: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const op = {
      ...base,
      id: "ops",
      name: "loss",
      publicSlug: "ops-public",
      operations: {
        kind: "loss",
        state: "pilot",
        revision: 1,
        grants: [
          {
            userId: "allowed",
            shopIds: ["shop1"],
            brands: ["brand1"],
            warehouseIds: [],
          },
        ],
        rules: defaultOperationsRules,
      },
    } as Agent;
    const restricted = {
      ...base,
      id: "restricted",
      name: "restricted",
      publicSlug: "restricted-public",
      access: { mode: "members", userIds: ["allowed"] },
    } as Agent;
    const models = [
      {
        id: "model",
        name: "test",
        provider: "test",
        kind: "chat",
        protocol: "openai",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "",
        model: "test",
        systemPrompt: "",
        enabled: true,
        isDefault: true,
        createdAt: timestamp,
      },
    ];
    await fs.writeFile(
      path.join(dir, "data/db.json"),
      JSON.stringify({
        users,
        models,
        agents: [op, restricted],
        conversations: [
          {
            id: "old",
            userId: "denied",
            agentId: "restricted",
            modelId: "model",
            title: "SECRET",
            archived: false,
            messages: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        messages: [],
        workspaces: [],
        integrationTokens: [],
        attachments: [],
        settings: { safetyRules: "" },
        operationsNotifications: [
          {
            id: "notice",
            companyId: "c1",
            userId: "allowed",
            agentId: "ops",
            scopeKey: scopeKey(op, users[1]),
            date: "2026-09-16",
            createdAt: timestamp,
            status: "alert",
          },
        ],
      }),
    );
    const socket = net.createServer();
    await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((r) => socket.close(() => r()));
    const secret = "test-only-secret";
    const child = spawn(
      process.execPath,
      [
        path.join(root, "node_modules/tsx/dist/cli.mjs"),
        path.join(dir, "server/index.ts"),
      ],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: "test",
          PORT: String(port),
          JWT_SECRET: secret,
          DB_PROVIDER: "json",
          DATA_DB_PROVIDER: "disabled",
          WANLINIU_SYNC_ENABLED: "false",
          KNOWLEDGE_SYNC_ENABLED: "false",
          MEMORY_SCAN_INTERVAL_MINUTES: "9999",
        },
      },
    );
    let logs = "";
    child.stdout.on("data", (b) => (logs += b));
    child.stderr.on("data", (b) => (logs += b));
    const baseUrl = `http://127.0.0.1:${port}`;
    async function request(
      url: string,
      userId?: string,
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
    ) {
      const r = await fetch(baseUrl + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(userId
            ? {
                Authorization: `Bearer ${signToken({ sub: userId, role: "user" }, secret)}`,
              }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() };
    }
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(baseUrl + "/api/health");
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(ready, logs);
      assert.equal(
        (
          await request("/api/auth/login", undefined, {
            username: "allowed",
            password: "test-password",
          })
        ).status,
        200,
      );
      assert.equal((await request("/api/operations/ops/report")).status, 401);
      for (const userId of ["denied", "other", "admin"]) {
        const r = await request(
          "/api/operations/ops/report?shopIds=shop1&brands=brand1",
          userId,
        );
        assert.notEqual(r.status, 200);
        assert.match(r.data.error, /未授权|不存在/);
      }
      const allowed = await request("/api/agents", "allowed");
      assert.equal(allowed.data.agents.length, 2);
      assert.equal(allowed.data.agents[0].operations, undefined);
      assert.equal(
        (await request("/api/agents", "denied")).data.agents.length,
        0,
      );
      assert.equal(
        (await request("/api/public/agents/ops-public")).status,
        404,
      );
      assert.equal(
        (await request("/api/public/agents/restricted-public")).status,
        404,
      );
      assert.equal(
        (
          await request("/api/public/agents/ops-public/chat", undefined, {
            content: "show all",
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request("/api/chat", "allowed", {
            agentId: "ops",
            modelId: "model",
            content: "show all company data",
          })
        ).status,
        403,
      );
      assert.notEqual(
        (
          await request(
            "/api/conversations/old",
            "denied",
            { archived: true },
            "PATCH",
          )
        ).status,
        200,
      );
      assert.equal(
        (await request("/api/operations/ops/access", "allowed")).status,
        200,
      );
      assert.equal(
        (await request("/api/operations/ops/access", "denied")).status,
        403,
      );
      assert.equal(
        (await request("/api/conversations/old", "denied")).status,
        404,
      );
      assert.equal(
        (await request("/api/conversations", "denied")).data.conversations
          .length,
        0,
      );
      assert.notEqual(
        (
          await request("/api/memories/save", "denied", {
            conversationId: "old",
            content: "secret",
          })
        ).status,
        200,
      );
      assert.equal(
        (await request("/api/admin/operations/install", "allowed", {})).status,
        403,
      );
      assert.equal(
        (await request("/api/operations-notifications", "allowed")).data
          .notifications.length,
        1,
      );
      assert.equal(
        (await request("/api/operations-notifications", "denied")).data
          .notifications.length,
        0,
      );
      assert.notEqual(
        (
          await request(
            "/api/operations-notifications/notice/read",
            "denied",
            {},
          )
        ).status,
        200,
      );
      const revoke = { ...op.operations!, grants: [], state: "disabled" };
      assert.equal(
        (
          await request(
            "/api/admin/operations/ops",
            "admin",
            { revision: 1, operations: revoke, modelId: "model" },
            "PUT",
          )
        ).status,
        200,
      );
      assert.equal(
        (await request("/api/operations-notifications", "allowed")).data
          .notifications.length,
        0,
      );
      assert.notEqual(
        (await request("/api/operations/ops/report", "allowed")).status,
        200,
      );
      assert.equal(
        (
          await request(
            "/api/admin/operations/ops",
            "admin",
            { revision: 1, operations: revoke, modelId: "model" },
            "PUT",
          )
        ).status,
        409,
      );
      assert.equal(
        (await request("/api/admin/operations/install", "admin", {})).status,
        200,
      );
      const admin = await request("/api/admin/operations", "admin");
      assert.equal(admin.data.agents.length, 3);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        if (child.exitCode !== null) return r();
        child.once("exit", () => r());
        setTimeout(() => {
          child.kill("SIGKILL");
          r();
        }, 2000).unref();
      });
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
