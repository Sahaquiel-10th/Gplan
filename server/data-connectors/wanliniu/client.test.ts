import assert from "node:assert/strict";
import test from "node:test";
import { unwrapRecords,signedWanliniuForm,WanliniuClient } from "./client.js";
import crypto from 'node:crypto';

test("万里牛成功但无 data 字段时按空分页处理", () => {
  assert.deepEqual(unwrapRecords({ code: 0 }), []);
});

test('官方签名向量一致，中文空格和特殊字符按表单编码，参数顺序不影响签名',()=>{
 const form=signedWanliniuForm('3823532979','ea5b29320cb3d15a9883c1fa4654bd02',{page:1,limit:200,bill_code:'OFL20221212164119384010001,OFL20221212155533384009005',query_extend:{query_relation_trade:true,encry_address:true}},1672213377);
 assert.equal(form.get('_sign')?.toUpperCase(),'F5BB54ED438BE6780110A2E4A58FA0EF');
 const special=signedWanliniuForm('test-key','test-secret',{z:"空 格!*~'()",a:2},100);
 const canonical=new URLSearchParams([...special].filter(([key])=>key!=='_sign').sort(([a],[b])=>a.localeCompare(b))).toString();
 assert.equal(special.get('_sign'),crypto.createHash('md5').update('test-secret'+canonical+'test-secret').digest('hex'));
 assert.equal(special.get('_sign'),signedWanliniuForm('test-key','test-secret',{a:2,z:"空 格!*~'()"},100).get('_sign'));
 assert.throws(()=>signedWanliniuForm('key','secret',{_app:'override'},100),/系统签名参数/);
});
test('售后和加工对象分页保留是否还有下一页，缺失标志不能冒充已完整',()=>{
 const after=unwrapRecords({code:0,data:{orders:[{bill_code:'SH1'}],has_next:true}});assert.equal(after.length,1);assert.equal(after.hasMore,true);
 const production=unwrapRecords({code:0,data:{data:[{product_code:'JG1'}],has_more:false}});assert.equal(production.hasMore,false);
 const realProduction=unwrapRecords({code:0,data:{elements:[{product_code:'JG1'}],next:true,total:2597}});assert.equal(realProduction.length,1);assert.equal(realProduction.hasMore,true);
 assert.throws(()=>unwrapRecords({code:0,data:{orders:[]}}),/has_next/);
 assert.throws(()=>unwrapRecords({code:0,data:{data:[]}}),/has_more/);
});
test('同步读取白名单拒绝写接口，不发出网络请求',async()=>{
 await assert.rejects(new WanliniuClient().call('/erp/stock/out/stockbill/add',{}),/未允许/);
});

test("万里牛非零错误码不能被当作空分页", () => {
  assert.throws(() => unwrapRecords({ code: 1500, message: "业务参数错误" }), /1500/);
});

test('大页响应使用文件输出，不会因 CLI 立即退出而截断；超时会终止进程',async()=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const {cliJsonToFile}=await import('./client.js');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wln-response-test-'));
  try{
    const raw=await cliJsonToFile(process.execPath,['-e',`process.stdout.write(JSON.stringify({data:'x'.repeat(600000)}));process.exit(0)`],dir,5000);
    assert.equal(JSON.parse(raw).data.length,600000);
    await fs.unlink(path.join(dir,'response.json'));
    await assert.rejects(cliJsonToFile(process.execPath,['-e','setInterval(()=>{},1000)'],dir,50),/超时/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
