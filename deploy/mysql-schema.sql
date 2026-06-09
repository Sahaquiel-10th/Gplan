CREATE DATABASE IF NOT EXISTS gplan
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE gplan;

CREATE TABLE IF NOT EXISTS app_state (
  id VARCHAR(64) PRIMARY KEY,
  data JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(64) PRIMARY KEY,
  company_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  conversation_id VARCHAR(64) NOT NULL,
  role VARCHAR(16) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  token_count INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_messages_conversation (company_id, user_id, conversation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS memory_sync_state (
  id VARCHAR(64) PRIMARY KEY,
  company_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  conversation_id VARCHAR(64) NOT NULL,
  last_submitted_message_id VARCHAR(64) NULL,
  last_submitted_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_memory_sync_conversation (company_id, user_id, conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_saved_memories (
  id VARCHAR(64) PRIMARY KEY,
  company_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  conversation_id VARCHAR(64) NOT NULL,
  source_message_id VARCHAR(64) NULL,
  content MEDIUMTEXT NOT NULL,
  memory_user_id VARCHAR(256) NOT NULL,
  bailian_memory_id VARCHAR(128) NULL,
  status VARCHAR(16) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_saved_memories_user (company_id, user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rag_retrieval_logs (
  id VARCHAR(64) PRIMARY KEY,
  company_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  conversation_id VARCHAR(64) NOT NULL,
  query TEXT NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  matched_items_json JSON NOT NULL,
  injected_context MEDIUMTEXT NOT NULL,
  threshold_value DECIMAL(8,4) NOT NULL,
  top_k INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rag_retrieval_logs_conversation (company_id, user_id, conversation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
