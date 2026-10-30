import { createPrivateKey, createPublicKey, generateKeyPair, X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import type { Database, User } from "./types.js";
import type { SealedCredential } from "./financeCredentials.js";
import { credentialMasterKey, openCredential, sealCredential } from "./financeCredentials.js";
import { uid } from "./security.js";

export type AlipayCredentials = { privateKey: string; mode: "public_key" | "certificate"; alipayPublicKey?: string; appCert?: string; alipayCert?: string; rootCert?: string };
export type AlipayCapability = { status: "not_tested" | "available" | "no_bill" | "failed"; checkedAt?: string; code?: string; message: string };
export type AlipayAccount = {
  id: string; companyId: string; name: string; legalEntity: string; appId: string;
  revision: number; credentials: SealedCredential; applicationPublicKey: string;
  configured: boolean; mode: AlipayCredentials["mode"];
  createdAt: string; updatedAt: string;
  capabilities: { balance: AlipayCapability; bill: AlipayCapability };
};
export type FinanceAudit = { at: string; companyId: string; userId: string; accountId?: string; action: "create" | "update" | "generate_key" | "check" | "lock" };
export type AccountStore = { read(): Promise<Database>; mutate<T>(fn: (db: Database) => T): Promise<T> };
export class FinanceError extends Error { constructor(message: string, public status = 400) { super(message); } }
const freshCapabilities = (): AlipayAccount["capabilities"] => ({ balance: { status: "not_tested", message: "尚未调用真实接口" }, bill: { status: "not_tested", message: "尚未调用真实接口" } });
const credentialScope = (a: Pick<AlipayAccount, "id" | "companyId" | "appId" | "revision">) => JSON.stringify(["alipay", a.companyId, a.id, a.appId, a.revision]);

function boundedText(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new FinanceError(`${label}需填写1至${max}个字符`);
  return value.trim();
}
function pem(value: unknown, label: string) { return boundedText(value, label, 32000).replace(/\\n/g, "\n"); }
export function normalizePrivateKey(value: unknown) {
  let input = pem(value, "应用私钥");
  if (!input.includes("-----BEGIN")) input = `-----BEGIN PRIVATE KEY-----\n${input.replace(/\s/g, "")}\n-----END PRIVATE KEY-----`;
  try {
    let key;
    try { key = createPrivateKey(input); }
    catch { key = createPrivateKey(input.replace(/BEGIN PRIVATE KEY/g, "BEGIN RSA PRIVATE KEY").replace(/END PRIVATE KEY/g, "END RSA PRIVATE KEY")); }
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error();
    return key.export({ format: "pem", type: "pkcs8" }).toString();
  } catch { throw new FinanceError("应用私钥格式不正确，需未加密的 RSA 2048 位或以上私钥（支持 PKCS1 / PKCS8）"); }
}
function normalizePublicKey(value: unknown) {
  let input = pem(value, "支付宝公钥");
  if (!input.includes("-----BEGIN")) input = `-----BEGIN PUBLIC KEY-----\n${input.replace(/\s/g, "")}\n-----END PUBLIC KEY-----`;
  try {
    const key = createPublicKey(input);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error();
    return key.export({ format: "pem", type: "spki" }).toString();
  } catch { throw new FinanceError("支付宝公钥格式不正确，请勿填写应用公钥或私钥"); }
}
function normalizeCertificate(value: unknown, label: string) {
  const input = pem(value, label);
  const blocks = input.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks?.length) throw new FinanceError(`${label}不是有效的 PEM 证书`);
  for (const block of blocks) {
    try {
      const cert = new X509Certificate(block);
      if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw new Error();
    } catch { throw new FinanceError(`${label}无效或已过期`); }
  }
  return blocks.join("\n");
}
function validatedCredentials(input: Record<string, unknown>, previous?: AlipayCredentials): AlipayCredentials {
  const privateKey = input.privateKey ? normalizePrivateKey(input.privateKey) : previous?.privateKey;
  if (!privateKey) throw new FinanceError("请上传应用私钥，或先为新应用生成密钥");
  if (input.mode === "public_key") {
    const alipayPublicKey = input.alipayPublicKey ? normalizePublicKey(input.alipayPublicKey) : previous?.mode === "public_key" ? previous.alipayPublicKey : undefined;
    if (!alipayPublicKey) throw new FinanceError("请填写支付宝公钥");
    if (createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString() === alipayPublicKey) throw new FinanceError("这里应填写支付宝公钥，不是应用公钥");
    return { mode: "public_key", privateKey, alipayPublicKey };
  }
  if (input.mode !== "certificate") throw new FinanceError("请选择公钥模式或证书模式");
  const certs = {
    appCert: input.appCert ? normalizeCertificate(input.appCert, "应用公钥证书") : previous?.appCert,
    alipayCert: input.alipayCert ? normalizeCertificate(input.alipayCert, "支付宝公钥证书") : previous?.alipayCert,
    rootCert: input.rootCert ? normalizeCertificate(input.rootCert, "支付宝根证书") : previous?.rootCert,
  };
  if (!certs.appCert || !certs.alipayCert || !certs.rootCert) throw new FinanceError("请上传应用公钥证书、支付宝公钥证书和支付宝根证书");
  if (!new X509Certificate(certs.appCert).checkPrivateKey(createPrivateKey(privateKey))) throw new FinanceError("应用证书与私钥不匹配");
  return { mode: "certificate", privateKey, ...certs };
}

