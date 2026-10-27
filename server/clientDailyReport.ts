import type { Connection, RowDataPacket } from 'mysql2/promise';

// Explicit source identities, independent of mutable source display names.
export const reportShops: Record<string, string> = {
  '282405E444FF316780EE3E444C12178D': '[拼多多]美呦日化专营店',
  '960FE71D504E38729E4FF63DF50491D3': '[拼多多]奕页美妆专营店',
  'B65306DC28AE3584BFAD1363ADED0941': '[拼多多]PDD薇诺娜奕页专卖店',
  '2EA2FC35B3733A91ACBC7F5822BF576D': '[天猫]薇诺娜奕页专卖店',
  '3FD62C2E49BD350B8A1BFC6C4954250B': '[拼多多]晳妍洗护用品专营店',
  'E193AF01F2CE3679BF5A61FAF67231F9': '[淘宝]薇诺娜品牌授权店',
  '313EDF7FA9813A1F8C228D20F21E7A4B': '[拼多多]麦轩美妆专营店',
  '6C329B234F8D30FF820DC6F0291F6ACB': '[拼多多]茉翎美妆专营店',
  '93C690FE2A863E7F968C866988A116B5': '[京东]JD美呦美妆专营店',
  'ED7971678B3F318FB4A6058A203DFA4A': '[京东]JD-薇诺娜小象优选专卖店',
  '9CE3621FFA5F355CB3CDEB82D0C98CDF': '[微信视频号]小象优选家',
  '3B9FA6FA29993AA2A18DDCA355FD787A': '[微信视频号]小象优选家',
  '1D0EB38BF5003BE59100A3D6F069190A': '[微信视频号]小象优选家',
};
export const reportClientCode = 'winona_daily_trial';
export function reportDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('date 必须为 YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('date 不是有效日期');
  return value;
}

