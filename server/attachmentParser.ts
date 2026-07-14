import path from "node:path";
import { createRequire } from "node:module";
import JSZip from "jszip";
import mammoth from "mammoth";
import readXlsxFile from "read-excel-file/node";
import * as XLSX from "xlsx";
import { parse as parseCsv } from "csv-parse/sync";
import { AttachmentKind } from "./types.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (buffer: Buffer) => Promise<{ text: string }>;

const maxExtractedChars = Math.max(1000, Number(process.env.ATTACHMENT_MAX_EXTRACTED_CHARS ?? 30000));

const supportedExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".pdf", ".docx", ".xls", ".xlsx", ".csv", ".txt", ".md", ".json", ".pptx"
]);

export function isSupportedAttachment(filename: string) {
  return supportedExtensions.has(path.extname(filename).toLowerCase());
}

export function safeAttachmentExtension(filename: string) {
  const extension = path.extname(filename).toLowerCase();
  return supportedExtensions.has(extension) ? extension : "";
}

export async function parseAttachment(buffer: Buffer, filename: string, mimeType: string) {
  const extension = path.extname(filename).toLowerCase();
  assertFileSignature(buffer, extension);
  if ([".docx", ".xlsx", ".pptx"].includes(extension)) await validateOfficeArchive(buffer);
  let kind: AttachmentKind;
  let extractedText = "";

  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) {
    kind = "image";
  } else if (extension === ".pdf") {
    kind = "document";
    extractedText = (await pdfParse(buffer)).text;
  } else if (extension === ".docx") {
    kind = "document";
    extractedText = (await mammoth.extractRawText({ buffer })).value;
  } else if (extension === ".xlsx") {
    kind = "spreadsheet";
    const sheets = await readXlsxFile(buffer);
    extractedText = sheets.map(({ sheet, data }) => {
      const rows = data.map((row) => row.map(formatCell).join("\t")).join("\n");
      return `[工作表：${sheet}]\n${rows}`;
    }).join("\n\n");
  } else if (extension === ".xls") {
    kind = "spreadsheet";
    extractedText = extractLegacyExcelText(buffer);
  } else if (extension === ".csv") {
    kind = "spreadsheet";
    const rows = parseCsv(buffer, { bom: true, relax_column_count: true, skip_empty_lines: true }) as unknown[][];
    extractedText = rows.map((row) => row.map(formatCell).join("\t")).join("\n");
  } else if ([".txt", ".md", ".json"].includes(extension)) {
    kind = "text";
    extractedText = buffer.toString("utf8");
  } else if (extension === ".pptx") {
    kind = "presentation";
    extractedText = await extractPptxText(buffer);
  } else {
    throw new Error("暂不支持这个文件格式");
  }

  const normalized = normalizeText(extractedText).slice(0, maxExtractedChars);
  if (kind !== "image" && !normalized) throw new Error("没有从文件中读取到可分析的文字");
  return { kind, extractedText: normalized, mimeType: normalizedMimeType(extension, mimeType) };
}

function assertFileSignature(buffer: Buffer, extension: string) {
  const matches = (...bytes: number[]) => bytes.every((byte, index) => buffer[index] === byte);
  const valid =
    extension === ".png" ? matches(0x89, 0x50, 0x4e, 0x47) :
    [".jpg", ".jpeg"].includes(extension) ? matches(0xff, 0xd8, 0xff) :
    extension === ".gif" ? buffer.subarray(0, 4).toString("ascii") === "GIF8" :
    extension === ".webp" ? buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP" :
    extension === ".pdf" ? buffer.subarray(0, 5).toString("ascii") === "%PDF-" :
    [".docx", ".xlsx", ".pptx"].includes(extension) ? matches(0x50, 0x4b) :
    extension === ".xls" ? isLegacyExcelFile(buffer) :
    true;
  if (!valid) throw new Error("文件内容与扩展名不一致");
}

function isLegacyExcelFile(buffer: Buffer) {
  const compoundFileHeader = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const isCompoundFile = compoundFileHeader.every((byte, index) => buffer[index] === byte);
  const isEarlyBiffWorkbook = buffer[0] === 0x09 && [0x00, 0x02, 0x04, 0x08].includes(buffer[1]);
  return isCompoundFile || isEarlyBiffWorkbook;
}

function extractLegacyExcelText(buffer: Buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });
    const text = rows.map((row) => row.map(formatCell).join("\t")).join("\n");
    return `[工作表：${sheetName}]\n${text}`;
  }).join("\n\n");
}

async function validateOfficeArchive(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  if (entries.length > 5000) throw new Error("Office 文件内部项目过多");
  const uncompressedBytes = entries.reduce((total, entry) => {
    const size = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
    return total + (Number.isFinite(size) ? size : 0);
  }, 0);
  if (uncompressedBytes > 60 * 1024 * 1024) throw new Error("Office 文件解压后过大");
}

function formatCell(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function normalizeText(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

async function extractPptxText(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  const slides: string[] = [];
  for (const name of slideNames) {
    const xml = await zip.file(name)?.async("string");
    if (!xml) continue;
    const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXml(match[1]))
      .filter(Boolean)
      .join("\n");
    if (text) slides.push(`[第 ${slideNumber(name)} 页]\n${text}`);
  }
  return slides.join("\n\n");
}

function slideNumber(name: string) {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizedMimeType(extension: string, mimeType: string) {
  const known: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json"
  };
  return known[extension] ?? mimeType ?? "application/octet-stream";
}
