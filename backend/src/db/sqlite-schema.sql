PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED')),
  is_manager INTEGER NOT NULL DEFAULT 0, manager_password_temporary INTEGER NOT NULL DEFAULT 0,
  manager_password_expires_at TEXT, manager_auth_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "groups" (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_groups (
  user_id INTEGER NOT NULL REFERENCES users(id), group_id INTEGER NOT NULL REFERENCES "groups"(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,group_id)
);
CREATE TABLE IF NOT EXISTS llm_inference_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, api_url TEXT NOT NULL, api_type TEXT NOT NULL DEFAULT 'OPENAI_COMPATIBLE',
  anthropic_api_url TEXT, request_compression TEXT NOT NULL DEFAULT 'NONE' CHECK(request_compression IN ('NONE','GZIP','ZSTD')),
  pricing_provider_key TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS upstream_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL REFERENCES llm_inference_providers(id), name TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL, key_fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', aws_region TEXT,
  request_compression_c TEXT NOT NULL DEFAULT 'NONE', request_compression_r TEXT NOT NULL DEFAULT 'NONE',
  request_compression_m TEXT NOT NULL DEFAULT 'NONE', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS proxy_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT, last_used_at TEXT,
  model_policy_id INTEGER REFERENCES model_policies(id), role_id INTEGER REFERENCES roles(id), expires_at TEXT
);
CREATE TABLE IF NOT EXISTS proxy_key_upstream_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, proxy_api_key_id INTEGER NOT NULL REFERENCES proxy_api_keys(id),
  upstream_api_key_id INTEGER NOT NULL REFERENCES upstream_api_keys(id), priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(proxy_api_key_id,upstream_api_key_id)
);
CREATE TABLE IF NOT EXISTS proxy_key_model_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, proxy_api_key_id INTEGER NOT NULL REFERENCES proxy_api_keys(id),
  model_pattern TEXT NOT NULL, policy TEXT NOT NULL CHECK(policy IN ('ALLOW','DENY')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(proxy_api_key_id,model_pattern,policy)
);
CREATE TABLE IF NOT EXISTS model_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS model_policy_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, model_policy_id INTEGER NOT NULL REFERENCES model_policies(id),
  model_pattern TEXT NOT NULL, policy TEXT NOT NULL CHECK(policy IN ('ALLOW','DENY')),
  UNIQUE(model_policy_id,model_pattern,policy)
);
CREATE TABLE IF NOT EXISTS classification_handlers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, api_url TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL, key_fingerprint TEXT NOT NULL, json_template TEXT NOT NULL,
  maxToken INTEGER CHECK(maxToken IS NULL OR maxToken > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE', classification_handler_id INTEGER REFERENCES classification_handlers(id),
  debug_enabled INTEGER NOT NULL DEFAULT 0 CHECK (debug_enabled IN (0,1)),
  evaluation_script TEXT, prompt_script TEXT, input_script TEXT, output_script TEXT, system_prompt_compaction TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS role_model_policies (
  role_id INTEGER NOT NULL REFERENCES roles(id), model_policy_id INTEGER NOT NULL REFERENCES model_policies(id),
  PRIMARY KEY(role_id,model_policy_id)
);
CREATE TABLE IF NOT EXISTS role_upstream_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, role_id INTEGER NOT NULL REFERENCES roles(id),
  upstream_api_key_id INTEGER NOT NULL REFERENCES upstream_api_keys(id), priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(role_id,upstream_api_key_id)
);
CREATE TABLE IF NOT EXISTS model_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS model_alias_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, model_alias_id INTEGER NOT NULL REFERENCES model_aliases(id),
  model_alias TEXT NOT NULL, model_upstream TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(model_alias_id,model_alias,model_upstream)
);
CREATE TABLE IF NOT EXISTS role_upstream_model_aliases (
  role_upstream_assignment_id INTEGER NOT NULL REFERENCES role_upstream_assignments(id),
  model_alias_id INTEGER NOT NULL REFERENCES model_aliases(id), PRIMARY KEY(role_upstream_assignment_id,model_alias_id)
);
CREATE TABLE IF NOT EXISTS api_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, user_id INTEGER REFERENCES users(id),
  proxy_api_key_id INTEGER REFERENCES proxy_api_keys(id), upstream_api_key_id INTEGER REFERENCES upstream_api_keys(id),
  provider_id INTEGER REFERENCES llm_inference_providers(id), role_id INTEGER REFERENCES roles(id),
  endpoint TEXT NOT NULL, http_method TEXT NOT NULL, model_requested TEXT, model_resolved TEXT,
  stream INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER,
  http_status INTEGER, request_status TEXT NOT NULL, upstream_request_id TEXT, error_type TEXT, error_code TEXT,
  aws_region TEXT, usage_expected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS api_requests_started_at ON api_requests(started_at);
