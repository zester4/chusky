PRAGMA foreign_keys = OFF;

-- A service name is a human label, not a security boundary. Allow the same
-- label and account alias to be used for different exact HTTPS origins, while
-- preserving existing credential IDs and encrypted ciphertext.
CREATE TABLE vault_credentials_v4 (
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
  UNIQUE(account_id, service, account_alias, origin)
);

INSERT INTO vault_credentials_v4
  (id,account_id,service,account_alias,origin,login_url,logout_url,username_field_label,password_field_label,submit_button_label,ciphertext,data_iv,data_tag,wrapped_dek,dek_iv,dek_tag,key_version,status,created_at,updated_at,last_used_at)
SELECT id,account_id,service,account_alias,origin,login_url,logout_url,username_field_label,password_field_label,submit_button_label,ciphertext,data_iv,data_tag,wrapped_dek,dek_iv,dek_tag,key_version,status,created_at,updated_at,last_used_at
FROM vault_credentials;

DROP TABLE vault_credentials;
ALTER TABLE vault_credentials_v4 RENAME TO vault_credentials;
CREATE INDEX idx_vault_credentials_account ON vault_credentials(account_id, status);
CREATE INDEX idx_vault_credentials_origin ON vault_credentials(account_id, origin, status);

PRAGMA foreign_keys = ON;
