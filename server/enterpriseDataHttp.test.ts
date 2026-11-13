import test from "node:test";
import assert from "node:assert/strict";
import { enterpriseDataFixture } from "./enterpriseData.fixture.js";
import { MemorySyncScheduler } from "./memorySync.js";

test("enterprise chat HTTP: real orchestration, automatic KB, ownership, revocation and memory isolation", { timeout: 60000 }, async () => {
  const f = await enterpriseDataFixture();
  const chat = { modelId: "model", content: "昨天全部商品的销售出库排行", enterpriseData: true };
  try {
    const before = f.counts();
    assert.equal((await f.request("/api/chat", "", chat)).status, 401);
    assert.equal((await f.request("/api/chat", "member", chat)).status, 403);
    assert.equal((await f.request("/api/chat", "admin", { ...chat, agentId: "restricted" })).status, 403);
    assert.deepEqual(f.counts(), before);
    const normal = await f.request("/api/chat", "member", { ...chat, enterpriseData: false });
    assert.equal(normal.status, 200);
    assert.equal(f.counts().plannerCalls, 0);
    assert.match(JSON.stringify(f.payloads.at(-1)), /AUTO-KB-CONTEXT/);
    assert.ok(!JSON.stringify(f.payloads.at(-1)).includes("本轮企业数据查询结果"));

    const result = await f.request("/api/chat", "admin", chat);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const id = result.data.conversation.id;
    assert.equal(result.data.conversation.enterpriseData.companyId, "c1");
    assert.equal(result.data.conversation.enterpriseDataEnabled, true);
    assert.equal(result.data.message.enterpriseData.status, "queried");
    assert.equal(result.data.message.enterpriseData.sources[0].hasMore, true);
    assert.match(JSON.stringify(f.payloads.at(-1)), /999999.00/);
    assert.match(JSON.stringify(f.payloads.at(-1)), /AUTO-KB-CONTEXT/);
    const read = await f.request("/api/conversations/" + id);
    assert.deepEqual(read.data.conversation.messages.at(-1).enterpriseData, result.data.message.enterpriseData);
    for (const who of ["member", "other", "controller"]) {
      assert.equal((await f.request("/api/conversations/" + id, who)).status, 404);
      assert.equal((await f.request("/api/chat", who, { ...chat, conversationId: id })).status, who === "member" ? 403 : 404);
    }
    assert.equal((await f.request("/api/memories/save", "admin", { conversationId: id, messageId: result.data.message.id, content: result.data.message.content })).status, 400);
    assert.equal((await f.request(`/api/conversations/${id}/save-to-memory`, "admin", {})).status, 400);
    const callsBeforeDisable = f.counts().plannerCalls;
    const noFreshQuery = await f.request("/api/chat", "admin", { ...chat, conversationId: id, content: "解释一下刚才的结果", enterpriseData: false });
    assert.equal(noFreshQuery.status, 200);
    assert.equal(noFreshQuery.data.conversation.enterpriseDataEnabled, false);
    assert.equal(noFreshQuery.data.conversation.enterpriseData.companyId, "c1");
    assert.equal(f.counts().plannerCalls, callsBeforeDisable);
    assert.equal(noFreshQuery.data.message.enterpriseData, undefined);
    let memoryWrites = 0;
    const state = await f.read();
    // Limit scheduler fixture to the sensitive conversation; normal chat remains unchanged.
    const db = { ...state, conversations: state.conversations.filter((c: any) => c.id === id), messages: state.messages.filter((m: any) => m.conversationId === id) };
    const scheduler = new MemorySyncScheduler({ read: async () => db, mutate: async () => undefined } as any, { addMemory: async () => { memoryWrites++; } } as any);
    await scheduler.scan();
    assert.equal(memoryWrites, 0);
    await assert.rejects(scheduler.submitConversation(id), /不能保存/);
    const record = state.ragRetrievalLogs.find((l: any) => l.sourceType === "enterprise_data");
    assert.equal(record.injectedContext, "");
    assert.ok(!JSON.stringify(record.matchedItemsJson).includes("999999"));
    assert.equal(state.modelUsageRecords.filter((u: any) => u.conversationId === id).length, 4); // two planner rounds + two answers

    const publicCalls = f.counts().plannerCalls;
    assert.equal((await f.request("/api/public/agents/public/chat", "", { content: "你好", enterpriseData: true })).status, 200);
    assert.equal(f.counts().plannerCalls, publicCalls);
    assert.ok(!JSON.stringify(f.payloads.at(-1)).includes("本轮企业数据查询结果"));

    await f.request("/api/admin/users/admin", "controller", { role: "user" }, "PATCH");
    assert.equal((await f.request("/api/conversations/" + id)).status, 404);
    assert.ok(!(await f.request("/api/conversations")).data.conversations.some((c: any) => c.id === id));
    assert.equal((await f.request("/api/chat", "admin", { ...chat, enterpriseData: false, conversationId: id })).status, 403);
    await f.request("/api/admin/users/admin", "controller", { role: "admin" }, "PATCH");
    for (const trigger of ["REVOKE_DURING_PLAN", "REVOKE_DURING_ANSWER"]) {
      const response = await f.request("/api/chat", "admin", { ...chat, content: trigger });
      assert.equal(response.status, 403, JSON.stringify(response.data));
      assert.ok(!JSON.stringify(response.data).includes("999999"));
      await f.request("/api/admin/users/admin", "controller", { role: "admin" }, "PATCH");
    }
  } finally { await f.close(); }
});