export async function buildClientReport(db: Connection, companyId: string, date: string) {
  reportDate(date);
  const shops = Object.keys(reportShops);
  const marks = shops.map(() => '?').join(',');
  const brand = "JSON_UNQUOTE(JSON_EXTRACT(p.raw_payload,'$.goods.brand_name'))='薇诺娜'";
  const [outbound] = await db.query<RowDataPacket[]>(`SELECT h.shop_id, h.storage_code,
      COALESCE(NULLIF(i.bar_code,''),NULLIF(p.bar_code,'')) product_code,
      COALESCE(NULLIF(i.goods_name,''),p.goods_name,i.sku_name) product_name,
      i.quantity,DATE_FORMAT(h.bill_date,'%Y-%m-%dT%H:%i:%s+08:00') movement_time
    FROM ods_wln_sale_outbound h FORCE INDEX (idx_wln_sale_outbound_bill_date)
    STRAIGHT_JOIN ods_wln_sale_outbound_items i ON i.company_id=h.company_id AND i.outbound_uid=h.outbound_uid
    JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code
    WHERE h.company_id=? AND h.bill_date>=? AND h.bill_date<DATE_ADD(?,INTERVAL 1 DAY)
      AND h.shop_id IN (${marks}) AND h.storage_code IN ('CK001','CK008') AND ${brand}
    ORDER BY h.bill_date,h.outbound_uid,i.line_key`,[companyId,date,date,...shops]);
  const [inbound] = await db.query<RowDataPacket[]>(`SELECT h.storage_code,h.inbound_type,
      COALESCE(NULLIF(i.bar_code,''),NULLIF(p.bar_code,'')) product_code,
      COALESCE(NULLIF(i.goods_name,''),p.goods_name,i.spec_name) product_name,
      i.quantity,DATE_FORMAT(h.bill_date,'%Y-%m-%dT%H:%i:%s+08:00') movement_time
    FROM ods_wln_purchase_inbound h JOIN ods_wln_purchase_inbound_items i
      ON i.company_id=h.company_id AND i.stock_code=h.stock_code
    JOIN ods_wln_products p ON p.company_id=i.company_id AND p.sku_code=i.sku_code
    WHERE h.company_id=? AND h.bill_date>=? AND h.bill_date<DATE_ADD(?,INTERVAL 1 DAY)
      AND h.storage_code IN ('CK001','CK008') AND ${brand}
    ORDER BY h.bill_date,h.stock_code,i.line_no`,[companyId,date,date]);
  const [inventory] = await db.query<RowDataPacket[]>(`SELECT i.storage_code,
      COALESCE(NULLIF(i.bar_code,''),NULLIF(p.bar_code,'')) product_code,
      COALESCE(NULLIF(p.goods_name,''),i.spec_name) product_name,i.actual_quantity quantity,
      DATE_FORMAT(i.snapshot_at,'%Y-%m-%d') inventory_date,
      DATE_FORMAT(i.snapshot_at,'%Y-%m-%dT%H:%i:%s+08:00') snapshot_time
    FROM ods_wln_inventory_current i JOIN ods_wln_products p
      ON p.company_id=i.company_id AND p.sku_code=i.sku_code
    WHERE i.company_id=? AND i.storage_code IN ('CK001','CK008') AND ${brand}`,[companyId]);
  const [inventorySync] = await db.query<RowDataPacket[]>(`SELECT
    DATE_FORMAT(last_success_at,'%Y-%m-%d') inventory_date,
    DATE_FORMAT(last_success_at,'%Y-%m-%dT%H:%i:%s+08:00') inventory_as_of
    FROM data_sync_cursors WHERE connector_id='wanliniu' AND resource_name='inventory'`);
  if (!inventorySync[0]) throw new Error('库存尚无成功同步记录');
  // The current table contains incremental updates: individual snapshot_at values
  // are last-change times, not separate historical inventory snapshots.
  for (const row of inventory) {
    row.inventory_date=inventorySync[0].inventory_date;
    row.snapshot_time=inventorySync[0].inventory_as_of;
  }
  type ReportRow = {
    record_type: string; business_date: string; inventory_date: string | null;
    shop_name: string | null; storage_name: string; product_code: string | null;
    product_name: string; inventory_quantity: number | null;
    outbound_quantity: number | null; inbound_quantity: number | null;
    movement_times: string[]; inventory_as_of: string | null;
    inbound_type: string | null;
  };
  const grouped = new Map<string, ReportRow>();
  for (const [type, source] of [['outbound',outbound],['inbound',inbound],['inventory',inventory]] as const) {
    for (const item of source) {
      const shop = type === 'outbound' ? reportShops[String(item.shop_id)] : null;
      const inboundType=type==='inbound'?String(item.inbound_type || 'UNKNOWN'):null;
      const key = JSON.stringify([type,shop,item.storage_code,item.product_code,item.product_name,type==='inventory'?item.inventory_date:null,inboundType]);
      let row = grouped.get(key);
      if (!row) {
        row={record_type:type,business_date:date,inventory_date:type==='inventory'?item.inventory_date:null,
          shop_name:shop,storage_name:item.storage_code==='CK008'?'奕页仓库':'淘宝仓库',
          product_code:item.product_code || null,product_name:item.product_name || '',
          inventory_quantity:type==='inventory'?0:null,outbound_quantity:type==='outbound'?0:null,
          inbound_quantity:type==='inbound'?0:null,movement_times:[],inventory_as_of:type==='inventory'?item.snapshot_time:null,
          inbound_type:inboundType};
        grouped.set(key,row);
      }
      const quantity=Number(item.quantity);
      if(type==='outbound') row.outbound_quantity!+=quantity;
      if(type==='inbound') row.inbound_quantity!+=quantity;
      if(type==='inventory') {
        row.inventory_quantity!+=quantity;
        if(item.snapshot_time>row.inventory_as_of!)row.inventory_as_of=item.snapshot_time;
      } else row.movement_times.push(item.movement_time);
    }
  }
  const rows=[...grouped.values()];
  for(const row of rows)row.movement_times=[...new Set(row.movement_times)].sort();
  rows.sort((a,b)=>JSON.stringify([a.record_type,a.shop_name,a.storage_name,a.product_code,a.product_name,a.inbound_type]).localeCompare(JSON.stringify([b.record_type,b.shop_name,b.storage_name,b.product_code,b.product_name,b.inbound_type])));
  return {rows,sourceCounts:{outbound:outbound.length,inbound:inbound.length,inventory:inventory.length},missingBarcodes:rows.filter(x=>!x.product_code).length};
}
