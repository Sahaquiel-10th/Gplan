import test from 'node:test';
import assert from 'node:assert/strict';
import {wanliniuRateDelay,noteWanliniuRateLimit,reserveWanliniuRead,closeWanliniuReadRateLimit} from './readRateLimit.js';
test('801遵循源平台等待秒数，429缺失等待信息时保守退避',()=>{
 assert.equal(wanliniuRateDelay('万里牛接口错误（801）：应用调用超过频次，限制调用 11 秒'),11);
 assert.equal(wanliniuRateDelay('万里牛HTTP429'),15);
 assert.equal(wanliniuRateDelay('万里牛接口错误（1500）：业务参数错误'),null);
});
test('冷却期间不提前发起下一次读取',async()=>{
 const prior=process.env.DATA_DB_PROVIDER;process.env.DATA_DB_PROVIDER='disabled';
 try{await noteWanliniuRateLimit('unit-key','801 限制调用 1 秒');const started=Date.now();await reserveWanliniuRead('unit-key');assert(Date.now()-started>=1900);}
 finally{if(prior===undefined)delete process.env.DATA_DB_PROVIDER;else process.env.DATA_DB_PROVIDER=prior;await closeWanliniuReadRateLimit();}
});
