import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Message, ModelConfig } from "./types.js";
import { callModel } from "./modelGateway.js";

const execFileAsync = promisify(execFile);
const erpIndexUrl = "https://hpublic.hupun.com/mp/open/md/erp/_index.md";
const maxCalls = Math.max(1, Math.min(5, Number(process.env.HUPUN_AI_SKILL_MAX_CALLS ?? 3)));
const resultMaxChars = Math.max(4000, Number(process.env.HUPUN_AI_SKILL_RESULT_MAX_CHARS ?? 30000));

type IndexEntry = {
  name: string;
  docUrl: string;
};

type PlannedCall = {
  docUrl: string;
  path: string;
  params: Record<string, unknown>;
  purpose?: string;
};

export type HupunSkillStatus = {
  ready: boolean;
  hasCredentials: boolean;
  cliPath: string;
  cliAvailable: boolean;
  missingEnvVars: string[];
};

function configuredCliPath() {
  return process.env.HUPUN_API_CLI_PATH?.trim() || "hupun-api-cli";
}

async function executableExists(file: string) {
  try {
    await execFileAsync(file, ["-v"], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

export async function hupunSkillStatus(): Promise<HupunSkillStatus> {
  const missingEnvVars = ["WANLINIU_APP_KEY", "WANLINIU_APP_SECRET"]
    .filter((name) => !process.env[name]?.trim());
  const cliPath = configuredCliPath();
  const cliAvailable = await executableExists(cliPath);
  return {
    ready: missingEnvVars.length === 0 && cliAvailable,
    hasCredentials: missingEnvVars.length === 0,
    cliPath,
    cliAvailable,
    missingEnvVars
  };
}

async function fetchText(url: string, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`万里牛文档请求失败（HTTP ${response.status}）`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function readOnlyEntries(markdown: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const match of markdown.matchAll(/^- (.+?) => (https:\/\/hpublic\.hupun\.com\/mp\/open\/md\/erp\/[^\s]+\.md[^\s]*)$/gm)) {
    const name = match[1].trim();
    if (!/(查询|获取)/.test(name)) continue;
    entries.push({ name, docUrl: match[2] });
  }
  return entries;
}

function parseJson<T>(content: string): T {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = (fenced || content).trim();
  const firstArray = source.indexOf("[");
  const lastArray = source.lastIndexOf("]");
  const firstObject = source.indexOf("{");
  const lastObject = source.lastIndexOf("}");
  const json = firstArray >= 0 && lastArray > firstArray
    ? source.slice(firstArray, lastArray + 1)
    : firstObject >= 0 && lastObject > firstObject
      ? source.slice(firstObject, lastObject + 1)
      : source;
  return JSON.parse(json) as T;
}

function plannerMessage(model: ModelConfig, content: string): Message {
  return {
    role: "user",
    content,
    modelId: model.id,
    createdAt: new Date().toISOString()
  };
}

function recentConversationText(messages: Message[]) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-8)
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`)
    .join("\n");
}

async function selectDocuments(model: ModelConfig, messages: Message[], entries: IndexEntry[], requestId: string) {
  const index = entries.map((entry) => `- ${entry.name} => ${entry.docUrl}`).join("\n");
  const result = await callModel(model, [
    plannerMessage(model, [
      "你是万里牛 ERP 只读 API 路由器。根据对话选择回答当前问题所需的官方接口文档。",
      `最多选择 ${maxCalls} 个。只可从给定列表原样复制 docUrl，禁止选择任何新增、修改、审核、关闭、发货、同步等写接口。`,
      "若问题不需要 ERP 数据、信息不足或列表中没有合适接口，返回 []。",
      '只输出 JSON 数组，例如：[{"docUrl":"https://...","reason":"需要查询店铺"}]',
      `当前时间（Asia/Shanghai）：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
      `对话：\n${recentConversationText(messages)}`,
      `可用只读接口：\n${index}`
    ].join("\n\n"))
  ], "不得执行或规划任何会修改 ERP 数据的操作。", `${requestId}:hupun-select`);
  const selected = parseJson<Array<{ docUrl?: string }>>(result.content);
  const allowed = new Map(entries.map((entry) => [entry.docUrl, entry]));
  return (Array.isArray(selected) ? selected : [])
    .map((item) => typeof item?.docUrl === "string" ? allowed.get(item.docUrl) : undefined)
    .filter((item): item is IndexEntry => Boolean(item))
    .slice(0, maxCalls);
}

