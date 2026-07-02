# AI 问数平台数据接入方案

## 目标

后续平台会接入公司经营数据，包括店铺经营数据、订单、库存、仓库、银行日记账、账户余额等，让员工可以用自然语言问数，并让特定智能体完成经营分析、活动复盘、库存预警、现金流分析等任务。

核心目标不是让大模型直接访问所有 API，而是把 API、数据库、权限、指标口径封装成稳定的数据能力，让 AI 在受控范围内调用。

## 总体结论

推荐采用“同步为主，实时补充”的架构：

```text
用户问题
→ AI 意图识别
→ 指标/工具路由
→ 权限校验
→ 查本地数据仓库或实时 API
→ 返回结构化数据
→ AI 生成分析
→ 保存查询记录、缓存结果、沉淀分析模板
```

不要让 AI 直接在原始 API 列表里自由选择接口。这样短期能跑，但后期数据源变多后会出现口径混乱、权限难控、缓存失效、分析结果不稳定的问题。

## 四层架构怎么放

### 1. 数据源层

数据源层保留在各业务系统里，不直接迁移业务系统。

当前可预期的数据源：

- 万里牛/ERP：店铺、订单、商品、库存、仓库、售后、采购等。
- 银行：账户余额、银行日记账、交易流水、回单、对账单。
- 后续其他系统：广告投放、会员、客服、财务软件、BI 表格等。

这一层只负责提供原始数据，不负责 AI 分析。

### 2. 数据接入层

这一层建议放在本平台后端，作为独立模块，不放在前端，也不放在大模型中转站。

建议职责：

- 管理不同数据源的 API 凭证。
- 定时拉取店铺、订单、库存、银行流水等数据。
- 做 API 签名、分页、限流、失败重试。
- 记录同步状态、同步时间、水位游标。
- 对实时数据提供按需查询能力。

建议实现形态：

```text
server/data-connectors/
  wanliniu/
  bank/
  warehouse/
server/jobs/
  sync-orders.ts
  sync-inventory.ts
  sync-bank-journal.ts
```

生产上建议由定时任务或队列触发，而不是由用户提问直接触发所有同步。

### 3. 数据仓库/业务数据库层

这一层建议使用平台自己的数据库。

如果当前只是内部测试，可以先用 MySQL。数据量上来后，再考虑 ClickHouse、Doris、PostgreSQL、云数据库分析版或其他数仓。

建议先建两类表：

原始镜像表：

- `raw_erp_orders`
- `raw_erp_stores`
- `raw_erp_inventory`
- `raw_erp_warehouses`
- `raw_bank_transactions`
- `raw_bank_accounts`

指标汇总表：

- `dm_store_daily_summary`
- `dm_product_daily_summary`
- `dm_inventory_daily_snapshot`
- `dm_promotion_effect_summary`
- `dm_cash_daily_summary`

原始表用于追溯和补算，汇总表用于 AI 快速问数。

### 4. 指标语义层

这是最关键的一层，建议也放在本平台后端。

它把业务语言翻译成稳定的数据能力，例如：

- 店铺销售额
- 订单数
- 客单价
- 退款金额
- 退款率
- 毛利
- 库存数量
- 库存周转
- 活动前后对比
- 银行账户余额
- 银行流水收入/支出
- 现金流净额

每个指标需要定义：

- 指标名称
- 业务解释
- 可用维度，例如店铺、商品、平台、仓库、时间
- 数据来源
- SQL 或 API 工具
- 时间口径
- 权限要求
- 缓存策略
- 返回字段结构

AI 不直接查表，不直接拼 SQL，而是调用后端暴露出来的指标工具。

示例：

```json
{
  "tool": "get_store_daily_summary",
  "params": {
    "store_id": "xxx",
    "date_range": ["2026-07-01", "2026-07-01"],
    "metrics": ["gmv", "orders", "aov", "refund_amount"]
  }
}
```

### 5. AI 问数层

