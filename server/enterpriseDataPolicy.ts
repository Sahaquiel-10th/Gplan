import type { Conversation, User } from "./types.js";

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
  note: string;
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
};

export function enterpriseEvidenceStatus(evidence: EnterpriseDataEvidence) {
  const business = evidence.sources.filter(source => source.tool !== "source_status");
  const relevant = business.length ? business : evidence.sources;
  if (!relevant.length) return evidence.status;
  const succeeded = relevant.filter(source => source.status === "success").length;
  return succeeded ? succeeded < relevant.length ? "partial" : "queried" : "unavailable";
}
