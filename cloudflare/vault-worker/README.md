# Chusky Vault Broker

This Worker is the production trust boundary for Chusky website identities.

- `VAULT_DB` is the dedicated EU D1 database.
- `VAULT_MASTER_KEY` and `BROKER_HMAC_SECRET` are Worker Secrets, never Wrangler variables or repository files.
- Railway authenticates broker API requests with a timestamped HMAC, request ID, and one-time nonce.
- The Worker receives credentials only through a short-lived, clean-URL setup form, encrypts them with Web Crypto envelope encryption, and records safe audit data.
- The Worker never exposes D1, ciphertext, or secrets publicly.
- Broker calls are account-scoped and rate-limited. Authenticated website sessions are bound to their saved HTTPS origin and expire after 30 days.

## Deploy and migrate

Run the D1 migrations before deploying the Worker. The second migration adds replay request IDs and
rate-limit buckets; the third adds origin-safe personal/work account aliases and migrates existing
credentials to the `default` alias. The fourth migration makes the exact HTTPS
origin part of the credential identity key, so one service label and alias can
refer to multiple websites without overwriting one another:

```sh
wrangler d1 migrations apply VAULT_DB --remote
wrangler deploy
```

Use the database binding name from `wrangler.jsonc` if it differs from `VAULT_DB`. Never put the key material in `wrangler.jsonc` or a committed `.env` file.

Set secrets with Wrangler or the Cloudflare dashboard:

```sh
wrangler secret put VAULT_MASTER_KEY
wrangler secret put BROKER_HMAC_SECRET
```

The master key must be a stable base64-encoded AES key. Keep the Railway `VAULT_BROKER_HMAC_SECRET` equal to the Worker `BROKER_HMAC_SECRET`; these are separate from `VAULT_MASTER_KEY`.

## Master-key rotation

For a rotation, keep the old key available as `VAULT_MASTER_KEY_PREVIOUS`, set the new key as `VAULT_MASTER_KEY`, and increment `VAULT_MASTER_KEY_VERSION` (the default is `2`). Deploy both together, then re-save each website identity through a new private setup link. The Worker can read the immediately previous version during the migration window; remove the previous secret only after all credentials have been re-encrypted.

## Browser safety behavior

Chusky injects leased credentials only inside the trusted Daytona workspace. While a saved identity is authenticated, raw coordinate typing, screenshots, and recordings are blocked from the model-facing browser tools. The agent must use a fresh accessibility find result and an explicit `vaultAction` for sensitive controls; owner inspection goes through the private browser handoff. This prevents credentials and private pages from entering model context or logs.

Deploy only after the Chusky backend has the matching `VAULT_BROKER_URL` and `VAULT_BROKER_HMAC_SECRET` secret. Run migrations before deployment.
