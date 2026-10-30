import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { createAlipayAccountRouter } from "./alipayAccountRoutes.js";
import type { Database, User } from "./types.js";

test("HTTP: deny unauthenticated/member/cross-tenant access; lock closes every config mutation; no credential disclosure", async () => {
  const users = [["a", "c1", "admin"], ["b", "c2", "admin"], ["u", "c1", "user"], ["x", "c1", "admin"]].map(([id, companyId, role]) => ({ id, companyId, role, enabled: true })) as User[];
  const db = { users } as Database;
  const store = { read: async () => db, mutate: async <T>(fn: (db: Database) => T) => fn(db) };
  const env = { FINANCE_CONFIG_ENABLED: "true", FINANCE_CONFIG_EPOCH: "http1", FINANCE_CONFIG_ADMIN_IDS: "a,b", FINANCE_CONFIG_EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString(), FINANCE_CREDENTIAL_MASTER_KEY: randomBytes(32).toString("base64") };
  let probes = 0;
  const app = express(); app.use(express.json());
  // Only this synthetic fixture replaces the session middleware. Production mounts auth + requireRole.
  app.use((req, _res, next) => { req.user = users.find(u => u.id === req.headers["x-fixture-user"]); next(); });
  app.use("/api/admin/data-platform/alipay", createAlipayAccountRouter(store, env, async () => {
    probes++;
    return { balance: { status: "available", message: "fixture" }, bill: { status: "available", message: "fixture" } };
  }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/data-platform/alipay`;
  const request = async (route = "", user = "a", method = "GET", body?: unknown) => {
    const res = await fetch(url + route, { method, headers: { "Content-Type": "application/json", "x-fixture-user": user }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() as any };
  };
  const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
  const merchant = pair(), platform = pair();
  const body = { name: "测试", legalEntity: "测试主体", appId: "2026000000000010", mode: "public_key", privateKey: merchant.privateKey, alipayPublicKey: platform.publicKey };
  try {
    assert.equal((await request("", "")).status, 401);
    assert.equal((await request("", "u")).status, 403);
    assert.equal((await request("/accounts", "x", "POST", body)).status, 403);
    const crossSite = await fetch(url + "/accounts", { method: "POST", headers: { "Content-Type": "application/json", "x-fixture-user": "a", Origin: "https://untrusted.example" }, body: JSON.stringify(body) });
    assert.equal(crossSite.status, 403);
    assert.equal(db.alipayAccounts, undefined);
    const created = await request("/accounts", "a", "POST", body);
    assert.equal(created.status, 201);
    assert.ok(!JSON.stringify(created.data).includes("PRIVATE KEY"));
    assert.ok(!JSON.stringify(created.data).includes(platform.publicKey));
    const id = created.data.account.id;
    assert.deepEqual((await request("", "b")).data.accounts, []);
    assert.equal((await request(`/accounts/${id}`, "b", "PUT", body)).status, 404);
    assert.equal((await request(`/accounts/${id}/check`, "b", "POST", {})).status, 404);
    assert.equal(probes, 0);
    assert.equal((await request(`/accounts/${id}/check`, "a", "POST", {})).status, 200);
    assert.equal(probes, 1);
    assert.equal((await request(`/accounts/${id}/check`, "a", "POST", {})).status, 429);
    assert.equal((await request("/lock", "a", "POST", {})).status, 200);
    const locked = await request();
    assert.equal(locked.data.configurationOpen, false);
    assert.equal(locked.data.accounts[0].applicationPublicKey, "");
    for (const [route, method] of [["/accounts", "POST"], ["/accounts/generate-key", "POST"], [`/accounts/${id}`, "PUT"], [`/accounts/${id}/check`, "POST"], ["/lock", "POST"]]) assert.equal((await request(route, "a", method, body)).status, 403, route);
    assert.equal(probes, 1);
    assert.equal((await request("/unlock", "a", "POST", {})).status, 404);
    assert.equal(db.alipayAccounts!.length, 1);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
