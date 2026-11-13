import test from "node:test";
import assert from "node:assert/strict";
import { enterpriseDataFixture } from "./enterpriseData.fixture.js";

test("model setup HTTP is admin-only; preset defaults, saved-key test and key preservation work", { timeout: 60000 }, async () => {
  const f = await enterpriseDataFixture();
  const admin = (route: string, body?: unknown, method?: string) => f.request(route, "admin", body, method, true);
  try {
    for (const who of ["", "member"]) assert.equal((await f.request("/api/admin/models/test", who, { provider: "deepseek", apiKey: "fixture-secret" })).status, who ? 403 : 401);
    assert.equal((await f.request("/api/admin/models/test", "admin", { provider: "deepseek", apiKey: "fixture-secret" })).status, 401);
    const created = await admin("/api/admin/models", { provider: "deepseek", apiKey: "fixture-secret", enabled: true });
    assert.equal(created.status, 200); assert.equal(created.data.model.model, "deepseek-flash"); assert.equal(created.data.model.hasApiKey, true); assert.ok(!JSON.stringify(created.data).includes("fixture-secret"));
    const id = created.data.model.id;
    await admin("/api/admin/models/" + id, { baseUrl: f.upstreamUrl }, "PATCH");
    const tested = await admin("/api/admin/models/test", { modelId: id });
    assert.equal(tested.status, 200, JSON.stringify(tested.data)); assert.equal(tested.data.model, "deepseek-flash");
    assert.equal(f.payloads.at(-1)?.thinking && (f.payloads.at(-1)!.thinking as any).type, "disabled");
    assert.equal((await admin("/api/admin/models/" + id, { provider: "doubao" }, "PATCH")).status, 400);
    const state = await f.read(); assert.equal(state.models.find((m: any) => m.id === id).provider, "deepseek");
    assert.equal((await admin("/api/admin/models/test", { provider: "deepseek" })).status, 400);
  } finally { await f.close(); }
});
