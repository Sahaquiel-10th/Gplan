import { Message, ModelConfig } from "./types.js";

type ChatResult = {
  content: string;
  imageUrl?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    source: "provider";
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
  if (model.protocol === "anthropic") return callAnthropicModel(model, messages, safetyRules, requestId);

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
          content: message.inputImageDataUrls?.length
            ? [
                { type: "text", text: message.content },
                ...message.inputImageDataUrls.map((url) => ({ type: "image_url", image_url: { url } }))
              ]
            : message.content
        })),
        temperature: 0.7,
        max_tokens: maxOutputTokens
      })
    }, requestTimeoutMs);

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof payload?.error?.message === "string" ? payload.error.message : response.statusText;
      console.error(JSON.stringify({
        event: "model_upstream_error",
        requestId,
        modelId: model.id,
        model: model.model,
        status: response.status,
        detail
      }));
      const hint =
        response.status === 503 || /temporarily unavailable/i.test(detail)
          ? `供应商暂时无法提供模型 "${model.model}"，请在中转站确认该 Key 所属分组已包含此模型且模型 ID 完全一致`
          : detail;
      throw new Error(`模型调用失败（上游 ${response.status}）：${hint}`);
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("模型响应格式不正确");
    const providerInputTokens = Number(payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens);
    const providerOutputTokens = Number(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens);
    const hasProviderUsage = Number.isFinite(providerInputTokens) && Number.isFinite(providerOutputTokens);
    console.log(JSON.stringify({
      event: "model_request_completed",
      requestId,
      modelId: model.id,
      durationMs: Date.now() - startedAt,
      outputChars: content.length
    }));
    return {
      content,
      usage: hasProviderUsage ? {
        inputTokens: providerInputTokens,
        outputTokens: providerOutputTokens,
        totalTokens: Number.isFinite(Number(payload?.usage?.total_tokens))
          ? Number(payload.usage.total_tokens)
          : providerInputTokens + providerOutputTokens,
        source: "provider"
      } : undefined,
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

async function callAnthropicModel(
  model: ModelConfig,
  messages: Message[],
  safetyRules = "",
  requestId = "unknown"
): Promise<ChatResult> {
  const system = [safetyRules, model.systemPrompt].map((content) => content.trim()).filter(Boolean).join("\n\n");
  const endpoint = `${model.baseUrl.replace(/\/$/, "")}/messages`;
  const startedAt = Date.now();
  console.log(JSON.stringify({
    event: "model_request_started",
    requestId,
    modelId: model.id,
    model: model.model,
    protocol: "anthropic",
    inputMessages: messages.length,
    inputChars: messages.reduce((total, message) => total + message.content.length, 0),
    maxOutputTokens
  }));
  try {
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": model.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: model.model,
        system: system || undefined,
        messages: messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({ role: message.role, content: message.content })),
        temperature: 0.7,
        max_tokens: maxOutputTokens
      })
    }, requestTimeoutMs);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof payload?.error?.message === "string" ? payload.error.message : response.statusText;
      console.error(JSON.stringify({
        event: "model_upstream_error",
        requestId,
        modelId: model.id,
        model: model.model,
        protocol: "anthropic",
        status: response.status,
        detail
      }));
      const hint =
        response.status === 503 || /temporarily unavailable/i.test(detail)
          ? `供应商暂时无法提供模型 "${model.model}"，请在中转站确认该 Key 所属分组已包含此模型且模型 ID 完全一致`
          : detail;
      throw new Error(`模型调用失败（上游 ${response.status}）：${hint}`);
    }
    const content = Array.isArray(payload?.content)
      ? payload.content.filter((item: { type?: string; text?: unknown }) => item?.type === "text" && typeof item.text === "string").map((item: { text: string }) => item.text).join("\n")
      : "";
    if (!content) throw new Error("模型响应格式不正确");
    const inputTokens = Number(payload?.usage?.input_tokens);
    const outputTokens = Number(payload?.usage?.output_tokens);
    const hasProviderUsage = Number.isFinite(inputTokens) && Number.isFinite(outputTokens);
    console.log(JSON.stringify({
      event: "model_request_completed",
      requestId,
      modelId: model.id,
      protocol: "anthropic",
      durationMs: Date.now() - startedAt,
      outputChars: content.length
    }));
    return {
      content,
      usage: hasProviderUsage ? {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        source: "provider"
      } : undefined,
      raw: payload
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: "model_request_failed",
      requestId,
      modelId: model.id,
      protocol: "anthropic",
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

  const inputImages = [...messages].reverse().find((message) => message.role === "user")?.inputImageDataUrls ?? [];
  const endpoint = `${model.baseUrl.replace(/\/$/, "")}/images/${inputImages.length ? "edits" : "generations"}`;
  const startedAt = Date.now();
  const request = inputImages.length
    ? imageEditRequest(model, prompt, inputImages)
    : {
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
      };
  const response = await fetchWithTimeout(endpoint, {
    ...request
  }, imageRequestTimeoutMs);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.error?.message === "string" ? payload.error.message : response.statusText;
    const hint = /requires an image model/i.test(detail)
      ? `当前模型 ID "${model.model}" 不是供应商认可的图片模型。请在后台确认模型 ID，yylx 的内置图片模型已改为 gpt-image-2。`
      : inputImages.length && response.status === 404
        ? `当前供应商没有提供 /images/edits 图生图接口，请确认模型和中转站支持图片编辑`
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
  const providerInputTokens = Number(payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens);
  const providerOutputTokens = Number(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens);
  const hasProviderUsage = Number.isFinite(providerInputTokens) && Number.isFinite(providerOutputTokens);
  return {
    content: "图片已生成",
    imageUrl,
    usage: hasProviderUsage ? {
      inputTokens: providerInputTokens,
      outputTokens: providerOutputTokens,
      totalTokens: Number.isFinite(Number(payload?.usage?.total_tokens))
        ? Number(payload.usage.total_tokens)
        : providerInputTokens + providerOutputTokens,
      source: "provider"
    } : undefined,
    raw: payload
  };
}

function imageEditRequest(model: ModelConfig, prompt: string, inputImages: string[]): RequestInit {
  const form = new FormData();
  form.append("model", model.model);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", "1024x1024");
  inputImages.forEach((dataUrl, index) => {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(dataUrl);
    if (!match) throw new Error("图生图输入图片格式不受支持");
    const mimeType = match[1].toLowerCase();
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
    const bytes = Uint8Array.from(Buffer.from(match[2], "base64"));
    form.append("image[]", new Blob([bytes], { type: mimeType }), `input-${index + 1}.${extension}`);
  });
  return {
    method: "POST",
    headers: { Authorization: `Bearer ${model.apiKey}` },
    body: form
  };
}
