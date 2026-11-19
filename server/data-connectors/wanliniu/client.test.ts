import assert from "node:assert/strict";
import test from "node:test";
import { unwrapRecords } from "./client.js";

test("万里牛成功但无 data 字段时按空分页处理", () => {
  assert.deepEqual(unwrapRecords({ code: 0 }), []);
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
