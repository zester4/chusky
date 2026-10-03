-- Neon owns canonical mission plans and append-only lifecycle events.
-- Redis remains the active lease, cancellation, and workflow coordination layer.
BEGIN;

CREATE TABLE IF NOT EXISTS chusky_mission (
  owner_user_id BIGINT NOT NULL CHECK (owner_user_id >= 0),
  mission_id TEXT NOT NULL CHECK (mission_id ~ '^mis_[A-Za-z0-9_-]{1,160}$'),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','paused','blocked','completed','failed','cancelled')),
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  version INTEGER NOT NULL CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_user_id, mission_id),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS chusky_mission_idempotency_idx
  ON chusky_mission (owner_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS chusky_mission_owner_status_updated_idx
  ON chusky_mission (owner_user_id, status, updated_at DESC, mission_id);

CREATE TABLE IF NOT EXISTS chusky_mission_event (
  event_order BIGINT GENERATED ALWAYS AS IDENTITY,
  owner_user_id BIGINT NOT NULL,
  mission_id TEXT NOT NULL,
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 180),
  event_type TEXT NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (owner_user_id, mission_id, event_id),
  FOREIGN KEY (owner_user_id, mission_id)
    REFERENCES chusky_mission (owner_user_id, mission_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chusky_mission_event_history_idx
  ON chusky_mission_event (owner_user_id, mission_id, event_order DESC);
CREATE INDEX IF NOT EXISTS chusky_mission_owner_sweeper_idx
  ON chusky_mission (owner_user_id, updated_at, mission_id);

COMMIT;
