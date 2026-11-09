import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import sharp from "sharp";
import {signToken} from "./security.js";

test("HTTP batch uploads expand archives, pass actual image data, persist private results and export the exact template",async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),dir=await fs.mkdtemp(path.join(os.tmpdir(),"gplan-invoice-http-"));let calls=0,imageCalls=0;
 const upstream=http.createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const body=JSON.parse(Buffer.concat(chunks).toString());calls++;if(body.messages.some((m:{content:unknown})=>Array.isArray(m.content)&&m.content.some((x:{type:string;image_url?:{url:string}})=>x.type==="image_url"&&x.image_url?.url.startsWith("data:image/png;base64,"))))imageCalls++;res.setHeader("Content-Type","application/json");res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({invoices:[{seller:"HTTP测试销货方",buyer:"HTTP测试购买方",date:"2026-11-09",number:"00123456789012345678",code:"",net:"100.00",tax:"6.00",total:"106.00",currency:"CNY",remark:""}]})}}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));});
 await new Promise<void>(r=>upstream.listen(0,"127.0.0.1",r));
 const port=await new Promise<number>(r=>{const server=net.createServer();server.listen(0,"127.0.0.1",()=>{const p=(server.address() as net.AddressInfo).port;server.close(()=>r(p));});});
 const at=new Date().toISOString(),users=[{id:"admin",role:"admin"},{id:"operator",role:"user"},{id:"peer",role:"user"}].map(u=>({...u,companyId:"co",username:u.id,enabled:true,passwordHash:"",createdAt:at}));
 await fs.cp(path.join(root,"server"),path.join(dir,"server"),{recursive:true});await fs.cp(path.join(root,"shared"),path.join(dir,"shared"),{recursive:true});await fs.symlink(path.join(root,"node_modules"),path.join(dir,"node_modules"));await fs.symlink(path.join(root,"dist"),path.join(dir,"dist"));await fs.writeFile(path.join(dir,"package.json"),'{"type":"module"}');await fs.mkdir(path.join(dir,"data"));
 await fs.writeFile(path.join(dir,"data/db.json"),JSON.stringify({users,models:[{id:"fixture",kind:"chat",protocol:"openai",name:"fixture",provider:"fixture",model:"fixture",enabled:true,isDefault:true,baseUrl:`http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`,apiKey:"fixture",systemPrompt:"",createdAt:at}],agents:[],conversations:[],messages:[],workspaces:[],integrationTokens:[],attachments:[],settings:{safetyRules:""}}));
 const secret="invoice-http-fixture-secret";let logs="";
 const child=spawn(process.execPath,[path.join(root,"node_modules/tsx/dist/cli.mjs"),path.join(dir,"server/index.ts")],{cwd:dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:"test",PORT:String(port),JWT_SECRET:secret,DB_PROVIDER:"json",DATA_DB_PROVIDER:"disabled",WANLINIU_SYNC_ENABLED:"false",KNOWLEDGE_SYNC_ENABLED:"false",MEMORY_SCAN_INTERVAL_MINUTES:"9999"}});child.stdout.on("data",b=>logs+=b);child.stderr.on("data",b=>logs+=b);
 const request=(url:string,method="GET",body?:unknown,user="operator")=>fetch(`http://127.0.0.1:${port}/api${url}`,{method,headers:{Authorization:`Bearer ${signToken({sub:user,role:"user"},secret)}`,...(body instanceof FormData?{}:{"Content-Type":"application/json"})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.equal(ready,true,logs);
  const conf=await(await request("/invoices/config")).json();assert.equal(conf.limits.files,500);assert.equal(conf.visionReady,true);
  const z=new JSZip();z.file("票据/纸票.png",await sharp({create:{width:200,height:300,channels:3,background:"white"}}).png().toBuffer());z.file("票据/电子票.xml","<Invoice><InvoiceNumber>00123456789012345678</InvoiceNumber><Total>106.00</Total></Invoice>");const form=new FormData();form.append("files",new Blob([new Uint8Array(await z.generateAsync({type:"nodebuffer"}))]),"发票资料.zip");
  const uploaded=await request("/invoices/uploads","POST",form);assert.equal(uploaded.status,200);const files=(await uploaded.json()).files;assert.equal(files.length,1);
  const created=await request("/invoices/jobs","POST",{fileIds:[files[0].id],requestKey:"http-invoice-key"});assert.equal(created.status,202);const id=(await created.json()).job.id;
  let job:any;for(let i=0;i<200;i++){job=(await(await request(`/invoices/jobs/${id}`)).json()).job;if(!["queued","processing"].includes(job.status))break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(job.status,"completed",JSON.stringify(job));assert.equal(calls,2);assert.equal(imageCalls,1);assert.equal(job.items[0].status,"expanded");assert.equal(job.items.length,3);assert.equal(job.companyId,undefined);assert.equal(job.items[1].units[0].imagePath,undefined);assert.equal(job.items[1].units[0].text,undefined);
  const duplicate=await request("/invoices/jobs","POST",{fileIds:[files[0].id],requestKey:"http-invoice-key"});assert.equal((await duplicate.json()).job.id,id);assert.equal(calls,2);
  for(const user of ["peer","admin"]){assert.notEqual((await request(`/invoices/jobs/${id}`,"GET",undefined,user)).status,200);assert.notEqual((await request(`/invoices/jobs/${id}/download`,"GET",undefined,user)).status,200);assert.equal((await request(`/attachments/${files[0].id}/content`,"GET",undefined,user)).status,404);assert.equal((await(await request("/invoices/jobs","GET",undefined,user)).json()).jobs.length,0);}
  assert.notEqual((await request(`/attachments/${files[0].id}`,"DELETE")).status,200);
  const exported=await request(`/invoices/jobs/${id}/download`);assert.equal(exported.status,200);assert.match(exported.headers.get("content-type")!,/spreadsheetml/);const wb=XLSX.read(Buffer.from(await exported.arrayBuffer()),{type:"buffer"});assert.deepEqual(wb.SheetNames,["发票明细"]);assert.equal(wb.Sheets["发票明细"].D6.v,"00123456789012345678");assert.equal(wb.Sheets["发票明细"].E3.v,1);
  const row=job.items.flatMap((i:any)=>i.units.flatMap((u:any)=>u.rows)).find((r:any)=>!r.duplicateOf);
  const edit=await request(`/invoices/jobs/${id}/rows/${row.id}`,"PATCH",{row:{remark:"人工核对通过"},expectedRevision:job.revision});assert.equal(edit.status,200);const readback=(await(await request(`/invoices/jobs/${id}`)).json()).job;assert.ok(readback.items.some((i:any)=>i.units.some((u:any)=>u.rows.some((r:any)=>r.remark==="人工核对通过"))));
  const saved=JSON.parse(await fs.readFile(path.join(dir,"data/db.json"),"utf8"));assert.equal(saved.invoiceJobs.length,1);assert.ok(saved.attachments.every((a:any)=>a.invoiceUpload));
 }finally{child.kill("SIGTERM");await new Promise(r=>setTimeout(r,100));child.kill("SIGKILL");await new Promise<void>(r=>upstream.close(()=>r()));await fs.rm(dir,{recursive:true,force:true});}
});
