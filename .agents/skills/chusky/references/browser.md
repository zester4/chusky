# Browser, Vault, and Cloudflare Broker

This reference documents Chusky's implemented browser and website-identity path.
It is the source of truth for agents changing Daytona browser tools, the vault
broker, or the Cloudflare Worker/D1 deployment.

## Capability split

Chusky has two separate execution paths:

```text
CHUCK_DAYTONA_BROWSER
  └─ normal browsing and site interaction in the user's isolated Daytona desktop

CHUCK_VAULT_LOGIN
  └─ trusted CredentialBroker
       └─ Cloudflare Worker
            └─ D1 encrypted credential records
```

Use Composio for OAuth-connected app integrations. Use the vault for ordinary
websites that must be operated through a browser and are not represented by a
supported Composio connection. Do not search the Composio catalogue merely
because a user asks to connect a website account.

## Intent routing

- “Connect/link/add/save/sign in to my Amazon account” starts `CHUCK_VAULT_SAVE`
  with a normalized service name and exact HTTPS origin.
- `CHUCK_VAULT_SAVE` returns a private, short-lived HTTPS setup URL. The user
  enters the username and password directly into that form; the model never
  receives them.
- “Use my saved Amazon account” or a detected expired session uses
  `CHUCK_VAULT_LOGIN` before browser actions.
- “What websites are connected?” uses `CHUCK_VAULT_LIST` or
  `CHUCK_VAULT_STATUS`. Results contain safe metadata only.
- Website identities belong to the Chusky account, not Telegram, a group, or a
  provider conversation. Group requests must continue in a private conversation.

## Daytona browser operating loop

1. Confirm the Daytona workspace and browser are available with the appropriate
   status tool.
2. Open only an explicit `http://` or `https://` URL. Never put credentials,
   cookies, access tokens, or secrets in a URL.
3. Inspect the page with `snapshot` or `find` before interacting.
4. Prefer accessible node actions (`focus`, `invoke`, `fill`) over guessed
   coordinates. Do not claim an interaction succeeded without inspecting the
   resulting page or state.
5. Re-check the page after navigation, form submission, or any consequential
   action. Keep browser state in the retained Daytona workspace.
6. If CAPTCHA, MFA/2FA, consent, or a site-specific challenge appears, pause and
   ask the user to complete it in the private browser session.

During a vault-authenticated session, normal browser tools must not receive a
password or cookie. The browser policy requires a matching `vaultAction` for
high-impact operations such as checkout, purchase, changing an address, or
adding a payment method. Account deletion, password changes, and email changes
are blocked by policy.

## Credential safety

- Never ask the user to paste a password, recovery code, cookie, or token into
  Telegram, a group, a model message, a tool argument, or a log.
- `CHUCK_VAULT_SAVE` accepts only setup metadata: service, origin, optional login
  and logout URLs, and optional field labels. It must reject secret fields.
- The Worker stores encrypted credential ciphertext in D1. The master key is a
  Worker Secret, not a D1 value and not a Railway variable.
- `CHUCK_VAULT_LOGIN` requests a short-lived broker lease and injects secrets
  directly into the trusted Daytona login flow. Return only authenticated status
  and safe session metadata.
- Destroy plaintext values as soon as the broker operation completes. Never log
  raw request bodies, credentials, cookies, decrypted values, or encryption keys.
- Audit identity usage with account, service/origin, action, run/request ID,
  result, timing, and safe error metadata; do not audit secret values.

## Cloudflare deployment

The production broker is the Worker `chusky-vault-broker` with a D1 binding:

```text
VAULT_DB → chusky-vault-prod
```

Worker Secrets:

- `BROKER_HMAC_SECRET`: authenticates broker requests from Chusky.
- `VAULT_MASTER_KEY`: encrypts/decrypts credential records inside the Worker.

Railway runtime variables:

- `VAULT_ENABLED=true`
- `VAULT_BROKER_URL=https://chusky-vault-broker.<account>.workers.dev`
- `VAULT_BROKER_HMAC_SECRET=<same value as the Worker secret>`

Never put `VAULT_MASTER_KEY` in Railway. Chusky signs broker requests with the
HMAC secret and the Worker verifies timestamp, nonce, request ID, and body hash.
Reject stale or replayed requests. Keep the Worker endpoint HTTPS-only.

The D1 schema and Worker source live in `cloudflare/vault-worker/`. Apply schema
migrations through Wrangler/Cloudflare deployment tooling, then verify the
Worker's health endpoint and a non-secret authenticated broker operation before
calling the feature live.

## Verification checklist

- Run TypeScript validation and focused vault/browser tests before deployment.
- Check the Worker health endpoint returns a healthy broker status.
- Confirm the D1 binding is named exactly `VAULT_DB`.
- Confirm both Worker secrets exist without printing their values.
- Confirm Railway has the broker URL, enable flag, and matching HMAC secret.
- In a private Telegram chat, send “connect my [website] account” and verify a
  setup URL is returned instead of a Composio search or an unsupported message.
- Complete setup with a test account, then verify `CHUCK_VAULT_LOGIN` authenticates
  inside Daytona without exposing the username/password to the model.
- Test retained-session reuse, logout, expired-session handling, CAPTCHA/2FA
  pause behavior, group denial, and high-impact action policy.
- Inspect logs for metadata only and confirm no credential or raw tool argument
  appears.

## Change rules

Keep vault ownership and policy in the server runtime. Do not expose the D1
binding, Worker master key, broker HMAC secret, or Daytona session cookies to the
client or model. Any new browser operation must document its `vaultAction`
classification, approval/block behavior, output redaction, and verification
test before it is added to `agentTools.ts`.