这一层放在当前聊天/智能体体系里。

AI 的职责是：

- 理解用户问题。
- 补全时间、店铺、指标、对比区间。
- 选择合适的数据工具。
- 读取结构化结果。
- 生成中文解释、经营判断、风险提示和建议动作。

对于经营分析智能体，可以预置分析框架，例如：

- 昨日经营日报
- 店铺经营概览
- 大促复盘
- 商品销售结构分析
- 库存预警
- 现金流日报

## 万里牛/ERP 数据怎么接

从万里牛开放平台公开说明看，它是典型开放平台模式：

- 通过开放平台创建应用。
- 使用 `app_key`、签名、时间戳等鉴权参数。
- API 返回授权用户在 ERP 中的数据。
- 接口采用 REST 风格。
- 文档中有店铺、订单、商品、库存、仓库等接口分类。

用户给的接口地址：

```text
https://open.hupun.com/api-doc/erp/base/distr/com/page/get
```

从路径看，`base/distr/com/page/get` 更像是基础资料里的店铺/渠道/经销商类分页查询接口。具体字段需要登录开放平台后查看完整接口文档。

建议接入方式：

1. 先接基础资料：
   - 店铺列表
   - 仓库列表
   - 商品列表
   - 类目/品牌/平台资料

2. 再接经营流水：
   - 订单
   - 售后/退款
   - 发货
   - 采购
   - 入库/出库

3. 最后接快照和汇总：
   - 库存快照
   - 店铺日汇总
   - 商品日汇总

同步策略：

- 基础资料：每 1-6 小时同步一次。
- 订单/售后：每 5-15 分钟增量同步一次。
- 库存：每 15-60 分钟同步一次，重要仓库可实时查。
- 历史数据：首次接入时按月份或日期分批拉取。

不要在用户每次提问时都直接查万里牛。订单、库存、店铺经营这种数据非常适合先同步进本平台数据库，再让 AI 查询本地指标。

### 万里牛接入落到四层里

数据源层：

- 万里牛 ERP 开放平台。
- 主要对象包括店铺、仓库、商品、订单、售后、库存、采购、入库、出库。

数据接入层：

- 新增 `wanliniu` 连接器。
- 负责 app_key、secret、签名、时间戳、分页、重试、接口限流。
- 按接口族拆成独立同步任务：
  - `sync-wanliniu-stores`
  - `sync-wanliniu-warehouses`
  - `sync-wanliniu-products`
  - `sync-wanliniu-orders`
  - `sync-wanliniu-refunds`
  - `sync-wanliniu-inventory`

数据库层：

- `raw_wanliniu_stores`
- `raw_wanliniu_warehouses`
- `raw_wanliniu_products`
- `raw_wanliniu_orders`
- `raw_wanliniu_refunds`
- `raw_wanliniu_inventory_snapshots`
- `dm_store_daily_summary`
- `dm_product_daily_summary`
- `dm_inventory_daily_snapshot`
- `dm_promotion_effect_summary`

指标语义层：

- `get_store_daily_summary`
- `get_store_trend`
- `get_product_sales_rank`
- `get_inventory_snapshot`
- `get_inventory_warning`
- `get_promotion_effect`

AI 问数层：

- 店铺经营分析智能体。
- 大促复盘智能体。
- 库存预警智能体。
- 商品销售分析智能体。

第一版建议只做店铺经营闭环：

```text
店铺列表
→ 订单
→ 售后/退款
→ 店铺日汇总
→ 店铺经营概览工具
→ 店铺经营分析智能体
```

## 银行日记账怎么接

银行数据接入通常比 ERP 难，主要有三种方案。

### 方案 A：银行银企直联

适合长期、正规、稳定接入。

能力通常包括：

- 账户余额查询
- 交易明细查询
- 回单下载
- 对账单
- 转账付款
- 银企对账

优点：

- 数据权威。
- 稳定性较好。
- 适合财务系统正式使用。

缺点：

