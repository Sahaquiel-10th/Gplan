# 薇诺娜经营数据 API 接入说明

## 连接信息

基础地址：`https://ai.miwuj.cn/api/open/v1`

使用独立签发的 API Token，通过 HTTPS GET 请求读取。Token 放在请求头，不放在 URL 中：

```http
Authorization: Bearer <API_TOKEN>
Accept: application/json
```

当前凭证为长期有效凭证，不设到期时间，可单独撤销或更换。接口支持读取现有业务日期的数据，不再限定为样板日。现有业务数据最早从 2026-06-04 起，不同记录类型的实际覆盖范围以返回数据为准。

后台每天北京时间 03:00 开始同步，同步成功后自动更新前一天的对外数据。查询其他日期时自动提供现有数据，无需逐日申请发布。建议查询前一自然日；当天数据可能尚不完整。未来日期或早于现有数据起始日期的请求返回 404。首次查询一个历史日可能需要数秒，建议客户端使用 60 秒超时。

## 接口

`GET /ping`：验证连接与 Token。

`GET /daily-report?date=2026-10-13&page=1&page_size=200`：获取一张统一结构的数据表，返回 JSON 行数组。

`GET /after-sales?date=2026-11-19&page=1&page_size=200`：查询该申请创建日、当前仍有效且尚未全部实收的退款／退货／换货申请。单独返回申请信息，不计实际入库，不混入 `/daily-report`。

两个接口沿用同一基础地址和现有 Token，均使用 `daily-report:read` 读取权限。`date`、分页、条码筛选和 `batch_id` 参数规则相同。每个接口分别完整翻页、整日覆盖，不要将售后申请数量加到实际入库。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| date | 是 | 业务日期，YYYY-MM-DD |
| page | 否 | 从 1 开始，默认 1 |
| page_size | 否 | 默认 100，最大 200 |
| product_code | 否 | 按商品条形码精确筛选，字符串 |
| batch_id | 否 | 翻页时填写第一页返回的批次，保证读取同一批数据 |

## 统一表字段

| 字段 | 中文 | 类型与含义 |
| --- | --- | --- |
| record_type | 记录类型 | outbound 出库、inbound 入库、inventory 库存 |
| inbound_type | 入库类型 | PURCHASE、TRANSFER、SALES_RETURN 及下方新增类型；非入库记录为 null |
| outbound_type | 出库类型 | SALES、OFFLINE_SALES、TRANSFER 及下方新增类型；非出库记录为 null |
| business_date | 业务日期 | 出入库统计所属自然日 |
| inventory_date | 库存日期 | 库存记录的实际快照日期，其他记录为空 |
| shop_name | 店铺名称 | 销售出库所属店铺；调拨、入库和仓库库存为仓库维度，店铺为空 |
| storage_name | 仓库名称 | 数据所属仓库 |
| product_code | 产品编码 | 商品条形码（69码），使用字符串；缺失时为 null，不用内部 SKU 代替。少数源条码不是 69 开头的 13 位数字，保留原值供联调核对 |
| product_name | 产品名称 | 字符串 |
| inventory_quantity | 当日库存量 | 库存记录的实际库存数，其他类型为空 |
| outbound_quantity | 当日出库 | 同日、同店铺、同仓库、同产品、同出库类型的出库数量；其他类型为空 |
| inbound_quantity | 当日入库 | 同日、同仓库、同产品、同入库类型的入库数量；非入库记录为空 |
| movement_times | 出入库时间 | 当日业务时间列表，去重、升序，ISO 8601，中国标准时间 +08:00 |
| inventory_as_of | 库存截至时间 | 该库存记录最近同步时间，其他类型为空 |
| source_documents | 实际单据 | 新增库存流水对应的 ERP 实际单号列表，旧来源可能为空数组 |
| source_orders | 关联业务单 | 已匹配的加工单或其他业务单编号列表，只作关联说明，不再累计数量 |
| operation_type | 加工类型 | ASSEMBLY 组装、DISASSEMBLY 拆卸；未关联到加工类型时为 null。保留ERP登记类型，不根据商品名猜测 |
| business_reason | 业务原因 | 对应其他出入库单的 ERP 原始业务原因，缺失时为 null |

### 2026-11-20 客户确认增加的口径