export function publicAlipayAccount(a: AlipayAccount) {
  return { id: a.id, name: a.name, legalEntity: a.legalEntity, appId: a.appId, mode: a.mode, configured: a.configured, hasPrivateKey: true, applicationPublicKey: a.applicationPublicKey, capabilities: a.capabilities, createdAt: a.createdAt, updatedAt: a.updatedAt, syncStatus: "not_enabled" as const };
}

export class AlipayAccountService {
  constructor(private store: AccountStore, private env: NodeJS.ProcessEnv = process.env) {}
  async state(user: User) {
    const db = await this.store.read();
    this.assertAdmin(db, user);
    let encryptionReady = true;
    try { credentialMasterKey(this.env); } catch { encryptionReady = false; }
    const configurationOpen = this.canConfigure(db, user);
    return { configurationOpen, encryptionReady, accounts: (db.alipayAccounts || []).filter(a => a.companyId === user.companyId).map(a => { const view = publicAlipayAccount(a); return configurationOpen ? view : { ...view, applicationPublicKey: "" }; }) };
  }
  private assertAdmin(db: Database, user: User) {
    if (!db.users.some(u => u.id === user.id && u.companyId === user.companyId && u.role === "admin" && u.enabled)) throw new FinanceError("无权访问资金账户", 403);
  }
  canConfigure(db: Database, user: User) {
    const expires = Date.parse(this.env.FINANCE_CONFIG_EXPIRES_AT || "");
    const epoch = this.env.FINANCE_CONFIG_EPOCH?.trim();
    const allowed = (this.env.FINANCE_CONFIG_ADMIN_IDS || "").split(",").map(x => x.trim());
    return this.env.FINANCE_CONFIG_ENABLED === "true" && !!epoch && Number.isFinite(expires) && expires > Date.now() && expires <= Date.now() + 24 * 3600_000 && allowed.includes(user.id) && db.financeConfigLocks?.[user.companyId] !== epoch;
  }
  private assertConfiguration(db: Database, user: User) {
    this.assertAdmin(db, user);
    if (!this.canConfigure(db, user)) throw new FinanceError("资金账户配置已锁定或未开放，请联系服务器维护人员", 403);
    credentialMasterKey(this.env);
  }
  private account(db: Database, user: User, id: string) {
    this.assertAdmin(db, user);
    const account = db.alipayAccounts?.find(a => a.id === id && a.companyId === user.companyId);
    if (!account) throw new FinanceError("账户不存在", 404);
    return account;
  }
  private audit(db: Database, user: User, action: FinanceAudit["action"], accountId?: string) {
    db.financeAudit ??= [];
    db.financeAudit.push({ at: new Date().toISOString(), companyId: user.companyId, userId: user.id, action, accountId });
    if (db.financeAudit.length > 10000) db.financeAudit.splice(0, db.financeAudit.length - 10000);
  }
  async save(user: User, input: Record<string, unknown>, id?: string, generate = false) {
    const db = await this.store.read();
    this.assertConfiguration(db, user);
    const existing = id ? this.account(db, user, id) : undefined;
    if (generate && existing) throw new FinanceError("已有账户不支持一键重置密钥，请使用受控更新流程");
    const name = boundedText(input.name, "账户名称", 60), legalEntity = boundedText(input.legalEntity, "账户主体", 100);
    const appId = boundedText(input.appId, "APP_ID", 32);
    if (!/^\d{16,32}$/.test(appId)) throw new FinanceError("APP_ID 应为16至32位数字");
    if (existing && existing.appId !== appId) throw new FinanceError("不能更换已有账户的 APP_ID，请另建账户");
    const key = credentialMasterKey(this.env);
    let credentials: AlipayCredentials;
    if (generate) {
      if (input.mode !== "public_key") throw new FinanceError("新密钥生成功能用于公钥模式；证书模式请导入现有配套私钥和证书");
      const pair = await promisify(generateKeyPair)("rsa", { modulusLength: 2048, publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" } });
      credentials = { mode: input.mode, privateKey: pair.privateKey };
    } else {
      const previous = existing ? openCredential<AlipayCredentials>(existing.credentials, credentialScope(existing), key) : undefined;
      credentials = validatedCredentials(input, previous);
    }
    const timestamp = new Date().toISOString();
    const accountBase = { id: existing?.id || uid("alipay"), companyId: user.companyId, appId, revision: (existing?.revision || 0) + 1 };
    const account: AlipayAccount = { ...accountBase, name, legalEntity, credentials: sealCredential(credentials, credentialScope(accountBase), key), applicationPublicKey: createPublicKey(credentials.privateKey).export({ format: "pem", type: "spki" }).toString(), mode: credentials.mode, configured: !generate, capabilities: freshCapabilities(), createdAt: existing?.createdAt || timestamp, updatedAt: timestamp };
    return this.store.mutate(current => {
      this.assertConfiguration(current, user); // Includes lock/revocation while key generation was pending.
      current.alipayAccounts ??= [];
      const latest = id ? this.account(current, user, id) : undefined;
      if (latest && latest.revision !== existing!.revision) throw new FinanceError("账户已被修改，请刷新后重试", 409);
      if (current.alipayAccounts.some(a => a.appId === appId && a.id !== id)) throw new FinanceError("该应用已登记，请核对后勿重复添加", 409);
      if (!latest && current.alipayAccounts.filter(a => a.companyId === user.companyId).length >= 100) throw new FinanceError("单个企业最多登记100个账户");
      if (latest) current.alipayAccounts[current.alipayAccounts.indexOf(latest)] = account;
      else current.alipayAccounts.push(account);
      this.audit(current, user, generate ? "generate_key" : id ? "update" : "create", account.id);
      return publicAlipayAccount(account);
    });
  }
  async check(user: User, id: string, probe: (appId: string, credentials: AlipayCredentials) => Promise<AlipayAccount["capabilities"]>) {
    const db = await this.store.read();
    this.assertConfiguration(db, user);
    const account = this.account(db, user, id);
    if (!account.configured) throw new FinanceError("请先完成公钥或证书配置并保存");
    const revision = account.revision;
    const credentials = openCredential<AlipayCredentials>(account.credentials, credentialScope(account), credentialMasterKey(this.env));
    const capabilities = await probe(account.appId, credentials);
    return this.store.mutate(current => {
      this.assertConfiguration(current, user);
      const latest = this.account(current, user, id);
      if (latest.revision !== revision) throw new FinanceError("检测期间配置已变化，请重新检测", 409);
      latest.capabilities = capabilities;
      this.audit(current, user, "check", id);
      return publicAlipayAccount(latest);
    });
  }
  async lock(user: User) {
    return this.store.mutate(db => {
      this.assertConfiguration(db, user);
      db.financeConfigLocks ??= {};
      db.financeConfigLocks[user.companyId] = this.env.FINANCE_CONFIG_EPOCH!.trim();
      this.audit(db, user, "lock");
      return { locked: true };
    });
  }
}
