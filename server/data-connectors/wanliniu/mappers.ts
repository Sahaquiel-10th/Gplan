import crypto from "node:crypto";
import type { WanliniuRecord } from "./client.js";

export type NormalizedShop = {
  shopUid: string;
  sourceCompanyId: string | null;
  shopNick: string | null;
  shopName: string | null;
  shopType: number | null;
  shopSubType: number | null;
  status: number | null;
  groupUid: string | null;
  groupName: string | null;
  syncEnabled: boolean | null;
  sourceModifiedAt: string | null;
  rawPayload: WanliniuRecord;
};

export type NormalizedProduct = {
  skuCode: string;
  goodsCode: string | null;
  goodsName: string | null;
  specName: string | null;
  barCode: string | null;
  sourceGoodsUid: string | null;
  sourceSpecUid: string | null;
  status: number | null;
  sourceModifiedAt: string | null;
  rawPayload: unknown;
};

export type NormalizedInventory = {
  storageCode: string;
  skuCode: string;
  goodsCode: string | null;
  articleNumber: string | null;
  barCode: string | null;
  specName: string | null;
  actualQuantity: number;
  lockedQuantity: number;
  inTransitQuantity: number;
  defectQuantity: number;
  lockedDefectQuantity: number;
  inTransitDefectQuantity: number;
  totalCost: number | null;
  snapshotAt: string;
  rawPayload: WanliniuRecord;
};

export type NormalizedOutbound = {
  outboundUid: string;
  outboundNo: string | null;
  externalOrderNo: string | null;
  billDate: string | null;
  billType: number | null;
  shopId: string | null;
  shopNick: string | null;
  shopName: string | null;
  shopSource: string | null;
  shopType: number | null;
  storageCode: string | null;
  storageName: string | null;
  grossAmount: number | null;
  paidAmount: number | null;
  actualPayment: number | null;
  discountAmount: number | null;
  postageAmount: number | null;
  currencyCode: string | null;
  sourceModifiedAt: string | null;
  rawPayload: WanliniuRecord;
  items: NormalizedOutboundItem[];
};

export type NormalizedOutboundItem = {
  lineKey: string;
  sourceDetailId: string | null;
  goodsUid: string | null;
  skuUid: string | null;
  skuCode: string | null;
  barCode: string | null;
  goodsName: string | null;
  skuName: string | null;
  quantity: number;
  unit: string | null;
  salePrice: number | null;
  grossAmount: number | null;
  actualPaidAmount: number | null;
  discountAmount: number | null;
  costAmount: number | null;
  isPackage: boolean | null;
  rawPayload: WanliniuRecord;
};

export type NormalizedInbound = {
  stockCode: string;
  externalReceiptNo: string | null;
  billDate: string | null;
  createdAtSource: string | null;
  approvedAt: string | null;
  storageCode: string | null;
  storageName: string | null;
  supplierCode: string | null;
  supplierName: string | null;
  settlementStatus: number | null;
  billStatus: number | null;
  totalAmount: number | null;
  taxAmount: number | null;
  currencyCode: string | null;
  sourceModifiedAt: string | null;
  rawPayload: WanliniuRecord;
  items: NormalizedInboundItem[];
};

export type NormalizedInboundItem = {
  lineNo: number;
  skuCode: string | null;
  barCode: string | null;
  goodsName: string | null;
  specName: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number | null;
  totalAmount: number | null;
  taxAmount: number | null;
  inventoryType: string | null;
  batchCode: string | null;
  productionDate: string | null;
  expiryDate: string | null;
  rawPayload: WanliniuRecord;
};

export function normalizeShop(source: WanliniuRecord): NormalizedShop {
  const shopUid = text(source.shop_uid) || text(source.shop_nick);
  if (!shopUid) throw new Error("万里牛店铺缺少 shop_uid 和 shop_nick");
  return {
    shopUid,
    sourceCompanyId: text(source.com_uid),
    shopNick: text(source.shop_nick),
    shopName: text(source.shop_name),
    shopType: numberOrNull(source.shop_type),
    shopSubType: numberOrNull(source.sub_type),
    status: numberOrNull(source.status),
    groupUid: text(source.group_uid),
    groupName: text(source.group_name),
    syncEnabled: booleanOrNull(source.is_sync),
    sourceModifiedAt: sourceDate(first(source.modify_time, source.modified_time)),
    rawPayload: sanitizePayload(source) as WanliniuRecord
  };
}

