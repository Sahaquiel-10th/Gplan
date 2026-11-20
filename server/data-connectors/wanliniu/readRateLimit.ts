import mysql,{type Pool,type RowDataPacket,type ResultSetHeader} from 'mysql2/promise';
import crypto from 'node:crypto';

let reservations:Pool|undefined,control:Pool|undefined,schema:Promise<void>|undefined;
let localNext=0,localCooldown=0;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const interval=()=>Math.max(250,Number(process.env.WANLINIU_HTTP_INTERVAL_MS)||250);
function pools(){
 if(process.env.DATA_DB_PROVIDER!=='mysql')return null;
 const opts={host:process.env.DATA_MYSQL_HOST,port:Number(process.env.DATA_MYSQL_PORT||3306),user:process.env.DATA_MYSQL_USER,password:process.env.DATA_MYSQL_PASSWORD,database:process.env.DATA_MYSQL_DATABASE,connectionLimit:1};
 reservations??=mysql.createPool(opts);control??=mysql.createPool(opts);
 schema??=control.query(`CREATE TABLE IF NOT EXISTS data_wln_read_rate_limit(
 app_hash CHAR(64) NOT NULL PRIMARY KEY,next_allowed_ms BIGINT NOT NULL,
 interval_ms INT NOT NULL,cooldown_until_ms BIGINT NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(()=>undefined).catch(error=>{schema=undefined;throw error;});
 return{reservations,control,schema};
}
const appHash=(key:string)=>crypto.createHash('sha256').update(key).digest('hex');
export function wanliniuRateDelay(message:string){
 if(!/(?<!\d)(?:801|429)(?!\d)|调用超过频次|限流|请求过于频繁/i.test(message))return null;
 const match=message.match(/(?:限制调用|等待|retry after)\s*(\d+)\s*(?:秒|s)/i);
 return match?Math.min(3600,Math.max(1,Number(match[1]))):15;
}
export async function reserveWanliniuRead(key:string){
 const all=pools();
 if(!all){const slot=Math.max(Date.now(),localNext,localCooldown);localNext=slot+interval();if(slot>Date.now())await pause(slot-Date.now());return;}
 await all.schema;const hash=appHash(key),lock='gplan-wln-read:'+hash.slice(0,40),db=await all.reservations.getConnection();let locked=false;
 try{
  const[got]=await db.query<RowDataPacket[]>('SELECT GET_LOCK(?,60) acquired',[lock]);locked=Number(got[0]?.acquired)===1;if(!locked)throw Error('等待万里牛共享读取频次锁超时');
  await db.execute('INSERT IGNORE INTO data_wln_read_rate_limit(app_hash,next_allowed_ms,interval_ms) VALUES(?,0,?)',[hash,interval()]);
  for(;;){
   const[rows]=await db.query<RowDataPacket[]>('SELECT next_allowed_ms,interval_ms FROM data_wln_read_rate_limit WHERE app_hash=?',[hash]);
   const now=Date.now(),wait=Number(rows[0].next_allowed_ms)-now;
   if(wait>0){await pause(Math.min(wait,30000));continue;}
   const[updated]=await db.execute<ResultSetHeader>('UPDATE data_wln_read_rate_limit SET next_allowed_ms=? WHERE app_hash=? AND next_allowed_ms<=?',[now+Math.max(interval(),Number(rows[0].interval_ms)),hash,now]);
   if(updated.affectedRows)break;
  }
 }finally{if(locked)await db.query('SELECT RELEASE_LOCK(?)',[lock]).catch(()=>undefined);db.release();}
}
export async function noteWanliniuRateLimit(key:string,message:string){
 const seconds=wanliniuRateDelay(message);if(seconds===null)return false;
 const until=Date.now()+(seconds+1)*1000;localCooldown=Math.max(localCooldown,until);
 const all=pools();if(all){await all.schema;await all.control.execute(`INSERT INTO data_wln_read_rate_limit(app_hash,next_allowed_ms,interval_ms,cooldown_until_ms) VALUES(?,?,?,?)
 ON DUPLICATE KEY UPDATE interval_ms=IF(cooldown_until_ms<=?,LEAST(5000,GREATEST(interval_ms*2,VALUES(interval_ms))),interval_ms),
 next_allowed_ms=GREATEST(next_allowed_ms,VALUES(next_allowed_ms)),cooldown_until_ms=GREATEST(cooldown_until_ms,VALUES(cooldown_until_ms))`,[appHash(key),until,Math.max(500,interval()),until,Date.now()]);}
 return true;
}
export async function closeWanliniuReadRateLimit(){await Promise.all([reservations?.end(),control?.end()]);reservations=undefined;control=undefined;schema=undefined;}
