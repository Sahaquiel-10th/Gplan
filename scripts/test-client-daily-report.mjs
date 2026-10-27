import fs from 'node:fs/promises';

// Usage: node scripts/test-client-daily-report.mjs /secure/credentials.json 2026-10-13
const credentialPath = process.argv[2];
if (!credentialPath) throw new Error('请提供凭证文件路径');
const credential = JSON.parse(await fs.readFile(credentialPath, 'utf8'));
const date = process.argv[3] || new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10);
const headers = { Authorization: `Bearer ${credential.token}` };
const base = credential.base_url;
async function get(path) {
  const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(60000) });
  const body = await response.json();
  if (!response.ok || body.code !== 0) throw new Error(JSON.stringify({ status: response.status, ...body }));
  return body;
}
await get('/ping');
const rows = [];
let batch;
for (let page = 1; ; page++) {
  const params = new URLSearchParams({ date, page: String(page), page_size: '200', ...(batch ? { batch_id: batch } : {}) });
  const body = await get(`/daily-report?${params}`);
  batch = body.batch_id;
  rows.push(...body.data);
  if (!body.pagination.has_more) {
    if (rows.length !== body.pagination.total) throw new Error('分页行数不一致');
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}
const summary = {};
for (const row of rows) {
  const current = summary[row.record_type] ||= { rows: 0, quantity: 0 };
  current.rows++;
  current.quantity += row.inventory_quantity ?? row.outbound_quantity ?? row.inbound_quantity ?? 0;
}
const output = `daily-report-${date}.json`;
await fs.writeFile(output, JSON.stringify({ date, batch_id: batch, data: rows }, null, 2));
console.log(JSON.stringify({ ok: true, rows: rows.length, summary, output }, null, 2));
