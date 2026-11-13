import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { callModel } from "./modelGateway.js";
import type { ModelConfig } from "./types.js";

test("OpenAI and Anthropic both receive enterprise facts and automatic knowledge context", async () => {
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    const system = req.url === "/messages" ? payload.system : payload.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
    assert.match(system, /ENTERPRISE-FACTS/);
    assert.match(system, /AUTO-KB/);
    assert.match(system, /MODEL-PROMPT/);
    assert.match(system, /SAFETY/);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/messages" ? { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 2 } } : { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    for (const protocol of ["openai", "anthropic"] as const) {
      const model = { id: "m", model: "test", kind: "chat", protocol, enabled: true, apiKey: "test", systemPrompt: "MODEL-PROMPT", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } as ModelConfig;
      const result = await callModel(model, [{ role: "system", content: "ENTERPRISE-FACTS AUTO-KB", createdAt: "now" }, { role: "user", content: "分析", createdAt: "now" }], "SAFETY", "enterprise-test", undefined, 3000);
      assert.equal(result.content, "ok");
      assert.equal(result.usage?.totalTokens, 12);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test("model timeout covers response body after headers for both protocols", async () => {
  const server = http.createServer(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"pending":');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const protocol of ["openai", "anthropic"] as const) {
      const started = Date.now();
      await assert.rejects(callModel({ id: "m", model: "test", kind: "chat", protocol, enabled: true, apiKey: "test", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, systemPrompt: "" } as ModelConfig, [], "", "body-timeout-test", 128, 1000), /模型响应超时/);
      assert.ok(Date.now() - started < 3000);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