| 客户确认项目 | 实际返回方式 |
| --- | --- |
| 采购退货出库 | outbound，outbound_type=PURCHASE_RETURN |
| 盘盈调整 | inbound，inbound_type=INVENTORY_GAIN，只计实际差额 |
| 盘亏调整 | outbound，outbound_type=INVENTORY_LOSS，只计实际差额 |
| 其他入库 | inbound，inbound_type=OTHER |
| 其他出库 | outbound，outbound_type=OTHER |
| 调拨还回 | 按实际库存方向返回 TRANSFER_RETURN 入库或出库 |
| 加工领料／原材料出库 | outbound，outbound_type=PRODUCTION_MATERIAL |
| 加工退料入库 | inbound，inbound_type=PRODUCTION_MATERIAL_RETURN |
| 加工成品入库 | inbound，inbound_type=PRODUCTION_FINISHED |
| 成品取消／加工撤销 | 以实际冲回方向返回 PRODUCTION_CANCEL 入库或出库，不按关闭订单虚构数量 |
| 组装／拆包／换规格 | 返回实际材料、成品规格的增减，通过 operation_type、business_reason 和关联单据核对；其他实际加工调整为 PRODUCTION_ADJUSTMENT，不将加工计划再算一次出入库 |
| 退款／退货申请未实际收货 | 使用 `/after-sales`，inventory_effect=false，不进入实际出入库表 |

新增实际变动按库存流水唯一标识保存，重复同步不会再次累加。同一调拨实际变动只计一次，不同时累加单据来源与流水来源。数量保留实际方向及冲回：例如其他出库的冲回可能返回负的 outbound_quantity，不能再次取绝对值扣减。不同包装规格的原材料与成品数量不要求相等，也不得合并成同一库存规格。

同日同条码可能因类型、加工模式、业务原因不同而返回多行。请保留所有返回行，按所需维度汇总，不以条码作唯一键删除或覆盖行。

库存与出入库使用同一套字段，通过 record_type 区分。不要将仓库库存复制到每家店铺累计。空值表示不适用或数据缺失，不能一律替换为零。历史查询返回该业务日已保存的库存记录，不再使用查询当天的库存代替。库存实际时点以 inventory_date 和 inventory_as_of 为准：可能是当日日末，也可能是次日凌晨的库存采样，不能仅凭 business_date 推断。多日库存余额不得累加。采购或调拨单的业务时间若仅有日期，则时分秒显示 00:00:00，不代表实际操作发生在零点。同一条形码可能对应独立商品记录，不能自行按条码删除记录或将数量除以二。

响应新增 inventory_status 对象：status 为 complete（该库存时点记录完整）、partial（存在已知缺口）或 unavailable（无可核验的历史库存）；missing_rows 为已知缺口行数，message 为必要说明。unavailable 时不会用当前库存填充历史数据，入库、出库记录仍可正常返回；partial 时未知库存可为 null 或未返回，不能视为零。原 URL、Token、分页方式和现有业务字段不变。修正数据会生成新 batch_id，收到 40901 时应从第一页重新读取，并覆盖对应业务日期的旧数据，不要追加累加。

2026-11-19 已增加调拨出库、调拨入库和销售退货入库。2026-11-20 在此基础上补充客户选定口径。已有销售、采购、退货和调拨继续提供，不以申请数量代替实际过账，也不因同一调拨申请编号去掉另一端。新增 source_documents、source_orders 只提供真实 ERP 单据关联，不提供买家信息或平台订单个人信息。

所有类型均严格限制 ERP 品牌分类为“薇诺娜”，仓库为 CK001 淘宝仓库、CK008 奕页仓库；销售出库继续限制在约定的 13 个店铺来源，未收货售后也受相同店铺限制。仓库级入库、调拨、盘点、其他出入库、加工没有店铺归属，shop_name 为 null。未单独扩展客户未选的报损报溢、正次转换、门店配送等其他独立类型；如这些业务已生成所提供的其他出入库实账，则按该实账计一次，不再重复。当前表仍不能认定为 ERP 所有类型的完整库存流水。

movement_status 的 status 为 complete、partial 或 unavailable，available_from 为当前所选口径共同覆盖的起始日期，synced_through 为相关来源保守的已完成查询时点。新增口径按客户确认从 2026-08-23 起回补；更早未覆盖的新增类型不能按零处理，已有来源仍按实际覆盖提供。complete 仅表示所选口径在已完成查询窗口内，不代表 ERP 所有类型或实时库存已对齐。当日数据仍可能不完整，后补业务会在后续同步更新。无法匹配商品身份、不能确认品牌的记录不提供，以 partial 和 unresolved_rows 标明缺口。

### 未收货售后字段

`/after-sales` 返回 `after_sales_status` 完整性信息和 `inventory_effect=false`。`data` 中每条记录包含：

| 字段 | 含义 |
| --- | --- |
| record_type | 固定为 after_sales_request，与真实库存表隔离 |
| document_no | ERP 系统售后单号 |
| business_date | 申请创建日，非历史库存时点 |
| shop_name、storage_name、product_code、product_name | 授权范围内店铺、仓库和商品 |
| request_type | RETURN 退货、EXCHANGE 换货、REFUND_ONLY 仅退款 |
| request_status | 保留ERP状态码：-2／-1待审核、0处理中、1完成；关闭、拒绝、取消的申请不在当前有效列表返回 |
| request_quantity | 申请涉及的商品数量，不是实际入库量 |
| received_quantity | 源系统实际实收数量，未知为 null |
| unreceived_quantity | 源申请数量减实收数量，未知为 null；不是预计入库量或在途库存，尤其仅退款不代表需要收回货物 |
| receipt_status | NOT_RECEIVED、PARTIALLY_RECEIVED 或 UNKNOWN |
| refund_status | 保留源明细退款状态码，不据退款成功推断已收货 |
| created_at、last_modified_at | 源申请创建、最后修改时间 |
| inventory_effect | 固定 false，不计实际入库、出库或库存余额 |

