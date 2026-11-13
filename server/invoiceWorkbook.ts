import fs from "node:fs/promises";
import JSZip from "jszip";
import type { InvoiceJob, InvoiceRow } from "./invoiceTypes.js";
import { isInvoiceAuxiliaryPath } from "../shared/invoiceFilePolicy.mjs";

export const invoiceHeaders = ["序号", "销货方", "开票日期", "发票号码", "未税金额（元）", "税额（元）", "价税合计（元）", "备注"];
const xml = (s: string) => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function cell(ref: string, style: number, value: string | number | null, formula?: string) {
  if (formula) return `<c r="${ref}" s="${style}"${value === null ? ' t="str"' : ""}><f>${xml(formula)}</f><v>${value ?? ""}</v></c>`;
  if (value === null || value === "") return `<c r="${ref}" s="${style}"/>`;
  return typeof value === "number" ? `<c r="${ref}" s="${style}"><v>${value}</v></c>` : `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}
function row(index: number, values: (string | number | null)[], styles: number[], height = 15) { return `<row r="${index}" ht="${height}" customHeight="1" spans="1:8">${values.map((value, i) => cell(`${String.fromCharCode(65 + i)}${index}`, styles[i], value)).join("")}</row>`; }
export function invoiceExportRows(job: InvoiceJob) {
  const output: { row?: InvoiceRow; source: string; failure?: string }[] = [];
  for (const item of job.items) {
    if (isInvoiceAuxiliaryPath(item.filename)) continue;
    if (["expanded", "duplicate"].includes(item.status)) continue;
    for (const unit of item.units) {
      for (const r of unit.rows) if (!r.duplicateOf) output.push({ row: r, source: `${item.filename}${item.units.length > 1 ? ` 第${unit.page}页` : ""}` });
      if (["failed", "interrupted", "pending", "processing"].includes(unit.status)) output.push({ source: `${item.filename} 第${unit.page}页`, failure: unit.error || "未完成识别" });
    }
    if (!item.units.length && !["completed"].includes(item.status)) output.push({ source: item.filename, failure: item.error || "未完成识别" });
    if (item.units.length && item.status === "failed" && item.units.every(u=>u.status === "completed" && !u.rows.length)) output.push({source:item.filename,failure:item.error||"没有识别到独立发票"});
  }
  return output;
}
export async function buildInvoiceWorkbook(job: InvoiceJob): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await fs.readFile(new URL("./assets/invoice-summary-template.xlsx", import.meta.url)));
  const rows = invoiceExportRows(job), invoices = rows.flatMap(x => x.row ? [x.row] : []);
  const buyers = [...new Set(invoices.map(r => r.buyer).filter(Boolean))];
  const buyer = buyers.length > 1 ? "多购买方（详见备注）" : buyers[0] || "待核对";
  const end = 5 + Math.max(1, rows.length), footer = end + 1;
  const hasIncomplete = !invoices.length || rows.some(r => !!r.failure) || invoices.some(r => r.total === null || !["CNY", "RMB", "人民币"].includes(r.currency));
  const hasForeign=invoices.some(r=>!["CNY","RMB","人民币"].includes(r.currency));
  const sum = (key: "net" | "tax" | "total") => invoices.some(r => r[key] !== null) ? invoices.reduce((n, r) => n + (r[key] ?? 0), 0) / 100 : null;
  let data = row(1, Array(8).fill(null), Array(8).fill(14), 16.8);
  data += row(2, ["发票汇总", null, null, null, null, null, null, null], [1,2,2,2,2,2,2,2], 22);
  data += `<row r="3" spans="1:8">${cell("A3",3,"购买方")}${cell("B3",3,buyer)}${cell("C3",3,null)}${cell("D3",3,"发票张数")}${cell("E3",3,invoices.length)}${cell("F3",3,"价税合计（元）")}${cell("G3",4,hasIncomplete?null:sum("total"),`IF(ISNUMBER(G${footer}),G${footer},"")`)}${cell("H3",3,null)}</row>`;
  data += row(4, Array(8).fill(null), Array(8).fill(3), 16.8) + row(5, invoiceHeaders, Array(8).fill(5), 26);
  const values = rows.length ? rows : [{ source: "", failure: "本任务未识别到发票" }];
  for (const [index, item] of values.entries()) {
    const r = item.row;
    const note = r ? [r.remark, buyers.length > 1 ? `购买方：${r.buyer || "待核对"}` : "", r.code ? `发票代码：${r.code}` : "", ...r.warnings.map(w=>`待核对：${w}`), `来源：${item.source}`].filter(Boolean).join("；") : `未识别：${item.failure}；来源：${item.source}`;
    const date = r?.date ? Math.round((Date.parse(r.date + "T00:00:00Z") - Date.UTC(1899,11,30))/86400000) : null;
    data += row(index+6, [index+1, r?.seller || "[未识别]", date, r?.number || null, r?.net === null || !r ? null : r.net/100, r?.tax === null || !r ? null : r.tax/100, r?.total === null || !r ? null : r.total/100, note], [6,7,8,9,10,10,10,7], Math.min(90, Math.max(30, Math.ceil(note.length/32)*15)));
  }
  const summaryNote = hasIncomplete ? "存在未完成、缺金额或非人民币票据，总额留空，请先核对。" : invoices.some(r=>r.warnings.length) ? "部分票据待核对，详见备注。" : "";
  data += `<row r="${footer}" ht="30" customHeight="1" spans="1:8">${["A","B","C","D"].map((c,i)=>cell(`${c}${footer}`,11,i?null:"汇总")).join("")}${cell(`E${footer}`,12,hasForeign?null:sum("net"),hasForeign?'""':`IF(COUNT(E6:E${end})=0,"",ROUND(SUM(E6:E${end}),2))`)}${cell(`F${footer}`,12,hasForeign?null:sum("tax"),hasForeign?'""':`IF(COUNT(F6:F${end})=0,"",ROUND(SUM(F6:F${end}),2))`)}${cell(`G${footer}`,12,hasIncomplete?null:sum("total"),hasIncomplete?'""':`IF(COUNT(G6:G${end})=${invoices.length},ROUND(SUM(G6:G${end}),2),"")`)}${cell(`H${footer}`,13,summaryNote)}</row>`;
  data += row(footer+1,Array(8).fill(null),Array(8).fill(3),16.8)+row(footer+2,Array(8).fill(null),Array(8).fill(3),16.8);
  let sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  sheet = sheet.replace(/<sheetData\s*\/>|<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${data}</sheetData>`).replace(/<dimension[^>]*\/>/, `<dimension ref="A1:H${footer+2}"/>`);
  zip.file("xl/worksheets/sheet1.xml",sheet);
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  zip.file("xl/workbook.xml",workbook.replace(/<calcPr[^>]*\/>/, '<calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/>'));
  return zip.generateAsync({type:"nodebuffer",compression:"DEFLATE"});
}
