# Chusky Developer API and SDK

Load this reference when working on `src/sdkApi.ts`, the `sdk/` package, project
credentials, `/v1` routes, R2-backed files, or signed developer webhooks. It captures
the contracts that differ from the Telegram and CLI transports.

## Boundary and credentials

The developer API is a hosted API boundary, not a replacement for the internal
Telegram identity model or `CHUCK_*` native tool identifiers.

- `CHUSKY_API_KEY` is the operator's root/bootstrap credential. It is used only for
  `/v1/admin/*` project management and must never be put in a browser, SDK example
  intended for app users, log, audit payload, or webhook payload.
- Project credentials start with `chsk_`. Return a project key only on create or
  rotation; persist its SHA-256 hash and safe prefix, never the raw secret.
- A project key must have the required scope and be active. Revocation and scope
  reductions take effect on the next request.
- Every project-key request also requires `X-Chusky-User-Id`. Derive the durable
  SDK session identity from both project and external user ID. Do not infer this
  identity from phone numbers, display names, IP addresses, or channel accounts.
- The root credential remains the encryption source for current webhook secrets.
  Do not add root-key rotation claims or change encryption behavior without a
  versioned key-ring and migration strategy.

## API implementation rules

`registerSdkApi(app)` lives in `src/sdkApi.ts` and is registered from `src/index.ts`
in the hosted webhook/API mode. Keep public API behavior isolated from Telegram
handlers and from private account session history.

- Keep the `/v1` prefix and preserve response/error shape compatibility. API errors
  carry stable machine-readable codes and the same request ID exposed through
  `X-Request-Id`.
- Require a matching `Idempotency-Key` for mutating create-style routes. Replay the
  saved response for an identical request; return a conflict for key reuse with a
  different fingerprint. The current retention window is 24 hours.
- Persist an audit event without raw Authorization headers, raw project keys, or
  arbitrary request bodies.
- Cancellation must use the specific run's abort controller. It must not cancel a
  different thread/run or mutate unrelated durable work.
- Keep streaming as NDJSON. The SDK stream parser must tolerate chunk boundaries,
  surface server errors as typed errors, and honor caller `AbortSignal`.
- Treat a disconnected streaming client as an abort for that request only. Durable
  run state must still reach a coherent terminal/cancelled outcome.
- Add a route-level authorization, invalid-input, duplicate/idempotency, and retry
  or cancellation test whenever introducing a mutating route.

## Files API and R2

R2 is optional and configured with `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`. `SDK_MAX_FILE_BYTES` defaults to 25 MiB.

The file lifecycle is `pending -> available` only after `HeadObject` confirms the
uploaded object's type and size; it may instead become `rejected`. Downloads must be
presigned only for `available` files. Deletion must remove the object and the durable
metadata record.

- Keep the allowlist narrow and validate file name, declared type, and declared size
  before creating an upload intent.
- Do not proxy upload bytes through the Chusky process unless the product
  intentionally changes the architecture and adds bounded streaming/abuse controls.
- Treat R2 CORS as deployment configuration. Browser clients need bucket CORS for
  their allowed origins and upload headers; do not attempt to solve it with API
  response headers alone.
- Before a broad untrusted-developer rollout, add malware scanning, quotas, and
  retention/lifecycle rules. Do not describe pending/available verification as
  malware protection.

## Developer webhooks

Subscriptions are developer callbacks, distinct from inbound Slack, WhatsApp, or
Telegram webhooks.

- Require public HTTPS destinations. Reject localhost, `.localhost`, `.local`,
  literal private/link-local addresses, and HTTP. Do not follow redirects.
- Store the delivery secret encrypted and return it once at subscription creation.
  Sign deliveries with HMAC-SHA256 over timestamp and raw body.
- Queue terminal run events in the durable outbox before delivery. Leases and retry
  state must survive process restart; never send from a best-effort in-memory timer.
- The current worker recovers work on startup and polls every 30 seconds with a
  five-attempt maximum. If altering retries, preserve durable lease recovery and
  idempotent queue insertion.
- DNS rebinding protection, exponential `nextAttemptAt` backoff, dead-letter replay,
  and endpoint auto-disablement are intentionally unfinished hardening work. Do not
  claim them as implemented until code and tests exist.

## SDK package and release discipline

The package in `sdk/` is standalone ESM TypeScript. Keep it free of Telegram,
Composio, Redis, internal native-tool, and operator-secret dependencies.

- Export only the public client, public types, and public error classes from
  `sdk/src/index.ts`.
- Update `sdk/docs/api-contract.md` and `sdk/openapi.yaml` whenever a public route,
  request, response, auth rule, or error code changes. Keep `sdk/README.md` focused
  on developer integration and clearly distinguish root from project keys.
- Public package publication needs an explicit registry/scope, license, semantic
  version, changelog, provenance, and deprecation policy. `UNLICENSED` means the
  current scaffold must not be represented as publicly publishable.
- The SDK exports `createChuskyAdmin({ apiKey, baseUrl, userId? })` as a convenience
  for trusted operator backends. It supplies the non-user `operator` identity when
  omitted; it does not weaken the server requirement for `X-Chusky-User-Id`.
- The admin client may create, list, scope, rotate, and revoke projects. Raw project
  keys are returned only by create/rotate and must be shown once and stored by the
  operator; list responses contain only the safe prefix. The root key must never be
  bundled into browser code or a public npm example.
- Self-hosted consumers should pass `CHUSKY_BASE_URL` (for example,
  `https://chusky.selithub.shop`) rather than relying on the hosted default.
- The npm package uses MIT metadata, includes `dist`, public docs, and `LICENSE`,
  and runs typecheck/build/tests through `prepublishOnly`. If generated `dist` is
  committed, update it together with the TypeScript source.

## Verification

For SDK/API work, run the normal repository checks plus the SDK checks:

```powershell
npm test
npm run typecheck
npm run build
npm run build:sdk
npm run test:sdk
git diff --check
```

When infrastructure is available, additionally test a deployed API with real Redis,
R2, and a public webhook receiver: provision a scoped project key, create and stream
a run, cancel a run, upload/complete/download/delete a file, verify a webhook
signature, and restart the service while a delivery is queued.
