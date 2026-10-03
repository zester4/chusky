-- SDK runs are independent durable records so updating one run never rewrites
-- every thread and run in the owner's SDK session document.
CREATE TABLE IF NOT EXISTS chusky_sdk_run (
  user_id BIGINT NOT NULL CHECK (user_id >= 0),
  thread_id TEXT NOT NULL CHECK (thread_id ~ '^thr_[A-Za-z0-9_-]{1,120}$'),
  run_id TEXT NOT NULL CHECK (run_id ~ '^run_[A-Za-z0-9_-]{1,120}$'),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, run_id),
  CHECK (updated_at >= created_at),
  CHECK (payload->>'id' = run_id)
);

CREATE INDEX IF NOT EXISTS chusky_sdk_run_thread_created_idx
  ON chusky_sdk_run (user_id, thread_id, created_at, run_id);

CREATE INDEX IF NOT EXISTS chusky_sdk_run_active_idx
  ON chusky_sdk_run (user_id, updated_at)
  WHERE payload->>'status' IN ('queued', 'running');
