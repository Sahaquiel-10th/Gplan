import test from "node:test";
import assert from "node:assert/strict";
import {
  savedReport,
  saveAnalysis,
  authorizedSnapshot,
} from "./operationsArchive.js";
import { defaultOperationsRules, reportDate } from "./operationsPolicy.js";
import type { Store } from "./db.js";
import type { Agent, User, Database } from "./types.js";
import type { OperationsReport } from "./operationsData.js";
function fixture() {
  const user = { id: "u", companyId: "c", enabled: true, role: "user" } as User;
  const agent = {
    id: "a",
    companyId: "c",
    published: true,
    operations: {
      kind: "loss",
      state: "pilot",
      revision: 1,
      grants: [
        { userId: "u", shopIds: ["s"], brands: ["b"], warehouseIds: [] },
      ],
      rules: defaultOperationsRules,
    },
  } as unknown as Agent;
  const db = { users: [user], agents: [agent] } as Database;
  const store = {
    read: async () => db,
    mutate: async (fn: (d: Database) => unknown) => fn(db),
  } as Store;
  const report = {
    agentId: "a",
    date: reportDate(),
    rows: [{ sku: "only-authorized-sku" }],
    generatedAt: new Date().toISOString(),
  } as unknown as OperationsReport;
  return { user, agent, db, store, report };
}
test("saved snapshots and analyses survive store reload; refresh bypasses query cache and resets analyses", async () => {
  const f = fixture();
  let calls = 0;
  let force = false;
  const query = async (_a: Agent, _u: User, _d: string, refresh = false) => {
    calls++;
    force = refresh;
    return f.report;
  };
  const first = await savedReport(
    f.store,
    f.agent,
    f.user,
    f.report.date,
    false,
    query,
  );
  const analysis = {
    id: "answer",
    action: "custom",
    question: "补货建议",
    content: "only scoped facts",
    createdAt: new Date().toISOString(),
  };
  await saveAnalysis(f.store, first, analysis);
  const reloaded = JSON.parse(JSON.stringify(f.db));
  const restored = {
    read: async () => reloaded,
    mutate: async (fn: (d: Database) => unknown) => fn(reloaded),
  } as Store;
  const again = await savedReport(
    restored,
    f.agent,
    f.user,
    f.report.date,
    false,
    query,
  );
  assert.equal(calls, 1);
  assert.equal(again.analyses[0].content, analysis.content);
  assert.equal(
    authorizedSnapshot(
      again,
      f.agent,
      { ...f.user, id: "other" },
      f.report.date,
    ),
    false,
  );
  assert.equal(
    authorizedSnapshot(
      again,
      f.agent,
      { ...f.user, companyId: "other" },
      f.report.date,
    ),
    false,
  );
  const fresh = await savedReport(
    restored,
    f.agent,
    f.user,
    f.report.date,
    true,
    query,
  );
  assert.equal(calls, 2);
  assert.equal(force, true);
  assert.notEqual(fresh.id, first.id);
  assert.equal(fresh.analyses.length, 0);
  await assert.rejects(saveAnalysis(restored, first, analysis), /数据已刷新/);
});
test("scope changes during a query cannot persist or return a saved report", async () => {
  const f = fixture();
  await assert.rejects(
    savedReport(f.store, f.agent, f.user, f.report.date, false, async () => {
      f.agent.operations!.revision++;
      return f.report;
    }),
    /权限/,
  );
  assert.equal(f.db.operationsSnapshots, undefined);
});
test("revoked grants block saved analysis writes and reads", async () => {
  const f = fixture();
  const snap = await savedReport(
    f.store,
    f.agent,
    f.user,
    f.report.date,
    false,
    async () => f.report,
  );
  f.agent.operations!.grants = [];
  await assert.rejects(
    savedReport(f.store, f.agent, f.user, f.report.date),
    /权限/,
  );
  await assert.rejects(
    saveAnalysis(f.store, snap, {
      id: "x",
      action: "summary",
      question: "",
      content: "secret",
      createdAt: new Date().toISOString(),
    }),
    /权限/,
  );
});
