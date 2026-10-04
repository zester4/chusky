BEGIN;

-- Conversation reflection is deliberately a reviewable staging area.  Rows in
-- this table are not durable memories until the consolidation worker applies
-- an explicitly accepted candidate through the normal scope-checked writer.
CREATE TABLE IF NOT EXISTS chusky_memory_reflections (
  id TEXT PRIMARY KEY,
  owner_user_id BIGINT NOT NULL CHECK (owner_user_id > 0),
  source_id TEXT NOT NULL REFERENCES chusky_memory_sources(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL REFERENCES chusky_memory_scopes(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  candidate JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','needs_review','accepted','rejected','consolidated','duplicate','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_at TIMESTAMPTZ,
  last_error TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS chusky_memory_reflections_ready_idx
  ON chusky_memory_reflections (status, created_at)
  WHERE status IN ('queued','accepted','processing');

CREATE INDEX IF NOT EXISTS chusky_memory_reflections_review_idx
  ON chusky_memory_reflections (owner_user_id, status, updated_at)
  WHERE status = 'needs_review';

COMMIT;
