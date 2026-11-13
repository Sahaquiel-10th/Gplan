import type { Conversation, User } from "./types.js";

export const enterpriseQueryBudgetMs = 45000;
export const enterpriseAnswerTimeoutMs = 120000;

export function canReadEnterpriseConversation(conversation: Conversation, user: User) {
  return !conversation.enterpriseData || (
    user.enabled && user.role === "admin" && conversation.enterpriseData.companyId === user.companyId
  );
}

export function assertEnterpriseAdmin(user: User) {
  if (!user.enabled || user.role !== "admin") {
    throw Object.assign(new Error("只有管理员可以使用企业数据"), { status: 403 });
  }
}

export type EnterpriseDataSource = {
  tool: string;
  title: string;
  mode: "database" | "live";
  filters: Record<string, unknown>;
  queriedAt: string;
  returnedRows: number;
  hasMore: boolean;
  status: "success" | "error";
  partial?: boolean;
  failureReason?: "timeout" | "source_error" | "invalid_params" | "budget";
  note: string;
  fields?: string[];
  querySteps?: Array<{ name: string; status: "success" | "error"; durationMs: number; returnedRows: number }>;
  coverage?: {
    startDate: string; endDate: string; queriedDays: number;
    recordsByCurrency: Array<{ currencyCode: string; daysWithRecords?: number; firstRecordDate?: string; lastRecordDate?: string }>;
  };
  sync?: Array<{ resource: string; lastSuccessAt: string }>;
};

export type EnterpriseDataEvidence = {
  status: "queried" | "partial" | "skipped" | "unavailable";
  sources: EnterpriseDataSource[];
  notices: string[];
  task?: {
    startDate: string; endDate: string;
    requestedMetrics: string[]; providedMetrics: string[]; missingMetrics: string[];
    completed: boolean;
  };
  context?: { characters: number; sha256: string };
  timing?: { planningMs: number; queryMs: number; totalMs: number; budgetMs: number };
};

export function enterpriseEvidenceStatus(evidence: EnterpriseDataEvidence) {
  const business = evidence.sources.filter(source => source.tool !== "source_status");
  const relevant = business.length ? business : evidence.sources;
  if (!relevant.length) return evidence.status;
  const succeeded = relevant.filter(source => source.status === "success").length;
  return succeeded ? succeeded < relevant.length || relevant.some(source => source.partial) || evidence.task?.completed === false ? "partial" : "queried" : "unavailable";
}