- 每家银行接口不同。
- 通常需要企业网银、证书、专线或安全控件。
- 开通流程依赖开户行和客户经理。
- 开发和联调周期较长。

如果公司主要就 1-2 家银行账户，优先考虑银企直联。

### 方案 B：开放银行 API

部分银行有开放银行平台，可以申请企业账户相关 API。

优点：

- 更接近现代 API。
- 文档和开发体验通常比传统银企直联好。

缺点：

- 能力开放程度因银行而异。
- 很多账户流水/余额能力仍然需要企业授权和线下开通。
- 不一定覆盖所有银行。

### 方案 C：第三方聚合服务

由第三方服务商统一对接多家银行。

优点：

- 接入多个银行更省事。
- API 统一。
- 实施速度可能更快。

缺点：

- 增加服务费。
- 数据安全、合规、合同、权限边界要重点评估。
- 财务数据敏感，客户未必接受第三方中转。

如果客户银行账户很多，且希望快速接入多家银行，可以评估第三方聚合；如果客户对财务数据非常敏感，优先走银行官方能力。

### 当前银行/账户来源接入判断

当前需要考虑的数据源：

- 交通银行
- 浙江网商银行
- 招商银行
- 企业支付宝
- 企业支付宝-余利宝
- 浙江余杭农商银行
- 杭州银行
- 中国民生银行
- 中国农业银行
- 中国工商银行
- 上海浦东发展银行
- 泰隆银行

总体判断：

- 企业支付宝和余利宝最像互联网开放平台，优先级可以靠前。
- 招商银行、工商银行、农业银行、交通银行、民生银行、浦发银行、杭州银行通常都有银企直联/银企互联/现金管理能力，但接口文档和开通一般需要企业网银、客户经理或银行后台提供。
- 浙江网商银行是互联网银行，可能有开放银行或企业网银能力，但企业账户流水/余额仍需要企业授权。
- 浙江余杭农商银行、泰隆银行更可能依赖本地银行银企直联或企业网银导出，开放 API 的公开资料通常不如大行完整，需要先找客户经理确认。

### 接入矩阵

| 数据源 | 推荐第一方案 | 可查能力 | 接入难度 | 第一版建议 |
| --- | --- | --- | --- | --- |
| 企业支付宝 | 支付宝开放平台 | 账务明细、交易订单、资金流水、余额类能力视产品权限而定 | 中 | 优先接，适合做收款、退款、支付渠道流水 |
| 企业支付宝-余利宝 | 支付宝开放平台/网商银行相关能力 | 余额、收益、转入转出流水，具体以已开通产品为准 | 中高 | 先确认是否有开放接口；没有接口就先做账单下载/导入 |
| 招商银行 | CBS/银企直联/企业网银现金管理 | 余额、交易明细、电子回单、对账单 | 中高 | 优先接，招行企业接口生态相对成熟 |
| 中国工商银行 | 银企互联/开放银行/企业网银 | 余额、明细、回单、对账 | 中高 | 优先接，但需要客户经理提供接口资料 |
| 中国农业银行 | 银企通/银企直联/企业网银 | 余额、明细、回单、对账 | 中高 | 优先接，但按银行项目制联调 |
| 交通银行 | 银企直联/企业网银 | 余额、明细、回单、对账 | 中高 | 可接，需开通银企直联或获取接口包 |
| 中国民生银行 | 银企直联/现金管理 | 余额、明细、回单、对账 | 中高 | 可接，需客户经理和企业网银配合 |
| 上海浦东发展银行 | 银企直联/企业网银/现金管理 | 余额、明细、回单、对账 | 中高 | 可接，需银行侧开通 |
| 杭州银行 | 银企直联/现金管理/企业网银 | 余额、明细、回单、对账 | 中高 | 可接，先确认企业账户服务能力 |
| 浙江网商银行 | 开放银行/企业网银/网商银行企业服务 | 余额、流水、账单，具体看企业账户产品 | 中高 | 先确认客户是否有企业账户开放接口权限 |
| 浙江余杭农商银行 | 企业网银/银企直联/本地银行接口 | 余额、明细、回单，具体看开户行能力 | 高 | 先找客户经理确认，不建议第一批开发；如果实际归属杭州联合银行体系，可参考其银企直联开通方式 |
| 泰隆银行 | 企业网银/银企直联/本地银行接口 | 余额、明细、回单，具体看开户行能力 | 高 | 先找客户经理确认，不建议第一批开发 |

