BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CLI and SDK event polling is owner-scoped and ordered by recency. The
-- retention index from 0016 starts with updated_at for sweeps, which is not
-- selective for a tenant poll and can force a broad index scan as the table
-- grows. Keep a separate owner-first index for the hot polling path.
CREATE INDEX IF NOT EXISTS chusky_sdk_run_owner_updated_idx
  ON chusky_sdk_run (user_id, updated_at DESC, run_id DESC);

-- Status-filtered run lists are common in dashboards and CLIs. Index only the
-- bounded JSON status value, while retaining user isolation in the leading
-- columns.
CREATE INDEX IF NOT EXISTS chusky_sdk_run_owner_status_updated_idx
  ON chusky_sdk_run (user_id, (payload->>'status'), updated_at DESC, run_id DESC);

COMMIT;
