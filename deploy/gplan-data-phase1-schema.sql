-- 万里牛第一期经营数据表。
-- 前置条件：gplan_data 已通过 RDS 控制台创建，应用账号已获 DDL+DML 权限。
-- 所有对象使用完整库名，避免 SQL Console 当前选库错误时误建表。

-- 商品/SKU 主数据：一行代表一个 SKU，用于补全库存接口缺少的完整商品名称。
CREATE TABLE IF NOT EXISTS gplan_data.ods_wln_products (
  company_id VARCHAR(128) NOT NULL,
  sku_code VARCHAR(128) NOT NULL,
  goods_code VARCHAR(128) NULL,
  goods_name VARCHAR(255) NULL,
  spec_name VARCHAR(255) NULL,
  bar_code VARCHAR(128) NULL,
  source_goods_uid VARCHAR(128) NULL,
  source_spec_uid VARCHAR(128) NULL,
  status INT NULL,
  source_modified_at DATETIME(3) NULL,
  raw_payload JSON NOT NULL,
  sync_run_id VARCHAR(64) NOT NULL,
  ingested_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_id, sku_code),
  INDEX idx_wln_products_goods_code (company_id, goods_code),
  INDEX idx_wln_products_bar_code (company_id, bar_code),
  INDEX idx_wln_products_modified (company_id, source_modified_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 销售出库单头：保存出货时间、店铺、仓库及整单金额。
CREATE TABLE IF NOT EXISTS gplan_data.ods_wln_sale_outbound (
  company_id VARCHAR(128) NOT NULL,
  outbound_uid VARCHAR(128) NOT NULL,
  outbound_no VARCHAR(128) NULL,
  external_order_no TEXT NULL,
  bill_date DATETIME(3) NULL,
  bill_type INT NULL,
  shop_id VARCHAR(128) NULL,
  shop_nick VARCHAR(255) NULL,
  shop_name VARCHAR(255) NULL,
  shop_source VARCHAR(64) NULL,
  shop_type INT NULL,
  storage_code VARCHAR(128) NULL,
  storage_name VARCHAR(255) NULL,
  gross_amount DECIMAL(18,2) NULL,
  paid_amount DECIMAL(18,2) NULL,
  actual_payment DECIMAL(18,2) NULL,
  discount_amount DECIMAL(18,2) NULL,
  postage_amount DECIMAL(18,2) NULL,
  currency_code VARCHAR(32) NULL,
  source_modified_at DATETIME(3) NULL,
  raw_payload JSON NOT NULL,
  sync_run_id VARCHAR(64) NOT NULL,
  ingested_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_id, outbound_uid),
  UNIQUE KEY uniq_wln_sale_outbound_no (company_id, outbound_no),
  INDEX idx_wln_sale_outbound_bill_date (company_id, bill_date),
  INDEX idx_wln_sale_outbound_dashboard (company_id, bill_date, gross_amount, actual_payment),
  INDEX idx_wln_sale_outbound_shop_date (company_id, shop_nick, bill_date),
  INDEX idx_wln_sale_outbound_modified (company_id, source_modified_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 销售出库明细：一行代表一张出库单中的一个商品/SKU 明细。
CREATE TABLE IF NOT EXISTS gplan_data.ods_wln_sale_outbound_items (
  company_id VARCHAR(128) NOT NULL,
  outbound_uid VARCHAR(128) NOT NULL,
  line_key VARCHAR(191) NOT NULL,
  source_detail_id VARCHAR(128) NULL,
  goods_uid VARCHAR(128) NULL,
  sku_uid VARCHAR(128) NULL,
  sku_code VARCHAR(128) NULL,
  bar_code VARCHAR(128) NULL,
  goods_name VARCHAR(255) NULL,
  sku_name VARCHAR(255) NULL,
  quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  unit VARCHAR(64) NULL,
  sale_price DECIMAL(18,4) NULL,
  gross_amount DECIMAL(18,2) NULL,
  actual_paid_amount DECIMAL(18,2) NULL,
  discount_amount DECIMAL(18,2) NULL,
  cost_amount DECIMAL(18,2) NULL,
  is_package TINYINT(1) NULL,
  raw_payload JSON NOT NULL,
  sync_run_id VARCHAR(64) NOT NULL,
  ingested_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_id, outbound_uid, line_key),
  INDEX idx_wln_sale_outbound_items_sku (company_id, sku_code),
  INDEX idx_wln_sale_outbound_items_detail (company_id, source_detail_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 当前分仓库存：一行代表一个仓库中的一个 SKU。
CREATE TABLE IF NOT EXISTS gplan_data.ods_wln_inventory_current (
  company_id VARCHAR(128) NOT NULL,
  storage_code VARCHAR(128) NOT NULL,
  sku_code VARCHAR(128) NOT NULL,
  goods_code VARCHAR(128) NULL,
  article_number VARCHAR(128) NULL,
  bar_code VARCHAR(128) NULL,
  spec_name VARCHAR(255) NULL,
  actual_quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  locked_quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  in_transit_quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  defect_quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  locked_defect_quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  in_transit_defect_quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_cost DECIMAL(18,2) NULL,
  snapshot_at DATETIME(3) NOT NULL,
  raw_payload JSON NOT NULL,
  sync_run_id VARCHAR(64) NOT NULL,
  ingested_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_id, storage_code, sku_code),
  INDEX idx_wln_inventory_sku (company_id, sku_code),
  INDEX idx_wln_inventory_snapshot (company_id, snapshot_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 采购入库单头：第一期将“入库”定义为采购入库，并预留入库类型字段。
CREATE TABLE IF NOT EXISTS gplan_data.ods_wln_purchase_inbound (
  company_id VARCHAR(128) NOT NULL,
  stock_code VARCHAR(256) NOT NULL,
  inbound_type VARCHAR(32) NOT NULL DEFAULT 'PURCHASE',
  external_receipt_no VARCHAR(128) NULL,
  bill_date DATETIME(3) NULL,
  created_at_source DATETIME(3) NULL,
  approved_at DATETIME(3) NULL,
  storage_code VARCHAR(128) NULL,
  storage_name VARCHAR(255) NULL,
  supplier_code VARCHAR(128) NULL,
  supplier_name VARCHAR(255) NULL,
  settlement_status INT NULL,
  bill_status INT NULL,
  total_amount DECIMAL(18,2) NULL,
  tax_amount DECIMAL(18,2) NULL,
  currency_code VARCHAR(32) NULL,
  source_modified_at DATETIME(3) NULL,
  raw_payload JSON NOT NULL,
  sync_run_id VARCHAR(64) NOT NULL,
  ingested_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_id, stock_code),
  INDEX idx_wln_purchase_inbound_bill_date (company_id, bill_date),
  INDEX idx_wln_purchase_inbound_storage (company_id, storage_code, bill_date),
  INDEX idx_wln_purchase_inbound_modified (company_id, source_modified_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 采购入库明细：一行代表一张采购入库单中的一个商品/SKU 明细。
CREATE TABLE IF NOT EXISTS gplan_data.ods_wln_purchase_inbound_items (
  company_id VARCHAR(128) NOT NULL,
  stock_code VARCHAR(256) NOT NULL,
  line_no INT NOT NULL,
  sku_code VARCHAR(128) NULL,
  bar_code VARCHAR(128) NULL,
  goods_name VARCHAR(255) NULL,
  spec_name VARCHAR(255) NULL,
  quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  unit VARCHAR(64) NULL,
  unit_price DECIMAL(18,4) NULL,
  total_amount DECIMAL(18,2) NULL,
  tax_amount DECIMAL(18,2) NULL,
  inventory_type VARCHAR(64) NULL,
  batch_code VARCHAR(128) NULL,
  production_date DATETIME(3) NULL,
  expiry_date DATETIME(3) NULL,
  raw_payload JSON NOT NULL,
  sync_run_id VARCHAR(64) NOT NULL,
  ingested_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_id, stock_code, line_no),
  INDEX idx_wln_purchase_inbound_items_sku (company_id, sku_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 甲方只读视图 1：出货维度。
-- gmv 优先取明细分摊实付；若源接口未返回，再回退到明细销售金额。
CREATE OR REPLACE VIEW gplan_data.vw_wln_shipments_v1 AS
SELECT
  h.company_id,
  h.outbound_uid,
  h.outbound_no,
  h.bill_date AS shipment_time,
  h.shop_name,
  h.shop_nick,
  h.storage_code,
  h.storage_name,
  i.sku_code AS product_code,
  COALESCE(i.goods_name, p.goods_name, i.sku_name, p.spec_name) AS product_name,
  i.sku_name,
  i.quantity,
  COALESCE(i.actual_paid_amount, i.gross_amount) AS gmv,
  i.gross_amount,
  i.actual_paid_amount,
  h.source_modified_at,
  h.ingested_at
FROM gplan_data.ods_wln_sale_outbound h
JOIN gplan_data.ods_wln_sale_outbound_items i
  ON i.company_id = h.company_id
 AND i.outbound_uid = h.outbound_uid
LEFT JOIN gplan_data.ods_wln_products p
  ON p.company_id = i.company_id
 AND p.sku_code = i.sku_code;

-- 甲方只读视图 2：当前库存维度。
CREATE OR REPLACE VIEW gplan_data.vw_wln_inventory_v1 AS
SELECT
  i.company_id,
  i.snapshot_at,
  i.storage_code,
  i.sku_code AS product_code,
  COALESCE(p.goods_name, i.spec_name, p.spec_name) AS product_name,
  i.spec_name,
  i.actual_quantity AS inventory_quantity,
  i.actual_quantity - i.locked_quantity AS available_quantity,
  i.locked_quantity,
  i.in_transit_quantity,
  i.defect_quantity,
  i.ingested_at
FROM gplan_data.ods_wln_inventory_current i
LEFT JOIN gplan_data.ods_wln_products p
  ON p.company_id = i.company_id
 AND p.sku_code = i.sku_code;

-- 甲方只读视图 3：采购入库维度。
CREATE OR REPLACE VIEW gplan_data.vw_wln_inbound_v1 AS
SELECT
  h.company_id,
  h.stock_code AS inbound_no,
  h.inbound_type,
  h.bill_date AS inbound_time,
  h.storage_code,
  h.storage_name,
  h.supplier_code,
  h.supplier_name,
  i.sku_code AS product_code,
  COALESCE(i.goods_name, p.goods_name, i.spec_name, p.spec_name) AS product_name,
  i.spec_name,
  i.quantity AS inbound_quantity,
  i.unit,
  i.unit_price,
  i.total_amount,
  h.bill_status,
  h.settlement_status,
  h.source_modified_at,
  h.ingested_at
FROM gplan_data.ods_wln_purchase_inbound h
JOIN gplan_data.ods_wln_purchase_inbound_items i
  ON i.company_id = h.company_id
 AND i.stock_code = h.stock_code
LEFT JOIN gplan_data.ods_wln_products p
  ON p.company_id = i.company_id
 AND p.sku_code = i.sku_code;

-- 甲方 API 客户端。Token 只保存 SHA-256 摘要，明文只在创建时展示一次。
CREATE TABLE IF NOT EXISTS gplan_data.data_api_clients (
  id VARCHAR(64) NOT NULL,
  company_id VARCHAR(128) NOT NULL,
  client_code VARCHAR(64) NOT NULL,
  client_name VARCHAR(255) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  scopes_json JSON NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  expires_at DATETIME(3) NULL,
  last_used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_data_api_client_code (company_id, client_code),
  UNIQUE KEY uniq_data_api_token_hash (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 甲方口径映射表：多条源编码可以映射为同一个甲方编码，从而实现店铺、仓库或商品合并。
-- 未配置映射的编码自动按万里牛原编码和原名称返回，不会阻塞 API 联调。
CREATE TABLE IF NOT EXISTS gplan_data.data_api_entity_mappings (
  client_id VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  source_code VARCHAR(255) NOT NULL,
  source_name VARCHAR(255) NULL,
  target_code VARCHAR(255) NOT NULL,
  target_name VARCHAR(255) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  metadata_json JSON NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (client_id, entity_type, source_code),
  INDEX idx_data_api_mapping_target (client_id, entity_type, target_code),
  CONSTRAINT fk_data_api_mapping_client
    FOREIGN KEY (client_id) REFERENCES gplan_data.data_api_clients(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- API 调用留痕，不记录 Token 和业务返回内容。
CREATE TABLE IF NOT EXISTS gplan_data.data_api_request_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id VARCHAR(64) NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  endpoint VARCHAR(128) NOT NULL,
  http_status INT NOT NULL,
  response_rows INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  requested_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_data_api_logs_client_time (client_id, requested_at),
  INDEX idx_data_api_logs_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 执行后的结构核对。
SELECT TABLE_TYPE, TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'gplan_data'
ORDER BY TABLE_TYPE, TABLE_NAME;
