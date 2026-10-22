-- Keep the autonomous execution ledger canonical across Neon rehydration.
-- This includes external provider receipts and recovery evidence; it contains
-- no provider credentials or raw tool secrets.
BEGIN;

ALTER TABLE chusky_session_domain
  DROP CONSTRAINT IF EXISTS chusky_session_domain_domain_check;

ALTER TABLE chusky_session_domain
  ADD CONSTRAINT chusky_session_domain_domain_check
  CHECK (domain IN ('profile', 'conversation', 'memories', 'assets', 'calls', 'autonomy', 'sdk'));

COMMIT;
