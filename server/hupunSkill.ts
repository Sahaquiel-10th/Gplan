import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Message, ModelConfig } from "./types.js";
import { callModel } from "./modelGateway.js";

const execFileAsync = promisify(execFile);

type HupunContextOptions = {
  deadline?: number;
  ensureAccess?: () => Promise<void>;
  onUsage?: (usage: NonNullable<Awaited<ReturnType<typeof callModel>>["usage"]>) => void;
};
function remaining(options: HupunContextOptions, cap: number) {
  const ms = Math.min(cap, options.deadline ? options.deadline - Date.now() : cap);
  if (ms < 1000) throw new Error("企业数据查询时间已用完，请缩小查询范围后重试");
  return ms;
}
const erpIndexUrl = "https://hpublic.hupun.com/mp/open/md/erp/_index.md";
const maxCalls = Math.max(1, Math.min(5, Number(process.env.HUPUN_AI_SKILL_MAX_CALLS ?? 3)));
const resultMaxChars = Math.max(4000, Number(process.env.HUPUN_AI_SKILL_RESULT_MAX_CHARS ?? 30000));

export type HupunApiDescriptor = {
  name: string;
  docUrl: string;
  path: string;
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

function apiPathFromDocUrl(docUrl: string) {
  const pathname = new URL(docUrl).pathname;
  const prefix = "/mp/open/md";
  if (!pathname.startsWith(`${prefix}/`) || !pathname.endsWith(".md")) return "";
  return pathname.slice(prefix.length, -3);
}

function readOnlyEntries(markdown: string): HupunApiDescriptor[] {
  const entries: HupunApiDescriptor[] = [];
  for (const match of markdown.matchAll(/^- (.+?) => (https:\/\/hpublic\.hupun\.com\/mp\/open\/md\/erp\/[^\s]+\.md[^\s]*)$/gm)) {
    const name = match[1].trim();
    if (!/(查询|获取)/.test(name)) continue;
    const path = apiPathFromDocUrl(match[2]);
    if (path) entries.push({ name, docUrl: match[2], path });
  }
  return entries;
}

let indexCache: { expiresAt: number; entries: HupunApiDescriptor[] } | undefined;

export async function listHupunReadOnlyApis() {
  if (indexCache && indexCache.expiresAt > Date.now()) return indexCache.entries;
  const markdown = await fetchText(`${erpIndexUrl}?date=${new Date().toISOString().slice(0, 10)}`);
  const entries = readOnlyEntries(markdown);
  indexCache = { expiresAt: Date.now() + 5 * 60_000, entries };
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

async function selectDocuments(model: ModelConfig, messages: Message[], entries: HupunApiDescriptor[], requestId: string, options: HupunContextOptions = {}) {
  await options.ensureAccess?.();
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
  ], "不得执行或规划任何会修改 ERP 数据的操作。", `${requestId}:hupun-select`, undefined, remaining(options, options.deadline ? 30000 : 150000));
  if (result.usage) options.onUsage?.(result.usage);
  const selected = parseJson<Array<{ docUrl?: string }>>(result.content);
  const allowed = new Map(entries.map((entry) => [entry.docUrl, entry]));
  return (Array.isArray(selected) ? selected : [])
    .map((item) => typeof item?.docUrl === "string" ? allowed.get(item.docUrl) : undefined)
    .filter((item): item is HupunApiDescriptor => Boolean(item))
    .slice(0, maxCalls);
}

function endpointFromDoc(markdown: string) {
  return markdown.match(/^## POST (.+)\n\nPOST (\/erp\/[^\s]+)/m);
}

async function planCalls(
  model: ModelConfig,
  messages: Message[],
  documents: Array<HupunApiDescriptor & { markdown: string }>,
  requestId: string,
  options: HupunContextOptions = {}
) {
  await options.ensureAccess?.();
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
  ], "只允许规划只读查询，不得执行或规划任何写操作。", `${requestId}:hupun-plan`, undefined, remaining(options, options.deadline ? 30000 : 150000));
  if (result.usage) options.onUsage?.(result.usage);
  const calls = parseJson<PlannedCall[]>(result.content);
  const allowed = new Map<string, { path: string; document: HupunApiDescriptor & { markdown: string } }>();
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

