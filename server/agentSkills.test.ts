import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { parseSkill, validateSkill, agentInstructions } from "./agentSkills.js";
test("Markdown and zipped Skill retain instructions and references without executing bundled scripts", async () => {
  const md =
    "---\nname: 库存复核\ndescription: 按步骤复核\n---\n# 操作步骤\n先核对授权范围。";
  const single = await parseSkill("demo.md", Buffer.from(md));
  assert.equal(single.name, "库存复核");
  const zip = new JSZip();
  zip.file("demo/SKILL.md", md);
  zip.file("demo/references/check.md", "逐项核查字段");
  zip.file("demo/scripts/run.sh", "touch /tmp/should-not-exist");
  const parsed = await parseSkill(
    "demo.zip",
    await zip.generateAsync({ type: "nodebuffer" }),
  );
  assert.equal(parsed.documents.length, 2);
  assert.match(parsed.warnings.join(" "), /忽略1个/);
  assert.ok(
    agentInstructions({ prompt: "补充", skill: parsed }).includes(
      "逐项核查字段",
    ),
  );
  assert.ok(!agentInstructions({ skill: parsed }).includes("touch /tmp"));
});
test("reject ambiguous, unsafe, oversized and malformed Skill packages", async () => {
  await assert.rejects(parseSkill("bad.exe", Buffer.from("x")), /上传/);
  await assert.rejects(
    parseSkill("huge.md", Buffer.from("x".repeat(24001))),
    /24000/,
  );
  const zip = new JSZip();
  zip.file("../SKILL.md", "# attack");
  await assert.rejects(
    parseSkill("bad.zip", await zip.generateAsync({ type: "nodebuffer" })),
    /路径/,
  );
  const many = new JSZip();
  many.file("one/SKILL.md", "one");
  many.file("two/SKILL.md", "two");
  await assert.rejects(
    parseSkill("many.zip", await many.generateAsync({ type: "nodebuffer" })),
    /仅包含一个/,
  );
  const bomb = new JSZip();
  bomb.file("SKILL.md", "x".repeat(600000));
  await assert.rejects(
    parseSkill(
      "bomb.zip",
      await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    ),
    /500KB/,
  );
  assert.throws(
    () =>
      validateSkill({
        entry: "SKILL.md",
        documents: [{ path: "../SKILL.md", content: "x" }],
      }),
    /不合法/,
  );
  await assert.rejects(
    parseSkill("bad.md", Buffer.from([0xff, 0xfe, 0x00])),
    /UTF-8/,
  );
});
