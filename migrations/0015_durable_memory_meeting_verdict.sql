BEGIN;
ALTER TABLE chusky_memory_items
  ADD COLUMN IF NOT EXISTS meeting_verdict text
  CHECK (meeting_verdict IS NULL OR meeting_verdict IN ('safe', 'unsafe', 'unknown'));
COMMIT;
