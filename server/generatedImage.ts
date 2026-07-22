export type DecodedGeneratedImage = {
  data: Buffer;
  extension: ".png" | ".jpg" | ".webp";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
};

export function decodeGeneratedImageDataUrl(imageUrl: string, maxBytes: number): DecodedGeneratedImage {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i.exec(imageUrl);
  if (!match) throw new Error("生成图片的格式不受支持");
  const mimeType = match[1].toLowerCase() as DecodedGeneratedImage["mimeType"];
  const data = Buffer.from(match[2], "base64");
  if (!data.length) throw new Error("生成图片内容为空");
  if (data.length > maxBytes) throw new Error(`生成图片不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
  return {
    data,
    mimeType,
    extension: mimeType === "image/jpeg" ? ".jpg" : `.${mimeType.slice("image/".length)}` as ".png" | ".webp"
  };
}
