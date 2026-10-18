-- Keep provider receipts and bounded voice-call lifecycle records in the
-- canonical Neon session domains. The old aggregate Redis session is only a
-- migration marker after durable state is enabled.
BEGIN;

ALTER TABLE chusky_session_domain
  DROP CONSTRAINT IF EXISTS chusky_session_domain_domain_check;

ALTER TABLE chusky_session_domain
  ADD CONSTRAINT chusky_session_domain_domain_check
  CHECK (domain IN ('profile', 'conversation', 'memories', 'assets', 'calls', 'sdk'));

COMMIT;
