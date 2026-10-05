BEGIN;
ALTER TABLE chusky_memory_items ADD COLUMN IF NOT EXISTS meeting_safe boolean NOT NULL DEFAULT false;
COMMIT;
