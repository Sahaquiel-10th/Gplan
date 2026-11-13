import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonFileAtomic } from "./jsonFile.js";

test("chunked persistence keeps nested conversation records, images, nulls and optional fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gplan-json-store-"));
  try {
    const file = path.join(dir, "db.json");
    const message = { id: "m", content: "中文正文\n与转义\"符号", imageUrl: "data:image/png;base64,AA==" };
    const data = { conversations: [{ id: "c", messages: [message] }], messages: [message], optional: undefined, array: [undefined, null, { missing: undefined }], settings: { enabled: true }, empty: [], amount: null };
    writeJsonFileAtomic(file, data);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(JSON.stringify(data)));
    assert.deepEqual(fs.readdirSync(dir), ["db.json"]);
    writeJsonFileAtomic(file, { ...data, revision: 2 });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).revision, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a serialization failure leaves the previous database intact and removes the temporary file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gplan-json-store-"));
  try {
    const file = path.join(dir, "db.json");
    writeJsonFileAtomic(file, { messages: [{ content: "saved" }] });
    assert.throws(() => writeJsonFileAtomic(file, { messages: [{ unsupported: 1n }] }));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { messages: [{ content: "saved" }] });
    assert.deepEqual(fs.readdirSync(dir), ["db.json"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