function endpointFromDoc(markdown: string) {
  return markdown.match(/^## POST (.+)\n\nPOST (\/erp\/[^\s]+)/m);
}

async function planCalls(
  model: ModelConfig,
  messages: Message[],
  documents: Array<IndexEntry & { markdown: string }>,
  requestId: string
) {
  const docs = documents.map((document) => [
    `文档 URL：${document.docUrl}`,
    document.markdown.slice(0, 16000)
  ].join("\n")).join("\n\n---\n\n").slice(0, 36000);
  const result = await callModel(model, [
    plannerMessage(model, [
      "你是万里牛 ERP 只读 API 参数规划器。请根据官方文档为当前问题生成调用参数。",
      "只能调用所附文档里的 POST 路径。参数名和格式必须严格来自文档；不要猜测未知 ID。",
      "时间使用 Asia/Shanghai。分页查询默认 page=1，并使用文档允许的合理 limit。",
      "如果缺少无法推断的必要参数，就不要调用该接口。",
      `最多 ${maxCalls} 个调用。只输出 JSON 数组：`,
      '[{"docUrl":"原文档URL","path":"/erp/...","params":{"page":1,"limit":50},"purpose":"用途"}]',
      `当前时间（Asia/Shanghai）：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
      `对话：\n${recentConversationText(messages)}`,
      `官方文档：\n${docs}`
    ].join("\n\n"))
  ], "只允许规划只读查询，不得执行或规划任何写操作。", `${requestId}:hupun-plan`);
  const calls = parseJson<PlannedCall[]>(result.content);
  const allowed = new Map<string, { path: string; document: IndexEntry & { markdown: string } }>();
  for (const document of documents) {
    const endpoint = endpointFromDoc(document.markdown);
    if (endpoint) allowed.set(document.docUrl, { path: endpoint[2], document });
  }
  return (Array.isArray(calls) ? calls : []).filter((call) => {
    const expected = allowed.get(call?.docUrl);
    return Boolean(
      expected &&
      call.path === expected.path &&
      call.params &&
      typeof call.params === "object" &&
      !Array.isArray(call.params)
    );
  }).slice(0, maxCalls);
}

async function executeCall(call: PlannedCall) {
  const appKey = process.env.WANLINIU_APP_KEY!.trim();
  const appSecret = process.env.WANLINIU_APP_SECRET!.trim();
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gplan-hupun-"));
  const configPath = path.join(temporaryDirectory, "config.json");
  try {
    await fs.writeFile(configPath, JSON.stringify({
      app_key: appKey,
      app_secret: appSecret,
      host: process.env.HUPUN_API_HOST?.trim() || "https://open-api.hupun.com",
      timeout_seconds: Math.max(5, Number(process.env.HUPUN_API_TIMEOUT_SECONDS ?? 45))
    }), { mode: 0o600 });
    const { stdout, stderr } = await execFileAsync(
      configuredCliPath(),
      ["-c", configPath, call.path, JSON.stringify(call.params)],
      { timeout: 60000, maxBuffer: 5 * 1024 * 1024 }
    );
    const raw = `${stdout || ""}${stderr ? `\n${stderr}` : ""}`.trim();
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch (error) {
    const details = error && typeof error === "object"
      ? `${"stdout" in error ? String(error.stdout || "") : ""}\n${"stderr" in error ? String(error.stderr || "") : ""}`.trim()
      : "";
    return {
      error: error instanceof Error ? error.message : "万里牛 CLI 调用失败",
      details
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function buildHupunSkillContext(params: {
  model: ModelConfig;
  messages: Message[];
  requestId: string;
}) {
  const status = await hupunSkillStatus();
  if (!status.ready) {
    const reason = status.missingEnvVars.length
      ? `缺少环境变量：${status.missingEnvVars.join("、")}`
      : `找不到可执行的万里牛 CLI：${status.cliPath}`;
    return `【万里牛 AI Skill 返回结果】\n当前不可用：${reason}`;
  }

  try {
    const indexMarkdown = await fetchText(`${erpIndexUrl}?date=${new Date().toISOString().slice(0, 10)}`);
    const entries = readOnlyEntries(indexMarkdown);
    const selected = await selectDocuments(params.model, params.messages, entries, params.requestId);
    if (!selected.length) {
      return "【万里牛 AI Skill 返回结果】\n本轮没有找到需要且允许调用的万里牛只读接口。";
    }
    const documents = await Promise.all(selected.map(async (entry) => ({
      ...entry,
      markdown: await fetchText(entry.docUrl)
    })));
    const calls = await planCalls(params.model, params.messages, documents, params.requestId);
    if (!calls.length) {
      return "【万里牛 AI Skill 返回结果】\n已匹配相关接口，但当前信息不足以生成符合官方文档的安全查询参数。";
    }
    const results = await Promise.all(calls.map(async (call) => ({
      purpose: call.purpose || "",
      path: call.path,
      params: call.params,
      result: await executeCall(call)
    })));
    const serialized = JSON.stringify(results, null, 2);
    return [
      "【万里牛 AI Skill 返回结果】",
      "以下内容来自万里牛开放平台只读接口。请基于数据回答，并明确时间口径；接口报错码需原样保留，不要编造缺失数据。",
      serialized.length > resultMaxChars ? `${serialized.slice(0, resultMaxChars)}\n[结果已截断]` : serialized
    ].join("\n");
  } catch (error) {
    return `【万里牛 AI Skill 返回结果】\n调用失败：${error instanceof Error ? error.message : "未知错误"}`;
  }
}
