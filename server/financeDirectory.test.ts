import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {FinanceDirectoryService,normalizeFinanceDraft} from './financeDirectory.js';
import {createFinanceDirectoryRouter} from './financeDirectoryRoutes.js';
import {AlipayAccountService,type AccountStore} from './alipayAccounts.js';
import {financeSources,financeCsvHeaders} from '../shared/financeCatalog.js';
import type {Database,User} from './types.js';
const row={legalEntity:'测试公司A',sourceId:'alipay',name:'主账户',last4:'0012',currency:'CNY',note:''};
const csv=(lines:string[])=>'\uFEFF'+financeCsvHeaders.join(',')+'\r\n'+lines.join('\r\n');
function fixture(){const users=[{id:'a',companyId:'one',role:'admin',enabled:true},{id:'b',companyId:'two',role:'admin',enabled:true},{id:'member',companyId:'one',role:'user',enabled:true}] as User[],db={users} as Database;const store:AccountStore={read:async()=>db,mutate:async fn=>fn(db)};return{users,db,store,service:new FinanceDirectoryService(store)};}

test('12 sources; no-credential draft persisted, leading zeros, entity reuse and per-tenant identity',async()=>{
  assert.equal(financeSources.length,12);const f=fixture();const a=await f.service.save(f.users[0],row);await f.service.save(f.users[0],{...row,sourceId:'icbc'});assert.equal(f.db.financeEntities?.length,1);assert.equal(a.last4,'0012');assert.equal(a.credentialStatus,'not_configured');assert.equal(a.syncStatus,'not_enabled');assert.equal((await new FinanceDirectoryService(f.store).state(f.users[0])).accounts.length,2);assert.equal((await f.service.state(f.users[1])).accounts.length,0);await f.service.save(f.users[1],row);assert.equal(f.db.financeEntities?.length,2);await assert.rejects(f.service.save(f.users[0],row),/已登记/);
});
test('ordinary/disabled/stale admins and foreign account IDs cannot read or mutate',async()=>{
 const f=fixture(),a=await f.service.save(f.users[0],row);await assert.rejects(f.service.state(f.users[2]),/无权/);await assert.rejects(f.service.save(f.users[1],row,a.id,1),/不存在/);await assert.rejects(f.service.save(f.users[0],row,a.id,2),/已更新/);f.users[0].enabled=false;await assert.rejects(f.service.commit(f.users[0],csv(['测试公司A,企业支付宝,其他,1234,CNY,']),''),/无权/);
});
test('manual and imported data share validation; secrets/full numbers/formulas never accepted',async()=>{
 for(const bad of [{...row,last4:'123456789'},{...row,currency:'ZZZ'},{...row,sourceId:'unknown'},{...row,name:'＝HYPERLINK("bad")'},{...row,note:'-----BEGIN PRIVATE KEY-----'},{...row,privateKey:'secret'}])assert.throws(()=>normalizeFinanceDraft(bad));
 const f=fixture(),p=await f.service.preview(f.users[0],csv(['测试公司A,企业支付宝,主账户,0012,CNY,','测试公司A,企业支付宝,坏账户,123456789,CNY,']));assert.equal(p.errors,1);await assert.rejects(f.service.commit(f.users[0],csv(['测试公司A,企业支付宝,主账户,0012,CNY,','测试公司A,企业支付宝,坏账户,123456789,CNY,']),p.digest),/未写入/);assert.equal(f.db.financeAccountDrafts,undefined);assert.equal(f.db.financeEntities,undefined);assert.ok(!JSON.stringify(p).includes('123456789'));
 await assert.rejects(f.service.preview(f.users[0],'公司名称,银行/来源,账户名称,账号尾号,币种,私钥\n测试公司A,企业支付宝,主账户,0012,CNY,SECRET'),/表头/);
});
test('CSV preview and atomic confirmation; repeated import skips without overwriting',async()=>{
 const f=fixture(),file=csv(['测试公司A,企业支付宝,主账户,0012,CNY,"用于收款,不要填密码"','测试公司A,中国工商银行,工行一户,0100,CNY,']);const before=JSON.stringify(f.db),p=await f.service.preview(f.users[0],file);assert.equal(JSON.stringify(f.db),before);assert.equal(p.creates,2);assert.equal(p.errors,0);assert.equal(p.rows[0].values?.note,'用于收款,不要填密码');assert.deepEqual(await f.service.commit(f.users[0],file,p.digest),{created:2,skipped:0});
 const again=await f.service.preview(f.users[0],file);assert.equal(again.skips,2);assert.deepEqual(await f.service.commit(f.users[0],file,again.digest),{created:0,skipped:2});assert.equal(f.db.financeAccountDrafts?.length,2);assert.equal(f.db.financeEntities?.length,1);assert.ok(!JSON.stringify(f.db.financeDirectoryAudit).includes('0012'));
 const changed=await f.service.preview(f.users[0],csv(['测试公司A,企业支付宝,主账户,2222,CNY,']));assert.equal(changed.errors,1);assert.equal(f.db.financeAccountDrafts?.[0].last4,'0012');
});
test('duplicate lines, unsupported headers, empty files and size/row limits reject safely',async()=>{
 const f=fixture(),line='测试公司A,企业支付宝,主账户,0012,CNY,';assert.equal((await f.service.preview(f.users[0],csv([line,line]))).errors,1);
 for(const file of [csv([]),'wrong\ncolumns',csv(['"broken']),csv(Array.from({length:501},(_,i)=>`测试公司A,企业支付宝,账户${i},0012,CNY,`)),'x'.repeat(262145)])await assert.rejects(f.service.preview(f.users[0],file));
});
test('preview is bound to user, tenant, file and current directory revision',async()=>{
 const f=fixture(),file=csv(['测试公司A,企业支付宝,主账户,0012,CNY,']),p=await f.service.preview(f.users[0],file);await assert.rejects(f.service.commit(f.users[1],file,p.digest),/预览已变化/);await assert.rejects(f.service.commit(f.users[0],file+'\r\n',p.digest),/预览已变化/);await f.service.save(f.users[0],{...row,name:'另一个账户'});await assert.rejects(f.service.commit(f.users[0],file,p.digest),/预览已变化/);assert.equal(f.db.financeAccountDrafts?.length,1);
});
test('reordered columns and empty records never hide trailing valid data',async()=>{
 const f=fixture(),file=financeCsvHeaders.slice().reverse().join(',')+'\n,CNY,0012,主账户,企业支付宝,测试公司A';const p=await f.service.preview(f.users[0],file);assert.equal(p.creates,1);assert.equal(p.rows[0].values?.last4,'0012');
 const manyBlanks=csv(['测试公司A,企业支付宝,主账户,0012,CNY,',...Array(600).fill(',,,,,'),'测试公司B,企业支付宝,第二账户,0001,CNY,']);assert.equal((await f.service.preview(f.users[0],manyBlanks)).creates,2);
});
test('credential linking validates tenant/source/entity and cannot bind an account twice',async()=>{
 const f=fixture(),a=await f.service.save(f.users[0],row),bank=await f.service.save(f.users[0],{...row,sourceId:'icbc'}),other=await f.service.save(f.users[1],row);
 const pair=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}}),bankPair=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const env={FINANCE_CONFIG_ENABLED:'true',FINANCE_CONFIG_EPOCH:'test',FINANCE_CONFIG_ADMIN_IDS:'a,b',FINANCE_CONFIG_EXPIRES_AT:new Date(Date.now()+3600000).toISOString(),FINANCE_CREDENTIAL_MASTER_KEY:randomBytes(32).toString('base64')},service=new AlipayAccountService(f.store,env),body={name:row.name,legalEntity:row.legalEntity,appId:'2026000000000001',mode:'public_key',privateKey:pair.privateKey,alipayPublicKey:bankPair.publicKey};
 for(const invalid of [bank.id,other.id,'missing'])await assert.rejects(service.save(f.users[0],{...body,financeAccountId:invalid}),/不存在/);
 await assert.rejects(service.save(f.users[0],{...body,name:'错误名称',financeAccountId:a.id}),/不一致/);
 const saved=await service.save(f.users[0],{...body,financeAccountId:a.id});const view=(await f.service.state(f.users[0])).accounts.find(r=>r.id===a.id)!;assert.equal(view.credentialStatus,'configured');assert.equal(view.linkedAlipayId,saved.id);assert.equal(view.checkStatus,'not_tested');assert.equal(view.syncStatus,'not_enabled');assert.ok(!JSON.stringify(view).includes('PRIVATE KEY'));
 await assert.rejects(service.save(f.users[0],{...body,appId:'2026000000000002',financeAccountId:a.id}),/已关联/);await assert.rejects(f.service.save(f.users[0],{...row,name:'改绑名称'},a.id,1),/不能更换/);
 await f.service.save(f.users[0],{...row,note:'稍后配置'},a.id,1);assert.equal((await f.service.state(f.users[0])).accounts.find(r=>r.id===a.id)?.note,'稍后配置');
});
test('real HTTP routes enforce access/origin, preview-before-commit and safe template',async()=>{
 const f=fixture(),app=express();app.use(express.json({limit:'300kb'}));app.use((req,_res,next)=>{req.user=f.users.find(u=>u.id===req.get('x-test-user'));next();});app.use('/directory',createFinanceDirectoryRouter(f.store,{APP_ORIGIN:'https://example.test'}));const server=app.listen(0);await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/directory`;
 const request=async(path='',user='a',body?:unknown,origin='https://example.test')=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-test-user':user,Origin:origin},...(body?{body:JSON.stringify(body)}:{})});
 try{assert.equal((await request('','none')).status,401);assert.equal((await request('','member')).status,403);assert.equal((await request('/accounts','a',row,'https://evil.test')).status,403);const template=await request('/template.csv');assert.equal(template.status,200);assert.match(template.headers.get('content-type')||'',/text\/csv/);assert.equal((await template.text()).trim(),financeCsvHeaders.join(','));
 const file=csv(['测试公司A,企业支付宝,主账户,0012,CNY,']);assert.equal((await request('/imports/commit','a',{csv:file})).status,409);const p=await(await request('/imports/preview','a',{csv:file})).json();assert.equal((await request('/imports/commit','a',{csv:file,digest:p.digest})).status,200);assert.equal(f.db.financeAccountDrafts?.length,1);assert.equal((await request('','b')).status,200);assert.equal((await(await request('','b')).json()).accounts.length,0);assert.equal((await request('/unlock','a',{})).status,404);
 }finally{server.closeIdleConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
