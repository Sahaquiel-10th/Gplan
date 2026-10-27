import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { createClientDataApiRouter } from './clientDataApi.js';
import { publicationVersion } from './clientReportPublication.js';
import { apiNotFound } from './apiNotFound.js';

test('正式接口 HTTP 合约：JSON、分页、过滤、权限、日期、批次和缺失路由', async () => {
  const rows = [
    {record_type:'outbound', product_code:'6900000000001', outbound_quantity:5, shop_name:'[微信视频号]小象优选家'},
    {record_type:'inventory', product_code:'6900000000002', inventory_quantity:20, shop_name:null}
  ];
  const database = {
    async query(sql: string) {
      if(sql.startsWith('CREATE TABLE')) return [{affectedRows:0}];
      if(sql.startsWith('SHOW COLUMNS')) return [[{Field:'source_version'}]];
      if(sql.includes('SELECT resource_name')) return [[]];
      throw new Error('Unexpected query: '+sql);
    },
    async execute(sql: string, args: unknown[]) {
      if(sql.includes('SELECT id, company_id')) return [[{
        id:'test-client', company_id:'company_default', client_code:'winona_daily_trial',
        scopes_json: JSON.stringify(['daily-report:read'])
      }]];
      if(sql.includes('UPDATE data_api_clients') || sql.includes('INSERT INTO data_api_request_logs')) return [{affectedRows:1}];
      if(sql.includes('SELECT batch_id,rows_json')) return [[{
        batch_id:'stable-batch', rows_json:rows, source_version:publicationVersion([] as RowDataPacket[]), prepared_at:'2026-10-27T03:30:00+08:00'
      }]];
      throw new Error('Unexpected execute: '+sql+' '+args?.length);
    }
  } as unknown as Pool;
  const app=express();
  app.use('/api/open/v1', createClientDataApiRouter(database));
  app.use('/api',apiNotFound);
  app.get(/.*/,(_req,res)=>res.type('html').send('<html>SPA</html>'));
  const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address() as {port:number};
  async function request(path:string,status=200,authenticated=true) {
    const response=await fetch(`http://127.0.0.1:${address.port}/api${path}`,{headers:authenticated?{Authorization:'Bearer fake-test-token'}:{}});
    assert.equal(response.status,status,path);
    assert.match(response.headers.get('content-type')||'',/application\/json/,path);
    return response.json();
  }
  try {
    assert.equal((await request('/open/v1/ping')).code,0);
    await request('/open/v1/daily-report?date=2026-10-13',401,false);
    const first=await request('/open/v1/daily-report?date=2026-10-13&page_size=1');
    assert.equal(first.data.length,1);assert.equal(first.pagination.total,2);assert.equal(first.pagination.has_more,true);
    const second=await request('/open/v1/daily-report?date=2026-10-13&page=2&page_size=1&batch_id=stable-batch');
    assert.equal(second.data[0].record_type,'inventory');assert.equal(second.pagination.has_more,false);
    const filtered=await request('/open/v1/daily-report?date=2026-10-13&product_code=6900000000002');
    assert.equal(filtered.pagination.total,1);assert.equal(filtered.data[0].product_code,'6900000000002');
    await request('/open/v1/daily-report',400);
    await request('/open/v1/daily-report?date=2026-02-30',400);
    await request('/open/v1/daily-report?date=2999-01-01',404);
    await request('/open/v1/daily-report?date=2026-10-13&batch_id=old',409);
    await request('/open/v1/inventory',403);
    await request('/open/v1/nonexistent',404);
    await request('/nonexistent',404);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