export function normalizeProducts(source: WanliniuRecord): NormalizedProduct[] {
  const specs = Array.isArray(source.specs) ? source.specs.filter(isRecord) : [];
  return specs.map((spec) => {
    const skuCode = text(spec.spec_code);
    if (!skuCode) throw new Error(`万里牛商品 ${text(source.goods_code) || "未知"} 的规格缺少 spec_code`);
    return {
      skuCode,
      goodsCode: text(source.goods_code),
      goodsName: text(source.goods_name),
      specName: [text(spec.spec1), text(spec.spec2)].filter(Boolean).join(" / ") || null,
      barCode: text(spec.barcode),
      sourceGoodsUid: text(source.sys_goods_uid),
      sourceSpecUid: text(spec.sys_spec_uid),
      status: numberOrNull(spec.status) ?? numberOrNull(source.status),
      sourceModifiedAt: sourceDate(first(spec.modify_time, source.modify_time, source.modified_time)),
      rawPayload: { goods: source, spec }
    };
  });
}

export function normalizeInventory(source: WanliniuRecord, snapshotAt: string): NormalizedInventory {
  const storageCode = text(source.storage_code);
  const skuCode = text(source.sku_code);
  if (!storageCode || !skuCode) throw new Error("万里牛库存缺少 storage_code 或 sku_code");
  return {
    storageCode,
    skuCode,
    goodsCode: text(source.goods_code),
    articleNumber: text(source.article_number),
    barCode: text(source.bar_code),
    specName: text(source.spec_name),
    actualQuantity: numberOrZero(source.quantity),
    lockedQuantity: numberOrZero(source.lock_size),
    inTransitQuantity: numberOrZero(source.underway),
    defectQuantity: numberOrZero(source.defect_num),
    lockedDefectQuantity: numberOrZero(source.lock_defect_num),
    inTransitDefectQuantity: numberOrZero(source.underway_defect_num),
    totalCost: numberOrNull(source.cost),
    snapshotAt,
    rawPayload: source
  };
}

export function normalizeOutbound(source: WanliniuRecord): NormalizedOutbound {
  const outboundUid = text(source.inv_uid) || text(source.inv_no);
  if (!outboundUid) throw new Error("万里牛销售出库单缺少 inv_uid 和 inv_no");
  const details = Array.isArray(source.details) ? source.details.filter(isRecord) : [];
  return {
    outboundUid,
    outboundNo: text(source.inv_no),
    externalOrderNo: text(source.tp_tid),
    billDate: sourceDate(source.bill_date),
    billType: numberOrNull(source.bill_type),
    shopId: text(source.sys_shop),
    shopNick: text(source.shop_nick),
    shopName: text(source.shop_name),
    shopSource: text(source.shop_source),
    shopType: numberOrNull(source.shop_type),
    storageCode: text(source.storage_code),
    storageName: text(source.storage_name),
    grossAmount: numberOrNull(source.sum_sale),
    paidAmount: numberOrNull(source.paid_fee),
    actualPayment: numberOrNull(source.actual_payment),
    discountAmount: numberOrNull(source.discount_fee),
    postageAmount: numberOrNull(source.post_fee),
    currencyCode: text(source.currency_code),
    sourceModifiedAt: sourceDate(first(source.modify_time, source.modified_time)),
    rawPayload: sanitizePayload(source) as WanliniuRecord,
    items: details.map((detail, index) => normalizeOutboundItem(detail, index))
  };
}

function normalizeOutboundItem(source: WanliniuRecord, index: number): NormalizedOutboundItem {
  const identity = [source.detail_id, source.sku_uid, source.sku_no, source.bar_code, index].join("|");
  const prefix = text(source.detail_id) || `line-${index + 1}`;
  const digest = crypto.createHash("sha1").update(identity).digest("hex").slice(0, 16);
  return {
    lineKey: `${prefix}:${digest}`.slice(0, 191),
    sourceDetailId: text(source.detail_id),
    goodsUid: text(source.goods_uid),
    skuUid: text(source.sku_uid),
    skuCode: text(first(source.sku_no, source.spec_code, source.sku_code)),
    barCode: text(first(source.bar_code, source.barcode)),
    goodsName: text(source.goods_name),
    skuName: text(source.sku_name),
    quantity: numberOrZero(first(source.nums, source.quantity)),
    unit: text(source.unit),
    salePrice: numberOrNull(source.sale_price),
    grossAmount: numberOrNull(source.sum_sale),
    actualPaidAmount: numberOrNull(first(source.actual_pay, source.actual_payment)),
    discountAmount: numberOrNull(source.discount_fee),
    costAmount: numberOrNull(source.sum_cost),
    isPackage: booleanOrNull(source.is_package),
    rawPayload: source
  };
}

