import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { AlipaySdk } from "alipay-sdk";
import { AlipayAccountService, FinanceError, normalizePrivateKey, type AccountStore, type AlipayCredentials } from "./alipayAccounts.js";
import { sealCredential, openCredential } from "./financeCredentials.js";
import { alipayReadClient, probeAlipayAccount } from "./alipayReadClient.js";
import type { Database, User } from "./types.js";

const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
const application = pair(), alipay = pair();
const credentials: AlipayCredentials = { privateKey: application.privateKey, mode: "public_key", alipayPublicKey: alipay.publicKey };
const body = { name: "店铺A", legalEntity: "测试企业", appId: "2026000000000001", ...credentials };
function fixture() {
  const users = [["owner", "c1", "admin"], ["admin2", "c1", "admin"], ["member", "c1", "user"], ["other", "c2", "admin"]].map(([id, companyId, role]) => ({ id, companyId, role, enabled: true })) as User[];
  const db = { users } as Database;
  const store: AccountStore = { read: async () => db, mutate: async fn => fn(db) };
  const env = { FINANCE_CONFIG_ENABLED: "true", FINANCE_CONFIG_EPOCH: "test-window-1", FINANCE_CONFIG_ADMIN_IDS: "owner,other", FINANCE_CONFIG_EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString(), FINANCE_CREDENTIAL_MASTER_KEY: randomBytes(32).toString("base64") };
  return { users, db, store, env, service: new AlipayAccountService(store, env) };
}

test("AES-GCM has per-write IV, tenant/account/revision binding and tamper protection", () => {
  const key = randomBytes(32), a = sealCredential(credentials, "c1:a1:r1", key), b = sealCredential(credentials, "c1:a1:r1", key);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(JSON.stringify(a).includes(application.privateKey.slice(40, 90)), false);
  assert.deepEqual(openCredential(a, "c1:a1:r1", key), credentials);
  for (const scope of ["c2:a1:r1", "c1:a2:r1", "c1:a1:r2"]) assert.throws(() => openCredential(a, scope, key), /解密失败/);
  assert.throws(() => openCredential(a, "c1:a1:r1", randomBytes(32)), /解密失败/);
  assert.throws(() => openCredential({ ...a, tag: randomBytes(16).toString("base64") }, "c1:a1:r1", key), /解密失败/);
});

test("default closed; explicit allowlist, valid <=24h window, master key required", async () => {
  const f = fixture(), user = f.users[0];
  for (const override of [{ FINANCE_CONFIG_ENABLED: "false" }, { FINANCE_CONFIG_EPOCH: "" }, { FINANCE_CONFIG_ADMIN_IDS: "" }, { FINANCE_CONFIG_EXPIRES_AT: "bad" }, { FINANCE_CONFIG_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() }, { FINANCE_CONFIG_EXPIRES_AT: new Date(Date.now() + 25 * 3600_000).toISOString() }]) {
    const service = new AlipayAccountService(f.store, { ...f.env, ...override });
    assert.equal((await service.state(user)).configurationOpen, false);
    await assert.rejects(service.save(user, body), (e: unknown) => e instanceof FinanceError && e.status === 403);
  }
  const noKey = new AlipayAccountService(f.store, { ...f.env, FINANCE_CREDENTIAL_MASTER_KEY: "" });
  assert.equal((await noKey.state(user)).encryptionReady, false);
  await assert.rejects(noKey.save(user, body), /主密钥/);
  await assert.rejects(f.service.save(f.users[1], body), /锁定/);
  await assert.rejects(f.service.state(f.users[2]), /无权/);
});

test("save, update, duplicates, isolation, no private credential readback or audit leakage", async () => {
  const f = fixture(), owner = f.users[0], other = f.users[3];
  const a = await f.service.save(owner, body);
  assert.equal(a.configured, true);
  assert.equal(a.capabilities.balance.status, "not_tested");
  const serialized = JSON.stringify(await f.service.state(owner));
  for (const secret of [application.privateKey, alipay.publicKey, "ciphertext", '"credentials"']) assert.ok(!serialized.includes(secret));
  assert.deepEqual((await f.service.state(other)).accounts, []);
  await assert.rejects(f.service.save(other, body, a.id), (e: unknown) => e instanceof FinanceError && e.status === 404);
  await assert.rejects(f.service.save(owner, body), /已登记/);
  await assert.rejects(f.service.save(owner, { ...body, appId: "2026000000000002" }, a.id), /不能更换/);
  await f.service.save(owner, { name: "重命名", legalEntity: body.legalEntity, appId: body.appId, mode: body.mode }, a.id);
  assert.equal((await f.service.state(owner)).accounts[0].name, "重命名");
  assert.ok(!JSON.stringify(f.db).includes(application.privateKey.slice(40, 90)));
  assert.ok(!JSON.stringify(f.db.financeAudit).includes("privateKey"));
});

test("generated key is never returned, saved as draft and cannot reset an existing account", async () => {
  const f = fixture(), user = f.users[0];
  const draft = await f.service.save(user, { name: body.name, legalEntity: body.legalEntity, appId: body.appId, mode: "public_key" }, undefined, true);
  assert.equal(draft.configured, false);
  assert.match(draft.applicationPublicKey, /BEGIN PUBLIC KEY/);
  assert.ok(!JSON.stringify(draft).includes("PRIVATE KEY"));
  await assert.rejects(f.service.check(user, draft.id, async () => { throw new Error("should not run"); }), /先完成/);
  const saved = await f.service.save(user, { name: body.name, legalEntity: body.legalEntity, appId: body.appId, mode: "public_key", alipayPublicKey: alipay.publicKey }, draft.id);
  assert.equal(saved.configured, true);
  await assert.rejects(f.service.save(user, body, draft.id, true), /不支持一键重置/);
  await assert.rejects(f.service.save(user, { ...body, appId: "2026000000000003", mode: "certificate" }, undefined, true), /证书模式/);
});

