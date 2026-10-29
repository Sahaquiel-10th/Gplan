export type ReviewFactStatus = "approved" | "pending" | "internal" | "forbidden";
export type ReviewFact = { id: string; productId: string; text: string; source: string; status: ReviewFactStatus };
export type ReviewProduct = { id: string; name: string; sku: string };
export type ReviewExample = { id: string; review: string; reply: string };
export type ReviewSettings = {
  tone: string; length: "short" | "medium" | "long"; count: 1 | 2;
  marketing: "none" | "light" | "natural"; address: "您" | "你" | "自然称呼";
  emoji: boolean; signature: string; closing: string; goals: string[];
  forbiddenPhrases: string[]; afterSales: string; sceneRules: Record<string, string>;
};
export type ReviewDraft = {
  name: string; shopName: string; brand: string; platform: string;
  settings: ReviewSettings; products: ReviewProduct[]; facts: ReviewFact[];
  examples: ReviewExample[]; rules: string[]; sourceAttachmentIds: string[];
};
export type ReviewProfileVersion = { revision: number; draft: ReviewDraft; createdAt: string };
export type ReviewProfile = ReviewDraft & {
  id: string; companyId: string; ownerId: string; agentId: string; revision: number;
  versions: ReviewProfileVersion[]; createdAt: string; updatedAt: string;
};
export type ReviewInput = { id: string; text: string; productId: string; afterSalesStatus: string };
export type ReviewCandidate = {
  id: string; label: string; text: string;
  versions: { text: string; instruction: string; createdAt: string }[];
};
export type ReviewResult = ReviewInput & {
  scene: string; risk: "low" | "medium" | "high"; axis: string;
  factIds: string[]; checks: string[]; candidates: ReviewCandidate[];
};
export type ReviewRun = {
  id: string; companyId: string; ownerId: string; agentId: string;
  profileId: string; profileRevision: number; profileSnapshot: ReviewDraft;
  requestKey: string; sourceImageIds: string[]; status: "generating" | "completed" | "failed" | "interrupted";
  results: ReviewResult[]; error: string; createdAt: string; updatedAt: string;
  mutations: { requestKey: string; itemId: string; candidateId: string; status: "generating" | "completed" | "failed" | "interrupted"; error: string }[];
};
export type ReviewTemplate = { id: string; name: string; description: string; draft: ReviewDraft };
export type ReviewConfig = { agentId: string; ready: boolean; visionReady: boolean; message: string; templates: ReviewTemplate[] };
export type ReviewRunInput = { profileId?: string; draft?: ReviewDraft; reviews: ReviewInput[]; sourceImageIds?: string[]; requestKey: string };
