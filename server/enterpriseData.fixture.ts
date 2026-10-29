// Isolated synthetic HTTP fixture. Never reads the checkout's .env or data/db.json.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashPassword, signToken } from "./security.js";

export async function enterpriseDataFixture() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gplan-enterprise-http-"));
  await fs.cp(path.join(root, "server"), path.join(dir, "server"), { recursive: true });
  await fs.cp(path.join(root, "dist"), path.join(dir, "dist"), { recursive: true }).catch(() => undefined);
  await fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  await fs.mkdir(path.join(dir, "data"));
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(dir, ".env"), "ENTERPRISE_BOOTSTRAP_PROBE=loaded\n");
  // Replace only the I/O boundaries in this ephemeral fixture; run the real planner and routes.
  const operations = path.join(dir, "server/operationsData.ts");
  let code = await fs.readFile(operations, "utf8");
  const start = code.indexOf("  const [rows] = await connection().execute<RowDataPacket[]>(sql, params);");
  const end = code.indexOf("\n}", start);
  if (start < 0 || end < 0) throw Error("query fixture boundary changed");
  code = code.slice(0, start) + `
  if (!params.includes("c1")) return [];
  if (!sql.startsWith("SELECT") || /DELETE|INSERT|UPDATE|CREATE|DROP/.test(sql)) throw new Error("non-read query");
  if (sql.includes("latestSyncedAt")) return [{ latestSyncedAt:"2026-10-29 03:00:00" }] as RowDataPacket[];
  if (!sql.includes("LIMIT")) return [{ currencyCode:"CNY", documentCount:1000, quantity:10000, amount:"999999.00" }] as RowDataPacket[];
  return [{dimension:"SKU-ONLY-C1",name:"测试商品",amount:"20.00"},{dimension:"SKU-SECOND",amount:"10.00"}] as RowDataPacket[];` + code.slice(end);
  await fs.writeFile(operations, code);
  const platform = path.join(dir, "server/dataPlatformDb.ts");
  await fs.writeFile(platform, `const enterpriseBootstrapReady = process.env.ENTERPRISE_BOOTSTRAP_PROBE === "loaded";\n` + (await fs.readFile(platform, "utf8")).replace("status() { return this.currentStatus; }", "status() { return {...this.currentStatus, ready: enterpriseBootstrapReady}; }"));
  await fs.appendFile(path.join(dir, "server/bailian.ts"), '\nBailianCompanyKnowledgeService.prototype.retrieveCompanyKnowledge = async () => [{text:"AUTO-KB-CONTEXT",score:1,sourceType:"company_kb",source:"钉钉测试知识"}];\n');
  let url = "";
  let modelCalls = 0, plannerCalls = 0;
  const payloads: Array<Record<string, unknown>> = [];
  const secret = "enterprise-http-test-secret";
  async function request(route: string, who = "admin", body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(url + route, { method, headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${signToken({ sub: who, role: "admin" }, secret)}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  }
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const payload = JSON.parse(body);
    payloads.push(payload);
    modelCalls++;
    const text = JSON.stringify(payload.messages);
    const planning = text.includes("你是企业数据只读查询规划器");
    if (planning) plannerCalls++;
    if ((planning && text.includes("REVOKE_DURING_PLAN")) || (!planning && text.includes("REVOKE_DURING_ANSWER"))) {
      await request("/api/admin/users/admin", "controller", { role: "user" }, "PATCH");
    }
    const existing = text.includes("SKU-ONLY-C1");
    const content = planning
      ? JSON.stringify({ calls: existing ? [] : [{ tool: "sales_summary", params: { startDate: "2026-10-28", endDate: "2026-10-28", groupBy: "product", limit: 1 } }] })
      : text.includes("本轮企业数据查询结果") ? "根据万里牛销售出库数据，测试汇总金额为999999元。仅返回一条排行，不能据此声称看完全部明细。" : "普通聊天回答";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const createdAt = new Date().toISOString();
  const passwordHash = hashPassword("test-password");
  const users = [["admin", "c1", "admin"], ["controller", "c1", "admin"], ["member", "c1", "user"], ["other", "c2", "admin"]].map(([id, companyId, role]) => ({ id, companyId, username: id, role, enabled: true, passwordHash, createdAt }));
  const agent = { id: "public", companyId: "c1", ownerId: "admin", name: "公开助手", description: "", prompt: "test", modelId: "model", group: "test", avatar: "", color: "#3984de", favoriteUserIds: [], useCount: 0, allowFileUpload: true, allowImageInput: true, allowWebSearch: false, published: true, publicSlug: "public", createdAt, updatedAt: createdAt };
  await fs.writeFile(path.join(dir, "data/db.json"), JSON.stringify({ users, models: [{ id: "model", name: "测试模型", provider: "fixture", protocol: "openai", kind: "chat", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "fixture-only", model: "fixture", systemPrompt: "", enabled: true, isDefault: true, createdAt }], agents: [agent, { ...agent, id: "restricted", publicSlug: "restricted", access: { mode: "members", userIds: ["admin", "member"] } }], conversations: [], messages: [], workspaces: [], integrationTokens: [], attachments: [], settings: { safetyRules: "" } }));
  const socket = net.createServer();
  await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>(r => socket.close(() => r()));
  url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", path.join(dir, "server/index.ts")], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", PORT: String(port), JWT_SECRET: secret, DB_PROVIDER: "json", DATA_DB_PROVIDER: "disabled", WANLINIU_SYNC_ENABLED: "false", KNOWLEDGE_SYNC_ENABLED: "false", MEMORY_SCAN_INTERVAL_MINUTES: "9999" },
  });
  let logs = "";
  child.stdout.on("data", b => { logs += b; });
  child.stderr.on("data", b => { logs += b; });
  async function close() {
    child.kill("SIGTERM");
    await Promise.race([new Promise<void>(r => child.once("exit", () => r())), new Promise<void>(r => setTimeout(() => { child.kill("SIGKILL"); r(); }, 3000).unref())]);
    upstream.closeAllConnections();
    await new Promise<void>(r => upstream.close(() => r()));
    await fs.rm(dir, { recursive: true, force: true });
  }
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + "/api/health")).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) { await close(); throw Error(logs); }
  return { url, dir, request, close, payloads, counts: () => ({ modelCalls, plannerCalls }), read: async () => JSON.parse(await fs.readFile(path.join(dir, "data/db.json"), "utf8")) };
}
