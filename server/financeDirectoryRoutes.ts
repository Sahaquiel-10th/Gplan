import {Router,type Request,type Response} from 'express';
import {FinanceError,type AccountStore} from './alipayAccounts.js';
import {FinanceDirectoryService,DirectoryValidationError} from './financeDirectory.js';
import {financeCsvHeaders} from '../shared/financeCatalog.js';

export function createFinanceDirectoryRouter(store:AccountStore,env=process.env){
  const router=Router(),service=new FinanceDirectoryService(store,env);
  router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');if(!['GET','HEAD'].includes(req.method)){const origin=req.get('origin'),expected=env.APP_ORIGIN?.trim()||`${req.protocol}://${req.get('host')}`;if((origin&&origin!==expected)||req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'请求来源无效'});}next();});
  const route=(fn:(req:Request,res:Response)=>Promise<unknown>)=>async(req:Request,res:Response)=>{try{if(!req.user)return res.status(401).json({error:'未登录'});await fn(req,res);}catch(e){if(e instanceof FinanceError)return res.status(e.status).json({error:e.message,...(e instanceof DirectoryValidationError?{fields:e.fields}:{})});res.status(503).json({error:'账户清单操作失败，请稍后重试'});}};
  router.get('/',route(async(req,res)=>res.json(await service.state(req.user!))));
  router.get('/template.csv',route(async(req,res)=>{await service.state(req.user!);res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="finance-accounts-template.csv"');res.setHeader('X-Content-Type-Options','nosniff');res.send('\uFEFF'+financeCsvHeaders.join(',')+'\r\n');}));
  router.post('/accounts',route(async(req,res)=>res.status(201).json({account:await service.save(req.user!,req.body)})));
  router.put('/accounts/:id',route(async(req,res)=>{const{revision,...input}=req.body||{};res.json({account:await service.save(req.user!,input,String(req.params.id),revision)});}));
  router.delete('/accounts/:id',route(async(req,res)=>res.json(await service.remove(req.user!,String(req.params.id),req.body||{}))));
  router.post('/imports/preview',route(async(req,res)=>res.json(await service.preview(req.user!,req.body?.csv))));
  router.post('/imports/commit',route(async(req,res)=>res.json(await service.commit(req.user!,req.body?.csv,req.body?.digest))));
  router.use((_req,res)=>res.status(404).json({error:'资金账户清单接口不存在'}));return router;
}
