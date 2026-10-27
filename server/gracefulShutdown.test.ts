import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {drainHttpServer} from './gracefulShutdown.js';

test('服务关闭时让正在进行的 HTTP 请求完成，而不是重置连接',async()=>{
  let markStarted:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{markStarted=resolve;});
  const server=createServer((_req,res)=>{
    markStarted();setTimeout(()=>res.end('completed'),60);
  });
  server.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address() as {port:number};
  const request=fetch(`http://127.0.0.1:${address.port}/`).then(r=>r.text());
  await started;
  const drained=drainHttpServer(server,2000);
  assert.equal(await request,'completed');
  await drained;
});
