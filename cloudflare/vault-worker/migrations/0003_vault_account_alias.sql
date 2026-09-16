PRAGMA foreign_keys = OFF;

-- Allow separate personal/work identities for the same service without
-- changing the credential ciphertext or exposing any secret in the alias.
CREATE TABLE vault_credentials_v3 (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  service TEXT NOT NULL,
  account_alias TEXT NOT NULL DEFAULT 'default',
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
  UNIQUE(account_id, service, account_alias)
);

INSERT INTO vault_credentials_v3
  (id,account_id,service,account_alias,origin,login_url,logout_url,username_field_label,password_field_label,submit_button_label,ciphertext,data_iv,data_tag,wrapped_dek,dek_iv,dek_tag,key_version,status,created_at,updated_at,last_used_at)
SELECT id,account_id,service,'default',origin,login_url,logout_url,username_field_label,password_field_label,submit_button_label,ciphertext,data_iv,data_tag,wrapped_dek,dek_iv,dek_tag,key_version,status,created_at,updated_at,last_used_at
FROM vault_credentials;

DROP TABLE vault_credentials;
ALTER TABLE vault_credentials_v3 RENAME TO vault_credentials;
CREATE INDEX idx_vault_credentials_account ON vault_credentials(account_id, status);

ALTER TABLE vault_setup_tickets ADD COLUMN account_alias TEXT NOT NULL DEFAULT 'default';

PRAGMA foreign_keys = ON;
