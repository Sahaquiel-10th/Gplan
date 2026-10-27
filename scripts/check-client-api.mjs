import fs from 'node:fs/promises';

const file=process.env.CLIENT_API_CREDENTIAL_FILE;
const credential=file?JSON.parse(await fs.readFile(file,'utf8')):{};
const token=process.env.CLIENT_API_TOKEN||credential.token;
if(!token)throw new Error('Client API deployment check requires a credential file or CLIENT_API_TOKEN');
const base=process.env.CLIENT_API_BASE_URL||credential.base_url;
if(!base)throw new Error('Client API base URL is required');
const date=process.env.CLIENT_API_DATE||new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10);
async function get(path,expected=200,authenticated=true) {
  const response=await fetch(base+path,{headers:authenticated?{Authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(60000)});
  if(!response.headers.get('content-type')?.includes('application/json'))throw new Error(`Client API returned non-JSON for ${path}; HTTP ${response.status}`);
  const body=await response.json();
  if(response.status!==expected)throw new Error(`Client API ${path}: HTTP ${response.status}, code ${body.code}`);
  return body;
}
const ping=await get('/ping');
if(ping.code!==0)throw new Error('Client credential verification failed');
await get('/daily-report',400);
await get('/daily-report?date='+date,401,false);
await get('/release-check-unknown',404);
let batch,total=0,pages=0,expectedTotal;
for(let page=1;;page++) {
  const body=await get('/daily-report?'+new URLSearchParams({date,page:String(page),page_size:'200',...(batch?{batch_id:batch}:{})}));
  if(body.code!==0||body.business_date!==date||!body.batch_id||!Array.isArray(body.data)||!body.pagination)throw new Error('Daily report JSON contract mismatch');
  batch ||= body.batch_id;
  if(body.batch_id!==batch)throw new Error('Report batch changed during deployment check');
  if(expectedTotal!==undefined&&body.pagination.total!==expectedTotal)throw new Error('Report total changed during pagination');
  expectedTotal=body.pagination.total;total+=body.data.length;pages++;
  if(!body.pagination.has_more)break;
  if(page>=1000)throw new Error('Pagination did not terminate');
  await new Promise(resolve=>setTimeout(resolve,500));
}
if(total!==expectedTotal||total===0)throw new Error('Report has missing rows or unexpected empty data');
console.log(JSON.stringify({clientApi:'ok',date,total,pages,batchId:batch}));
