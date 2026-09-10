PRAGMA foreign_keys = ON;

CREATE TABLE vault_credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  service TEXT NOT NULL,
  origin TEXT NOT NULL,
  login_url TEXT NOT NULL,
  logout_url TEXT,
  username_field_label TEXT NOT NULL,
  password_field_label TEXT NOT NULL,
  submit_button_label TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  data_iv TEXT NOT NULL,
  data_tag TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  dek_iv TEXT NOT NULL,
  dek_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','compromised')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE(account_id, service)
);
CREATE INDEX idx_vault_credentials_account ON vault_credentials(account_id, status);

CREATE TABLE vault_setup_tickets (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  account_id TEXT NOT NULL,
  service TEXT NOT NULL,
  origin TEXT NOT NULL,
  login_url TEXT NOT NULL,
  logout_url TEXT,
  username_field_label TEXT NOT NULL,
  password_field_label TEXT NOT NULL,
  submit_button_label TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_vault_tickets_expiry ON vault_setup_tickets(expires_at);

CREATE TABLE vault_browser_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES vault_credentials(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('authenticated','unknown','expired','logged_out','needs_reauth','awaiting_user_interaction')),
  last_authenticated_at INTEGER,
  last_used_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, credential_id, workspace_id)
);
CREATE INDEX idx_vault_identities_account ON vault_browser_identities(account_id, status);

CREATE TABLE vault_broker_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_vault_nonces_expiry ON vault_broker_nonces(expires_at);

CREATE TABLE vault_audit_log (
  id TEXT PRIMARY KEY,
  account_hash TEXT NOT NULL,
  event TEXT NOT NULL,
  credential_id TEXT,
  identity_id TEXT,
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_vault_audit_account_created ON vault_audit_log(account_hash, created_at DESC);
