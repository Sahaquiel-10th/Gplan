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
  sync?: Array<{ resource: string; lastSuccessAt: string }>;
};

export type EnterpriseDataEvidence = {
  status: "queried" | "skipped" | "unavailable";
  sources: EnterpriseDataSource[];
  notices: string[];
};
