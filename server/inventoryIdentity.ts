export type InventoryIdentityRow = {
  company_id: string; storage_code: string; sku_code: string;
  source_spec_uid?: string | null; resolved_uid?: string | null;
  snapshot_at?: string; product_modified?: string | null;
  actual_quantity?: number | string; [key: string]: unknown;
};

export class MissingInventoryIdentityError extends Error {
  constructor(public skuCodes: string[]) {
    super('库存商品缺少稳定系统规格 ID，需先补全商品资料：'+skuCodes.join('、'));
  }
}
export function inventoryIdentity(row: InventoryIdentityRow) {
  const uid=String(row.source_spec_uid||row.resolved_uid||'').trim();
  if(!uid)throw new MissingInventoryIdentityError([row.sku_code]);
  return JSON.stringify([row.company_id,row.storage_code,uid]);
}
export function canonicalInventoryRows<T extends InventoryIdentityRow>(rows: T[]) {
  const groups=new Map<string,T[]>();
  const tombstones:T[]=[];
  for(const row of rows){
    if(!row.resolved_uid&&!row.source_spec_uid){
      if(row.sku_code==='已删除商品'&&Number(row.actual_quantity)===0){tombstones.push(row);continue;}
      throw new MissingInventoryIdentityError([row.sku_code]);
    }
    const key=inventoryIdentity(row),group=groups.get(key)||[];group.push(row);groups.set(key,group);
  }
  const kept:T[]=[],retired:T[]=[];
  for(const group of groups.values()){
    group.sort((a,b)=>String(b.product_modified||'').localeCompare(String(a.product_modified||''))||String(b.snapshot_at||'').localeCompare(String(a.snapshot_at||''))||a.sku_code.localeCompare(b.sku_code));
    if(group.length>1&&group[0].product_modified===group[1].product_modified&&group[0].snapshot_at===group[1].snapshot_at&&Number(group[0].actual_quantity)!==Number(group[1].actual_quantity))throw new Error('同一库存身份存在无法判定先后的冲突值，禁止相加');
    kept.push(group[0]);retired.push(...group.slice(1));
  }
  return{kept,retired,tombstones};
}

type ProductAlias={sku_code:string;goods_name:string|null;bar_code:string|null;source_spec_uid:string|null;source_modified_at:string|null};
export function repairCachedInventory(rows: Record<string,any>[],products: ProductAlias[],strict=true):{rows:Record<string,any>[];removed:number;unresolved:Record<string,any>[]} {
  const unresolved:Record<string,any>[]=[];
  const candidates=rows.filter(r=>r.record_type==='inventory').flatMap(row=>{
    let matches=products.filter(p=>p.bar_code===row.product_code&&p.goods_name===row.product_name&&p.source_spec_uid);
    if(!matches.length){
      const byCode=products.filter(p=>p.bar_code===row.product_code&&p.source_spec_uid);
      if(new Set(byCode.map(p=>p.source_spec_uid)).size===1)matches=byCode;
    }
    const ids=new Set(matches.map(p=>p.source_spec_uid));
    if(ids.size!==1){if(strict)throw new Error('历史库存行无法唯一对应系统规格，禁止按条码盲目去重：'+JSON.stringify({code:row.product_code,name:row.product_name,ids:[...ids]}));unresolved.push(row);return[];}
    const p=matches.sort((a,b)=>String(b.source_modified_at).localeCompare(String(a.source_modified_at)))[0];
    return[{...row,company_id:'cache',storage_code:row.storage_name,sku_code:p.sku_code,source_spec_uid:p.source_spec_uid,product_modified:p.source_modified_at,actual_quantity:row.inventory_quantity,original:row}];
  });
  const result=canonicalInventoryRows(candidates);
  return{rows:result.kept.map(r=>({...r.original,source_spec_uid:r.source_spec_uid,source_sku_code:r.sku_code})),removed:result.retired.length,unresolved};
}
