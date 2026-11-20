import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import crypto from 'node:crypto';
import {reserveWanliniuRead,noteWanliniuRateLimit} from './readRateLimit.js';

const execFileAsync = promisify(execFile);
// Official request/signature specification:
// https://hpublic.hupun.com/mp/open/doc/pub-api-spec.json
export function signedWanliniuForm(appKey:string,secret:string,params:Record<string,unknown>,timestamp:number){
  if(Object.keys(params).some(key=>key.startsWith('_')))throw Error('业务参数不能覆盖系统签名参数');
  const values:Record<string,string>={_app:appKey,_t:String(timestamp)};
  for(const [key,value]of Object.entries(params))if(value!==undefined&&value!==null)values[key]=typeof value==='object'?JSON.stringify(value):String(value);
  const encode=(value:string)=>encodeURIComponent(value).replace(/[!'()~]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g,'+');
  const canonical=Object.keys(values).sort().map(key=>`${encode(key)}=${encode(values[key])}`).join('&');
  values._sign=crypto.createHash('md5').update(secret+canonical+secret,'utf8').digest('hex');
  return new URLSearchParams(values);
}

// Large movement responses can be truncated when the upstream CLI exits before
// flushing a pipe. A regular file makes its stdout writes synchronous.
export async function cliJsonToFile(executable: string, args: string[], directory: string, timeout: number) {
  const output = path.join(directory, 'response.json');
  const file = await fs.open(output, 'wx', 0o600);
  let stderr = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ['ignore', file.fd, 'pipe'] });
      let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (expired) reject(new Error('万里牛接口请求超时'));
        else if (code !== 0) reject(new Error(stderr || `万里牛 CLI 退出码 ${code}`));
        else resolve();
      });
    });
  } finally { await file.close(); }
  if ((await fs.stat(output)).size > 20 * 1024 * 1024) throw new Error('万里牛单页响应超过20MB，请缩小分页');
  const raw = await fs.readFile(output, 'utf8');
  if (!raw.trim()) throw new Error(stderr || '万里牛 CLI 未返回JSON，不能视为空页');
  return raw;
}

export type WanliniuRecord = Record<string, unknown>;

const allowedPaths = new Set([
  "/erp/base/shop/page/get",
  "/erp/goods/spec/open/query/goodswithspeclist",
  "/erp/open/inventory/items/get/by/modifytimev2",
  "/erp/sale/stock/out/query",
  "/erp/purchase/purchasebill/stockin/query",
  "/erp/allocation/in/changebill/query",
  "/erp/allocation/out/changebill/query",
  "/erp/sale/stock/in/query",
  "/erp/open/inventory/stream/query",
  "/erp/open/return/order/v2/list",
  "/erp/product/bill/page",
  "/erp/stock/product/in/bill/query",
  "/erp/stock/product/out/bill/query",
  "/erp/stock/in/stockbill/query",
  "/erp/stock/out/stockbill/query"
]);
const httpReadPaths=new Set(['/erp/open/inventory/stream/query','/erp/open/return/order/v2/list','/erp/product/bill/page',
 '/erp/stock/product/in/bill/query','/erp/stock/product/out/bill/query','/erp/stock/in/stockbill/query','/erp/stock/out/stockbill/query']);

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

