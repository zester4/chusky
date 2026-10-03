-- SDK run writes use compare-and-swap so a stale request cannot replace a newer run.
ALTER TABLE chusky_sdk_run
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0);
