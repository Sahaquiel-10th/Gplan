import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import sharp from "sharp";
import type {Database,User} from "./types.js";
import type {Store} from "./db.js";
import {invoiceAgent,invoiceAccess,invoiceAttachment,invoiceCents,normalizeInvoiceRow,publicInvoiceJob,safeInvoicePath,invoiceUsesAttachment} from "./invoicePolicy.js";
import {InvoiceService,invoiceStats} from "./invoices.js";
import {runInvoiceWorker} from "./invoiceFiles.js";
import {buildInvoiceWorkbook,invoiceHeaders} from "./invoiceWorkbook.js";

const at=new Date().toISOString();
async function fixture(n=2){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"gplan-invoices-test-"));
  const admin:User={id:"admin",companyId:"co",username:"admin",role:"admin",enabled:true,passwordHash:"",createdAt:at},user:User={...admin,id:"operator",role:"user"},peer:User={...user,id:"peer"};
  const db={users:[admin,user,peer],agents:[],models:[{id:"m",name:"fixture",provider:"fixture",kind:"chat",protocol:"openai",baseUrl:"http://fixture.invalid",apiKey:"fixture-key",enabled:true,isDefault:true,model:"fixture",systemPrompt:"",createdAt:at}],settings:{safetyRules:""},attachments:[],invoiceJobs:[],modelUsageRecords:[]} as unknown as Database;
  const agent=invoiceAgent(db,"co")!;
  for(let i=0;i<n;i++){const p=path.join(dir,`source-${i}.xml`);await fs.writeFile(p,`<Invoice>Source ${i}</Invoice>`);db.attachments.push({id:`a${i}`,companyId:"co",userId:user.id,invoiceUpload:true,originalName:`文件夹/发票${i}.xml`,mimeType:"application/xml",kind:"document",size:32,storagePath:p,extractedText:"",createdAt:at});}
  const store={read:async()=>db,mutate:async(fn:(db:Database)=>unknown)=>fn(db)} as Store;
  return {dir,db,store,user,peer,admin,agent};
}
const payload=(number="00123456789012345678",extra:Record<string,unknown>={})=>({seller:"测试销货方",buyer:"测试购买方",date:"2026-11-09",number,code:"",net:"100.00",tax:"6.00",total:"106.00",currency:"CNY",remark:"",...extra});
const worker=(async(file:string)=>({units:[{page:1,text:path.basename(file)}]})) as typeof runInvoiceWorker;
async function terminal(f:Awaited<ReturnType<typeof fixture>>,id:string){const end=Date.now()+6000;while(Date.now()<end){const j=f.db.invoiceJobs!.find(j=>j.id===id)!;if(!["queued","processing"].includes(j.status))return structuredClone(j);await new Promise(r=>setTimeout(r,5));}throw Error("invoice job timeout");}