### 银行接入落到四层里

数据源层：

- 各银行企业网银、银企直联、开放银行、支付宝开放平台。
- 第一版只读取数据，不做付款、转账、审批。

数据接入层：

- 新增统一 `bank` 连接器框架。
- 每家银行或平台做一个 adapter：
  - `bank-adapter-alipay`
  - `bank-adapter-cmb`
  - `bank-adapter-icbc`
  - `bank-adapter-abc`
  - `bank-adapter-bocom`
  - `bank-adapter-cmbc`
  - `bank-adapter-spdb`
  - `bank-adapter-hzbank`
  - `bank-adapter-mybank`
  - `bank-adapter-yhrcb`
  - `bank-adapter-tailong`
- adapter 对外统一输出本平台标准字段，不把各银行原始字段直接暴露给 AI。

数据库层：

- `raw_bank_accounts`
- `raw_bank_transactions`
- `raw_bank_receipts`
- `raw_bank_statements`
- `raw_alipay_transactions`
- `raw_yulibao_transactions`
- `dm_cash_daily_summary`
- `dm_cash_account_daily_summary`
- `dm_cash_counterparty_summary`

指标语义层：

- `get_cash_balance`
- `get_cash_daily_summary`
- `get_bank_transactions`
- `get_cash_in_out_trend`
- `get_counterparty_summary`
- `get_unusual_cash_movement`
- `get_store_cash_reconciliation`

AI 问数层：

- 现金流日报智能体。
- 银行日记账查询智能体。
- 收支异常分析智能体。
- 店铺收入和支付宝/银行到账对账智能体。

### 银行连接器标准输出

不管来自哪家银行，连接器都应该输出统一结构。

账户：

```json
{
  "source": "cmb",
  "account_id": "internal-account-id",
  "bank_name": "招商银行",
  "account_name": "杭州某某有限公司",
  "account_no_masked": "****1234",
  "currency": "CNY",
  "available_balance": 100000.12,
  "book_balance": 100000.12,
  "balance_time": "2026-07-02T10:00:00+08:00"
}
```

流水：

```json
{
  "source": "cmb",
  "transaction_id": "source-serial-no",
  "account_id": "internal-account-id",
  "transaction_time": "2026-07-02T09:31:20+08:00",
  "direction": "income",
  "amount": 1200.5,
  "balance_after": 99120.3,
  "counterparty_name": "某某公司",
  "counterparty_account_masked": "****9876",
  "summary": "货款",
  "purpose": "销售回款",
  "bank_serial_no": "bank-flow-no",
  "raw_payload": {}
}
```

### 银行第一版优先级

第一批建议：

1. 企业支付宝。
2. 招商银行。
3. 工商银行。
4. 农业银行。
5. 交通银行。

第二批建议：

1. 民生银行。
2. 浦发银行。
3. 杭州银行。
4. 浙江网商银行。

第三批建议：

1. 浙江余杭农商银行。
2. 泰隆银行。

原因：

- 第一批覆盖面更大，接口生态更成熟，企业客户经理也更容易配合。
- 第二批可以接，但需要逐家确认开通方式。
- 第三批本地银行公开开发资料通常更少，容易变成项目制联调，不适合作为第一阶段主线。

## 银行数据建议怎么进入 AI 平台

银行日记账不要让 AI 直接查银行接口。

建议流程：

