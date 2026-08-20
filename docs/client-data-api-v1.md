# 甲方经营数据开放 API V1 对接文档

## 1. 接口说明

- 生产地址：`https://ai.miwuj.cn/api/open/v1`
- 数据来源：万里牛 ERP 同步至小象 G 计划经营数据仓库后的标准数据
- 数据格式：UTF-8 JSON
- 鉴权方式：HTTP Bearer Token
- 当前版本：`v1`

调用时须携带请求头：

```http
Authorization: Bearer <由小象 G 计划单独提供的 API Token>
Accept: application/json
```

Token 仅在签发时展示一次，请存入服务端密钥管理系统，不要放入网页、App 或代码仓库。不同甲方使用独立 Token，可单独停用和轮换。

## 2. 什么是映射表

映射表不是另一份需要反复复制的业务数据，而是一组“源口径 → 甲方口径”的实时转换规则。万里牛原始同步表保持不变，API 查询时关联映射规则后返回甲方认可的编码和名称。

例如两个万里牛仓库需要按一个甲方仓库报送：

| 万里牛源仓库 | 甲方目标仓库 |
| --- | --- |
| `CK001` 淘宝仓库 | `CUSTOMER_MAIN` 总仓 |
| `CK002` 天猫仓库 | `CUSTOMER_MAIN` 总仓 |

库存接口会把两条源仓库存量实时合并为 `CUSTOMER_MAIN` 的库存。调整映射规则不需要改接口地址、字段或历史 ODS 数据。未配置映射的店铺、仓库、商品默认返回万里牛原编码和名称，因此可以先联调，再逐步补齐口径。

当前支持三类映射：`shop`（店铺）、`storage`（仓库）、`product`（商品）。

## 3. 通用约定

### 3.1 成功响应

```json
{
  "code": 0,
  "message": "success",
  "request_id": "req_xxx",
  "data": [],
  "pagination": {
    "page": 1,
    "page_size": 100,
    "total": 0,
    "has_more": false
  },
  "generated_at": "2026-08-20T08:00:00.000Z"
}
```

- `page` 默认 `1`。
- `page_size` 默认 `100`，最大 `200`。
- 出货、入库单次最多查询连续 31 个自然日。
- 建议按自然日查询并持续翻页，直到 `has_more=false`。
- 时间字段为 ISO 8601 字符串；业务时间按中国标准时间（Asia/Shanghai）理解。
- 金额单位为人民币元，数量可能包含小数。
- 每个响应头和响应体均带有 `request_id`，联调排错时请提供该值。

### 3.2 错误响应

| HTTP 状态 | code | 含义 |
| --- | ---: | --- |
| 401 | `40101` | 未提供 Bearer Token |
| 401 | `40102` | Token 无效、过期或已停用 |
| 403 | `40301` | Token 没有当前资源的读取权限 |
| 400 | — | 日期格式、范围或其他参数错误 |

## 4. 连通性检测

### `GET /ping`

```bash
curl -sS 'https://ai.miwuj.cn/api/open/v1/ping' \
  -H 'Authorization: Bearer <API_TOKEN>'
```

成功示例：

```json
{
  "code": 0,
  "message": "success",
  "request_id": "req_xxx",
  "client_code": "customer_phase1",
  "api_version": "v1",
  "server_time": "2026-08-20T08:00:00.000Z"
}
```

## 5. 出货明细

### `GET /shipments`

权限：`shipments:read`

查询参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `start_date` | 是 | 开始日期，`YYYY-MM-DD` |
| `end_date` | 是 | 结束日期，`YYYY-MM-DD`，包含当天 |
| `shop_code` | 否 | 映射后的店铺编码 |
| `product_code` | 否 | 映射后的商品编码 |
| `page` | 否 | 页码 |
| `page_size` | 否 | 每页数量，最大 200 |

```bash
curl -sS 'https://ai.miwuj.cn/api/open/v1/shipments?start_date=2026-08-19&end_date=2026-08-19&page=1&page_size=100' \
  -H 'Authorization: Bearer <API_TOKEN>'
```

