import assert from "node:assert/strict";
import test from "node:test";
import { unwrapRecords } from "./client.js";

test("万里牛成功但无 data 字段时按空分页处理", () => {
  assert.deepEqual(unwrapRecords({ code: 0 }), []);
});

test("万里牛非零错误码不能被当作空分页", () => {
  assert.throws(() => unwrapRecords({ code: 1500, message: "业务参数错误" }), /1500/);
});
