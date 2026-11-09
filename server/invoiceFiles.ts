import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

export type InvoicePrepared = { units: { page: number; text: string; imagePath?: string }[] };
export type InvoiceExpanded = { files: { name: string; path: string; size: number }[] };
export function runInvoiceWorker<T>(file: string, out: string, action: "archive" | "document"): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./invoiceWorker.mjs", import.meta.url)), [], { execArgv: ["--max-old-space-size=384"], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: process.env.PATH } });
    let finished = false;
    const finish = (error?: Error, result?: T) => { if (finished) return; finished = true; clearTimeout(timer); child.kill("SIGKILL"); error ? reject(error) : resolve(result!); };
    const timer = setTimeout(() => finish(new Error("文件处理超时，请拆分文件或更换清晰版本")), 90000);
    child.once("error", error => finish(error));
    child.once("exit", () => { if (!finished) finish(new Error("文件无法处理或超过资源限制，请拆分后重试")); });
    child.once("message", (raw: unknown) => { const result = raw as { ok?: boolean; error?: string }; result.ok ? finish(undefined, result as T) : finish(new Error(result.error || "文件读取失败")); });
    child.send({ file, out, ext: path.extname(file).toLowerCase(), action });
  });
}
export async function removeInvoiceWork(dir: string) { await fs.rm(dir, { recursive: true, force: true }); }
