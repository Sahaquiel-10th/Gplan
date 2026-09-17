import type { Store } from "./db.js";
import type { Agent, User } from "./types.js";
import { operationsReport, type OperationsReport } from "./operationsData.js";
import { scopeKey } from "./operationsPolicy.js";
import { uid } from "./security.js";

export type OperationsAnalysis = {
  id: string;
  action: string;
  question: string;
  content: string;
  createdAt: string;
};
export type OperationsSnapshot = {
  id: string;
  companyId: string;
  userId: string;
  agentId: string;
  scopeKey: string;
  date: string;
  report: OperationsReport;
  analyses: OperationsAnalysis[];
};
export function authorizedSnapshot(
  s: OperationsSnapshot,
  agent: Agent,
  user: User,
  date: string,
) {
  const key = scopeKey(agent, user);
  return (
    !!key &&
    s.companyId === user.companyId &&
    s.userId === user.id &&
    s.agentId === agent.id &&
    s.scopeKey === key &&
    s.date === date
  );
}
export function assertCurrent(
  db: Awaited<ReturnType<Store["read"]>>,
  agentId: string,
  userId: string,
  key: string,
) {
  const a = db.agents.find((a) => a.id === agentId);
  const u = db.users.find((u) => u.id === userId && u.enabled);
  if (!a || !u || !key || scopeKey(a, u) !== key)
    throw Object.assign(new Error("权限或配置已变更，请重新查看结果"), {
      status: 403,
    });
}
const pending = new Map<string, Promise<OperationsSnapshot>>();
export async function savedReport(
  store: Store,
  agent: Agent,
  user: User,
  date: string,
  refresh = false,
  query: typeof operationsReport = operationsReport,
): Promise<OperationsSnapshot> {
  const key = scopeKey(agent, user);
  const db = await store.read();
  assertCurrent(db, agent.id, user.id, key);
  const existing = db.operationsSnapshots?.find((s) =>
    authorizedSnapshot(s, agent, user, date),
  );
  if (existing && !refresh) return structuredClone(existing);
  const pendingKey = `${user.id}:${key}:${date}`;
  if (pending.has(pendingKey)) return pending.get(pendingKey)!;
  const work = (async () => {
    const report = await query(agent, user, date, refresh);
    const snapshot: OperationsSnapshot = {
      id: uid("opsnap"),
      companyId: user.companyId,
      userId: user.id,
      agentId: agent.id,
      scopeKey: key,
      date,
      report,
      analyses: [],
    };
    await store.mutate((current) => {
      assertCurrent(current, agent.id, user.id, key);
      current.operationsSnapshots = (current.operationsSnapshots || []).filter(
        (s) =>
          !(s.userId === user.id && s.agentId === agent.id && s.date === date),
      );
      current.operationsSnapshots.push(snapshot);
      // Bound persisted business data; permission is checked again on every read.
      const cutoff = new Date(Date.now() - 90 * 86400000)
        .toISOString()
        .slice(0, 10);
      current.operationsSnapshots = current.operationsSnapshots.filter(
        (s) => s.date >= cutoff,
      );
    });
    return structuredClone(snapshot);
  })();
  pending.set(pendingKey, work);
  try {
    return await work;
  } finally {
    pending.delete(pendingKey);
  }
}
export async function saveAnalysis(
  store: Store,
  snapshot: OperationsSnapshot,
  analysis: OperationsAnalysis,
) {
  await store.mutate((db) => {
    assertCurrent(db, snapshot.agentId, snapshot.userId, snapshot.scopeKey);
    const current = db.operationsSnapshots?.find(
      (s) =>
        s.id === snapshot.id &&
        s.userId === snapshot.userId &&
        s.scopeKey === snapshot.scopeKey,
    );
    if (!current) throw new Error("数据已刷新，请基于最新数据重新分析");
    current.analyses = current.analyses.filter(
      (a) =>
        !(a.action === analysis.action && a.question === analysis.question),
    );
    current.analyses.push(analysis);
    current.analyses = current.analyses.slice(-20);
  });
}