```text
银行接口/银企直联
→ 本平台银行连接器
→ raw_bank_transactions
→ dm_cash_daily_summary
→ 指标工具
→ AI 现金流分析智能体
```

建议核心表：

`raw_bank_accounts`

- account_id
- bank_name
- account_name
- account_no_masked
- currency
- status
- last_synced_at

`raw_bank_transactions`

- transaction_id
- account_id
- bank_name
- transaction_time
- direction
- amount
- balance_after
- counterparty_name
- counterparty_account_masked
- summary
- purpose
- bank_serial_no
- raw_payload
- synced_at

`dm_cash_daily_summary`

- date
- account_id
- opening_balance
- closing_balance
- income_amount
- expense_amount
- net_cash_flow
- transaction_count

权限要求：

- 默认普通员工不应可见银行流水。
- 银行数据至少按角色、账号、账户维度授权。
- AI 输出中应避免暴露完整账号、对手方账号等敏感信息。
- 所有查询必须记录审计日志。
- 银行/支付宝凭证必须加密保存，不放在前端，不进入大模型上下文。
- 第一版只读，不做付款、转账、提现、理财赎回等资金动作。
- 如果后续涉及付款，必须单独设计审批流、双人复核、操作签名、额度限制和审计。

## 缓存策略

可以缓存，但不要按自然语言问题缓存。

不建议：

```text
问题文本 = “昨天 xx 店铺经营情况怎么样？”
直接缓存最终回答
```

建议缓存结构化查询结果：

```text
tool_name
user_id / role_id
permission_scope
store_id / account_id
date_range
metrics
data_version
ttl
```

建议 TTL：

- 昨日及更早经营数据：6-24 小时。
- 今日经营数据：1-5 分钟。
- 库存：1-15 分钟。
- 银行余额：30 秒-5 分钟。
- 银行历史流水：1-24 小时，视银行更新规则决定。

## 典型问题如何执行

### 昨天 xx 店铺经营情况怎么样？

执行步骤：

1. 识别时间：昨天。
2. 识别对象：xx 店铺。
3. 识别任务：经营概览。
4. 调用指标工具：
   - 销售额
   - 订单数
   - 客单价
   - 退款金额
   - 退款率
   - 商品销售排行
   - 环比/同比
5. AI 输出：
   - 核心结论
   - 异常变化
   - 可能原因
   - 建议动作

### 我前两天做的大促，活动效果如何？

执行步骤：

1. 确认活动时间。如果用户说“前两天”，需要解析为具体日期，也可以追问。
2. 确认对比基准，例如活动前 7 天、上周同期、去年同期。
3. 调用指标工具：
   - 活动期销售额
   - 对比期销售额
   - 订单数变化
   - 客单价变化
   - 退款变化
   - 商品结构变化
   - 新老客变化，如果有会员数据
   - 优惠成本/广告成本，如果有投放数据
   - 库存消耗
4. AI 输出：
   - 活动是否有效
   - 有效在哪里
   - 问题在哪里
   - 后续复盘建议

## 第一阶段落地建议

第一阶段不要贪多，建议只做“店铺经营问数”闭环。

优先级：

1. 数据库表设计。
2. 万里牛店铺列表同步。
3. 万里牛订单/售后同步。
4. 店铺日汇总表。
5. 指标工具：店铺经营概览。
6. 智能体：店铺经营分析。
7. 查询审计日志。
8. 权限：先按管理员/员工粗粒度控制，后续再做店铺级权限。

第二阶段再接：

- 库存快照
- 商品销售排行
- 大促复盘智能体

第三阶段接：

- 银行余额
- 银行日记账
- 现金流日报智能体

## 当前先做的工程落点

第一版先接两个数据源：

- 万里牛 ERP：负责店铺、订单、售后、库存、仓库等经营数据。
- 企业支付宝：负责企业支付宝账务明细、余额、提现/转账/退款等资金流水。

后台入口：

```text
管理后台
→ 模型充值后台
→ 数据接入
```

