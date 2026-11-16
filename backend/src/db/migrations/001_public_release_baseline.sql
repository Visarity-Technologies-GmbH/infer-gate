-- InferGate public-release MySQL schema.
-- Keep this baseline immutable after release; add numbered migrations for later changes.

CREATE TABLE `admins` (
  id TINYINT PRIMARY KEY,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CHECK (id = 1)
) ENGINE=InnoDB;

CREATE TABLE `admin_sessions` (
  token_hash CHAR(64) PRIMARY KEY,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))
) ENGINE=InnoDB;

CREATE TABLE `users` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(255),
  status ENUM('ACTIVE','SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
  is_manager BOOLEAN NOT NULL DEFAULT FALSE,
  manager_password_temporary BOOLEAN NOT NULL DEFAULT FALSE,
  manager_password_expires_at DATETIME(3),
  manager_auth_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))
) ENGINE=InnoDB;

CREATE TABLE `groups` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))
) ENGINE=InnoDB;

CREATE TABLE `user_groups` (
  user_id BIGINT UNSIGNED NOT NULL,
  group_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (user_id, group_id),
  FOREIGN KEY (user_id) REFERENCES `users`(id),
  FOREIGN KEY (group_id) REFERENCES `groups`(id)
) ENGINE=InnoDB;

CREATE TABLE `llm_inference_providers` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  api_url VARCHAR(2048) NOT NULL,
  api_type ENUM('OPENAI_COMPATIBLE','ANTHROPIC','GEMINI','AWS_BEDROCK','OPENAI_ANTHROPIC') NOT NULL DEFAULT 'OPENAI_COMPATIBLE',
  anthropic_api_url VARCHAR(2048),
  pricing_provider_key VARCHAR(255) COLLATE utf8mb4_bin,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))
) ENGINE=InnoDB;

CREATE TABLE `upstream_api_keys` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  key_fingerprint VARCHAR(32) NOT NULL,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  aws_region VARCHAR(32),
  request_compression_c ENUM('NONE','GZIP','ZSTD') NOT NULL DEFAULT 'NONE',
  request_compression_r ENUM('NONE','GZIP','ZSTD') NOT NULL DEFAULT 'NONE',
  request_compression_m ENUM('NONE','GZIP','ZSTD') NOT NULL DEFAULT 'NONE',
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  last_used_at DATETIME(3),
  FOREIGN KEY (provider_id) REFERENCES `llm_inference_providers`(id)
) ENGINE=InnoDB;

CREATE TABLE `model_policies` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))
) ENGINE=InnoDB;

CREATE TABLE `model_policy_rules` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  model_policy_id BIGINT UNSIGNED NOT NULL,
  model_pattern VARCHAR(255) NOT NULL,
  policy ENUM('ALLOW','DENY') NOT NULL,
  FOREIGN KEY (model_policy_id) REFERENCES `model_policies`(id),
  UNIQUE (model_policy_id, model_pattern, policy)
) ENGINE=InnoDB;

CREATE TABLE `classification_handlers` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  api_url VARCHAR(2048) NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  key_fingerprint CHAR(16) NOT NULL,
  json_template JSON NOT NULL,
  `maxToken` INT UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CHECK (`maxToken` IS NULL OR `maxToken` > 0)
) ENGINE=InnoDB;

CREATE TABLE `roles` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  classification_handler_id BIGINT UNSIGNED,
  evaluation_script MEDIUMTEXT,
  prompt_script MEDIUMTEXT,
  input_script MEDIUMTEXT,
  output_script MEDIUMTEXT,
  system_prompt_compaction JSON,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  FOREIGN KEY (classification_handler_id) REFERENCES `classification_handlers`(id)
) ENGINE=InnoDB;

CREATE TABLE `role_model_policies` (
  role_id BIGINT UNSIGNED NOT NULL,
  model_policy_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, model_policy_id),
  FOREIGN KEY (role_id) REFERENCES `roles`(id),
  FOREIGN KEY (model_policy_id) REFERENCES `model_policies`(id)
) ENGINE=InnoDB;

CREATE TABLE `model_aliases` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))
) ENGINE=InnoDB;

CREATE TABLE `model_alias_entries` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  model_alias_id BIGINT UNSIGNED NOT NULL,
  model_alias VARCHAR(255) NOT NULL,
  model_upstream VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  FOREIGN KEY (model_alias_id) REFERENCES `model_aliases`(id),
  UNIQUE (model_alias_id, model_alias, model_upstream)
) ENGINE=InnoDB;