export function unwrapRecords(payload: unknown): WanliniuRecord[] & {hasMore?:boolean} {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) throw new Error("万里牛接口返回结构不是 JSON 对象");
  if (payload.code !== undefined && Number(payload.code) !== 0) {
    throw new Error(`万里牛接口返回错误：${JSON.stringify(payload)}`);
  }
  // 部分万里牛分页接口在“本页无数据”时只返回 { code: 0 }，没有 data 字段。
  // 这代表正常到达分页末尾，不应把增量同步标记为失败。
  if (Number(payload.code) === 0 && payload.data === undefined) return [];
  if (!Array.isArray(payload.data)) {
    if (isRecord(payload.data) && Array.isArray(payload.data.orders)) {
      if(typeof payload.data.has_next!=='boolean')throw new Error('售后分页缺少has_next，不能确定是否完整');
      const rows=payload.data.orders.filter(isRecord);
      Object.defineProperty(rows,'hasMore',{value:payload.data.has_next,enumerable:false});
      return rows;
    }
    if(isRecord(payload.data)&&Array.isArray(payload.data.data)){
      if(typeof payload.data.has_more!=='boolean')throw new Error('加工分页缺少has_more，不能确定是否完整');
      const rows=payload.data.data.filter(isRecord);Object.defineProperty(rows,'hasMore',{value:payload.data.has_more,enumerable:false});return rows;
    }
    if(isRecord(payload.data)&&Array.isArray(payload.data.elements)){
      if(typeof payload.data.next!=='boolean')throw new Error('加工分页缺少next，不能确定是否完整');
      const rows=payload.data.elements.filter(isRecord);Object.defineProperty(rows,'hasMore',{value:payload.data.next,enumerable:false});return rows;
    }
    throw new Error(`万里牛接口缺少 data 数组；顶层字段：${Object.keys(payload).join(',')}；data字段：${isRecord(payload.data)?Object.keys(payload.data).join(','):typeof payload.data}`);
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
    if(httpReadPaths.has(apiPath)){
      await reserveWanliniuRead(appKey);
      const body=signedWanliniuForm(appKey,appSecret,params,Math.floor(Date.now()/1000));
      let host=(process.env.HUPUN_API_HOST?.trim()||'https://open-api.hupun.com').replace(/\/+$/,'');
      if(!new URL(host).pathname.endsWith('/api'))host+='/api';
      const response=await fetch(host+apiPath,{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=utf-8','User-Agent':'GPlan-Approved-ReadOnly'},body,signal:AbortSignal.timeout(timeoutMs())});
      const raw=await response.text();if(raw.length>20*1024*1024)throw Error('万里牛单页响应超过20MB');
      if(!response.ok){const detail=safeErrorMessage(raw);const message=response.status===429?`万里牛HTTP429：${detail}`:detail||`万里牛HTTP错误${response.status}`;await noteWanliniuRateLimit(appKey,message);throw Error(message);}
      const parsed=parseCliJson(raw);
      if(isRecord(parsed)&&parsed.code!==undefined&&Number(parsed.code)!==0){const message=safeErrorMessage(raw);await noteWanliniuRateLimit(appKey,message);throw Error(message);}
      return unwrapRecords(parsed);
    }
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gplan-wln-sync-"));
    const configPath = path.join(temporaryDirectory, "config.json");
    try {
      await fs.writeFile(configPath, JSON.stringify({
        app_key: appKey,
        app_secret: appSecret,
        host: process.env.HUPUN_API_HOST?.trim() || "https://open-api.hupun.com",
        timeout_seconds: Math.ceil(timeoutMs() / 1000)
      }), { mode: 0o600 });
      const args = ["-c", configPath, apiPath, JSON.stringify(params), "--agent", "GPlan-Wanliniu-Sync"];
      if (apiPath === '/erp/sale/stock/in/query' || apiPath.startsWith('/erp/allocation/') || apiPath === '/erp/open/inventory/stream/query' || apiPath === '/erp/open/return/order/v2/list') {
        const stdout = await cliJsonToFile(cliPath(), args, temporaryDirectory, timeoutMs() + 15_000);
        return unwrapRecords(parseCliJson(stdout));
      }
      const { stdout, stderr } = await execFileAsync(
        cliPath(),
        args,
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

  findProductBySku(skuCode:string){
    return this.call('/erp/goods/spec/open/query/goodswithspeclist',{spec_code:skuCode,all_status:true,page:1,limit:20});
  }
  listInventoryForSkus(skus:string[],page:number){
    if(!skus.length||skus.length>50||skus.some(s=>s.includes(',')))throw new Error('库存规格校验批次非法');
    return this.call('/erp/open/inventory/items/get/by/modifytimev2',{sku_code:skus.join(','),storage:'CK001,CK008',page_no:page,page_size:200});
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

  listTransferInbound(page: number, limit: number, modifiedAfter: string, modifiedBefore: string) {
    return this.call('/erp/allocation/in/changebill/query', { page, limit, modify_time: modifiedAfter, modify_end: modifiedBefore });
  }

  listTransferOutbound(page: number, limit: number, modifiedAfter: string, modifiedBefore: string) {
    return this.call('/erp/allocation/out/changebill/query', { page, limit, modify_time: modifiedAfter, modify_end: modifiedBefore });
  }

  listSalesReturn(page: number, limit: number, modifiedAfter: string, modifiedBefore: string) {
    return this.call('/erp/sale/stock/in/query', { page, limit, modify_time: modifiedAfter, modify_end_time: modifiedBefore, is_split: true });
  }

  listInventoryStream(page: number, limit: number, start: string, end: string, skuCodes: string[]) {
    return this.call('/erp/open/inventory/stream/query', {page_no:page,page_size:limit,storage_code:'CK001,CK008',sku_code:skuCodes.join(','),his:true,start_time:start,end_time:end});
  }

  listAfterSales(page: number, limit: number, start: string, end: string) {
    return this.call('/erp/open/return/order/v2/list', {page,limit,start_time:start,end_time:end,time_type:2,ext:{query_custom:false,is_split:true}});
  }
  listProductionOrders(page:number,limit:number){return this.call('/erp/product/bill/page',{condition:{page,limit}});}
  listStockReferences(resource:'other_in'|'other_out'|'production_in'|'production_out',page:number,limit:number,start:string,end:string){
    const paths={other_in:'/erp/stock/in/stockbill/query',other_out:'/erp/stock/out/stockbill/query',production_in:'/erp/stock/product/in/bill/query',production_out:'/erp/stock/product/out/bill/query'};
    return this.call(paths[resource],{page,limit,modify_time:start,modify_time_end:end});
  }

  async checkCredentials() {
    const records = await this.listShops(1, 1);
    return { reachable: true, sampleCount: records.length };
  }
}

export const wanliniuClient = new WanliniuClient();

function isRetryable(message: string) {
  return /timeout|timed out|ECONN|socket|\b801\b|429|请求过于频繁|调用超过频次|限流|系统繁忙|服务异常|bad gateway|gateway timeout|\b5\d\d\b/i.test(message);
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
