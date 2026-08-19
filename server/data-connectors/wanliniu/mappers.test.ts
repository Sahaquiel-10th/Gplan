import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeInbound,
  normalizeInventory,
  normalizeOutbound,
  normalizeProducts,
  normalizeShop
} from "./mappers.js";

test("店铺映射会剔除联系人敏感字段", () => {
  const result = normalizeShop({
    shop_uid: "shop-1",
    shop_name: "旗舰店",
    cellphone: "13800000000",
    contacts: "张三"
  });
  assert.equal(result.shopUid, "shop-1");
  assert.equal(result.shopName, "旗舰店");
  assert.equal("cellphone" in result.rawPayload, false);
  assert.equal("contacts" in result.rawPayload, false);
});

test("商品映射会把商品下的规格展开为 SKU 行", () => {
  const result = normalizeProducts({
    goods_code: "G-1",
    goods_name: "测试商品",
    specs: [
      { spec_code: "SKU-1", spec1: "红色", barcode: "6901" },
      { spec_code: "SKU-2", spec1: "蓝色", barcode: "6902" }
    ]
  });
  assert.deepEqual(result.map((item) => item.skuCode), ["SKU-1", "SKU-2"]);
  assert.equal(result[0].goodsName, "测试商品");
});

test("库存、出库和入库映射保留第一期所需维度", () => {
  const inventory = normalizeInventory({
    storage_code: "WH-1",
    sku_code: "SKU-1",
    quantity: "12.5",
    lock_size: 2
  }, "2026-08-19 10:00:00.000");
  assert.equal(inventory.actualQuantity, 12.5);
  assert.equal(inventory.lockedQuantity, 2);

  const outbound = normalizeOutbound({
    inv_uid: "OUT-1",
    bill_date: "2026-08-18 09:00:00",
    shop_name: "旗舰店",
    details: [{ sku_no: "SKU-1", goods_name: "测试商品", nums: 3, actual_pay: 99 }]
  });
  assert.equal(outbound.shopName, "旗舰店");
  assert.equal(outbound.items[0].skuCode, "SKU-1");
  assert.equal(outbound.items[0].quantity, 3);
  assert.equal(outbound.items[0].actualPaidAmount, 99);

  const inbound = normalizeInbound({
    stock_code: "IN-1",
    bill_date: "2026-08-17 08:00:00",
    details: [{ spec_code: "SKU-1", goods_name: "测试商品", nums: 8 }]
  });
  assert.equal(inbound.items[0].skuCode, "SKU-1");
  assert.equal(inbound.items[0].quantity, 8);
});

test("重复或异常入库明细序号会生成唯一行号", () => {
  const result = normalizeInbound({
    stock_code: "IN-2",
    details: [
      { index: 2, spec_code: "SKU-1" },
      { index: 2, spec_code: "SKU-2" },
      { index: 1, spec_code: "SKU-3" }
    ]
  });
  assert.equal(new Set(result.items.map((item) => item.lineNo)).size, 3);
});