CREATE TABLE `proxy_api_keys` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  key_prefix VARCHAR(32) NOT NULL,
  status ENUM('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
  model_policy_id BIGINT UNSIGNED,
  role_id BIGINT UNSIGNED,
  expires_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  revoked_at DATETIME(3),
  last_used_at DATETIME(3),
  FOREIGN KEY (user_id) REFERENCES `users`(id),
  FOREIGN KEY (model_policy_id) REFERENCES `model_policies`(id),
  FOREIGN KEY (role_id) REFERENCES `roles`(id)
) ENGINE=InnoDB;

CREATE TABLE `proxy_key_upstream_assignments` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  proxy_api_key_id BIGINT UNSIGNED NOT NULL,
  upstream_api_key_id BIGINT UNSIGNED NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  FOREIGN KEY (proxy_api_key_id) REFERENCES `proxy_api_keys`(id),
  FOREIGN KEY (upstream_api_key_id) REFERENCES `upstream_api_keys`(id),
  UNIQUE (proxy_api_key_id, upstream_api_key_id)
) ENGINE=InnoDB;

CREATE TABLE `proxy_key_model_policies` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  proxy_api_key_id BIGINT UNSIGNED NOT NULL,
  model_pattern VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  policy ENUM('ALLOW','DENY') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  FOREIGN KEY (proxy_api_key_id) REFERENCES `proxy_api_keys`(id),
  UNIQUE (proxy_api_key_id, model_pattern, policy)
) ENGINE=InnoDB;

CREATE TABLE `role_upstream_assignments` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role_id BIGINT UNSIGNED NOT NULL,
  upstream_api_key_id BIGINT UNSIGNED NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  FOREIGN KEY (role_id) REFERENCES `roles`(id),
  FOREIGN KEY (upstream_api_key_id) REFERENCES `upstream_api_keys`(id),
  UNIQUE (role_id, upstream_api_key_id)
) ENGINE=InnoDB;

CREATE TABLE `role_upstream_model_aliases` (
  role_upstream_assignment_id BIGINT UNSIGNED NOT NULL,
  model_alias_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (role_upstream_assignment_id, model_alias_id),
  FOREIGN KEY (role_upstream_assignment_id) REFERENCES `role_upstream_assignments`(id),
  FOREIGN KEY (model_alias_id) REFERENCES `model_aliases`(id)
) ENGINE=InnoDB;

CREATE TABLE `api_requests` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id CHAR(36) NOT NULL UNIQUE,
  user_id BIGINT UNSIGNED,
  proxy_api_key_id BIGINT UNSIGNED,
  upstream_api_key_id BIGINT UNSIGNED,
  provider_id BIGINT UNSIGNED,
  role_id BIGINT UNSIGNED,
  endpoint VARCHAR(2048) NOT NULL,
  http_method VARCHAR(16) NOT NULL,
  model_requested VARCHAR(255),
  model_resolved VARCHAR(255),
  stream BOOLEAN NOT NULL DEFAULT FALSE,
  started_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3),
  duration_ms BIGINT UNSIGNED,
  http_status SMALLINT UNSIGNED,
  request_status ENUM('RECEIVED','FORWARDED','SUCCESS','FAILED','REJECTED','CANCELLED') NOT NULL,
  upstream_request_id VARCHAR(255),
  error_type VARCHAR(128),
  error_code VARCHAR(128),
  aws_region VARCHAR(32),
  usage_expected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  FOREIGN KEY (user_id) REFERENCES `users`(id),
  FOREIGN KEY (proxy_api_key_id) REFERENCES `proxy_api_keys`(id),
  FOREIGN KEY (upstream_api_key_id) REFERENCES `upstream_api_keys`(id),
  FOREIGN KEY (provider_id) REFERENCES `llm_inference_providers`(id),
  FOREIGN KEY (role_id) REFERENCES `roles`(id),
  INDEX (started_at),
  INDEX (user_id, started_at),
  INDEX user_usage_gaps (user_id, usage_expected, completed_at)
) ENGINE=InnoDB;

