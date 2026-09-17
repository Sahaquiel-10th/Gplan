import { createHash } from "node:crypto";
import type { Agent, User } from "./types.js";

export type OperationsKind = "loss" | "inventory" | "product";
export type OperationsGrant = {
  userId: string;
  shopIds: string[];
  brands: string[];
  warehouseIds: string[];
};
export type OperationsRules = {
  dangerDays: number;
  targetDays: number;
  spikeRatio: number;
  assumeMissingCurrencyCny: boolean;
  includeDeliveryCost: boolean;
  includeServiceFee: boolean;
  includeStorageFee: boolean;
  excludedBillTypes: number[];
};
export type OperationsConfig = {
  kind: OperationsKind;
  state: "draft" | "pilot" | "active" | "disabled";
  revision: number;
  grants: OperationsGrant[];
  rules: OperationsRules;
};
export type OperationsNotification = {
  id: string;
  companyId: string;
  userId: string;
  agentId: string;
  scopeKey: string;
  date: string;
  createdAt: string;
  readAt?: string;
  status: "alert" | "incomplete";
};
export const defaultOperationsRules: OperationsRules = {
  dangerDays: 7,
  targetDays: 30,
  spikeRatio: 1.5,
  assumeMissingCurrencyCny: true,
  includeDeliveryCost: true,
  includeServiceFee: false,
  includeStorageFee: false,
  excludedBillTypes: [],
};
export const operationsNames: Record<OperationsKind, string> = {
  loss: "昨日亏损助手",
  inventory: "销量与库存助手",
  product: "商品经营诊断",
};
export function canUseAgent(agent: Agent, user: User, users: User[]): boolean {
  if (!user.enabled || agent.companyId !== user.companyId) return false;
  if (agent.operations) return !!operationsGrant(agent, user);
  if (agent.ownerId === user.id) return true;
  if (
    !agent.published ||
    !users.some(
      (u) =>
        u.id === agent.ownerId &&
        u.companyId === user.companyId &&
        u.role === "admin",
    )
  )
    return false;
  return (
    agent.access?.mode !== "members" || agent.access.userIds.includes(user.id)
  );
}
export function operationsGrant(
  agent: Agent,
  user: User,
): OperationsGrant | undefined {
  if (
    !user.enabled ||
    user.companyId !== agent.companyId ||
    !agent.published ||
    !agent.operations ||
    !["pilot", "active"].includes(agent.operations.state)
  )
    return;
  const grant = agent.operations.grants.find((g) => g.userId === user.id);
  if (
    !grant?.shopIds.length ||
    !grant.brands.length ||
    (agent.operations.kind === "inventory" && !grant.warehouseIds.length)
  )
    return;
  return grant;
}
export function scopeKey(agent: Agent, user: User): string {
  const grant = operationsGrant(agent, user);
  if (!grant) return "";
  return createHash("sha256")
    .update(
      JSON.stringify([
        agent.companyId,
        agent.id,
        agent.operations?.revision,
        grant,
      ]),
    )
    .digest("hex");
}
function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((v) => typeof v !== "string" || !v.trim() || v.length > 200)
  )
    throw new Error("权限范围格式错误");
  return [...new Set(value as string[])];
}
export function validateOperationsConfig(
  value: unknown,
  previous: OperationsConfig,
  users: User[],
  companyId: string,
): OperationsConfig {
  const input = value as Partial<OperationsConfig>;
  if (
    !input ||
    !["draft", "pilot", "active", "disabled"].includes(input.state || "") ||
    !Array.isArray(input.grants) ||
    input.grants.length > 500
  )
    throw new Error("智能体配置格式错误");
  const seen = new Set<string>();
  const grants = input.grants.map((g) => {
    if (
      !g ||
      seen.has(g.userId) ||
      !users.some(
        (u) => u.id === g.userId && u.companyId === companyId && u.enabled,
      )
    )
      throw new Error("成员不存在、已停用或重复");
    seen.add(g.userId);
    const grant = {
      userId: g.userId,
      shopIds: strings(g.shopIds),
      brands: strings(g.brands),
      warehouseIds: strings(g.warehouseIds),
    };
    if (
      !grant.shopIds.length ||
      !grant.brands.length ||
      (previous.kind === "inventory" && !grant.warehouseIds.length)
    )
      throw new Error("每位成员必须选择店铺、品牌；库存助手还需选择仓库");
    return grant;
  });
  const rules = input.rules;
  if (
    !rules ||
    !Number.isFinite(rules.dangerDays) ||
    rules.dangerDays < 1 ||
    rules.dangerDays > 90 ||
    !Number.isFinite(rules.targetDays) ||
    rules.targetDays < rules.dangerDays ||
    rules.targetDays > 365 ||
    !Number.isFinite(rules.spikeRatio) ||
    rules.spikeRatio < 1 ||
    rules.spikeRatio > 20
  )
    throw new Error("预警阈值不合法");
  if (
    [
      "includeDeliveryCost",
      "includeServiceFee",
      "includeStorageFee",
      "assumeMissingCurrencyCny",
    ].some((k) => typeof rules[k as keyof OperationsRules] !== "boolean")
  )
    throw new Error("费用口径不合法");
  if (
    !Array.isArray(rules.excludedBillTypes) ||
    rules.excludedBillTypes.length > 30 ||
    rules.excludedBillTypes.some(
      (v) => !Number.isInteger(v) || v < 0 || v > 999,
    )
  )
    throw new Error("排除类型必须是已核实的单据类型编码");
  return {
    kind: previous.kind,
    state: input.state!,
    revision: previous.revision + 1,
    grants,
    rules: {
      dangerDays: rules.dangerDays,
      targetDays: rules.targetDays,
      spikeRatio: rules.spikeRatio,
      assumeMissingCurrencyCny: rules.assumeMissingCurrencyCny,
      includeDeliveryCost: rules.includeDeliveryCost,
      includeServiceFee: rules.includeServiceFee,
      includeStorageFee: rules.includeStorageFee,
      excludedBillTypes: [...new Set(rules.excludedBillTypes)],
    },
  };
}
export function reportDate(value?: unknown, clock = new Date()): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(clock);
  const yesterday = shiftDate(today, -1);
  if (value === undefined || value === "") return yesterday;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value ||
    value > yesterday ||
    value < shiftDate(today, -90)
  )
    throw new Error("请选择最近90天内的完整日期（最晚昨天）");
  return value;
}
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function finiteDecimal(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^-?\d+(?:\.\d+)?$/.test(value))
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function estimateProfit(
  paid: unknown,
  cost: unknown,
  fees: unknown[],
): number | null {
  const values = [paid, cost, ...fees].map(finiteDecimal);
  if (values.some((v) => v === null || v < 0)) return null;
  // Monetary inputs are rounded to fen before deterministic subtraction.
  const cents = values.map((v) => Math.round(v! * 100));
  const totalCost = cents.slice(1).reduce((a, b) => a + b, 0);
  if (
    cents.some((v) => !Number.isSafeInteger(v)) ||
    !Number.isSafeInteger(totalCost)
  )
    return null;
  return (cents[0] - totalCost) / 100;
}
export function inventoryMetrics(
  stock: number,
  sales3: number,
  sales7: number,
  sales30: number,
  rules: OperationsRules,
) {
  const days = sales3 > 0 ? Math.max(0, stock) / (sales3 / 3) : null;
  const growth = sales30 > 0 ? sales3 / 3 / (sales30 / 30) : null;
  return {
    days: days === null ? null : Math.round(days * 10) / 10,
    spike: growth !== null && growth >= rules.spikeRatio,
    growth: growth === null ? null : Math.round(growth * 100) / 100,
    risk:
      stock <= 0
        ? "缺货"
        : days === null
          ? "无近期销量"
          : days < rules.dangerDays
            ? "需关注"
            : "参考范围内",
    targetGap: Math.max(0, Math.ceil((sales7 / 7) * rules.targetDays - stock)),
  };
}