export function normalizeInbound(source: WanliniuRecord): NormalizedInbound {
  const stockCode = text(source.stock_code);
  if (!stockCode) throw new Error("万里牛采购入库单缺少 stock_code");
  const details = Array.isArray(source.details) ? source.details.filter(isRecord) : [];
  const usedLineNumbers = new Set<number>();
  const items = details.map((detail, index) => {
    const preferred = Math.trunc(numberOrNull(detail.index) ?? index + 1);
    let lineNo = preferred > 0 && !usedLineNumbers.has(preferred) ? preferred : index + 1;
    while (usedLineNumbers.has(lineNo)) lineNo += 1;
    usedLineNumbers.add(lineNo);
    return normalizeInboundItem(detail, lineNo);
  });
  return {
    stockCode,
    externalReceiptNo: text(source.bill_no),
    billDate: sourceDate(source.bill_date),
    createdAtSource: sourceDate(source.create_time),
    approvedAt: sourceDate(source.approve_time),
    storageCode: text(source.storage_code),
    storageName: text(source.storage_name),
    supplierCode: text(source.supplier_code),
    supplierName: text(source.supplier_name),
    settlementStatus: numberOrNull(source.status),
    billStatus: numberOrNull(source.bill_status),
    totalAmount: numberOrNull(source.sumprice),
    taxAmount: numberOrNull(source.tax_sum),
    currencyCode: text(source.currency_code),
    sourceModifiedAt: sourceDate(first(source.modified_time, source.modify_time)),
    rawPayload: sanitizePayload(source) as WanliniuRecord,
    items
  };
}

function normalizeInboundItem(source: WanliniuRecord, lineNo: number): NormalizedInboundItem {
  return {
    lineNo,
    skuCode: text(first(source.spec_code, source.sku_code, source.sku_no)),
    barCode: text(first(source.bar_code, source.barcode)),
    goodsName: text(source.goods_name),
    specName: text(source.spec_name),
    quantity: numberOrZero(first(source.nums, source.quantity)),
    unit: text(source.unit),
    unitPrice: numberOrNull(source.price),
    totalAmount: numberOrNull(source.total_money),
    taxAmount: numberOrNull(source.tax),
    inventoryType: text(source.inventory_type),
    batchCode: text(source.batch_code),
    productionDate: sourceDate(source.batch_date),
    expiryDate: sourceDate(source.expiry_date),
    rawPayload: source
  };
}

export function mysqlDateInShanghai(value: Date | string | number) {
  const date = value instanceof Date ? value : epochOrDate(value);
  if (Number.isNaN(date.getTime())) throw new Error(`无法解析日期：${String(value)}`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function sourceDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const date = epochOrDate(value);
  return Number.isNaN(date.getTime()) ? null : mysqlDateInShanghai(date);
}

function epochOrDate(value: unknown) {
  const numeric = typeof value === "number" || /^\d+$/.test(String(value)) ? Number(value) : Number.NaN;
  if (Number.isFinite(numeric)) return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000);
  return new Date(String(value));
}

function text(value: unknown) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function first(...values: unknown[]) {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function numberOrZero(value: unknown) {
  return numberOrNull(value) ?? 0;
}

function booleanOrNull(value: unknown) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

function isRecord(value: unknown): value is WanliniuRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const sensitiveKeys = new Set([
  "cellphone", "phone", "mobile", "tel", "telephone", "contacts", "contact",
  "receiver", "receiver_name", "receiver_mobile", "receiver_phone", "buyer_name",
  "address", "receiver_address", "province", "city", "district", "id_card", "identity_card"
]);

function sanitizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveKeys.has(key.toLowerCase()))
      .map(([key, nested]) => [key, sanitizePayload(nested)])
  );
}
