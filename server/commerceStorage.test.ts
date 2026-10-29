import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { saveCommerceImage } from "./commerceStorage.js";
import { defaultCommerceBrief, type CommerceJob, type CommerceVariant } from "./commerceTypes.js";

function fixture(taskType: CommerceJob["taskType"] = "main", kind: CommerceJob["kind"] = "product_creative") {
  const variant: CommerceVariant = { id: "v", name: "结果", reason: "", headline: "", subline: "", imagePrompt: "", title: "", titleReason: "", status: "generating", attempts: 1 };
  const job = { id: "job", kind, taskType, companyId: "company", userId: "user", brief: { ...defaultCommerceBrief(), productName: "商品" }, variants: [variant] } as CommerceJob;
  return { job, variant };
}

test("main and SKU exports are actual 1440 square PNGs; portrait is width1440 height1920", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-dimensions-"));
  try {
    const source = await sharp({ create: { width: 200, height: 100, channels: 3, background: "red" } }).png().toBuffer();
    for (const taskType of ["main", "sku", "portrait"] as const) {
      const { job, variant } = fixture(taskType);
      const saved = await saveCommerceImage(`data:image/png;base64,${source.toString("base64")}`, job, variant, dir);
      const metadata = await sharp(saved.storagePath).metadata();
      assert.equal(saved.mimeType, "image/png");
      assert.equal(metadata.width, 1440);
      assert.equal(metadata.height, taskType === "portrait" ? 1920 : 1440);
      assert.equal(variant.sourceWidth, 200);
      assert.equal(variant.sourceHeight, 100);
      assert.equal(variant.outputWidth, 1440);
      assert.equal(variant.outputHeight, metadata.height);
      assert.match(variant.qualityNote!, /按比例留白/);
      // Original wide red canvas is centered and preserved rather than stretched or cropped.
      const { data, info } = await sharp(saved.storagePath).raw().toBuffer({ resolveWithObject: true });
      assert.deepEqual([...data.subarray(0, 3)], [255, 255, 255]);
      const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
      assert.deepEqual([...data.subarray(center, center + 3)], [255, 0, 0]);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("small edits preserve native dimensions and bytes, without imposing ecommerce export sizing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-native-edit-"));
  try {
    const source = await sharp({ create: { width: 320, height: 211, channels: 3, background: "blue" } }).jpeg().toBuffer();
    const { job, variant } = fixture(undefined, "image_edit");
    const saved = await saveCommerceImage(`data:image/jpeg;base64,${source.toString("base64")}`, job, variant, dir);
    assert.deepEqual(await fs.readFile(saved.storagePath), source);
    assert.equal(saved.mimeType, "image/jpeg");
    assert.equal(variant.outputWidth, 320);
    assert.equal(variant.outputHeight, 211);
    assert.equal(variant.qualityNote, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
