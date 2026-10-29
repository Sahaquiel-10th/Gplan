import fs from "node:fs/promises";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { decodeGeneratedImageDataUrl } from "./generatedImage.js";
import { parseAttachment } from "./attachmentParser.js";
import { uid } from "./security.js";
import sharp from "sharp";
import type { Attachment } from "./types.js";
import type { CommerceJob, CommerceVariant } from "./commerceTypes.js";

function publicAddress(address: string): boolean {
  if (isIP(address) === 6) return !/^(::|fc|fd|fe[89ab]|ff)/i.test(address) && !address.includes(".");
  const p = address.split(".").map(Number);
  return p.length === 4 && ![0, 10, 127].includes(p[0]) && p[0] < 224
    && !(p[0] === 169 && p[1] === 254) && !(p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    && !(p[0] === 192 && p[1] === 168) && !(p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

async function downloadImage(raw: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string; extension: string }> {
  let current = raw;
  for (let redirect = 0; redirect < 4; redirect++) {
    const url = new URL(current);
    if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") throw new Error("图片下载地址无效");
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error("图片下载地址不可访问");
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(45000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("图片下载跳转无效");
      current = new URL(location, url).toString(); continue;
    }
    if (!response.ok || !response.body) throw new Error("生成的图片下载失败，请重试该张图片");
    if (Number(response.headers.get("content-length")) > maxBytes) { await response.body.cancel(); throw new Error("生成的图片超过大小限制"); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("生成的图片超过大小限制");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const data = Buffer.concat(chunks);
    const mimeType = data[0] === 0x89 && data[1] === 0x50 ? "image/png"
      : data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg"
      : data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP" ? "image/webp" : "";
    if (!mimeType) throw new Error("作图服务返回的文件不是支持的图片");
    return { data, mimeType, extension: mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/png" ? ".png" : ".webp" };
  }
  throw new Error("图片下载跳转过多");
}

export async function saveCommerceImage(raw: string, job: CommerceJob, variant: CommerceVariant, uploadDir: string): Promise<Attachment> {
  const maxBytes = 25 * 1024 * 1024;
  let { data, mimeType, extension } = raw.startsWith("data:") ? decodeGeneratedImageDataUrl(raw, maxBytes) : await downloadImage(raw, maxBytes);
  await parseAttachment(data, `image${extension}`, mimeType);
  const metadata = await sharp(data, { limitInputPixels: 60_000_000 }).metadata();
  if (!metadata.width || !metadata.height || (metadata.pages || 1) > 1) throw new Error("生成的图片尺寸无效");
  const swapDimensions = [5, 6, 7, 8].includes(metadata.orientation || 1);
  variant.sourceWidth = swapDimensions ? metadata.height : metadata.width;
  variant.sourceHeight = swapDimensions ? metadata.width : metadata.height;
  if (job.kind === "image_edit") {
    variant.outputWidth = variant.sourceWidth;
    variant.outputHeight = variant.sourceHeight;
  } else {
    const portrait = job.taskType === "portrait" || job.brief.outputFormat === "portrait";
    variant.outputWidth = 1440;
    variant.outputHeight = portrait ? 1920 : 1440;
    data = await sharp(data, { limitInputPixels: 60_000_000 }).rotate().resize(variant.outputWidth, variant.outputHeight, {
      fit: "contain", position: "centre", background: { r: 255, g: 255, b: 255, alpha: 1 },
    }).png().toBuffer();
    mimeType = "image/png";
    extension = ".png";
    if (variant.sourceWidth !== variant.outputWidth || variant.sourceHeight !== variant.outputHeight) {
      const ratioChanged = Math.abs(variant.sourceWidth / variant.sourceHeight - variant.outputWidth / variant.outputHeight) > .001;
      const note = `已从${variant.sourceWidth}×${variant.sourceHeight}适配为${variant.outputWidth}×${variant.outputHeight}${ratioChanged ? "，为保留完整画面按比例留白" : ""}；导出像素已达到要求，请核对放大后的细节清晰度。`;
      variant.qualityNote = [variant.qualityNote, note].filter(Boolean).join(" ");
    }
  }
  const id = uid("att");
  const attachment: Attachment = {
    id, companyId: job.companyId, userId: job.userId, originalName: `${job.brief.productName.slice(0, 50)}-${variant.name.slice(0, 30)}${extension}`,
    mimeType, kind: "image", size: data.length, storagePath: path.join(uploadDir, `${id}${extension}`), extractedText: "", createdAt: new Date().toISOString(),
  };
  await fs.writeFile(attachment.storagePath, data, { flag: "wx" });
  return attachment;
}

export async function readCommerceImages(attachments: Attachment[]): Promise<string[]> {
  return Promise.all(attachments.map(async a => `data:${a.mimeType};base64,${(await fs.readFile(a.storagePath)).toString("base64")}`));
}