CREATE INDEX IF NOT EXISTS api_requests_user_started_at ON api_requests(user_id,started_at);
CREATE INDEX IF NOT EXISTS api_requests_user_usage_gaps ON api_requests(user_id,usage_expected,completed_at);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, api_request_id INTEGER NOT NULL REFERENCES api_requests(id),
  user_id INTEGER REFERENCES users(id), proxy_api_key_id INTEGER REFERENCES proxy_api_keys(id),
  upstream_api_key_id INTEGER REFERENCES upstream_api_keys(id), provider_id INTEGER REFERENCES llm_inference_providers(id),
  model TEXT, input_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER,
  cache_write_5m_tokens INTEGER, cache_write_1h_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
  total_tokens INTEGER, request_status TEXT NOT NULL, timestamp TEXT NOT NULL,
  category TEXT, sensitive_data INTEGER CHECK(sensitive_data IS NULL OR sensitive_data IN (0,1)),
  requestedModel TEXT, complexity INTEGER CHECK(complexity IS NULL OR complexity BETWEEN 0 AND 2),
  requestedProvider_id INTEGER REFERENCES llm_inference_providers(id)
);
CREATE INDEX IF NOT EXISTS usage_events_timestamp ON usage_events(timestamp);
CREATE INDEX IF NOT EXISTS usage_events_user_timestamp ON usage_events(user_id,timestamp);
CREATE INDEX IF NOT EXISTS usage_events_proxy_timestamp ON usage_events(proxy_api_key_id,timestamp);
CREATE INDEX IF NOT EXISTS usage_events_upstream_timestamp ON usage_events(upstream_api_key_id,timestamp);
CREATE INDEX IF NOT EXISTS usage_events_provider_timestamp ON usage_events(provider_id,timestamp);
CREATE INDEX IF NOT EXISTS usage_events_model_timestamp ON usage_events(model,timestamp);
CREATE TABLE IF NOT EXISTS pricing_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, checksum TEXT NOT NULL UNIQUE, source_url TEXT NOT NULL,
  generated_at TEXT NOT NULL, imported_at TEXT NOT NULL, model_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing_catalog (
  import_id INTEGER NOT NULL REFERENCES pricing_imports(id), provider_key TEXT NOT NULL, model_id TEXT NOT NULL,
  input_rate TEXT, output_rate TEXT, cache_read_rate TEXT, cache_write_rate TEXT,
  cache_write_5m_rate TEXT, cache_write_1h_rate TEXT, subscription INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(import_id,provider_key,model_id)
);
CREATE TABLE IF NOT EXISTS pricing_model_aliases (
  provider_id INTEGER NOT NULL REFERENCES llm_inference_providers(id), model_id TEXT NOT NULL, source_model_id TEXT NOT NULL,
  PRIMARY KEY(provider_id,model_id)
);
CREATE TABLE IF NOT EXISTS model_pricing (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL REFERENCES llm_inference_providers(id),
  model_pattern TEXT NOT NULL, input_price_per_million TEXT, cached_input_price_per_million TEXT,
  output_price_per_million TEXT, reasoning_price_per_million TEXT, currency TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cache_write_price_per_million TEXT, cache_write_5m_rate TEXT, cache_write_1h_rate TEXT,
  import_id INTEGER REFERENCES pricing_imports(id), source_model_id TEXT,
  source_kind TEXT NOT NULL DEFAULT 'MANUAL', subscription INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider_id,model_pattern,source_kind)
);
CREATE TABLE IF NOT EXISTS pricing_state (id INTEGER PRIMARY KEY CHECK(id=1));
INSERT OR IGNORE INTO pricing_state(id) VALUES (1);
CREATE TABLE IF NOT EXISTS usage_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, usage_event_id INTEGER NOT NULL UNIQUE REFERENCES usage_events(id),
  pricing_id INTEGER REFERENCES model_pricing(id), input_cost TEXT, cached_input_cost TEXT, cache_write_cost TEXT,
  cache_write_5m_cost TEXT, cache_write_1h_cost TEXT, output_cost TEXT, known_cost TEXT,
  currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'COMPLETE', reason TEXT,
  requested_cost TEXT CHECK(requested_cost IS NULL OR status='COMPLETE'), calculated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_usage_limits (
  user_id INTEGER PRIMARY KEY REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 0,
  period TEXT NOT NULL CHECK(period IN ('DAILY','WEEKLY')), basis TEXT NOT NULL CHECK(basis IN ('TOKENS','COST')),
  token_limit TEXT, cost_limit TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((basis='TOKENS' AND token_limit IS NOT NULL AND cost_limit IS NULL) OR
         (basis='COST' AND cost_limit IS NOT NULL AND token_limit IS NULL))
);
CREATE TABLE IF NOT EXISTS user_viewing_keys (
  user_id INTEGER PRIMARY KEY REFERENCES users(id), key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS manager_sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), auth_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mcp_access_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, manager_id INTEGER REFERENCES users(id), name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('REPORT','ADMIN','MANAGER')), token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL,
  last_used_at TEXT, revoked_at TEXT,
  CHECK ((manager_id IS NULL AND scope IN ('REPORT','ADMIN')) OR (manager_id IS NOT NULL AND scope IN ('REPORT','MANAGER')))
);
CREATE TABLE IF NOT EXISTS debug_logging_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO debug_logging_settings(id,enabled) VALUES (1,0);