CREATE TABLE `usage_events` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  api_request_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED,
  proxy_api_key_id BIGINT UNSIGNED,
  upstream_api_key_id BIGINT UNSIGNED,
  provider_id BIGINT UNSIGNED,
  model VARCHAR(255) COLLATE utf8mb4_bin,
  input_tokens BIGINT UNSIGNED,
  cached_input_tokens BIGINT UNSIGNED,
  cache_write_input_tokens BIGINT UNSIGNED,
  cache_write_5m_tokens BIGINT UNSIGNED,
  cache_write_1h_tokens BIGINT UNSIGNED,
  output_tokens BIGINT UNSIGNED,
  reasoning_tokens BIGINT UNSIGNED,
  total_tokens BIGINT UNSIGNED,
  request_status VARCHAR(32) NOT NULL,
  timestamp DATETIME(3) NOT NULL,
  category VARCHAR(255),
  sensitive_data BOOLEAN,
  requestedModel VARCHAR(255) COLLATE utf8mb4_bin,
  complexity TINYINT UNSIGNED,
  requestedProvider_id BIGINT UNSIGNED,
  FOREIGN KEY (api_request_id) REFERENCES `api_requests`(id),
  FOREIGN KEY (user_id) REFERENCES `users`(id),
  FOREIGN KEY (proxy_api_key_id) REFERENCES `proxy_api_keys`(id),
  FOREIGN KEY (upstream_api_key_id) REFERENCES `upstream_api_keys`(id),
  FOREIGN KEY (provider_id) REFERENCES `llm_inference_providers`(id),
  CONSTRAINT usage_events_requested_provider_fk FOREIGN KEY (requestedProvider_id) REFERENCES `llm_inference_providers`(id),
  CHECK (sensitive_data IS NULL OR sensitive_data IN (0, 1)),
  CHECK (complexity IS NULL OR complexity BETWEEN 0 AND 2),
  INDEX (timestamp),
  INDEX (user_id, timestamp),
  INDEX (proxy_api_key_id, timestamp),
  INDEX (upstream_api_key_id, timestamp),
  INDEX (provider_id, timestamp),
  INDEX (model, timestamp)
) ENGINE=InnoDB;

CREATE TABLE `pricing_imports` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  checksum CHAR(64) NOT NULL UNIQUE,
  source_url VARCHAR(2048) NOT NULL,
  generated_at DATETIME(3) NOT NULL,
  imported_at DATETIME(3) NOT NULL,
  model_count INT UNSIGNED NOT NULL
) ENGINE=InnoDB;

CREATE TABLE `pricing_catalog` (
  import_id BIGINT UNSIGNED NOT NULL,
  provider_key VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  model_id VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  input_rate DECIMAL(20,8) UNSIGNED,
  output_rate DECIMAL(20,8) UNSIGNED,
  cache_read_rate DECIMAL(20,8) UNSIGNED,
  cache_write_rate DECIMAL(20,8) UNSIGNED,
  cache_write_5m_rate DECIMAL(20,8) UNSIGNED,
  cache_write_1h_rate DECIMAL(20,8) UNSIGNED,
  subscription BOOLEAN NOT NULL,
  PRIMARY KEY (import_id, provider_key, model_id),
  FOREIGN KEY (import_id) REFERENCES `pricing_imports`(id)
) ENGINE=InnoDB;

CREATE TABLE `pricing_model_aliases` (
  provider_id BIGINT UNSIGNED NOT NULL,
  model_id VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  source_model_id VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (provider_id, model_id),
  FOREIGN KEY (provider_id) REFERENCES `llm_inference_providers`(id)
) ENGINE=InnoDB;

CREATE TABLE `model_pricing` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id BIGINT UNSIGNED NOT NULL,
  model_pattern VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  input_price_per_million DECIMAL(20,8) UNSIGNED,
  cached_input_price_per_million DECIMAL(20,8) UNSIGNED,
  output_price_per_million DECIMAL(20,8) UNSIGNED,
  reasoning_price_per_million DECIMAL(20,8) UNSIGNED,
  currency CHAR(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  cache_write_price_per_million DECIMAL(20,8) UNSIGNED,
  cache_write_5m_rate DECIMAL(20,8) UNSIGNED,
  cache_write_1h_rate DECIMAL(20,8) UNSIGNED,
  import_id BIGINT UNSIGNED,
  source_model_id VARCHAR(255) COLLATE utf8mb4_bin,
  source_kind ENUM('FEED','MANUAL') NOT NULL DEFAULT 'MANUAL',
  subscription BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY (provider_id) REFERENCES `llm_inference_providers`(id),
  FOREIGN KEY (import_id) REFERENCES `pricing_imports`(id),
  UNIQUE KEY pricing_lookup (provider_id, model_pattern, source_kind)
) ENGINE=InnoDB;