数据字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `outbound_no` | string | 出库单号，业务定位和去重依据之一 |
| `shipment_time` | datetime | 出货时间 |
| `shop_code` | string | 甲方口径店铺编码；无映射时为源编码/名称 |
| `shop_name` | string | 甲方口径店铺名称 |
| `storage_code` | string | 甲方口径仓库编码 |
| `storage_name` | string | 甲方口径仓库名称 |
| `product_code` | string | 产品编码 |
| `product_name` | string | 产品名称 |
| `quantity` | decimal | 出货数量 |
| `gmv` | decimal | 该商品明细的成交金额（元） |
| `updated_at` | datetime | 本平台最近入仓时间 |

## 6. 当前库存

### `GET /inventory`

权限：`inventory:read`

查询参数：`storage_code`、`product_code`、`page`、`page_size` 均为可选。库存无需日期参数，返回最近一次同步后的当前快照。

```bash
curl -sS 'https://ai.miwuj.cn/api/open/v1/inventory?page=1&page_size=100' \
  -H 'Authorization: Bearer <API_TOKEN>'
```

数据字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `snapshot_at` | datetime | 参与汇总的最新库存快照时间 |
| `storage_code` | string | 甲方口径仓库编码 |
| `storage_name` | string | 甲方口径仓库名称 |
| `product_code` | string | 产品编码 |
| `product_name` | string | 产品名称 |
| `inventory_quantity` | decimal | 库存总数量；多个源仓映射至同一目标仓时自动求和 |
| `available_quantity` | decimal | 可用数量 |
| `locked_quantity` | decimal | 锁定数量 |
| `in_transit_quantity` | decimal | 在途数量 |
| `defect_quantity` | decimal | 次品数量 |
| `updated_at` | datetime | 本平台最近入仓时间 |

## 7. 入库明细

### `GET /inbounds`

权限：`inbounds:read`

查询参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `start_date` | 是 | 开始日期，`YYYY-MM-DD` |
| `end_date` | 是 | 结束日期，`YYYY-MM-DD`，包含当天 |
| `storage_code` | 否 | 映射后的仓库编码 |
| `product_code` | 否 | 映射后的商品编码 |
| `page` | 否 | 页码 |
| `page_size` | 否 | 每页数量，最大 200 |

```bash
curl -sS 'https://ai.miwuj.cn/api/open/v1/inbounds?start_date=2026-08-19&end_date=2026-08-19&page=1&page_size=100' \
  -H 'Authorization: Bearer <API_TOKEN>'
```

数据字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `inbound_no` | string | 入库单号 |
| `inbound_time` | datetime | 入库时间 |
| `storage_code` | string | 甲方口径仓库编码 |
| `storage_name` | string | 甲方口径仓库名称 |
| `supplier_code` | string | 供应商编码 |
| `supplier_name` | string | 供应商名称 |
| `product_code` | string | 产品编码 |
| `product_name` | string | 产品名称 |
| `inbound_quantity` | decimal | 入库数量 |
| `unit` | string | 单位 |
| `unit_price` | decimal | 入库单价 |
| `total_amount` | decimal | 入库金额 |
| `updated_at` | datetime | 本平台最近入仓时间 |

## 8. 接入与验收清单

1. 小象 G 计划确认甲方系统名称、联系人，并签发独立 Token。
2. 双方先调用 `/ping` 验证网络和鉴权。
3. 分别读取出货、库存、入库各一页，核对字段类型。
4. 甲方提供需要合并或改名的店铺、仓库、商品清单，小象 G 计划录入映射规则。
5. 再次调用相同 API，核对映射后的编码、名称和库存汇总口径。
6. 双方选定一个自然日，与万里牛后台数据核对数量、GMV 和入库数量。
7. 验收后约定拉取频率、失败重试与 Token 轮换联系人。

API 的 `/v1` 路径和本文字段在 V1 生命周期内保持兼容；新增可选字段不会影响既有字段。若发生不兼容变更，将发布新版本路径，不要求甲方临时更换现有 V1 接口。
