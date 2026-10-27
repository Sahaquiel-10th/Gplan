import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationVersion,shanghaiDate,yesterdayShanghai,ensurePublishedReport,ReportNotAvailable } from './clientReportPublication.js';
import type { Pool,RowDataPacket } from 'mysql2/promise';
test('北京时间跨日与昨日不受主机时区影响',()=>{
  const now=new Date('2026-10-15T19:00:00Z');
  assert.equal(shanghaiDate(now),'2026-10-16');
  assert.equal(yesterdayShanghai(now),'2026-10-15');
});
test('同步游标推进后旧发布批次失效',()=>{
  const a=[{resource_name:'inventory',modified_through:'2026-10-15T19:00:00Z'}] as RowDataPacket[];
  const b=[{resource_name:'inventory',modified_through:'2026-10-16T19:00:00Z'}] as RowDataPacket[];
  assert.equal(publicationVersion(a),publicationVersion(a));
  assert.notEqual(publicationVersion(a),publicationVersion(b));
});
test('错误客户端和未来日期不能生成数据',async()=>{
  const db={} as Pool;
  await assert.rejects(ensurePublishedReport(db,'company_default','unrelated','2026-10-13'),ReportNotAvailable);
  await assert.rejects(ensurePublishedReport(db,'company_default','winona_daily_trial','2999-01-01'),ReportNotAvailable);
});
