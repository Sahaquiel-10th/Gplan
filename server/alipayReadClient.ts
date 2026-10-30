import { AlipaySdk } from "alipay-sdk";
import type { AlipayCredentials, AlipayAccount, AlipayCapability } from "./alipayAccounts.js";

export const ALIPAY_READ_METHODS = ["alipay.data.bill.balance.query", "alipay.data.dataservice.bill.downloadurl.query"] as const;
type ReadMethod = typeof ALIPAY_READ_METHODS[number];
type Exec = (method: string, params: Record<string, unknown>, options: { validateSign: boolean }) => Promise<Record<string, unknown>>;

export function alipayReadClient(appId: string, credentials: AlipayCredentials): Exec {
  // Fixed official endpoints: no user-provided gateway, proxy, callback, method or target merchant.
  const sdk = new AlipaySdk({ appId, privateKey: credentials.privateKey, keyType: "PKCS8", signType: "RSA2", timeout: 12000, camelcase: false,
    gateway: "https://openapi.alipay.com/gateway.do", endpoint: "https://openapi.alipay.com",
    ...(credentials.mode === "public_key" ? { alipayPublicKey: credentials.alipayPublicKey } : {
      appCertContent: credentials.appCert, alipayPublicCertContent: credentials.alipayCert, alipayRootCertContent: credentials.rootCert,
    }),
  });
  if (!sdk.config.alipayPublicKey) throw new Error("支付宝验签公钥未配置");
  return async (method, params, options) => {
    if (!ALIPAY_READ_METHODS.includes(method as ReadMethod)) throw new Error("该接口不在资金只读白名单内");
    return sdk.exec(method, params, { validateSign: true });
  };
}

function yesterday() {
  return new Date(Date.now() + 8 * 3600_000 - 86400_000).toISOString().slice(0, 10);
}
const safeCode = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : "UPSTREAM_ERROR";

export async function probeAlipayAccount(appId: string, credentials: AlipayCredentials, providedExecute?: Exec): Promise<AlipayAccount["capabilities"]> {
  let execute: Exec;
  try { execute = providedExecute || alipayReadClient(appId, credentials); }
  catch {
    const failed: AlipayCapability = { status: "failed", checkedAt: new Date().toISOString(), code: "INVALID_SIGNING_CONFIGURATION", message: "签名或验签配置不可用，请核对配套私钥、公钥和证书" };
    return { balance: { ...failed }, bill: { ...failed } };
  }
  async function query(kind: "balance" | "bill"): Promise<AlipayCapability> {
    const checkedAt = new Date().toISOString();
    try {
      const result = await execute(kind === "balance" ? ALIPAY_READ_METHODS[0] : ALIPAY_READ_METHODS[1], {
        bizContent: kind === "balance" ? {} : { bill_type: "signcustomer", bill_date: yesterday(), secure: "true" },
      }, { validateSign: true });
      const code = safeCode(result.sub_code || result.code);
      if (String(result.code) !== "10000") {
        if (kind === "bill" && ["isv.BILL_NOT_EXIST", "BILL_NOT_EXIST"].includes(code)) return { status: "no_bill", checkedAt, code, message: "昨日账单未生成或不存在，尚不能确认账单下载权限；请换有账单的日期复核" };
        return { status: "failed", checkedAt, code, message: "接口未通过，请检查应用状态、权限和密钥；此结果不代表已接通" };
      }
      if (kind === "bill") {
        const url = typeof result.bill_download_url === "string" ? new URL(result.bill_download_url) : undefined;
        if (!url || url.protocol !== "https:") throw new Error("invalid download URL");
      }
      return { status: "available", checkedAt, code: "10000", message: kind === "balance" ? "余额查询与响应验签通过；未开启自动同步" : "昨日资金账单地址查询与响应验签通过；尚未下载、入库或核对账单" };
    } catch {
      // Raw SDK errors can include signatures, full URLs or balance data. Never persist/return them.
      return { status: "failed", checkedAt, code: "REQUEST_OR_SIGNATURE_FAILED", message: "查询或响应验签失败，请核对密钥、证书、网络和应用权限" };
    }
  }
  // Keep requests bounded and independent: one entitlement may be available while the other isn't.
  const balance = await query("balance"), bill = await query("bill");
  return { balance, bill };
}
