export type OfficialModelProvider = "deepseek" | "doubao";

export const modelProviderPresets = {
  deepseek: {
    label: "DeepSeek 官方", name: "DeepSeek Flash", baseUrl: "https://api.deepseek.com", model: "deepseek-flash",
    models: ["deepseek-flash", "deepseek-v4-pro"], docsUrl: "https://api-docs.deepseek.com/quick_start/agent_integrations/",
    hint: "填写 DeepSeek API Key 即可测试。也可选择 Pro。",
  },
  doubao: {
    label: "豆包 · 火山方舟", name: "豆包 Seed 2.1 Pro", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-2-1-pro-260915",
    models: ["doubao-seed-2-1-pro-260915", "doubao-seed-2-1-lite-260915"], docsUrl: "https://www.volcengine.com/docs/82379/1494384",
    hint: "填写方舟 API Key，需在方舟开通所选模型。也可填写账号自己的 ep- 接入点 ID。",
  },
} as const;

export function officialProvider(value: unknown): value is OfficialModelProvider {
  return value === "deepseek" || value === "doubao";
}

export function providerRequestOptions(provider: string, mode?: "enabled" | "disabled") {
  return officialProvider(provider) ? { thinking: { type: mode || "disabled" } } : {};
}

export function modelChatEndpoint(base: string) {
  const url = new URL(base.trim());
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("模型地址须为不含凭证、查询参数的 HTTP(S) 地址");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "") + "/chat/completions";
  return url.toString();
}
