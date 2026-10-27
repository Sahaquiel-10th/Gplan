import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const required=[
  'server/clientDataApi.ts','server/clientDailyReport.ts','server/clientReportPublication.ts',
  'server/apiNotFound.ts','server/gracefulShutdown.ts','server/gracefulShutdown.test.ts',
  'server/clientDataApi.test.ts','server/clientDailyReport.test.ts','deploy/deploy-gplan.sh',
  'server/clientReportPublication.test.ts','scripts/check-client-api.mjs','scripts/test-client-daily-report.mjs',
  'docs/client-daily-report-v1.md'
];
const archive=process.argv[2];
const entries=archive?new Set(execFileSync('tar',['-tf',archive],{encoding:'utf8'}).split('\n')):null;
const missing=required.filter(file=>entries?!entries.has(file):!fs.existsSync(file));
if(missing.length)throw new Error('Release is missing the formal client API contract: '+missing.join(', '));
console.log(JSON.stringify({releaseContract:'ok',files:required.length,archive:!!archive}));
