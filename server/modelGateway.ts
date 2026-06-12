import { Message, ModelConfig } from "./types.js";

type ChatResult = {
  content: string;
  imageUrl?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    source: "provider" | "estimated";
  };
  raw?: unknown;
};

const requestTimeoutMs = numberEnv("MODEL_REQUEST_TIMEOUT_MS", 150000);
const imageRequestTimeoutMs = numberEnv("IMAGE_REQUEST_TIMEOUT_MS", 180000);
const maxOutputTokens = numberEnv("MODEL_MAX_OUTPUT_TOKENS", 3000);

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`模型响应超时（已等待 ${Math.max(1, Math.round(timeoutMs / 1000))} 秒），请缩短问题或稍后重试`);
    }
    throw new Error("无法连接模型服务，请稍后重试");
  } finally {
    clearTimeout(timeout);
  }
}

export async function callModel(
  model: ModelConfig,
  messages: Message[],
  safetyRules = "",
  requestId = "unknown"
): Promise<ChatResult> {
  if (!model.enabled) throw new Error("模型未启用");
  if (!model.apiKey) throw new Error("模型缺少 API Key");
  if (model.kind === "image") return callImageModel(model, messages, safetyRules, requestId);

  const systemMessages: Message[] = [safetyRules, model.systemPrompt]
    .map((content) => content.trim())
    .filter(Boolean)
    .map((content) => ({
      role: "system",
      content,
      createdAt: new Date().toISOString(),
      modelId: model.id
    }));

  const endpoint = `${model.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const startedAt = Date.now();
  console.log(JSON.stringify({
    event: "model_request_started",
    requestId,
    modelId: model.id,
    model: model.model,
    inputMessages: messages.length,
    inputChars: messages.reduce((total, message) => total + message.content.length, 0),
    maxOutputTokens
  }));
  try {
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${model.apiKey}`
      },
      body: JSON.stringify({
        model: model.model,
        messages: [...systemMessages, ...messages].map((message) => ({
          role: message.role,
          content: message.content
        })),
        temperature: 0.7,
        max_tokens: maxOutputTokens
      })
    }, requestTimeoutMs);

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof payload?.error?.message === "string" ? payload.error.message : response.statusText;
      const hint =
        response.status === 503 || /temporarily unavailable/i.test(detail)
          ? "供应商服务暂时不可用，请稍后重试"
          : detail;
      throw new Error(`模型调用失败（上游 ${response.status}）：${hint}`);
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("模型响应格式不正确");
    const providerInputTokens = Number(payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens);
    const providerOutputTokens = Number(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens);
    const hasProviderUsage = Number.isFinite(providerInputTokens) && Number.isFinite(providerOutputTokens);
    const inputTokens = hasProviderUsage
      ? providerInputTokens
      : Math.ceil([...systemMessages, ...messages].reduce((total, message) => total + message.content.length, 0) / 4);
    const outputTokens = hasProviderUsage ? providerOutputTokens : Math.ceil(content.length / 4);
    console.log(JSON.stringify({
      event: "model_request_completed",
      requestId,
      modelId: model.id,
      durationMs: Date.now() - startedAt,
      outputChars: content.length
    }));
    return {
      content,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        source: hasProviderUsage ? "provider" : "estimated"
      },
      raw: payload
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: "model_request_failed",
      requestId,
      modelId: model.id,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "未知错误"
    }));
    throw error;
  }
}

async function callImageModel(
  model: ModelConfig,
  messages: Message[],
  safetyRules = "",
  requestId = "unknown"
): Promise<ChatResult> {
  const userPrompt = [...messages].reverse().find((message) => message.role === "user")?.content;
  const prompt = [safetyRules, model.systemPrompt, userPrompt].map((item) => item?.trim()).filter(Boolean).join("\n\n");
  if (!prompt) throw new Error("图片提示词不能为空");

  const endpoint = `${model.baseUrl.replace(/\/$/, "")}/images/generations`;
  const startedAt = Date.now();
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.apiKey}`
    },
    body: JSON.stringify({
      model: model.model,
      prompt,
      n: 1,
      size: "1024x1024"
    })
  }, imageRequestTimeoutMs);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.error?.message === "string" ? payload.error.message : response.statusText;
    const hint = /requires an image model/i.test(detail)
      ? `当前模型 ID "${model.model}" 不是供应商认可的图片模型。请在后台确认模型 ID，yylx 的内置图片模型已改为 gpt-image-2。`
      : detail;
    throw new Error(`图片模型调用失败：${hint}`);
  }

  const first = payload?.data?.[0];
  const imageUrl =
    typeof first?.url === "string"
      ? first.url
      : typeof first?.b64_json === "string"
        ? `data:image/png;base64,${first.b64_json}`
        : typeof payload?.output?.[0]?.url === "string"
          ? payload.output[0].url
          : typeof payload?.output?.[0]?.b64_json === "string"
            ? `data:image/png;base64,${payload.output[0].b64_json}`
            : "";
  if (!imageUrl) throw new Error("图片模型响应格式不正确");
  console.log(JSON.stringify({
    event: "image_request_completed",
    requestId,
    modelId: model.id,
    durationMs: Date.now() - startedAt
  }));
  const inputTokens = Math.ceil(prompt.length / 4);
  return {
    content: "图片已生成",
    imageUrl,
    usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens, source: "estimated" },
    raw: payload
  };
}
