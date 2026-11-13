import { modelProviderPresets, officialProvider } from "../shared/modelProviders.js";
import { callModel } from "./modelGateway.js";
import type { ModelConfig } from "./types.js";

export function modelConnectionDraft(input: Record<string, unknown>, existing?: ModelConfig): ModelConfig {
  const provider = typeof input.provider === "string" ? input.provider.trim() : existing?.provider || "custom";
  if (existing && provider !== existing.provider && !(typeof input.apiKey === "string" && input.apiKey.trim())) throw new Error("切换服务商时请填写新服务商的 API Key");
  const preset = officialProvider(provider) ? modelProviderPresets[provider] : undefined;
  if (preset && input.kind === "image") throw new Error("官方预设用于聊天模型；图片生成请使用对应的图片接口配置");
  const field = (name: "name" | "baseUrl" | "model") => typeof input[name] === "string" && (input[name] as string).trim() ? (input[name] as string).trim() : (existing?.provider === provider ? existing[name] : undefined) || preset?.[name] || "";
  return {
    id: existing?.id || "connection-test", name: field("name"), provider, baseUrl: field("baseUrl"), model: field("model"),
    kind: input.kind === "image" || input.kind === "chat" ? input.kind : existing?.kind || "chat",
    protocol: preset ? "openai" : input.protocol === "anthropic" || input.protocol === "openai" ? input.protocol : existing?.protocol || "openai",
    apiKey: typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : existing?.apiKey || "",
    systemPrompt: typeof input.systemPrompt === "string" ? input.systemPrompt : existing?.systemPrompt || "",
    thinkingMode: input.thinkingMode === "enabled" || input.thinkingMode === "disabled" ? input.thinkingMode : existing?.thinkingMode || (preset ? "disabled" : undefined),
    enabled: true, isDefault: false, createdAt: existing?.createdAt || new Date().toISOString(),
  };
}

export async function testModelConnection(model: ModelConfig, requestId: string, run = callModel) {
  if (model.kind !== "chat") throw new Error("此处仅测试聊天模型，请使用聊天模型配置");
  if (!model.apiKey) throw new Error("请先填写 API Key");
  if (!model.model || !model.baseUrl) throw new Error("请填写模型 ID 和服务地址");
  const start = Date.now();
  try {
    const result = await run({ ...model, enabled: true, systemPrompt: "", thinkingMode: "disabled" }, [{ role: "user", content: "连接测试，请只回复：连接成功。", createdAt: new Date().toISOString() }], "", requestId, 128, 20000);
    return { ok: true, latencyMs: Date.now() - start, model: model.model, reply: result.content.replaceAll(model.apiKey, "[已隐藏密钥]").slice(0, 200) };
  } catch (error) {
    // Provider exceptions can echo credentials. Never return the original error.
    const message = String((error as Error).message);
    throw new Error(/401|403|API.key|api_key|authentication/i.test(message) ? "认证或模型授权失败，请核对 API Key，并在服务商后台开通所选模型或接入点。" : /404|model.*not.*found/i.test(message) ? "模型或接入点不存在，请核对模型 ID、接入点 ID 和服务地址。" : /超时|timeout/i.test(message) ? "连接测试超时，请稍后重试或检查服务地址。" : "连接测试失败，请核对模型配置及服务商状态。");
  }
}
