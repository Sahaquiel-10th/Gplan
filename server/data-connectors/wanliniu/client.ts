import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WanliniuRecord = Record<string, unknown>;

const allowedPaths = new Set([
  "/erp/base/shop/page/get",
  "/erp/goods/spec/open/query/goodswithspeclist",
  "/erp/open/inventory/items/get/by/modifytimev2",
  "/erp/sale/stock/out/query",
  "/erp/purchase/purchasebill/stockin/query"
]);

function cliPath() {
  return process.env.HUPUN_API_CLI_PATH?.trim() || "hupun-api-cli";
}

function timeoutMs() {
  const seconds = Number(process.env.HUPUN_API_TIMEOUT_SECONDS ?? 45);
  return Math.max(5, Number.isFinite(seconds) ? seconds : 45) * 1000;
}

function credentials() {
  const appKey = process.env.WANLINIU_APP_KEY?.trim() || "";
  const appSecret = process.env.WANLINIU_APP_SECRET?.trim() || "";
  const missing = [
    ["WANLINIU_APP_KEY", appKey],
    ["WANLINIU_APP_SECRET", appSecret]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`缺少万里牛凭证：${missing.join("、")}`);
  return { appKey, appSecret };
}

function parseCliJson(raw: string) {
  const source = raw.trim();
  if (!source) throw new Error("万里牛 CLI 未返回数据");
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "JSON 解析失败";
    throw new Error(`万里牛 CLI 响应无法解析（${source.length} 字节）：${reason}`);
  }
}

export function unwrapRecords(payload: unknown): WanliniuRecord[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) throw new Error("万里牛接口返回结构不是 JSON 对象");
  if (payload.code !== undefined && Number(payload.code) !== 0) {
    throw new Error(`万里牛接口返回错误：${JSON.stringify(payload)}`);
  }
  // 部分万里牛分页接口在“本页无数据”时只返回 { code: 0 }，没有 data 字段。
  // 这代表正常到达分页末尾，不应把增量同步标记为失败。
  if (Number(payload.code) === 0 && payload.data === undefined) return [];
  if (!Array.isArray(payload.data)) {
    throw new Error(`万里牛接口缺少 data 数组：${JSON.stringify(payload).slice(0, 2000)}`);
  }
  return payload.data.filter(isRecord);
}

function isRecord(value: unknown): value is WanliniuRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function missingWanliniuSyncConfig() {
  const names = ["WANLINIU_APP_KEY", "WANLINIU_APP_SECRET"]
    .filter((name) => !process.env[name]?.trim());
  return names;
}

export class WanliniuClient {
  async call(apiPath: string, params: Record<string, unknown>) {
    if (!allowedPaths.has(apiPath)) throw new Error(`未允许的万里牛同步接口：${apiPath}`);
    const retries = Math.max(0, Math.trunc(Number(process.env.WANLINIU_API_RETRIES ?? 2)) || 0);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.callOnce(apiPath, params);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= retries || !isRetryable(lastError.message)) throw lastError;
        await delay(500 * 2 ** attempt);
      }
    }
    throw lastError || new Error("万里牛接口调用失败");
  }

  private async callOnce(apiPath: string, params: Record<string, unknown>) {
    const { appKey, appSecret } = credentials();
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gplan-wln-sync-"));
    const configPath = path.join(temporaryDirectory, "config.json");
    try {
      await fs.writeFile(configPath, JSON.stringify({
        app_key: appKey,
        app_secret: appSecret,
        host: process.env.HUPUN_API_HOST?.trim() || "https://open-api.hupun.com",
        timeout_seconds: Math.ceil(timeoutMs() / 1000)
      }), { mode: 0o600 });
      const { stdout, stderr } = await execFileAsync(
        cliPath(),
        ["-c", configPath, apiPath, JSON.stringify(params), "--agent", "GPlan-Wanliniu-Sync"],
        { timeout: timeoutMs() + 15_000, maxBuffer: 20 * 1024 * 1024 }
      );
      if (!stdout.trim() && stderr.trim()) throw new Error(stderr.trim());
      return unwrapRecords(parseCliJson(stdout));
    } catch (error) {
      const details = error && typeof error === "object"
        ? [
            "stdout" in error ? String(error.stdout || "") : "",
            "stderr" in error ? String(error.stderr || "") : ""
          ].filter(Boolean).join("\n").trim()
        : "";
      const message = details || (error instanceof Error ? error.message : String(error));
      throw new Error(safeErrorMessage(message));
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  listShops(page: number, limit: number, modifiedAfter?: string) {
    return this.call("/erp/base/shop/page/get", {
      page,
      limit,
      ...(modifiedAfter ? { shop_ext: { modify_time: modifiedAfter } } : {})
    });
  }

  listProducts(page: number, limit: number, modifiedAfter?: string, modifiedBefore?: string) {
    return this.call("/erp/goods/spec/open/query/goodswithspeclist", {
      page,
      limit,
      all_status: true,
      ...(modifiedAfter ? { modify_time: modifiedAfter } : {}),
      ...(modifiedBefore ? { end_time: modifiedBefore } : {})
    });
  }

  listInventory(page: number, pageSize: number, modifiedAfter?: string, modifiedBefore?: string) {
    return this.call("/erp/open/inventory/items/get/by/modifytimev2", {
      page_no: page,
      page_size: pageSize,
      ...(modifiedAfter ? { modify_time: modifiedAfter } : {}),
      ...(modifiedBefore ? { modify_time_end: modifiedBefore } : {})
    });
  }

  listSaleOutbound(page: number, limit: number, modifiedAfter: string, modifiedBefore: string) {
    return this.call("/erp/sale/stock/out/query", {
      page,
      limit,
      modify_time: modifiedAfter,
      modify_time_end: modifiedBefore,
      is_split: true,
      query_extend: { need_split_actual_payment: true }
    });
  }

  listPurchaseInbound(page: number, limit: number, modifiedAfter: string, modifiedBefore: string) {
    return this.call("/erp/purchase/purchasebill/stockin/query", {
      page,
      limit,
      modify_time: modifiedAfter,
      modify_end: modifiedBefore
    });
  }

  async checkCredentials() {
    const records = await this.listShops(1, 1);
    return { reachable: true, sampleCount: records.length };
  }
}

export const wanliniuClient = new WanliniuClient();

function isRetryable(message: string) {
  return /timeout|timed out|ECONN|socket|429|请求过于频繁|限流|系统繁忙|服务异常|bad gateway|gateway timeout|\b5\d\d\b/i.test(message);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeErrorMessage(message: string) {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed.slice(0, 1000);
  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const nested = typeof payload.error_message === "string" ? parseNestedError(payload.error_message) : undefined;
    const code = nested?.code ?? payload.code ?? payload.http_code;
    const description = nested?.message ?? payload.message ?? "万里牛接口调用失败";
    return `万里牛接口错误${code === undefined ? "" : `（${String(code)}）`}：${String(description).slice(0, 500)}`;
  } catch {
    return "万里牛接口或 CLI 返回了无法安全展示的错误；请查看服务端结构化日志。";
  }
}

function parseNestedError(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
