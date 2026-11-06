import {createHash} from 'node:crypto';
import {parse} from 'csv-parse/sync';
import {financeSources,financeCsvHeaders,type FinanceDraftInput,type FinanceImportPreview,type FinanceImportRow,type FinanceAccountView} from '../shared/financeCatalog.js';
import {AlipayAccountService,FinanceError,type AccountStore} from './alipayAccounts.js';
import {uid} from './security.js';
import type {Database,User} from './types.js';

export type FinanceEntity = {id:string;companyId:string;name:string;createdAt:string};
export type FinanceAccountDraft = Omit<FinanceAccountView,'legalEntity'|'credentialStatus'|'checkStatus'|'syncStatus'|'linkedAlipayId'|'linkedAlipayRevision'> & {companyId:string;deletedAt?:string};
export type FinanceDirectoryAudit = {at:string;companyId:string;userId:string;action:'add'|'edit'|'import'|'delete';created:number;accountId?:string};
export class DirectoryValidationError extends FinanceError {
  constructor(message:string,public fields:Record<string,string>={}){super(message);}
}
export const directoryLimits={csvBytes:256*1024,rows:500,accounts:1000};
const key=(v:string)=>v.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
const sourceNames=new Map<string,string>(financeSources.flatMap(s=>[[key(s.name),s.id],[s.id,s.id]]));
sourceNames.set('企业支付宝-余利宝','alipay_yulibao');
const columns=['legalEntity','sourceId','name','last4','currency','note'] as const;
function text(value:unknown,label:string,max:number,required=true){
  if(typeof value!=='string'||value.length>max*2)throw new Error(`${label}${required?'需填写有效内容':'格式不正确'}`);
  const v=value.normalize('NFKC').trim();
  if((required&&!v)||v.length>max||/[\x00-\x1f\x7f]/.test(v))throw new Error(`${label}${required?'需填写1至'+max+'个字符':'最多'+max+'个字符'}`);
  if(/^\s*[=+@-]/.test(v)||/-----BEGIN|private[_ -]?key|app[_ -]?secret\s*[:=]|密码\s*[:：=]|验证码\s*[:：=]/i.test(v))throw new Error(`${label}不能包含公式、密钥或口令`);
  return v;
}
export function normalizeFinanceDraft(input:unknown):FinanceDraftInput{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new DirectoryValidationError('请填写账户资料');
  const obj=input as Record<string,unknown>,fields:Record<string,string>={},out:Record<string,string>={};
  if(Object.keys(obj).some(k=>!columns.includes(k as any)))throw new DirectoryValidationError('账户清单不接受密钥、完整账号或其他未支持字段');
  const definitions=[['legalEntity','公司名称',100,true],['sourceId','银行/来源',60,true],['name','账户名称',60,true],['last4','账号尾号',4,false],['currency','币种',3,true],['note','备注',200,false]] as const;
  for(const[field,label,max,required]of definitions){try{out[field]=text(obj[field]??(field==='currency'?'CNY':''),label,max,required);}catch(e){fields[field]=(e as Error).message;}}
  if(!fields.sourceId){const id=sourceNames.get(key(out.sourceId));if(!id)fields.sourceId='请选择清单中的银行/来源';else out.sourceId=id;}
  if(!fields.last4&&out.last4&&!/^\d{4}$/.test(out.last4))fields.last4='账号尾号请填4位数字，或暂时留空；不要填写完整账号';
  if(!fields.currency){out.currency=out.currency.toUpperCase();if(!Intl.supportedValuesOf('currency').includes(out.currency))fields.currency='请填写有效的三位币种代码，例如CNY';}
  if(Object.keys(fields).length)throw new DirectoryValidationError('账户资料需修正',fields);
  return out as FinanceDraftInput;
}
function assertAdmin(db:Database,user:User){if(!db.users.some(u=>u.id===user.id&&u.companyId===user.companyId&&u.enabled&&u.role==='admin'))throw new FinanceError('无权访问资金账户清单',403);}
function accountKey(v:Pick<FinanceDraftInput,'legalEntity'|'sourceId'|'name'|'currency'>){return JSON.stringify([key(v.legalEntity),v.sourceId,key(v.name),v.currency]);}
function views(db:Database,user:User):FinanceAccountView[]{
  const entities=new Map((db.financeEntities||[]).filter(e=>e.companyId===user.companyId).map(e=>[e.id,e.name]));
  return(db.financeAccountDrafts||[]).filter(a=>a.companyId===user.companyId&&!a.deletedAt).map(({companyId,...a})=>{
    const linked=(db.alipayAccounts||[]).find(p=>p.companyId===user.companyId&&p.financeAccountId===a.id&&!p.deletedAt);
    const statuses=linked?Object.values(linked.capabilities).map(c=>c.status):[];
    const checkStatus=statuses.every(s=>s==='available')&&statuses.length?'available':statuses.some(s=>s==='failed')?'failed':statuses.some(s=>s==='available'||s==='no_bill')?'partial':'not_tested';
    return{...a,legalEntity:entities.get(a.legalEntityId)||'主体记录缺失',credentialStatus:linked?(linked.configured?'configured':'incomplete'):'not_configured',checkStatus,syncStatus:'not_enabled',...(linked?{linkedAlipayId:linked.id,linkedAlipayRevision:linked.revision}:{})} as FinanceAccountView;
  });
}
function parseRows(csv:unknown):{rowNumber:number;input:Record<string,string>}[]{
  if(typeof csv!=='string'||Buffer.byteLength(csv,'utf8')>directoryLimits.csvBytes)throw new FinanceError('请上传不超过256KB的UTF-8 CSV文件');
  let records:{record:string[];info:{lines:number}}[];
  try{records=parse(csv,{bom:true,skip_empty_lines:true,max_record_size:4000,info:true}) as unknown as typeof records;}catch{throw new FinanceError('CSV格式无法读取，请使用模板并另存为CSV UTF-8（逗号分隔）');}
  const header=records[0]?.record.map(v=>v.trim());
  if(!header||header.length!==financeCsvHeaders.length||new Set(header).size!==header.length||financeCsvHeaders.some(h=>!header.includes(h)))throw new FinanceError('表头须完整使用模板的6列；不能添加完整账号、私钥或密码列');
  const body=records.slice(1).filter(r=>r.record.some(v=>v.trim()));
  if(!body.length)throw new FinanceError('文件没有账户记录，请在表头下填写资料');
  if(body.length>directoryLimits.rows)throw new FinanceError('每次最多导入500行，请拆分文件');
  return body.map(r=>({rowNumber:r.info.lines,input:Object.fromEntries(columns.map((field,i)=>[field,r.record[header.indexOf(financeCsvHeaders[i])]]))}));
}
function prepare(db:Database,user:User,csv:unknown):FinanceImportPreview{
  const existing=views(db,user),byKey=new Map(existing.map(a=>[accountKey(a),a])),seen=new Set<string>();
  const rows:FinanceImportRow[]=parseRows(csv).map(({rowNumber,input})=>{
    try{
      const values=normalizeFinanceDraft(input),id=accountKey(values);
      if(seen.has(id))return{rowNumber,action:'error',errors:['文件内存在相同公司、来源、账户名称和币种的重复行']};seen.add(id);
      const old=byKey.get(id);
      if(old&&(['last4','note'] as const).some(f=>old[f]!==values[f]))return{rowNumber,action:'error',errors:['此账户已登记但资料不同，请在台账中编辑；批量导入不会覆盖已有资料']};
      return{rowNumber,values,action:old?'skip':'create',errors:[]};
    }catch(e){return{rowNumber,action:'error',errors:e instanceof DirectoryValidationError?Object.values(e.fields).length?Object.values(e.fields):[e.message]:['账户资料无法识别']};}
  });
  const creates=rows.filter(r=>r.action==='create').length,skips=rows.filter(r=>r.action==='skip').length;
  if(existing.length+creates>directoryLimits.accounts)throw new FinanceError('本企业账户清单最多1000个，请先核对重复账户');
  const digest=createHash('sha256').update(JSON.stringify(['finance-directory-v1',user.companyId,user.id,csv,rows,existing.map(a=>[a.id,a.revision]).sort()])).digest('hex');
  return{digest,rows,creates,skips,errors:rows.filter(r=>r.action==='error').length};
}
function append(db:Database,user:User,inputs:FinanceDraftInput[]){
  const entities=[...(db.financeEntities||[])],accounts=[...(db.financeAccountDrafts||[])],created:FinanceAccountDraft[]=[],at=new Date().toISOString();
  for(const input of inputs){let entity=entities.find(e=>e.companyId===user.companyId&&key(e.name)===key(input.legalEntity));if(!entity){entity={id:uid('fent'),companyId:user.companyId,name:input.legalEntity,createdAt:at};entities.push(entity);}
    const{legalEntity,...fields}=input;const a={...fields,id:uid('facc'),companyId:user.companyId,legalEntityId:entity.id,revision:1,createdAt:at,updatedAt:at};accounts.push(a);created.push(a);
  }
  // Assign only after all validation has completed: the app's JSON store is not transactional.
  db.financeEntities=entities;db.financeAccountDrafts=accounts;return created;
}
function audit(db:Database,user:User,action:FinanceDirectoryAudit['action'],created:number,accountId?:string){db.financeDirectoryAudit??=[];db.financeDirectoryAudit.push({at:new Date().toISOString(),companyId:user.companyId,userId:user.id,action,created,...(accountId?{accountId}:{})});if(db.financeDirectoryAudit.length>10000)db.financeDirectoryAudit.splice(0,db.financeDirectoryAudit.length-10000);}
export class FinanceDirectoryService{
  constructor(private store:AccountStore,private env=process.env){}
  async remove(user:User,id:string,input:{revision?:unknown;confirmName?:unknown;linkedAlipayRevision?:unknown}){
    return this.store.mutate(db=>{
      assertAdmin(db,user);const old=views(db,user).find(a=>a.id===id);if(!old)throw new FinanceError('账户不存在或已删除',404);
      if(old.revision!==input.revision||old.linkedAlipayRevision!==input.linkedAlipayRevision)throw new FinanceError('账户或凭证已更新，请刷新后重新确认删除',409);
      if(input.confirmName!==old.name)throw new FinanceError('请完整输入账户名称以确认删除');
      if(old.linkedAlipayId&&!new AlipayAccountService(this.store,this.env).canConfigure(db,user))throw new FinanceError('此账户已关联凭证，删除需在指定管理员的凭证维护窗口内进行',403);
      const at=new Date().toISOString();
      db.financeAccountDrafts=db.financeAccountDrafts!.map(a=>a.id===id&&a.companyId===user.companyId?{...a,deletedAt:at,updatedAt:at,revision:a.revision+1}:a);
      db.alipayAccounts=(db.alipayAccounts||[]).map(a=>a.id===old.linkedAlipayId&&a.companyId===user.companyId?{...a,deletedAt:at,updatedAt:at,revision:a.revision+1}:a);
      if(old.linkedAlipayId){db.financeAudit??=[];db.financeAudit.push({at,companyId:user.companyId,userId:user.id,accountId:old.linkedAlipayId,action:'delete'});if(db.financeAudit.length>10000)db.financeAudit.splice(0,db.financeAudit.length-10000);}
      audit(db,user,'delete',0,id);return{deleted:true,credentialsDisabled:!!old.linkedAlipayId};
    });
  }
  async state(user:User){const db=await this.store.read();assertAdmin(db,user);return{sources:financeSources,accounts:views(db,user),entities:(db.financeEntities||[]).filter(e=>e.companyId===user.companyId).map(({id,name})=>({id,name})),credentialConfigurationOpen:new AlipayAccountService(this.store,this.env).canConfigure(db,user)};}
  async preview(user:User,csv:unknown){const db=await this.store.read();assertAdmin(db,user);return prepare(db,user,csv);}
  async commit(user:User,csv:unknown,digest:unknown){return this.store.mutate(db=>{assertAdmin(db,user);const p=prepare(db,user,csv);if(typeof digest!=='string'||p.digest!==digest)throw new FinanceError('预览已变化，请重新预览后再确认',409);if(p.errors)throw new FinanceError('文件仍有错误，未写入任何账户');const created=append(db,user,p.rows.filter(r=>r.action==='create').map(r=>r.values!));audit(db,user,'import',created.length);return{created:created.length,skipped:p.skips};});}
  async save(user:User,input:unknown,id?:string,revision?:unknown){
    return this.store.mutate(db=>{
      assertAdmin(db,user);const normalized=normalizeFinanceDraft(input),list=views(db,user),old=id?list.find(a=>a.id===id):undefined;
      if(id&&!old)throw new FinanceError('账户不存在',404);
      if(old&&old.revision!==revision)throw new FinanceError('账户已更新，请刷新后再编辑',409);
      if(list.some(a=>a.id!==id&&accountKey(a)===accountKey(normalized)))throw new FinanceError('此公司、来源、账户名称和币种已登记',409);
      if(old?.linkedAlipayId&&(old.legalEntity!==normalized.legalEntity||old.name!==normalized.name||old.sourceId!==normalized.sourceId||old.currency!==normalized.currency))throw new FinanceError('已关联凭证的账户不能更换公司、来源、名称或币种，请另建账户');
      if(!old&&list.length>=directoryLimits.accounts)throw new FinanceError('本企业账户清单最多1000个');
      if(!old){const[a]=append(db,user,[normalized]);audit(db,user,'add',1,a.id);return views(db,user).find(v=>v.id===a.id)!;}
      const entities=[...(db.financeEntities||[])];let entity=entities.find(e=>e.companyId===user.companyId&&key(e.name)===key(normalized.legalEntity));if(!entity){entity={id:uid('fent'),companyId:user.companyId,name:normalized.legalEntity,createdAt:new Date().toISOString()};entities.push(entity);}
      const{legalEntity,...fields}=normalized;
      db.financeEntities=entities;db.financeAccountDrafts=db.financeAccountDrafts!.map(a=>a.id===id&&a.companyId===user.companyId?{...a,...fields,legalEntityId:entity.id,revision:a.revision+1,updatedAt:new Date().toISOString()}:a);audit(db,user,'edit',0,id);return views(db,user).find(a=>a.id===id)!;
    });
  }
}
