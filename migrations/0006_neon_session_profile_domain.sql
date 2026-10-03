-- Add the safe, explicitly selected user-preference/session-metadata domain.
BEGIN;

ALTER TABLE chusky_session_domain
  DROP CONSTRAINT IF EXISTS chusky_session_domain_domain_check;

ALTER TABLE chusky_session_domain
  ADD CONSTRAINT chusky_session_domain_domain_check
  CHECK (domain IN ('profile', 'conversation', 'memories', 'assets', 'sdk'));

COMMIT;
