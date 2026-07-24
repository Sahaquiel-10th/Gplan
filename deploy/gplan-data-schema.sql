-- 先在 RDS 控制台创建 gplan_data，并给应用账号授权。
-- 所有表都使用完整库名，避免 SQL Console 当前选库错误时误建表。
CREATE TABLE IF NOT EXISTS gplan_data.data_sync_runs (
  id VARCHAR(64) PRIMARY KEY,
  connector_id VARCHAR(64) NOT NULL,
  resource_name VARCHAR(128) NOT NULL,
  sync_mode VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  records_read INT NOT NULL DEFAULT 0,
  records_written INT NOT NULL DEFAULT 0,
  cursor_json JSON NULL,
  error_message TEXT NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sync_runs_resource (connector_id, resource_name, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gplan_data.data_sync_cursors (
  connector_id VARCHAR(64) NOT NULL,
  resource_name VARCHAR(128) NOT NULL,
  cursor_json JSON NOT NULL,
  last_success_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connector_id, resource_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gplan_data.ods_wln_shops (
  company_id VARCHAR(128) NOT NULL,
  shop_uid VARCHAR(128) NOT NULL,
  source_company_id VARCHAR(128) NULL,
  shop_nick VARCHAR(255) NULL,
  shop_name VARCHAR(255) NULL,
  shop_type INT NULL,
  shop_sub_type INT NULL,
  status INT NULL,
  group_uid VARCHAR(128) NULL,
  group_name VARCHAR(255) NULL,
  sync_enabled TINYINT(1) NULL,
  source_modified_at DATETIME(3) NULL,
  raw_payload JSON NOT NULL,
  sync_run_id VARCHAR(64) NOT NULL,
  ingested_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, shop_uid),
  INDEX idx_wln_shops_nick (company_id, shop_nick),
  INDEX idx_wln_shops_modified (company_id, source_modified_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