CREATE TABLE `pricing_state` (
  id TINYINT PRIMARY KEY,
  CHECK (id = 1)
) ENGINE=InnoDB;

CREATE TABLE `usage_costs` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  usage_event_id BIGINT UNSIGNED NOT NULL UNIQUE,
  pricing_id BIGINT UNSIGNED,
  input_cost DECIMAL(30,12) UNSIGNED,
  cached_input_cost DECIMAL(30,12) UNSIGNED,
  cache_write_cost DECIMAL(30,12) UNSIGNED,
  cache_write_5m_cost DECIMAL(30,12) UNSIGNED,
  cache_write_1h_cost DECIMAL(30,12) UNSIGNED,
  output_cost DECIMAL(30,12) UNSIGNED,
  known_cost DECIMAL(30,12) UNSIGNED,
  currency CHAR(3) NOT NULL,
  status ENUM('COMPLETE','PARTIAL','UNPRICED','UNSUPPORTED') NOT NULL DEFAULT 'COMPLETE',
  reason VARCHAR(255),
  requested_cost DECIMAL(30,12) UNSIGNED,
  calculated_at DATETIME(3) NOT NULL,
  FOREIGN KEY (usage_event_id) REFERENCES `usage_events`(id),
  FOREIGN KEY (pricing_id) REFERENCES `model_pricing`(id),
  CONSTRAINT usage_costs_requested_complete CHECK (requested_cost IS NULL OR status = 'COMPLETE')
) ENGINE=InnoDB;

CREATE TABLE `user_usage_limits` (
  user_id BIGINT UNSIGNED PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  period ENUM('DAILY','WEEKLY') NOT NULL,
  basis ENUM('TOKENS','COST') NOT NULL,
  token_limit BIGINT UNSIGNED,
  cost_limit DECIMAL(30,12) UNSIGNED,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  FOREIGN KEY (user_id) REFERENCES `users`(id),
  CHECK ((basis = 'TOKENS' AND token_limit IS NOT NULL AND token_limit > 0 AND cost_limit IS NULL)
      OR (basis = 'COST' AND cost_limit IS NOT NULL AND cost_limit > 0 AND token_limit IS NULL))
) ENGINE=InnoDB;

CREATE TABLE `user_viewing_keys` (
  user_id BIGINT UNSIGNED PRIMARY KEY,
  key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  FOREIGN KEY (user_id) REFERENCES `users`(id)
) ENGINE=InnoDB;

CREATE TABLE `manager_sessions` (
  token_hash CHAR(64) PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  auth_version BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  FOREIGN KEY (user_id) REFERENCES `users`(id),
  INDEX (user_id),
  INDEX (expires_at)
) ENGINE=InnoDB;

CREATE TABLE `mcp_access_tokens` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  manager_id BIGINT UNSIGNED,
  name VARCHAR(255) NOT NULL,
  scope ENUM('REPORT','ADMIN','MANAGER') NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  token_prefix VARCHAR(12) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  expires_at DATETIME(3) NOT NULL,
  last_used_at DATETIME(3),
  revoked_at DATETIME(3),
  FOREIGN KEY (manager_id) REFERENCES `users`(id),
  CONSTRAINT mcp_token_owner_scope CHECK (
    (manager_id IS NULL AND scope IN ('REPORT','ADMIN')) OR
    (manager_id IS NOT NULL AND scope IN ('REPORT','MANAGER'))
  ),
  INDEX (manager_id, id)
) ENGINE=InnoDB;

CREATE TABLE `debug_logging_settings` (
  id TINYINT UNSIGNED PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT debug_logging_singleton CHECK (id = 1),
  CONSTRAINT debug_logging_boolean CHECK (enabled IN (0, 1))
) ENGINE=InnoDB;

INSERT INTO `pricing_state` (id) VALUES (1);
INSERT INTO `debug_logging_settings` (id, enabled) VALUES (1, FALSE);
INSERT INTO `llm_inference_providers` (name, api_url, api_type, status) VALUES
  ('OpenAI', 'https://api.openai.com/v1', 'OPENAI_COMPATIBLE', 'ACTIVE'),
  ('Anthropic', 'https://api.anthropic.com/v1', 'ANTHROPIC', 'ACTIVE'),
  ('Gemini', 'https://generativelanguage.googleapis.com/v1beta', 'GEMINI', 'ACTIVE'),
  ('AWS Bedrock', 'https://bedrock-mantle.{region}.api.aws/v1', 'AWS_BEDROCK', 'ACTIVE');