售后数据来源为 ERP 系统售后单，不等同于平台全部退款或支付流水。查询某个创建日，返回该日申请在最近一次同步时的当前状态，不是该日结束时的历史状态快照。旧申请后续收货、关闭或取消后，需重新拉取对应申请创建日并整批覆盖。`after_sales_status` 为 partial／unavailable 时不将未返回或未知实收按零处理；unknown_receipt_rows 表示实收数量未知的已列示行数。实际已收货数量的库存影响仍以真实销售退货入库为准，不能与申请再加一次。

### 来源与核验依据

类型来自[万里牛库存流水定义](https://hpublic.hupun.com/mp/open/md/erp/open/inventory/stream/query.md)，加工关联来自[加工订单查询](https://hpublic.hupun.com/mp/open/md/erp/product/bill/page.md)，未收货信息来自[系统售后单V2](https://hpublic.hupun.com/mp/open/md/erp/open/return/order/v2/list.md)。读取接口使用[官方调用及签名规范](https://hpublic.hupun.com/mp/open/doc/pub-api-spec.json)。新增来源通过共享频次控制读取，源平台限制或单页失败时保留进度，未完成的范围不推进完整覆盖标记。

## 调用频率

目前本接口应用层及已核查的 Nginx 配置未设置固定 QPS 限流，也没有按 Token 设置每日或每月调用次数配额。这不表示已承诺无限吞吐能力。联调建议单并发、最多每秒 2 次请求，按顺序翻页；此为调用建议，不是服务器强制限额。每页默认 100 行，最大 200 行，不限制同一已发布日期的重复读取次数。请求失败时建议按 1、2、4 秒退避重试，最多 3 次；401、403、400、404 不要持续重试，409 请从第一页重拉。若收到 429，应遵循 Retry-After（如提供）。

## 请求示例

```bash
export DATA_API_TOKEN='单独提供的Token'
curl --fail-with-body --get 'https://ai.miwuj.cn/api/open/v1/daily-report' \
  -H "Authorization: Bearer $DATA_API_TOKEN" \
  --data-urlencode 'date=2026-10-13' \
  --data-urlencode 'page=1' \
  --data-urlencode 'page_size=200'
```

响应结构：

```json
{
  "code": 0,
  "message": "success",
  "request_id": "req_xxx",
  "business_date": "2026-10-13",
  "batch_id": "batch_xxx",
  "data_updated_at": "2026-10-15T12:00:00+08:00",
  "data": [],
  "pagination": {"page": 1, "page_size": 200, "total": 0, "has_more": false}
}
```

data 是上表所述对象的数组。持续请求下一页并携带 batch_id，直到 has_more=false。再次拉取同一天时，以完整批次替换该日已有数据，避免重复追加。

## Node.js 20+ 调用示例

将以下代码保存为 `test-data-api.mjs`，设置环境变量后执行 `node test-data-api.mjs`。程序在全部页面成功后输出 JSON 文件，可直接作为其他项目的接入起点。

```js
import fs from 'node:fs/promises';
const token = process.env.DATA_API_TOKEN;
if (!token) throw new Error('请设置 DATA_API_TOKEN');
const date = process.env.DATA_API_DATE || new Date(Date.now() + 8*3600000 - 86400000).toISOString().slice(0,10);
const rows = [];
let batch;
for (let page = 1; ; page++) {
  const url = new URL('https://ai.miwuj.cn/api/open/v1/daily-report');
  url.search = new URLSearchParams({date, page: String(page), page_size: '200', ...(batch ? {batch_id: batch} : {})});
  const response = await fetch(url, {
    headers: {Authorization: `Bearer ${token}`},
    signal: AbortSignal.timeout(60000)
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) throw new Error(JSON.stringify(body));
  batch = body.batch_id;
  rows.push(...body.data);
  if (!body.pagination.has_more) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
await fs.writeFile(`data-${date}.json`, JSON.stringify({date, batch_id: batch, data: rows}, null, 2));
console.log(`已读取 ${rows.length} 行`);
```

## 排错与验收

401：Token 缺失或失效。403：无该接口权限。400：日期参数错误。404：日期不在现有数据范围内。409：翻页期间批次改变，从第一页重拉。500：服务异常，请提供 request_id。

联调时核对：字段类型、69码、店铺名称、数量汇总、业务时间、分页总条数。当前接口提供只读权限；数据调整由服务方发布新批次。URL 与 V1 字段保持兼容。
