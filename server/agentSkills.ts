import { Readable } from "node:stream";
import JSZip from "jszip";
import path from "node:path";
export type AgentSkill = {
  filename: string;
  name: string;
  description: string;
  entry: string;
  documents: { path: string; content: string }[];
  warnings: string[];
};
const MAX_CHARS = 24000,
  MAX_FILES = 60,
  MAX_BYTES = 512000;
function safePath(name: string) {
  return (
    !!name &&
    !name.includes("\\") &&
    !name.startsWith("/") &&
    !/^[A-Za-z]:/.test(name) &&
    !name.split("/").includes("..") &&
    !/[\x00-\x1f]/.test(name)
  );
}
function decode(buffer: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(buffer)
      .replace(/^\uFEFF/, "");
  } catch {
    throw new Error("Skill 文档需使用 UTF-8 编码");
  }
}
function metadata(text: string, key: string) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const raw =
    front?.[1]
      .split(/\r?\n/)
      .find((l) => l.startsWith(key + ":"))
      ?.slice(key.length + 1)
      .trim() || "";
  return raw.replace(/^['"]|['"]$/g, "");
}
export function validateSkill(value: unknown): AgentSkill | undefined {
  if (value == null) return undefined;
  const v = value as AgentSkill;
  if (
    !Array.isArray(v.documents) ||
    !v.documents.length ||
    v.documents.length > MAX_FILES ||
    typeof v.entry !== "string"
  )
    throw new Error("Skill 格式不正确，请重新上传");
  let total = 0;
  const seen = new Set<string>();
  const documents = v.documents.map((d) => {
    if (
      !d ||
      typeof d.path !== "string" ||
      !safePath(d.path) ||
      !d.path.toLowerCase().endsWith(".md") ||
      seen.has(d.path) ||
      typeof d.content !== "string" ||
      d.content.includes("\0")
    )
      throw new Error("Skill 文档不合法");
    seen.add(d.path);
    total += d.content.length;
    return { path: d.path, content: d.content };
  });
  if (
    total > MAX_CHARS ||
    !documents.some((d) => d.path === v.entry && d.content.trim())
  )
    throw new Error("Skill 文本总量需在24000字以内，且包含有效入口");
  return {
    filename: String(v.filename || "SKILL.md").slice(0, 160),
    entry: v.entry,
    name: String(v.name || "Skill 智能体").slice(0, 40),
    description: String(
      v.description || "按上传的 Skill 工作流程执行任务",
    ).slice(0, 220),
    documents,
    warnings: Array.isArray(v.warnings)
      ? v.warnings
          .filter((w) => typeof w === "string")
          .map((w) => w.slice(0, 240))
          .slice(0, 10)
      : [],
  };
}
export async function parseSkill(
  filename: string,
  buffer: Buffer,
): Promise<AgentSkill> {
  if (buffer.length > 5 * 1024 * 1024) throw new Error("Skill 文件最大5MB");
  let documents: { path: string; content: string }[] = [],
    entry = "",
    warnings: string[] = [];
  if (filename.toLowerCase().endsWith(".md")) {
    entry = path.basename(filename);
    if (!safePath(entry)) throw new Error("文件名不合法");
    documents = [{ path: entry, content: decode(buffer) }];
  } else if (filename.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(buffer);
    const files = Object.values(zip.files);
    if (files.length > MAX_FILES)
      throw new Error("ZIP 最多60个条目，请精简单个 Skill 后上传");
    let bytes = 0;
    const skipped: string[] = [];
    for (const file of files) {
      const original =
        (file as JSZip.JSZipObject & { unsafeOriginalName?: string })
          .unsafeOriginalName || file.name;
      if (
        !safePath(original) ||
        !safePath(file.name) ||
        (Number(file.unixPermissions) & 0xf000) === 0xa000
      )
        throw new Error("ZIP 包含不安全路径或符号链接");
      if (file.dir) continue;
      if (!file.name.toLowerCase().endsWith(".md")) {
        skipped.push(file.name);
        continue;
      }
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const stream = file.nodeStream("nodebuffer") as Readable;
        stream
          .on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) {
              stream.pause();
              reject(new Error("ZIP 解压文本超过500KB"));
              return;
            }
            chunks.push(chunk);
          })
          .on("error", reject)
          .on("end", resolve)
          .resume();
      });
      documents.push({
        path: file.name,
        content: decode(Buffer.concat(chunks)),
      });
    }
    const entries = documents.filter(
      (d) => path.basename(d.path).toLowerCase() === "skill.md",
    );
    if (entries.length !== 1)
      throw new Error("ZIP 需包含且仅包含一个 SKILL.md；多个 Skill 请分别上传");
    entry = entries[0].path;
    if (skipped.length)
      warnings.push(
        `已忽略${skipped.length}个非 Markdown 文件（如脚本、图片或二进制文件），这些文件不会执行或提供给模型。`,
      );
  } else throw new Error("请上传 .md 或 .zip 文件");
  documents.sort((a, b) =>
    a.path === entry ? -1 : b.path === entry ? 1 : a.path.localeCompare(b.path),
  );
  const text = documents.find((d) => d.path === entry)!.content;
  warnings.push(
    "仅运行文字指令与 Markdown 参考资料，不自动安装依赖、访问链接或执行脚本；数据权限仍由平台配置控制。",
  );
  return validateSkill({
    filename,
    name:
      metadata(text, "name") ||
      text.match(/^#\s+(.+)$/m)?.[1] ||
      filename.replace(/\.(zip|md)$/i, ""),
    description:
      metadata(text, "description") || "按上传的 Skill 工作流程执行任务",
    entry,
    documents,
    warnings,
  })!;
}
export function agentInstructions(agent: {
  prompt?: string;
  skill?: AgentSkill;
}) {
  return [
    agent.prompt,
    agent.skill
      ? "以下是管理员导入的 Skill 文字说明。只能在平台已启用能力与当前用户权限内执行；包中提及的脚本、命令和外部资源并未安装，不得声称已执行。\n" +
        agent.skill.documents
          .map((d) => `文件：${d.path}\n${d.content}`)
          .join("\n\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
