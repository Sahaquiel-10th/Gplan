export type Role = "admin" | "user";

export type User = {
  id: string;
  companyId: string;
  username: string;
  passwordHash: string;
  role: Role;
  enabled: boolean;
  createdAt: string;
};

export type ModelConfig = {
  id: string;
  name: string;
  provider: string;
  kind: "chat" | "image";
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
};

export type Message = {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  imageUrl?: string;
  createdAt: string;
  modelId?: string;
};

export type MessageRecord = Required<Pick<Message, "id" | "role" | "content" | "createdAt">> & {
  companyId: string;
  userId: string;
  conversationId: string;
  modelId?: string;
  imageUrl?: string;
  tokenCount?: number;
};

export type Conversation = {
  id: string;
  userId: string;
  modelId: string;
  workspaceId?: string;
  archived: boolean;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
};

export type Workspace = {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
};

export type IntegrationToken = {
  id: string;
  name: string;
  token?: string;
  tokenHash: string;
  enabled: boolean;
  createdAt: string;
};

export type SystemSettings = {
  safetyRules: string;
};

export type MemorySyncState = {
  id: string;
  companyId: string;
  userId: string;
  conversationId: string;
  lastSubmittedMessageId?: string;
  lastSubmittedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserSavedMemory = {
  id: string;
  companyId: string;
  userId: string;
  conversationId?: string;
  sourceMessageId?: string;
  content: string;
  memoryUserId: string;
  bailianMemoryId?: string;
  status: "active" | "deleted" | "failed";
  createdAt: string;
  updatedAt: string;
};

export type RagRetrievalLog = {
  id: string;
  companyId: string;
  userId: string;
  conversationId: string;
  query: string;
  sourceType: "company_kb" | "memory_library";
  matchedItemsJson: unknown;
  injectedContext: string;
  threshold: number;
  topK: number;
  createdAt: string;
};

export type ModelUsageRecord = {
  id: string;
  companyId: string;
  userId: string;
  conversationId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: "provider" | "estimated";
  createdAt: string;
};

export type Database = {
  users: User[];
  models: ModelConfig[];
  conversations: Conversation[];
  messages: MessageRecord[];
  memorySyncStates: MemorySyncState[];
  userSavedMemories: UserSavedMemory[];
  ragRetrievalLogs: RagRetrievalLog[];
  modelUsageRecords: ModelUsageRecord[];
  workspaces: Workspace[];
  integrationTokens: IntegrationToken[];
  settings: SystemSettings;
};

export type PublicUser = Omit<User, "passwordHash">;
export type PublicModel = Omit<ModelConfig, "apiKey" | "systemPrompt"> & { hasApiKey: boolean };
export type AdminModel = PublicModel & { systemPrompt: string };