test("PKCS1/PKCS8 accepted, non-RSA/weak keys/cert mismatch/incorrect public key rejected", async () => {
  const f = fixture(), user = f.users[0];
  const pkcs1 = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs1" }, publicKeyEncoding: { format: "pem", type: "spki" } });
  assert.match(normalizePrivateKey(pkcs1.privateKey), /BEGIN PRIVATE KEY/);
  assert.match(normalizePrivateKey(application.privateKey.replace(/-----[^\n]+-----/g, "").replace(/\s/g, "")), /BEGIN PRIVATE KEY/);
  const weak = generateKeyPairSync("rsa", { modulusLength: 1024, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
  assert.throws(() => normalizePrivateKey(weak.privateKey), /2048/);
  await assert.rejects(f.service.save(user, { ...body, alipayPublicKey: application.publicKey }), /不是应用公钥/);
  await assert.rejects(f.service.save(user, { ...body, mode: "certificate" }), /上传/);
  await assert.rejects(f.service.save(user, { ...body, mode: "certificate", appCert: "bad" }), /PEM/);
});

test("lock persists across restart, has no web reopen and rejects check/update/generate", async () => {
  const f = fixture(), user = f.users[0], a = await f.service.save(f.users[0], body);
  await f.service.lock(user);
  const restarted = new AlipayAccountService(f.store, f.env);
  assert.equal((await restarted.state(user)).configurationOpen, false);
  assert.equal((await restarted.state(user)).accounts[0].applicationPublicKey, "");
  await assert.rejects(restarted.save(user, body, a.id), /锁定/);
  await assert.rejects(restarted.save(user, body, undefined, true), /锁定/);
  await assert.rejects(restarted.check(user, a.id, async () => { throw Error("must never run"); }), /锁定/);
  assert.ok(f.db.alipayAccounts![0].credentials.ciphertext);
  const maintenance = new AlipayAccountService(f.store, { ...f.env, FINANCE_CONFIG_EPOCH: "server-only-new-window" });
  assert.equal((await maintenance.state(user)).configurationOpen, true);
});

test("in-flight checks cannot write after locking, config change or role revocation", async () => {
  for (const change of ["lock", "revision", "revoke"]) {
    const f = fixture(), user = f.users[0], a = await f.service.save(f.users[0], body);
    await assert.rejects(f.service.check(user, a.id, async () => {
      if (change === "lock") await f.service.lock(user);
      if (change === "revision") await f.service.save(user, body, a.id);
      if (change === "revoke") f.db.users[0].enabled = false;
      return { balance: { status: "available", message: "fixture" }, bill: { status: "available", message: "fixture" } };
    }), /锁定|变化|无权/);
    assert.equal(f.db.alipayAccounts![0].capabilities.balance.status, "not_tested");
  }
});

test("read-only method allowlist, signed SDK responses and tamper rejection", async () => {
  const execute = alipayReadClient(body.appId, credentials);
  for (const method of ["alipay.trade.pay", "alipay.fund.trans.uni.transfer", "alipay.trade.refund"]) await assert.rejects(execute(method, {}, { validateSign: false }), /白名单/);
  const sdk = new AlipaySdk({ appId: body.appId, privateKey: application.privateKey, keyType: "PKCS8", alipayPublicKey: alipay.publicKey });
  const node = "alipay_data_bill_balance_query_response", response = '{"code":"10000","total_amount":"100.00"}', signature = sign("sha256", Buffer.from(response), alipay.privateKey).toString("base64");
  const envelope = `{"${node}":${response},"sign":"${signature}"}`;
  assert.doesNotThrow(() => sdk.checkResponseSign(envelope, node, signature, "fixture"));
  assert.throws(() => sdk.checkResponseSign(envelope.replace("100.00", "900.00"), node, signature, "fixture"), /验签失败/);
  assert.throws(() => sdk.checkResponseSign(envelope, node, "", "fixture"), /验签失败/);
});

test("probes call only self-account query methods with verify enabled, distinguish no bill and no permission", async () => {
  const calls: unknown[] = [];
  const result = await probeAlipayAccount(body.appId, credentials, async (method, params, options) => {
    calls.push({ method, params, options });
    return method.includes("balance") ? { code: "10000", total_amount: "SECRET-AMOUNT" } : { code: "40004", sub_code: "BILL_NOT_EXIST" };
  });
  assert.equal(result.balance.status, "available");
  assert.equal(result.bill.status, "no_bill");
  assert.ok(!JSON.stringify(result).includes("SECRET-AMOUNT"));
  assert.match(JSON.stringify(calls), /"validateSign":true/);
  assert.ok(!JSON.stringify(calls).includes("bill_user_id"));
  assert.match(JSON.stringify(calls), /signcustomer/);
  const fail = await probeAlipayAccount(body.appId, credentials, async () => { throw Error("PRIVATE KEY \nSECRET\n URL"); });
  assert.equal(fail.balance.status, "failed");
  assert.ok(!JSON.stringify(fail).includes("SECRET"));
  const bill = await probeAlipayAccount(body.appId, credentials, async method => method.includes("balance") ? { code: "40006", sub_code: "isv.insufficient-isv-permissions", sub_msg: "SECRET" } : { code: "10000", bill_download_url: "https://dwbillcenter.alipay.com/temporary-secret" });
  assert.equal(bill.balance.status, "failed"); assert.equal(bill.bill.status, "available");
  assert.ok(!JSON.stringify(bill).includes("temporary-secret"));
});
