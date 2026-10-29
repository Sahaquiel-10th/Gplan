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
