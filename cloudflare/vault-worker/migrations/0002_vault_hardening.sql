PRAGMA foreign_keys = ON;

-- Bind authenticated broker requests to both their nonce and request ID. This
-- prevents replaying a request with a fresh nonce and makes retries safe.
ALTER TABLE vault_broker_nonces ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_nonces_request_id ON vault_broker_nonces(request_id) WHERE request_id IS NOT NULL;

-- Fixed-window limits are deliberately account-scoped and only store hashes,
-- never IP addresses or account identifiers.
CREATE TABLE IF NOT EXISTS vault_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vault_rate_limits_window ON vault_rate_limits(window_started_at);
