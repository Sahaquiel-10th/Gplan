import { Message, ModelConfig } from "./types.js";

type ChatResult = {
  content: string;
  imageUrl?: string;
  raw?: unknown;
};

export async function callModel(model: ModelConfig, messages: Message[], safetyRules = ""): Promise<ChatResult> {
  if (!model.enabled) throw new Error("模型未启用");
  if (!model.apiKey) throw new Error("模型缺少 API Key");
  if (model.kind === "image") return callImageModel(model, messages, safetyRules);

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
  const response = await fetch(endpoint, {
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
      temperature: 0.7
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.error?.message === "string" ? payload.error.message : response.statusText;
    const hint =
      response.status === 503 || /temporarily unavailable/i.test(detail)
        ? "供应商服务暂时不可用，稍后重试；如果一直出现，检查该模型在供应商控制台是否可用。"
        : detail;
    throw new Error(`模型调用失败：${hint}`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("模型响应格式不正确");
  return { content, raw: payload };
}

async function callImageModel(model: ModelConfig, messages: Message[], safetyRules = ""): Promise<ChatResult> {
  const userPrompt = [...messages].reverse().find((message) => message.role === "user")?.content;
  const prompt = [safetyRules, model.systemPrompt, userPrompt].map((item) => item?.trim()).filter(Boolean).join("\n\n");
  if (!prompt) throw new Error("图片提示词不能为空");

  const endpoint = `${model.baseUrl.replace(/\/$/, "")}/images/generations`;
  const response = await fetch(endpoint, {
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
  });

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
  return { content: "图片已生成", imageUrl, raw: payload };
}
