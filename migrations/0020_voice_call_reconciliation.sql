-- Durable, owner-scoped reconciliation work. This table contains no provider
-- credentials or audio. It only lets the server recover missed lifecycle and
-- outcome callbacks without ever redialing a provider call.
BEGIN;

CREATE TABLE IF NOT EXISTS chusky_voice_call_reconciliation (
  id TEXT PRIMARY KEY CHECK (id ~ '^vcr_[A-Za-z0-9_-]{1,120}$'),
  user_id BIGINT NOT NULL CHECK (user_id > 0),
  call_id TEXT NOT NULL CHECK (call_id ~ '^(twc|blc)_[A-Za-z0-9_-]{1,120}$'),
  provider TEXT NOT NULL CHECK (provider IN ('twilio', 'bland')),
  provider_call_id TEXT CHECK (provider_call_id IS NULL OR provider_call_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  phase TEXT NOT NULL CHECK (phase IN ('provider', 'outcome')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 100),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_token TEXT CHECK (lease_token IS NULL OR lease_token ~ '^[A-Za-z0-9_-]{1,120}$'),
  lease_until TIMESTAMPTZ,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, call_id, phase)
);

CREATE INDEX IF NOT EXISTS chusky_voice_call_reconciliation_due_idx
  ON chusky_voice_call_reconciliation (status, next_attempt_at, updated_at);

CREATE INDEX IF NOT EXISTS chusky_voice_call_reconciliation_call_idx
  ON chusky_voice_call_reconciliation (user_id, call_id);

COMMIT;
