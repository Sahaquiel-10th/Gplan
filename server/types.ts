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
  protocol: "openai" | "anthropic";
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
  attachments?: AttachmentSummary[];
  sources?: SearchSource[];
  inputImageDataUrls?: string[];
  createdAt: string;
  modelId?: string;
};

export type MessageRecord = Required<Pick<Message, "id" | "role" | "content" | "createdAt">> & {
  companyId: string;
  userId: string;
  conversationId: string;
  modelId?: string;
  imageUrl?: string;
  attachmentIds?: string[];
  sources?: SearchSource[];
  tokenCount?: number;
};

export type Conversation = {
  id: string;
  userId: string;
  modelId: string;
  agentId?: string;
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

export type Agent = {
  id: string;
  companyId: string;
  ownerId: string;
  name: string;
  description: string;
  prompt: string;
  modelId: string;
  group: string;
  avatar: string;
  color: string;
  favoriteUserIds: string[];
  useCount: number;
  allowFileUpload: boolean;
  allowImageInput: boolean;
  allowWebSearch: boolean;
  published: boolean;
  publicSlug: string;
  createdAt: string;
  updatedAt: string;
};

export type AttachmentKind = "image" | "document" | "spreadsheet" | "presentation" | "text";

export type Attachment = {
  id: string;
  companyId: string;
  userId: string;
  originalName: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  storagePath: string;
  extractedText: string;
  conversationId?: string;
  messageId?: string;
  createdAt: string;
};

export type AttachmentSummary = Pick<Attachment, "id" | "originalName" | "mimeType" | "kind" | "size">;

export type SearchSource = {
  title: string;
  url: string;
  snippet: string;
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

export type DataConnectorId = "wanliniu" | "alipay" | "dingtalk_knowledge";

export type DataConnector = {
  id: DataConnectorId;
  name: string;
  sourceType: "erp" | "payment" | "knowledge";
  enabled: boolean;
  status: "waiting_credentials" | "ready" | "syncing" | "error";
  requiredEnvVars: string[];
  lastCheckedAt?: string;
  lastSyncedAt?: string;
  message?: string;
};

export type KnowledgeSyncDocument = {
  id: string;
  source: "dingtalk";
  sourceWorkspaceId: string;
  sourceNodeId: string;
  title: string;
  sourceUrl?: string;
  contentHash: string;
  sourceUpdatedAt?: string;
  bailianDocumentId?: string;
  bailianJobId?: string;
  status: "synced" | "skipped" | "failed" | "unsupported";
  lastSyncedAt?: string;
  lastError?: string;
  retryAfter?: string;
  unsupportedReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type DataSyncLog = {
  id: string;
  connectorId: DataConnectorId;
  action: "check_credentials" | "manual_sync" | "scheduled_sync";
  status: "running" | "success" | "blocked" | "failed";
  message: string;
  startedAt: string;
  finishedAt: string;
};

export type DataMetricDefinition = {
  id: string;
  name: string;
  layer: "semantic";
  connectorIds: DataConnectorId[];
  description: string;
  status: "planned" | "available";
};

export type ManagementBriefDimensionId =
  | "sales_overview"
  | "shop_performance"
  | "product_performance"
  | "inventory_status"
  | "purchase_inbound"
  | "period_comparison"
  | "data_quality";

export type ManagementBriefDefinition = {
  id: string;
  companyId: string;
  source: "system" | "custom";
  name: string;
  description: string;
  dimensionIds: ManagementBriefDimensionId[];
  prompt: string;
  enabled: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
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
  agents: Agent[];
  attachments: Attachment[];
  dataConnectors: DataConnector[];
  dataSyncLogs: DataSyncLog[];
  dataMetricDefinitions: DataMetricDefinition[];
  managementBriefDefinitions: ManagementBriefDefinition[];
  knowledgeSyncDocuments: KnowledgeSyncDocument[];
  settings: SystemSettings;
};

export type PublicUser = Omit<User, "passwordHash">;
export type PublicModel = Omit<ModelConfig, "apiKey" | "systemPrompt"> & { hasApiKey: boolean };
export type AdminModel = PublicModel & { systemPrompt: string };
