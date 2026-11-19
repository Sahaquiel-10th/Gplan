import { config } from 'dotenv';
import mysql from 'mysql2/promise';
import { ClientMovementSync } from '../server/clientMovements.js';
import { reportDate } from '../server/clientDailyReport.js';

config({ path: process.env.GPLAN_ENV_FILE || '.env', quiet: true });
const fromIndex = process.argv.indexOf('--from');
const from = fromIndex < 0 ? undefined : reportDate(process.argv[fromIndex + 1]);
const e = process.env;
if (e.DATA_DB_PROVIDER !== 'mysql') throw new Error('需要配置现有经营数据库');
const pool = mysql.createPool({ host: e.DATA_MYSQL_HOST, port: Number(e.DATA_MYSQL_PORT || 3306),
  user: e.DATA_MYSQL_USER, password: e.DATA_MYSQL_PASSWORD, database: e.DATA_MYSQL_DATABASE,
  dateStrings: true, decimalNumbers: true, connectionLimit: 2 });
try {
  const result = await new ClientMovementSync(pool).sync(e.WANLINIU_COMPANY_ID?.trim() || 'company_default', from);
  console.log(JSON.stringify({ event: 'client_movement_sync_complete', resources: result }));
} finally { await pool.end(); }
