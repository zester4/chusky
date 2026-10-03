-- Existing CLI threads used this prefix before SDK runs moved to their own
-- table. Keep those durable identities valid during and after run cutover.
BEGIN;

ALTER TABLE chusky_sdk_run
  DROP CONSTRAINT IF EXISTS chusky_sdk_run_thread_id_check;

ALTER TABLE chusky_sdk_run
  ADD CONSTRAINT chusky_sdk_run_thread_id_check
  CHECK (thread_id ~ '^(thr|cli_thread)_[A-Za-z0-9_-]{1,120}$');

COMMIT;
