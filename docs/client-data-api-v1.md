# 甲方经营数据开放 API V1 对接文档

## 1. 接口说明

- 生产地址：`https://ai.miwuj.cn/api/open/v1`
- 数据格式：UTF-8 JSON
- 鉴权方式：HTTP Bearer Token
- 当前版本：`v1`

调用时须携带请求头：

```http
Authorization: Bearer <由小象 G 计划单独提供的 API Token>
Accept: application/json
```

Token 仅在签发时展示一次，请存入服务端密钥管理系统，不要放入网页、App 或代码仓库。不同甲方使用独立 Token，可单独停用和轮换。

## 2. 通用约定

### 2.1 成功响应

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

### 2.2 错误响应

| HTTP 状态 | code | 含义 |
| --- | ---: | --- |
| 401 | `40101` | 未提供 Bearer Token |
| 401 | `40102` | Token 无效、过期或已停用 |
| 403 | `40301` | Token 没有当前资源的读取权限 |
| 400 | `40001` | 日期格式、范围或其他参数错误 |
| 500 | `50001` | 数据服务暂时不可用 |

## 3. 连通性检测

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

## 4. 出货明细

### `GET /shipments`

权限：`shipments:read`

查询参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `start_date` | 是 | 开始日期，`YYYY-MM-DD` |
| `end_date` | 是 | 结束日期，`YYYY-MM-DD`，包含当天 |
| `product_code` | 否 | 产品编码 |
| `page` | 否 | 页码 |
| `page_size` | 否 | 每页数量，最大 200 |

```bash
curl -sS 'https://ai.miwuj.cn/api/open/v1/shipments?start_date=2026-08-19&end_date=2026-08-19&page=1&page_size=100' \
  -H 'Authorization: Bearer <API_TOKEN>'
```

数据字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `shipment_time` | datetime | 出货时间 |
| `shop_name` | string | 店铺名称 |
| `product_code` | string | 产品编码 |
| `product_name` | string | 产品名称 |
| `quantity` | decimal | 出货数量 |
| `gmv` | decimal | 该商品明细的成交金额（元） |

## 5. 当前库存

### `GET /inventory`

权限：`inventory:read`

查询参数：`product_code`、`page`、`page_size` 均为可选。库存无需日期参数，返回当前库存。

```bash
curl -sS 'https://ai.miwuj.cn/api/open/v1/inventory?page=1&page_size=100' \
  -H 'Authorization: Bearer <API_TOKEN>'
```

数据字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `product_code` | string | 产品编码 |
| `product_name` | string | 产品名称 |
| `inventory_quantity` | decimal | 库存数量 |

## 6. 入库明细

### `GET /inbounds`

权限：`inbounds:read`

查询参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `start_date` | 是 | 开始日期，`YYYY-MM-DD` |
| `end_date` | 是 | 结束日期，`YYYY-MM-DD`，包含当天 |
| `product_code` | 否 | 产品编码 |
| `page` | 否 | 页码 |
| `page_size` | 否 | 每页数量，最大 200 |

```bash
curl -sS 'https://ai.miwuj.cn/api/open/v1/inbounds?start_date=2026-08-19&end_date=2026-08-19&page=1&page_size=100' \
  -H 'Authorization: Bearer <API_TOKEN>'
```

数据字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `inbound_time` | datetime | 入库时间 |
| `product_code` | string | 产品编码 |
| `product_name` | string | 产品名称 |
| `inbound_quantity` | decimal | 入库数量 |

## 7. 接入与验收清单

1. 小象 G 计划确认甲方系统名称、联系人，并签发独立 Token。
2. 双方先调用 `/ping` 验证网络和鉴权。
3. 分别读取出货、库存、入库各一页，核对字段类型。
4. 双方选定一个自然日，核对出货数量、GMV、库存数量和入库数量。
5. 验收后约定拉取频率、失败重试与 Token 轮换联系人。

API 的 `/v1` 路径和本文字段在 V1 生命周期内保持兼容；新增可选字段不会影响既有字段。若发生不兼容变更，将发布新版本路径，不要求甲方临时更换现有 V1 接口。
