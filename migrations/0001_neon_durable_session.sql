-- Run only with DURABLE_STATE_MIGRATION_DATABASE_URL (a Neon direct URL).
-- This table contains bounded structured JSON, never file bytes or credentials.
CREATE TABLE IF NOT EXISTS chusky_session_domain (
  user_id BIGINT NOT NULL CHECK (user_id >= 0),
  domain TEXT NOT NULL CHECK (domain IN ('conversation', 'memories', 'assets', 'sdk')),
  payload JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, domain)
);

CREATE INDEX IF NOT EXISTS chusky_session_domain_updated_at_idx
  ON chusky_session_domain (updated_at);