test("full-day analysis uses saved source dates through the normal chat history path", { timeout: 60000 }, async () => {
  const f = await enterpriseDataFixture();
  try {
    const first = await f.request("/api/chat", "admin", { modelId: "model", content: "昨天所有品牌销售额、笔数、件数及占比", enterpriseData: true });
    assert.equal(first.status, 200);
    const before = f.counts().plannerCalls;
    const followup = await f.request("/api/chat", "admin", { modelId: "model", conversationId: first.data.conversation.id, content: "结合以往你可以查看的所有数据，和我们知识库中关于公司的所有内容，对我们这一天的数据进行全方位多方面的梳理和分析，越详细越完整越好。", enterpriseData: true });
    assert.equal(followup.status, 200, JSON.stringify(followup.data));
    assert.equal(f.counts().plannerCalls, before);
    assert.equal(followup.data.message.enterpriseData.sources.length, 7);
    assert.equal(followup.data.message.enterpriseData.task.startDate, first.data.message.enterpriseData.task.startDate);
    assert.ok(followup.data.message.enterpriseData.timing.budgetMs <= 45000);
    assert.match(JSON.stringify(f.payloads.at(-1)), /AUTO-KB-CONTEXT/);
  } finally { await f.close(); }
});

test("answer timeout identifies the answer stage and keeps completed query diagnostics", { timeout: 10000 }, async () => {
  const f = await enterpriseDataFixture({ modelTimeoutMs: 1000 });
  try {
    const response = await f.request("/api/chat", "admin", { modelId: "model", content: "STALL_ANSWER 查看销售数据", enterpriseData: true });
    assert.equal(response.status, 504);
    assert.equal(response.data.stage, "model_answer");
    assert.match(response.data.error, /模型回答阶段响应超时（已等待1秒）/);
    assert.ok(response.data.requestId);
    const state = await f.read();
    assert.ok(state.ragRetrievalLogs.some((log: any) => log.sourceType === "enterprise_data" && log.matchedItemsJson.sources.some((source: any) => source.status === "success")));
  } finally { await f.close(); }
});

test("a provider length stop is visible in the saved enterprise answer", { timeout: 10000 }, async () => {
  const f = await enterpriseDataFixture();
  try {
    const response = await f.request("/api/chat", "admin", { modelId: "model", content: "TRUNCATED_ANSWER 昨天所有品牌销售额占比", enterpriseData: true });
    assert.equal(response.status, 200);
    assert.match(response.data.message.content, /本次回答达到模型输出长度上限/);
    const saved = await f.request("/api/conversations/" + response.data.conversation.id);
    assert.match(saved.data.conversation.messages.at(-1).content, /正文尚未完整结束/);
  } finally { await f.close(); }
});
