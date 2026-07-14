export function normalizeUploadFilename(filename: string) {
  if (!/[\u0080-\u00ff]/.test(filename)) return filename;
  const decoded = Buffer.from(filename, "latin1").toString("utf8");
  return decoded.includes("\ufffd") ? filename : decoded;
}
