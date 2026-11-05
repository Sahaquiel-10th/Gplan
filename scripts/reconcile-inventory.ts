import 'dotenv/config';
import {WanliniuSyncService} from '../server/data-connectors/wanliniu/sync.js';
try{
 const result=await new WanliniuSyncService().reconcileCurrentInventory(process.env.WANLINIU_COMPANY_ID||'company_default');
 console.log(JSON.stringify({inventorySourceReconciliation:'ok',resources:result}));
 process.exit(0);
}catch(error){console.error(JSON.stringify({inventorySourceReconciliation:'failed',error:error instanceof Error?error.message:String(error)}));process.exit(1);}
