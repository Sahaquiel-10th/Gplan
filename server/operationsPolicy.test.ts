import test from "node:test";
import assert from "node:assert/strict";
import {
  canUseAgent,
  defaultOperationsRules,
  estimateProfit,
  inventoryMetrics,
  operationsGrant,
  reportDate,
  scopeKey,
  validateOperationsConfig,
} from "./operationsPolicy.js";
import type { Agent, User } from "./types.js";
const user = { id: "u1", companyId: "c1", enabled: true, role: "user" } as User;
const admin = { ...user, id: "admin", role: "admin" } as User;
const agent = {
  id: "a1",
  companyId: "c1",
  ownerId: "admin",
  published: true,
  operations: {
    kind: "loss",
    state: "pilot",
    revision: 1,
    grants: [
      {
        userId: "u1",
        shopIds: ["shop1"],
        brands: ["brand1"],
        warehouseIds: [],
      },
    ],
    rules: defaultOperationsRules,
  },
} as unknown as Agent;
test("membership does not bypass company, enabled status, state or explicit scope", () => {
  assert.ok(operationsGrant(agent, user));
  for (const u of [
    { ...user, companyId: "c2" },
    { ...user, enabled: false },
    admin,
  ])
    assert.equal(operationsGrant(agent, u), undefined);
  assert.equal(
    operationsGrant(
      { ...agent, operations: { ...agent.operations!, state: "disabled" } },
      user,
    ),
    undefined,
  );
  assert.equal(
    operationsGrant(
      {
        ...agent,
        operations: {
          ...agent.operations!,
          grants: [
            { userId: "u1", shopIds: [], brands: ["brand1"], warehouseIds: [] },
          ],
        },
      },
      user,
    ),
    undefined,
  );
  assert.equal(
    operationsGrant(
      { ...agent, operations: { ...agent.operations!, kind: "inventory" } },
      user,
    ),
    undefined,
  );
});
test("revocation and changed scope invalidate report / notification fingerprint", () => {
  const old = scopeKey(agent, user);
  assert.ok(old);
  assert.notEqual(
    old,
    scopeKey(
      { ...agent, operations: { ...agent.operations!, revision: 2 } },
      user,
    ),
  );
  assert.notEqual(
    old,
    scopeKey(
      {
        ...agent,
        operations: {
          ...agent.operations!,
          grants: [
            {
              userId: "u1",
              shopIds: ["shop2"],
              brands: ["brand1"],
              warehouseIds: [],
            },
          ],
        },
      },
      user,
    ),
  );
  assert.equal(
    scopeKey(
      { ...agent, operations: { ...agent.operations!, grants: [] } },
      user,
    ),
    "",
  );
});
test("non-business member visibility is enforced server-side", () => {
  const generic = {
    ...agent,
    operations: undefined,
    access: { mode: "members" as const, userIds: ["u1"] },
  };
  assert.equal(canUseAgent(generic, user, [admin, user]), true);
  assert.equal(
    canUseAgent(generic, { ...user, id: "u2" }, [admin, user]),
    false,
  );
  assert.equal(
    canUseAgent(generic, { ...user, companyId: "c2" }, [admin, user]),
    false,
  );
});
test("configuration rejects cross-company members, empty grants, invalid thresholds", () => {
  const config = agent.operations!;
  const next = validateOperationsConfig(config, config, [user], user.companyId);
  assert.equal(next.revision, 2);
  assert.throws(() =>
    validateOperationsConfig(
      config,
      config,
      [{ ...user, companyId: "c2" }],
      user.companyId,
    ),
  );
  assert.throws(() =>
    validateOperationsConfig(
      {
        ...config,
        grants: [
          { userId: user.id, shopIds: ["x"], brands: [], warehouseIds: [] },
        ],
      },
      config,
      [user],
      user.companyId,
    ),
  );
  assert.throws(() =>
    validateOperationsConfig(
      { ...config, rules: { ...config.rules, targetDays: 0 } },
      config,
      [user],
      user.companyId,
    ),
  );
  assert.throws(() =>
    validateOperationsConfig(
      { ...config, grants: [...config.grants, ...config.grants] },
      config,
      [user],
      user.companyId,
    ),
  );
});
test("profit uses cents, missing / negative inputs do not silently become zero", () => {
  assert.equal(estimateProfit("99.00", "42.30", ["5.00"]), 51.7);
  assert.equal(estimateProfit("0.30", "0.10", ["0.20"]), 0);
  assert.equal(estimateProfit("10", "12", ["3"]), -5);
  for (const value of [null, undefined, "", "null", "5x", -1, Infinity])
    assert.equal(estimateProfit(10, 5, [value]), null);
});
test("stock metrics handle zero sales, negative stock and target gap", () => {
  const result = inventoryMetrics(380, 240, 301, 810, defaultOperationsRules);
  assert.equal(result.days, 4.8);
  assert.equal(result.targetGap, 910);
  assert.equal(result.risk, "需关注");
  assert.equal(
    inventoryMetrics(0, 0, 0, 0, defaultOperationsRules).risk,
    "缺货",
  );
  assert.equal(
    inventoryMetrics(10, 0, 0, 0, defaultOperationsRules).days,
    null,
  );
  assert.equal(inventoryMetrics(-1, 3, 7, 30, defaultOperationsRules).days, 0);
});
test("dates are full Shanghai days and reject invalid or future dates", () => {
  const clock = new Date("2026-09-17T01:00:00Z");
  assert.equal(reportDate(undefined, clock), "2026-09-16");
  assert.equal(reportDate("2026-09-15", clock), "2026-09-15");
  for (const date of [
    "2026-09-17",
    "2026-02-30",
    "2026-01-01",
    "2026-09-16' OR 1=1",
  ])
    assert.throws(() => reportDate(date, clock));
});

test("memory scheduler excludes business and member-restricted conversations", async () => {
  const { MemorySyncScheduler } = await import("./memorySync.js");
  const db = {
    agents: [agent],
    conversations: [
      {
        id: "private-chat",
        agentId: agent.id,
        userId: user.id,
        updatedAt: new Date().toISOString(),
      },
    ],
    messages: [
      {
        id: "m1",
        conversationId: "private-chat",
        companyId: user.companyId,
        userId: user.id,
        role: "user",
        content: "x".repeat(10000),
        createdAt: new Date().toISOString(),
      },
    ],
    memorySyncStates: [],
  };
  let calls = 0;
  const scheduler = new MemorySyncScheduler(
    { read: async () => db, mutate: async () => undefined } as any,
    {
      addMemory: async () => {
        calls++;
      },
    } as any,
  );
  await scheduler.scan();
  assert.equal(calls, 0);
  await assert.rejects(
    scheduler.submitConversation("private-chat"),
    /不能保存/,
  );
});