async function executeCall(call: PlannedCall, timeoutMs = 60000) {
  const appKey = process.env.WANLINIU_APP_KEY!.trim();
  const appSecret = process.env.WANLINIU_APP_SECRET!.trim();
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gplan-hupun-"));
  const configPath = path.join(temporaryDirectory, "config.json");
  try {
    await fs.writeFile(configPath, JSON.stringify({
      app_key: appKey,
      app_secret: appSecret,
      host: process.env.HUPUN_API_HOST?.trim() || "https://open-api.hupun.com",
      timeout_seconds: Math.max(1, Math.min(Math.floor(timeoutMs / 1000), Number(process.env.HUPUN_API_TIMEOUT_SECONDS ?? 45)))
    }), { mode: 0o600 });
    const { stdout, stderr } = await execFileAsync(
      configuredCliPath(),
      ["-c", configPath, call.path, JSON.stringify(call.params)],
      { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 }
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

export async function debugHupunReadOnlyApi(pathValue: string, params: Record<string, unknown>) {
  const status = await hupunSkillStatus();
  if (!status.ready) {
    const reason = status.missingEnvVars.length
      ? `缺少环境变量：${status.missingEnvVars.join("、")}`
      : `找不到可执行的万里牛 CLI：${status.cliPath}`;
    throw new Error(`万里牛接口暂不可用：${reason}`);
  }
  const path = pathValue.trim().startsWith("/") ? pathValue.trim() : `/${pathValue.trim()}`;
  const entries = await listHupunReadOnlyApis();
  const api = entries.find((entry) => entry.path === path);
  if (!api) throw new Error("该路径不在万里牛官方只读查询接口列表中");
  const startedAt = Date.now();
  const result = await executeCall({ docUrl: api.docUrl, path: api.path, params });
  return {
    api,
    params,
    durationMs: Date.now() - startedAt,
    result
  };
}

export async function buildHupunSkillContext(params: {
  model: ModelConfig;
  messages: Message[];
  requestId: string;
} & HupunContextOptions) {
  await params.ensureAccess?.();
  const status = await hupunSkillStatus();
  if (!status.ready) {
    const reason = status.missingEnvVars.length
      ? `缺少环境变量：${status.missingEnvVars.join("、")}`
      : `找不到可执行的万里牛 CLI：${status.cliPath}`;
    return `【万里牛 AI Skill 返回结果】\n当前不可用：${reason}`;
  }

  try {
    remaining(params, 15000);
    await params.ensureAccess?.();
    const entries = await listHupunReadOnlyApis();
    const selected = await selectDocuments(params.model, params.messages, entries, params.requestId, params);
    if (!selected.length) {
      return "【万里牛 AI Skill 返回结果】\n本轮没有找到需要且允许调用的万里牛只读接口。";
    }
    const documents = await Promise.all(selected.map(async (entry) => ({
      ...entry,
      markdown: await fetchText(entry.docUrl, remaining(params, 15000))
    })));
    const calls = await planCalls(params.model, params.messages, documents, params.requestId, params);
    if (!calls.length) {
      return "【万里牛 AI Skill 返回结果】\n已匹配相关接口，但当前信息不足以生成符合官方文档的安全查询参数。";
    }
    const results = await Promise.all(calls.map(async (call) => {
      await params.ensureAccess?.();
      const result = await executeCall(call, remaining(params, 60000));
      await params.ensureAccess?.();
      return { purpose: call.purpose || "", path: call.path, params: call.params, result };
    }));
    const serialized = JSON.stringify(results, null, 2);
    return [
      "【万里牛 AI Skill 返回结果】",
      "以下内容来自万里牛开放平台只读接口。请基于数据回答，并明确时间口径；接口报错码需原样保留，不要编造缺失数据。",
      serialized.length > resultMaxChars ? `${serialized.slice(0, resultMaxChars)}\n[结果已截断]` : serialized
    ].join("\n");
  } catch (error) {
    if ((error as { status?: number }).status === 403) throw error;
    return `【万里牛 AI Skill 返回结果】\n调用失败：${error instanceof Error ? error.message : "未知错误"}`;
  }
}