test("invoice amounts preserve cents, red credits, zero and unknown; invoice numbers never become floats",()=>{
  assert.equal(invoiceCents("0.10"),10);assert.equal(invoiceCents("￥1,234.56"),123456);assert.equal(invoiceCents("-10.01"),-1001);assert.equal(invoiceCents("0"),0);assert.equal(invoiceCents("***"),null);assert.equal(invoiceCents("1.234"),null);
  const r=normalizeInvoiceRow(payload("00123456789012345678"));assert.equal(r.number,"00123456789012345678");assert.equal(r.tax,600);assert.deepEqual(r.warnings,[]);
  assert.ok(normalizeInvoiceRow(payload("8",{tax:null,total:"107.00"})).warnings.some(w=>w.includes("税额")));
  assert.equal(normalizeInvoiceRow(payload("8",{number:26332000003747093511})).number,"");
  assert.ok(normalizeInvoiceRow(payload("8",{total:"107.00"})).warnings.some(w=>w.includes("不等于")));
  assert.ok(normalizeInvoiceRow(payload("8",{currency:"USD"})).warnings.some(w=>w.includes("未折算")));
});
test("ordinary members own jobs and originals; even company administrators cannot read another member's invoices",async()=>{
  const f=await fixture(1);try{let calls=0;const service=new InvoiceService(f.store,f.dir,{worker,model:async()=>{calls++;return {content:JSON.stringify({invoices:[payload()]})};}});const j=await service.create(f.user,["a0"],"ownership-request");await terminal(f,j.id);assert.throws(()=>invoiceAccess(f.db,f.peer,j.id),/无权/);assert.throws(()=>invoiceAccess(f.db,f.admin,j.id),/无权/);assert.throws(()=>invoiceAttachment(f.db,f.admin,"a0"),/无权/);assert.equal((await service.list(f.peer)).length,0);assert.equal(invoiceUsesAttachment(f.db,"a0"),true);f.agent.published=false;await assert.rejects(service.get(f.user,j.id),/无权/);assert.equal(calls,1);}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test("independent files persist partial results; retry and duplicate creation never repeat completed paid work",async()=>{
 const f=await fixture(3);try{let calls=0,fail=true;const service=new InvoiceService(f.store,f.dir,{worker,model:async(_m,messages)=>{calls++;const body=messages.at(-1)!.content;if(body.includes("source-1")&&fail)throw Error("fixture failure");return {content:JSON.stringify({invoices:[payload(body.includes("source-0")?"00000001":body.includes("source-1")?"00000002":"00000003")]})};}});const j=await service.create(f.user,["a0","a1","a2"],"partial-request");const done=await terminal(f,j.id);assert.equal(done.status,"partial");assert.equal(invoiceStats(done).invoices,2);assert.equal(calls,3);await service.create(f.user,["a0","a1","a2"],"partial-request");assert.equal(calls,3);fail=false;await service.retry(f.user,j.id,"only-retry-one");const retried=await terminal(f,j.id);assert.equal(retried.status,"completed");assert.equal(invoiceStats(retried).invoices,3);assert.equal(calls,4);await service.retry(f.user,j.id,"only-retry-one");assert.equal(calls,4);assert.equal(retried.items[0].units[0].attempts,1);assert.equal(retried.items[1].units[0].attempts,2);assert.equal(publicInvoiceJob(retried).items[0].units[0].hasOwnProperty("text"),false);}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test("byte duplicates skip the model; different files with the same invoice identity do not double count",async()=>{
 const f=await fixture(3);try{await fs.copyFile(f.db.attachments[0].storagePath,f.db.attachments[2].storagePath);let calls=0;const service=new InvoiceService(f.store,f.dir,{worker,model:async()=>{calls++;return {content:JSON.stringify({invoices:[payload()]})};}});const j=await service.create(f.user,["a0","a1","a2"],"deduplicate-request");const done=await terminal(f,j.id);assert.equal(calls,2);assert.equal(invoiceStats(done).invoices,1);assert.equal(invoiceStats(done).duplicates,2);assert.equal(done.items[2].status,"duplicate");}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test("the exported workbook keeps the exact eight-column template, text identifiers, styles and formulas",async()=>{
 const f=await fixture(1);try{const service=new InvoiceService(f.store,f.dir,{worker,model:async()=>({content:JSON.stringify({invoices:[payload("00123456789012345678",{seller:'=HYPERLINK("https://invalid")'})]})})});const j=await terminal(f,(await service.create(f.user,["a0"],"workbook-request")).id);const bytes=await buildInvoiceWorkbook(j);const wb=XLSX.read(bytes,{type:"buffer",cellFormula:true,cellStyles:true});assert.deepEqual(wb.SheetNames,["发票明细"]);const s=wb.Sheets["发票明细"];assert.deepEqual(Array.from({length:8},(_,i)=>s[`${String.fromCharCode(65+i)}5`].v),invoiceHeaders);assert.equal(s.D6.t,"s");assert.equal(s.D6.v,"00123456789012345678");assert.equal(s.B6.t,"s");assert.equal(s.B6.f,undefined);assert.equal(s.E6.v,100);assert.equal(s.G7.v,106);assert.match(s.G7.f,/SUM\(G6:G6\)/);assert.equal(s.E3.v,1);const z=await JSZip.loadAsync(bytes),template=await JSZip.loadAsync(await fs.readFile(new URL("./assets/invoice-summary-template.xlsx",import.meta.url)));assert.equal(await z.file("xl/styles.xml")!.async("string"),await template.file("xl/styles.xml")!.async("string"));const xml=await z.file("xl/worksheets/sheet1.xml")!.async("string");assert.match(xml,/ySplit="5"/);assert.match(xml,/width="45"/);assert.ok(!(await z.file("xl/sharedStrings.xml")!.async("string")).includes("杭州"));await fs.mkdir("output/invoice-test",{recursive:true});await fs.writeFile("output/invoice-test/export.xlsx",bytes);}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test("failed files stay visible in the same-format export and incomplete grand totals stay blank",async()=>{
 const f=await fixture(2);try{const service=new InvoiceService(f.store,f.dir,{worker,model:async(_m,msg)=>{if(msg.at(-1)!.content.includes("source-1"))throw Error("cannot read");return {content:JSON.stringify({invoices:[payload()]})};}});const job=await terminal(f,(await service.create(f.user,["a0","a1"],"incomplete-request")).id);const w=XLSX.read(await buildInvoiceWorkbook(job),{type:"buffer"}).Sheets["发票明细"];assert.equal(w.E3.v,1);assert.match(w.H7.v,/未识别/);assert.ok(w.G3.v===""||w.G3.v===undefined);assert.match(w.H8.v,/总额留空/);}finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test("real archive engine handles Chinese paths, nested containers and rejects traversal without touching the host filesystem",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"gplan-archive-"));try{const z=new JSZip();z.file("发票目录/票据.xml","<Invoice>test</Invoice>");const file=path.join(dir,"bills.zip");await fs.writeFile(file,await z.generateAsync({type:"nodebuffer"}));const r=await runInvoiceWorker<{files:{name:string;path:string}[]}>(file,path.join(dir,"out"),"archive");assert.equal(r.files[0].name,"发票目录/票据.xml");assert.match(await fs.readFile(r.files[0].path,"utf8"),/Invoice/);for(const name of ["../secret","/tmp/secret","C:/secret","a/../../b"]){assert.throws(()=>safeInvoicePath(name));}const bad=new JSZip();bad.file("../outside.txt","bad");await fs.writeFile(file,await bad.generateAsync({type:"nodebuffer"}));await assert.rejects(runInvoiceWorker(file,path.join(dir,"bad"),"archive"),/不安全/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test("OFD and XML text plus multi-frame images are actually read outside the web process",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"gplan-formats-"));try{const z=new JSZip();z.file("Doc_0/Pages/Page_0/Content.xml",'<ofd:Page xmlns:ofd="x"><ofd:TextCode>发票号码 00123456789012345678</ofd:TextCode></ofd:Page>');const ofd=path.join(dir,"bill.ofd");await fs.writeFile(ofd,await z.generateAsync({type:"nodebuffer"}));const r=await runInvoiceWorker<{units:{text:string}[]}>(ofd,path.join(dir,"ofd"),"document");assert.match(r.units[0].text,/00123456789012345678/);const file=path.join(dir,"invoice.png");await sharp({create:{width:30,height:50,channels:3,background:"white"}}).png().toFile(file);const image=await runInvoiceWorker<{units:{imagePath:string}[]}>(file,path.join(dir,"png"),"document");assert.ok((await fs.stat(image.units[0].imagePath)).size>0);const xml=path.join(dir,"invoice.xml");await fs.writeFile(xml,'<!DOCTYPE x [<!ENTITY ext SYSTEM "file:///etc/passwd">]><x>&ext;</x>');await assert.rejects(runInvoiceWorker(xml,path.join(dir,"xml"),"document"),/外部实体/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});

test("restart preserves completed pages and interrupts only the paid in-flight page until explicit retry",async()=>{
 const f=await fixture(1);try{
  const at=new Date().toISOString(),done=normalizeInvoiceRow(payload("001"));
  f.db.invoiceJobs!.push({id:"restart-job",companyId:"co",userId:f.user.id,agentId:f.agent.id,requestKey:"restart-original",name:"restart",status:"processing",sourceIds:["a0"],items:[{id:"item",attachmentId:"a0",filename:"test.xml",status:"processing",error:"",units:[{id:"done",page:1,text:"",status:"completed",rows:[done],error:"",attempts:1},{id:"paid",page:2,text:"page2",status:"processing",rows:[],error:"",attempts:1},{id:"pending",page:3,text:"page3",status:"pending",rows:[],error:"",attempts:0}]}],revision:1,retryKeys:[],createdAt:at,updatedAt:at});
  let calls=0;const service=new InvoiceService(f.store,f.dir,{worker,model:async()=>{calls++;return {content:JSON.stringify({invoices:[payload(String(calls+1))]})};}});
  await service.recover();await service.tick();let job=await terminal(f,"restart-job");assert.equal(calls,1);assert.equal(job.status,"partial");assert.equal(job.items[0].units[0].rows[0].id,done.id);assert.equal(job.items[0].units[1].status,"interrupted");await service.retry(f.user,job.id,"restart-manual-retry");job=await terminal(f,job.id);assert.equal(calls,2);assert.equal(job.status,"completed");assert.equal(job.items[0].units[0].attempts,1);
 }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test("manual correction rejects invalid amounts and stale writes; model output cannot cross revoked access",async()=>{
 const f=await fixture(1);try{const service=new InvoiceService(f.store,f.dir,{worker,model:async()=>({content:JSON.stringify({invoices:[payload()]})})});const job=await terminal(f,(await service.create(f.user,["a0"],"correction-request")).id);const row=job.items[0].units[0].rows[0];await assert.rejects(service.edit(f.user,job.id,row.id,{tax:"abc"},job.revision),/金额/);await assert.rejects(service.edit(f.user,job.id,row.id,{tax:"8.00"},0),/更新/);await assert.rejects(service.create(f.user,Array.from({length:501},(_,i)=>String(i)),"oversized-request"),/500/);
 }finally{await fs.rm(f.dir,{recursive:true,force:true});}
 const f2=await fixture(1);try{const service=new InvoiceService(f2.store,f2.dir,{worker,model:async()=>{f2.agent.published=false;return {content:JSON.stringify({invoices:[payload()]})};}});const job=await terminal(f2,(await service.create(f2.user,["a0"],"revoked-request")).id);assert.equal(invoiceStats(job).invoices,0);assert.equal(job.status,"failed");}finally{await fs.rm(f2.dir,{recursive:true,force:true});}
});
