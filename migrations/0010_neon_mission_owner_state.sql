-- Per-owner cutover marker: runtime reads Neon only after a verified backfill.
BEGIN;

CREATE TABLE IF NOT EXISTS chusky_mission_owner_state (
  owner_user_id BIGINT PRIMARY KEY CHECK (owner_user_id >= 0),
  mission_count INTEGER NOT NULL CHECK (mission_count >= 0),
  event_count BIGINT NOT NULL CHECK (event_count >= 0),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