这个页面不是普通员工入口，只给管理员在受保护后台里查看。页面会展示：

- 数据源层：已经登记哪些数据源。
- 数据接入层：每个数据源凭证是否配置、是否可以进入联调。
- 业务数据库层：哪些原始表和汇总表会承接这些数据。
- 指标语义层：后续 AI 能调用哪些指标工具。
- AI 问数层：这些指标会服务哪些智能体。
- 接入留痕：每次检测凭证、手动同步、定时同步都生成记录。

### 前端会看到什么

前端只展示管理状态，不展示密钥明文。

管理员能看到：

- 数据源名称，例如万里牛 ERP、企业支付宝。
- 需要配置的环境变量名。
- 哪些环境变量缺失。
- 最近检测时间。
- 最近同步时间。
- 手动检测凭证按钮。
- 手动同步按钮。
- 指标工具清单。
- 最近接入留痕。

管理员看不到：

- 万里牛 app secret 明文。
- 支付宝私钥明文。
- 银行证书、密钥、账号完整号码。
- 原始 API 返回中的敏感字段，除非后续专门做权限控制页面。

### 当前凭证约定

万里牛需要先准备：

```text
WANLINIU_APP_KEY
WANLINIU_APP_SECRET
WANLINIU_ACCESS_TOKEN
```

后续如果万里牛实际还需要租户 ID、授权店铺 ID、刷新 token、环境标识等，再追加：

```text
WANLINIU_SHOP_IDS
WANLINIU_TENANT_ID
WANLINIU_REFRESH_TOKEN
```

企业支付宝需要先准备：

```text
ALIPAY_APP_ID
ALIPAY_PRIVATE_KEY
ALIPAY_PUBLIC_KEY
```

后续如果正式调用资金账务接口，还可能需要：

```text
ALIPAY_GATEWAY_URL
ALIPAY_APP_AUTH_TOKEN
ALIPAY_SIGN_TYPE
```

说明：

- 第一版凭证放在服务器环境变量或 `.env`，不在前端填写，不存明文到业务数据库。
- 后台页面只检测环境变量是否存在。
- 真实请求万里牛/支付宝前，需要拿到接口权限、调用频率、沙箱/生产网关、签名规则和测试账号。

### 当前留痕设计

接入留痕表：

```text
dataSyncLogs
```

记录字段：

- connectorId：数据源，例如 `wanliniu`、`alipay`
- action：检测凭证、手动同步、定时同步
- status：成功、阻塞、失败
- message：本次结果说明
- startedAt
- finishedAt

这能保证每一步都可以追溯：

- 谁进入后台看状态，后续可以接管理审计。
- 什么时候检测过凭证。
- 为什么同步没有执行。
- 哪个数据源缺少什么配置。
- 哪次同步成功或失败。

### 当前还没有做的真实同步

目前先完成框架和后台入口。真实同步 adapter 等凭证和权限拿到后开发。

万里牛真实同步下一步：

1. 用 `WANLINIU_APP_KEY`、`WANLINIU_APP_SECRET`、`WANLINIU_ACCESS_TOKEN` 实现签名请求。
2. 先调用店铺分页接口，验证授权和分页。
3. 落表 `raw_wanliniu_stores`。
4. 再接订单、售后和库存接口。
5. 生成 `dm_store_daily_summary`。

企业支付宝真实同步下一步：

1. 用 `ALIPAY_APP_ID`、`ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` 实现支付宝开放平台签名。
2. 先调账务明细或余额查询接口验证权限。
3. 落表 `raw_alipay_transactions`。
4. 生成 `dm_cash_daily_summary`。
5. 后续和万里牛销售/退款做到账核对。

## 需要客户确认的问题

万里牛/ERP：

- 是否已经有开放平台应用。
- 是否有 app_key、secret、授权店铺。
- 接口调用频率限制是多少。
- 订单、售后、库存接口是否都已开通。
- 是否支持按更新时间增量拉取。
- 历史数据可拉多长时间。

