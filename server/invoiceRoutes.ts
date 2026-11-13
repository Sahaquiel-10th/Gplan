import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import type { Store } from "./db.js";
import type { Attachment } from "./types.js";
import { asyncRoute, auth } from "./middleware.js";
import { uid } from "./security.js";
import { normalizeUploadFilename } from "./uploadFilename.js";
import { invoiceAccess, invoiceAgent, invoiceAttachment, invoiceUsesAttachment, publicInvoiceJob, safeInvoicePath } from "./invoicePolicy.js";
import { invoiceExtensions, invoiceLimits } from "./invoiceTypes.js";
import { InvoiceService, invoiceStats } from "./invoices.js";
import { buildInvoiceWorkbook } from "./invoiceWorkbook.js";
import { isInvoiceAuxiliaryPath } from "../shared/invoiceFilePolicy.mjs";

export function createInvoiceRouter(store:Store,secret:string,uploadDir:string){
  const router=express.Router();const service=new InvoiceService(store,uploadDir);const ready=service.recover();
  void ready.then(()=>service.tick()).catch(e=>console.error("发票任务恢复失败",e instanceof Error?e.message:"unknown"));
  const timer=setInterval(()=>{void service.tick().catch(()=>undefined);},5000);timer.unref();
  router.use("/invoices",auth(secret),(_req,_res,next)=>{void ready.then(()=>next(),next);});
  router.get("/invoices/config",asyncRoute(async(req,res)=>{
    await store.mutate(db=>invoiceAgent(db,req.user!.companyId));const db=await store.read();const {agent}=invoiceAccess(db,req.user!);
    const textReady=db.models.some(m=>m.enabled&&m.apiKey&&m.kind==="chat"),visionReady=db.models.some(m=>m.enabled&&m.apiKey&&m.kind==="chat"&&m.protocol==="openai");
    res.json({agentId:agent.id,ready:textReady,visionReady,limits:invoiceLimits,extensions:invoiceExtensions,message:!textReady?"请管理员配置可用的识别模型":!visionReady?"图片和扫描件识别需要配置支持图片理解的模型":""});
  }));
  const storage=multer.diskStorage({destination:(_req,_file,callback)=>{fs.mkdir(uploadDir,{recursive:true}).then(()=>callback(null,uploadDir),error=>callback(error,uploadDir));},filename:(_req,file,callback)=>{const ext=path.extname(file.originalname).replace(/[^.a-z0-9]/ig,"").slice(0,16);callback(null,`${uid("att")}${ext||".bin"}`);}});
  const uploader=multer({storage,preservePath:true,limits:{fileSize:invoiceLimits.uploadBytes,files:20,fields:0},fileFilter:(_req,file,callback)=>{
    try {
      const filename = safeInvoicePath(normalizeUploadFilename(file.originalname));
      callback(null, !isInvoiceAuxiliaryPath(filename));
    } catch(error) {
      callback(error as Error);
    }
  }}).array("files",20);
  const uploading=new Set<string>();
  router.post("/invoices/uploads",asyncRoute(async(req,res)=>{
    const user=req.user!;const db=await store.read();invoiceAccess(db,user);if(uploading.has(user.id))return res.status(429).json({error:"文件仍在上传，请稍后继续"});
    const pending=db.attachments.filter(a=>a.invoiceUpload&&a.userId===user.id&&a.companyId===user.companyId&&!invoiceUsesAttachment(db,a.id)&&Date.now()-Date.parse(a.createdAt)<86400000);
    if(pending.length>=500||pending.reduce((n,a)=>n+a.size,0)>=invoiceLimits.totalBytes)throw Error("待提交的上传已达到500个或500MB，请先开始处理");
    uploading.add(user.id);
    try{
      await new Promise<void>((resolve,reject)=>uploader(req,res,error=>error?reject(error):resolve()));
      const files=req.files as Express.Multer.File[];
      if(!files?.length)throw Error("没有找到发票文件，文件夹附带的系统文件会自动忽略");
      if(pending.length+files.length>500||pending.reduce((n,a)=>n+a.size,0)+files.reduce((n,f)=>n+f.size,0)>invoiceLimits.totalBytes)throw Error("待提交文件合计超过500个或500MB，请分批处理");
      const attachments:Attachment[]=files.map(file=>({id:path.basename(file.filename,path.extname(file.filename)),companyId:user.companyId,userId:user.id,invoiceUpload:true,originalName:safeInvoicePath(normalizeUploadFilename(file.originalname)),mimeType:file.originalname.toLowerCase().endsWith(".pdf")?"application/pdf":/\.(?:png|jpe?g|webp)$/i.test(file.originalname)?file.mimetype:"application/octet-stream",kind:/\.(?:png|jpe?g|webp)$/i.test(file.originalname)?"image":"document",size:file.size,storagePath:file.path,extractedText:"",createdAt:new Date().toISOString()}));
      await store.mutate(d=>{invoiceAccess(d,user);d.attachments.push(...attachments);});
      res.json({files:attachments.map(a=>({id:a.id,name:a.originalName,size:a.size}))});
    }catch(error){const files=(req.files||[]) as Express.Multer.File[];await Promise.all(files.map(f=>fs.rm(f.path,{force:true}).catch(()=>undefined)));if(error instanceof multer.MulterError)throw Error(error.code==="LIMIT_FILE_SIZE"?"单个文件不能超过100MB":"一次上传最多20个文件，请由页面自动分批上传");throw error;}
    finally{uploading.delete(user.id);}
  }));
  router.get("/invoices/jobs",asyncRoute(async(req,res)=>{const jobs=await service.list(req.user!,typeof req.query.before==="string"?req.query.before:undefined);res.json({jobs,nextCursor:jobs.length===100?jobs.at(-1)!.id:null});}));
  router.post("/invoices/jobs",asyncRoute(async(req,res)=>{const job=await service.create(req.user!,req.body.fileIds,req.body.requestKey);res.status(202).json({job:publicInvoiceJob(job)});}));
  router.get("/invoices/jobs/:id",asyncRoute(async(req,res)=>{const job=await service.get(req.user!,String(req.params.id));res.json({job:publicInvoiceJob(job),stats:invoiceStats(job)});}));
  router.post("/invoices/jobs/:id/retry",asyncRoute(async(req,res)=>{res.status(202).json({job:publicInvoiceJob(await service.retry(req.user!,String(req.params.id),req.body.requestKey,typeof req.body.itemId==="string"?req.body.itemId:undefined))});}));
  router.patch("/invoices/jobs/:id/rows/:rowId",asyncRoute(async(req,res)=>{res.json({job:publicInvoiceJob(await service.edit(req.user!,String(req.params.id),String(req.params.rowId),req.body.row,req.body.expectedRevision))});}));
  router.get("/invoices/jobs/:id/download",asyncRoute(async(req,res)=>{
    const job=await service.get(req.user!,String(req.params.id));if(["queued","processing"].includes(job.status))throw Error("本批还在处理中，请等处理结束后下载");
    const buffer=await buildInvoiceWorkbook(job);await service.get(req.user!,job.id);
    res.setHeader("Cache-Control","no-store");res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(`发票汇总_${job.createdAt.slice(0,10)}_${job.id.slice(-6)}.xlsx`)}`);res.send(buffer);
  }));
  return router;
}
