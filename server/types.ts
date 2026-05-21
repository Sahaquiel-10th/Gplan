export type Role = "admin" | "user";

export type User = {
  id: string;
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
  createdAt: string;
};

export type Message = {
  role: "user" | "assistant" | "system";
  content: string;
  imageUrl?: string;
  createdAt: string;
  modelId?: string;
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

export type Database = {
  users: User[];
  models: ModelConfig[];
  conversations: Conversation[];
  workspaces: Workspace[];
  integrationTokens: IntegrationToken[];
  settings: SystemSettings;
};

export type PublicUser = Omit<User, "passwordHash">;
export type PublicModel = Omit<ModelConfig, "apiKey" | "systemPrompt"> & { hasApiKey: boolean };
export type AdminModel = PublicModel & { apiKey: string; systemPrompt: string };
