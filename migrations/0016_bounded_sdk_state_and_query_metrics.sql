BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- High-churn SDK state must not share one JSON document with memories,
-- conversation history, and assets. These rows are owner-scoped and bounded
-- by the application before they cross the database boundary.
CREATE TABLE IF NOT EXISTS chusky_sdk_thread (
  user_id BIGINT NOT NULL CHECK (user_id >= 0),
  thread_id TEXT NOT NULL CHECK (thread_id ~ '^(thr|cli_thread)_[A-Za-z0-9_-]{1,120}$'),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  history JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, thread_id),
  CHECK (updated_at >= created_at),
  CHECK (octet_length(metadata::text) <= 128000),
  CHECK (octet_length(history::text) <= 512000)
);

CREATE INDEX IF NOT EXISTS chusky_sdk_thread_recent_idx
  ON chusky_sdk_thread (user_id, updated_at DESC, thread_id);

CREATE TABLE IF NOT EXISTS chusky_sdk_audit_event (
  user_id BIGINT NOT NULL CHECK (user_id >= 0),
  audit_id TEXT NOT NULL CHECK (audit_id ~ '^audit_[A-Za-z0-9_-]{1,180}$'),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 240),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 240),
  status INTEGER NOT NULL CHECK (status BETWEEN 100 AND 599),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, audit_id)
);

CREATE INDEX IF NOT EXISTS chusky_sdk_audit_event_recent_idx
  ON chusky_sdk_audit_event (user_id, created_at DESC, audit_id);

CREATE TABLE IF NOT EXISTS chusky_sdk_idempotency (
  user_id BIGINT NOT NULL CHECK (user_id >= 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{32,128}$'),
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, idempotency_key),
  CHECK (octet_length(response::text) <= 512000)
);

CREATE INDEX IF NOT EXISTS chusky_sdk_idempotency_retention_idx
  ON chusky_sdk_idempotency (created_at, user_id);

-- The run table already exists, but its retention path needs an index that is
-- independent of the active-run index.
CREATE INDEX IF NOT EXISTS chusky_sdk_run_retention_idx
  ON chusky_sdk_run (updated_at, user_id, run_id);

CREATE INDEX IF NOT EXISTS chusky_sdk_run_terminal_retention_idx
  ON chusky_sdk_run (updated_at, user_id, run_id)
  WHERE (payload->>'status') IN ('completed', 'failed', 'cancelled');

-- measuredQuery() aggregates in memory and flushes bounded samples. This
-- table records query volume and estimated request/response bytes without
-- persisting SQL text, parameters, user IDs, or result payloads.
CREATE TABLE IF NOT EXISTS chusky_query_metric_sample (
  instance_id UUID NOT NULL,
  batch_id BIGINT NOT NULL CHECK (batch_id > 0),
  query_hash TEXT NOT NULL CHECK (query_hash ~ '^[a-f0-9]{64}$'),
  query_family TEXT NOT NULL CHECK (length(query_family) BETWEEN 1 AND 120),
  observed_at TIMESTAMPTZ NOT NULL,
  commands BIGINT NOT NULL CHECK (commands >= 0),
  errors BIGINT NOT NULL CHECK (errors >= 0 AND errors <= commands),
  request_bytes BIGINT NOT NULL CHECK (request_bytes >= 0),
  response_bytes BIGINT NOT NULL CHECK (response_bytes >= 0),
  duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0),
  max_value_bytes BIGINT NOT NULL CHECK (max_value_bytes >= 0),
  PRIMARY KEY (instance_id, batch_id, query_hash)
);

CREATE INDEX IF NOT EXISTS chusky_query_metric_sample_observed_at_idx
  ON chusky_query_metric_sample (observed_at);

CREATE INDEX IF NOT EXISTS chusky_query_metric_sample_route_idx
  ON chusky_query_metric_sample (observed_at, query_family);

-- The retention indexes are intentionally separate from the data tables so
-- cleanup can delete small batches without a full-table scan.
CREATE INDEX IF NOT EXISTS chusky_conversation_message_retention_idx
  ON chusky_conversation_message (created_at, user_id, message_id);

CREATE INDEX IF NOT EXISTS chusky_memory_reflections_retention_idx
  ON chusky_memory_reflections (updated_at, id)
  WHERE status IN ('rejected', 'consolidated', 'duplicate', 'failed');

COMMIT;
