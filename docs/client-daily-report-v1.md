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
| inbound_type | 入库类型 | PURCHASE 采购入库、SALES_RETURN 销售退货入库、UNKNOWN 类型未确认；非入库记录为 null |
| business_date | 业务日期 | 出入库统计所属自然日 |
| inventory_date | 库存日期 | 库存记录的实际快照日期，其他记录为空 |
| shop_name | 店铺名称 | 出库所属店铺；仓库库存、采购入库无店铺归属时为空 |
| storage_name | 仓库名称 | 数据所属仓库 |
| product_code | 产品编码 | 商品条形码（69码），使用字符串；缺失时为 null，不用内部 SKU 代替。少数源条码不是 69 开头的 13 位数字，保留原值供联调核对 |
| product_name | 产品名称 | 字符串 |
| inventory_quantity | 当日库存量 | 库存记录的实际库存数，其他类型为空 |
| outbound_quantity | 当日出库 | 同日、同店铺、同仓库、同产品的出库数量；其他类型为空 |
| inbound_quantity | 当日入库 | 同日、同仓库、同产品、同入库类型的入库数量；非入库记录为空 |
| movement_times | 出入库时间 | 当日业务时间列表，去重、升序，ISO 8601，中国标准时间 +08:00 |
| inventory_as_of | 库存截至时间 | 该库存记录最近同步时间，其他类型为空 |

库存与出入库使用同一套字段，通过 record_type 区分。不要将仓库库存复制到每家店铺累计。空值表示不适用或数据缺失，不能一律替换为零。无论查询哪个业务日，库存返回最近成功同步的当前库存，日期以 inventory_date 为准，不能视为 business_date 当天的历史日末库存；多日结果中的库存不得重复累加。采购入库的业务时间若仅有日期，则时分秒显示 00:00:00，不代表实际操作发生在零点。同一条形码存在不同商品名称时保留多行，不强行合并。

当前仅提供 PURCHASE 采购入库记录，销售退货入库数据尚未提供。SALES_RETURN 为后续接入预留值；当前未返回退货记录不代表该日退货数量为零。采购与退货按 inbound_type 分行，不能将采购入库当作退货入库。正式 API 不含核对 Excel 中临时补充的订单号和单据号。

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
