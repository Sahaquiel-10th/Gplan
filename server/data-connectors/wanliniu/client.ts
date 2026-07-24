import crypto from "node:crypto";

const defaultBaseUrl = "https://open-api.hupun.com/api";
const requestTimeoutMs = Math.max(1000, Number(process.env.WANLINIU_REQUEST_TIMEOUT_MS ?? 20000));

export type WanliniuShop = {
  cellphone?: string;
  com_uid?: string;
  contacts?: string;
  modify_time?: string | number;
  phone?: string;
  shop_name?: string;
  shop_nick?: string;
  shop_type?: number;
  shop_uid?: string;
  status?: number;
  group_name?: string;
  is_sync?: boolean;
  sub_type?: number;
  expires_time?: string | number;
  group_uid?: string;
  [key: string]: unknown;
};

type WanliniuResponse<T> = {
  code?: number | string;
  data?: T;
  message?: string;
  msg?: string;
  sub_message?: string;
};

type Scalar = string | number | boolean | null | undefined;

export const wanliniuConfig = {
  baseUrl: process.env.WANLINIU_BASE_URL?.trim() || defaultBaseUrl,
  appKey: process.env.WANLINIU_APP_KEY?.trim() || "",
  appSecret: process.env.WANLINIU_APP_SECRET?.trim() || ""
};

export function missingWanliniuCredentials() {
  return [
    ["WANLINIU_APP_KEY", wanliniuConfig.appKey],
    ["WANLINIU_APP_SECRET", wanliniuConfig.appSecret]
  ].filter(([, value]) => !value).map(([name]) => name);
}

function javaFormEncode(value: string) {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/~/g, "%7E")
    .replace(/%20/g, "+");
}

function paramValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value as Scalar);
}

export function signWanliniuParameters(
  parameters: Record<string, unknown>,
  appKey: string,
  appSecret: string,
  timestampSeconds = Math.floor(Date.now() / 1000)
) {
  const unsigned: Record<string, string> = {
    ...Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, paramValue(value)])),
    _app: appKey,
    _t: String(timestampSeconds)
  };
  const query = Object.keys(unsigned)
    .sort()
    .map((key) => `${key}=${javaFormEncode(unsigned[key])}`)
    .join("&");
  const sign = crypto
    .createHash("md5")
    .update(`${appSecret}${query}${appSecret}`, "utf8")
    .digest("hex")
    .toUpperCase();
  return { ...unsigned, _sign: sign };
}

function formBody(parameters: Record<string, string>) {
  return Object.entries(parameters)
    .map(([key, value]) => `${javaFormEncode(key)}=${javaFormEncode(value)}`)
    .join("&");
}

export class WanliniuClient {
  async checkCredentials() {
    const shops = await this.listShops(1, 1);
    return { reachable: true, sampleCount: shops.length };
  }

  async listShops(page: number, limit = 50): Promise<WanliniuShop[]> {
    if (!Number.isInteger(page) || page < 1) throw new Error("万里牛分页页码必须从 1 开始");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("万里牛店铺接口每页数量必须在 1-50 之间");
    const payload = await this.post<WanliniuShop[]>("/erp/base/shop/page/get", { page, limit });
    return Array.isArray(payload) ? payload : [];
  }

  private async post<T>(apiPath: string, parameters: Record<string, unknown>): Promise<T> {
    const missing = missingWanliniuCredentials();
    if (missing.length) throw new Error(`缺少万里牛凭证：${missing.join("、")}`);
    const signed = signWanliniuParameters(parameters, wanliniuConfig.appKey, wanliniuConfig.appSecret);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(`${wanliniuConfig.baseUrl.replace(/\/$/, "")}${apiPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: formBody(signed),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({})) as WanliniuResponse<T>;
      if (!response.ok) throw new Error(`万里牛接口请求失败（HTTP ${response.status}）`);
      if (Number(result.code) !== 0) {
        throw new Error(result.message || result.msg || result.sub_message || `万里牛接口返回错误码 ${result.code ?? "unknown"}`);
      }
      return result.data as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`万里牛接口响应超时（${Math.round(requestTimeoutMs / 1000)} 秒）`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const wanliniuClient = new WanliniuClient();
