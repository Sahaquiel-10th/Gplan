import {config} from 'dotenv';
import {ApprovedStockSync,ClientAfterSalesSync,syncClientStockReferences,scopePool} from '../server/clientApprovedScope.js';
import {closeWanliniuReadRateLimit} from '../server/data-connectors/wanliniu/readRateLimit.js';
config({path:process.env.GPLAN_ENV_FILE||'.env',quiet:true});
if(process.env.DATA_DB_PROVIDER!=='mysql')throw Error('需要已配置的经营数据库');
const resourceIndex=process.argv.indexOf('--resource');
const resource=resourceIndex<0?'all':process.argv[resourceIndex+1];
if(!['all','stock','after-sales','references'].includes(resource))throw Error('resource 必须是stock、after-sales或references');
const pool=scopePool(),company=process.env.WANLINIU_COMPANY_ID?.trim()||'company_default';
try{
 if(resource==='all'||resource==='stock')console.log(JSON.stringify({event:'approved_stock_sync_complete',result:await new ApprovedStockSync(pool).sync(company)}));
 if(resource==='all'||resource==='after-sales')console.log(JSON.stringify({event:'client_after_sales_sync_complete',result:await new ClientAfterSalesSync(pool).sync(company)}));
 if(resource==='all'||resource==='references')console.log(JSON.stringify({event:'client_stock_references_sync_complete',result:await syncClientStockReferences(pool,company)}));
}finally{await pool.end();await closeWanliniuReadRateLimit();}
