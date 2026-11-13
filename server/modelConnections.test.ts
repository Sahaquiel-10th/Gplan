import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callModel } from "./modelGateway.js";
import { modelConnectionDraft, testModelConnection } from "./modelConnections.js";
import { modelChatEndpoint } from "../shared/modelProviders.js";

test("official presets need only a key and preserve saved model/endpoint configuration", () => {
  const ds = modelConnectionDraft({ provider: "deepseek", apiKey: "test" });
  assert.equal(ds.model, "deepseek-flash"); assert.equal(ds.baseUrl, "https://api.deepseek.com"); assert.equal(ds.protocol, "openai"); assert.equal(ds.thinkingMode, "disabled");
  const ark = modelConnectionDraft({ provider: "doubao", apiKey: "test" });
  assert.equal(ark.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  const saved = { ...ark, model: "ep-custom", name: "团队豆包", thinkingMode: "enabled" as const };
  assert.deepEqual(modelConnectionDraft({}, saved), { ...saved, isDefault: false, enabled: true });
  assert.equal(modelChatEndpoint("https://api.deepseek.com/chat/completions/"), "https://api.deepseek.com/chat/completions");
  assert.equal(modelChatEndpoint(ark.baseUrl), ark.baseUrl + "/chat/completions");
  assert.throws(() => modelChatEndpoint("https://example.test/?key=secret"));
});

test("DeepSeek and Doubao receive identical business context, bearer key and explicit thinking mode", async () => {
  const captured: Array<{ url?: string; auth?: string; body: any }> = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    captured.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "已取得完整指标" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = (upstream.address() as { port: number }).port;
    for (const provider of ["deepseek", "doubao"]) {
      const model = modelConnectionDraft({ provider, apiKey: "unit-secret", baseUrl: `http://127.0.0.1:${port}/api/v3` });
      const result = await callModel(model, [{ role: "system", content: "ENTERPRISE_FACTS amount=100;documentCount=10;quantity=20", createdAt: "now" }, { role: "user", content: "昨天各品牌三类占比", createdAt: "now" }], "SAFETY", "provider-unit", 128, 5000);
      assert.equal(result.usage?.totalTokens, 15);
    }
    assert.deepEqual(captured[0].body.messages, captured[1].body.messages);
    for (const request of captured) {
      assert.equal(request.auth, "Bearer unit-secret");
      assert.deepEqual(request.body.thinking, { type: "disabled" });
      assert.equal(request.body.temperature, undefined);
      assert.equal(request.url, "/api/v3/chat/completions");
      assert.match(JSON.stringify(request.body.messages), /ENTERPRISE_FACTS/);
    }
  } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test("connection checks reject absent keys and sanitize provider errors", async () => {
  const model = modelConnectionDraft({ provider: "deepseek", apiKey: "TOP-SECRET" });
  await assert.rejects(testModelConnection({ ...model, apiKey: "" }, "test"), /填写 API Key/);
  await assert.rejects(testModelConnection(model, "test", async () => { throw Error("上游 401 TOP-SECRET"); }), error => !String(error).includes("TOP-SECRET") && /认证/.test(String(error)));
});

test("trusted detailed analysis can request 6000 tokens while ordinary calls use the default", async () => {
  const limits: number[] = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    limits.push(JSON.parse(raw).max_tokens);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "complete" }, finish_reason: "stop" }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const model = modelConnectionDraft({ provider: "deepseek", apiKey: "test", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}` });
    await callModel(model, [], "", "analysis-limit", 6000, 1000);
    await callModel(model, [], "", "default-limit", undefined, 1000);
    assert.deepEqual(limits, [6000, Number(process.env.MODEL_MAX_OUTPUT_TOKENS) || 3000]);
  } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
