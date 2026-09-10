# Chusky Vault Broker

This Worker is the production trust boundary for Chusky website identities.

- `VAULT_DB` is the dedicated EU D1 database.
- `VAULT_MASTER_KEY` and `BROKER_HMAC_SECRET` are Worker Secrets, never Wrangler variables or repository files.
- Railway authenticates broker API requests with a timestamped HMAC and one-time nonce.
- The Worker receives credentials only through a short-lived setup form, encrypts them with Web Crypto envelope encryption, and records safe audit data.
- The Worker never exposes D1, ciphertext, or secrets publicly.

Deploy only after the Chusky backend has the matching `VAULT_BROKER_URL` and `VAULT_BROKER_HMAC_SECRET` secret. Run migrations before deployment.