银行：

- 使用哪些银行。
- 是否开通企业网银。
- 是否支持银企直联/银企互联。
- 是否接受第三方聚合服务。
- 是否只查余额和流水，还是未来要付款。
- 财务数据哪些角色可见。
- 是否需要回单、对账单。

## 参考资料

- 万里牛开放平台：`https://open.hupun.com/`
- 用户提供的万里牛接口文档地址：`https://open.hupun.com/api-doc/erp/base/distr/com/page/get`
- 万里牛 SDK 和签名代码：`https://open.hupun.com/guide/sdk`
- 万里牛开放平台使用说明 PDF：`https://netmarket.oss.aliyuncs.com/df6ed371-b5b3-4710-a2dd-d427a32dc7d1.pdf`
- 支付宝商家账户账务明细查询：`https://opendocs.alipay.com/open/02awe0`
- 支付宝商家账户当前余额查询：`https://opendocs.alipay.com/open/2acb3c34_alipay.data.bill.balance.query`
- 支付宝商家账户历史余额查询：`https://opendocs.alipay.com/open/2cb36cd5_alipay.data.bill.balancehis.query`
- 支付宝商家账户充值、转账、提现查询：`https://opendocs.alipay.com/open/0d2f1256_alipay.data.bill.transfer.query`
- 余利宝产品介绍：`https://developer.alibaba.com/docs/doc.htm?articleId=105624&docType=1&treeId=193`
- 交通银行银企直联：`https://www.bankcomm.com/BankCommSite/shtml/jyjr/cn/2602759/2602766/2602771/list.shtml?channelId=7158`
- 招商银行银财直联：`https://www.cmbchina.com/Corporate/Financial/FinancialInfo.aspx?guid=0bbee705-97a0-4795-904d-ae06fd677838`
- 工商银行银企互联：`https://www.icbc.com.cn/column/1438058386850988211.html`
- 工商银行账户管理：`https://www.icbc.com.cn/column/1438058386850988254.html`
- 农业银行账户管理及信息服务：`https://www.abchina.com/cn/businesses/cashmgmt/200909/t20090907_787542.html`
- 农业银行银企互联平台说明：`https://www.abchina.com/cn/businesses/cashmgmt/200912/t20091217_787534.html`
- 民生银行银企直联：`https://www.cmbc.com.cn/gsjr/jsyxjgl/jtxjgl/yqzl/index.htm`
- 浦发银行银企直连：`https://cor.spdb.com.cn/trade_finance_and_cash_management/dzyh/yqzl/`
- 杭州银行财资管理平台：`https://ebank.hzbank.com.cn/corporBank/`
- 杭州银行企业网银/银企直连相关公开说明可参考其年报披露：`https://pdf.dfcfw.com/pdf/H2_AN201904251322706644_1.pdf`
- 网商银行企业账户开通：`https://mobilehelp.mybank.cn/bkebank/knowledgeDetail.htm?id=3306415`
- 网商企业结算户账户信息查询：`https://mobilehelp.mybank.cn/bkebank/knowledgeDetail.htm?id=2946`
- 杭州联合银行银企直联收费标准：`https://www.urcb.com/urcb/wzfw/sfbz/2020111810083044588/index.shtml`
- 浙江泰隆商业银行电子银行：`https://www.zjtlcb.com/zjtlcb/dzyx/grwy/index.shtml`
- 浙江农商联合银行企业网银演示：`https://www.qy96596.com/eis-demo/home/index`

说明：

- 银行数据接入一般通过银行官方银企直联、开放银行 API、企业网银或第三方聚合服务完成，具体能力以客户开户银行和已开通服务为准。
- 上述公开资料主要用于判断能力方向；正式开发前必须取得客户对应银行的接口包、测试账号、证书、IP 白名单规则、调用频率限制和生产开通流程。
- 涉及资金动作的接口不纳入第一版。第一版只做余额、流水、账单、回单等只读能力。
