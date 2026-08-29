# Chusky SDK and Developer API

This document records the SDK/control-plane work that has been added to Chusky, the files involved, how to verify it, and the remaining work before treating it as a broadly public SaaS API.

## What has been built

### Developer API and TypeScript SDK

Chusky now has a versioned developer API under `/v1` and a standalone ESM TypeScript SDK package, `@chusky/sdk`.

- Threads: create, list, and fetch.
- Runs: synchronous execution, NDJSON streaming, fetch/list events, and cancellation.
- Approvals: inspect, decide, and resume an approval-gated run.
- Tasks: list and inspect durable agent tasks.
- Audit/usage: fetch scoped audit events.
- Typed SDK errors for authentication, validation, rate-limit, HTTP, and abort failures.
- Streaming is exposed as an async iterator and supports cancellation through `AbortSignal`.
- The client sends request IDs and idempotency keys where appropriate.

The SDK uses the requested `CHUSKY_API_KEY` naming convention. There is no `CHUSKY_SDK_API_KEY`.

### Project credentials and tenant isolation

`CHUSKY_API_KEY` is the server-side root/bootstrap credential. It can create developer projects and their runtime keys through root-only admin endpoints.

- Project API keys are returned only at creation or rotation time.
- Only a SHA-256 hash and a non-sensitive key prefix are persisted.
- Keys can be scoped, revoked, and rotated.
- Supported scopes include `resource:read`, `resource:write`, `resource:*`, and `*`.
- A project key plus `X-Chusky-User-Id` creates a stable, project-isolated user namespace.
- Root project mutations are audit logged without persisting key material or request bodies.

### Durable runs, safety, and persistence

- SDK thread/run/task state uses the existing durable store.
- The SDK control plane uses reserved session `0`; in Redis it intentionally has no chat-session TTL.
- Idempotency records prevent duplicate creates and are retained for 24 hours, capped at 500 records per user session.
- Cancelling a streamed request aborts only that run; it does not stop unrelated work.
- Run API throttling returns `429` with `Retry-After: 60`.
- `X-Request-Id`, structured error `requestId`, and audit event request IDs are kept consistent.

### R2-backed file uploads

The files API supports direct Cloudflare R2 uploads without proxying file bytes through Chusky.

- Create an upload intent with an allowlisted content type and a maximum size.
- Receive a five-minute presigned upload URL.
- Complete the upload only after Chusky verifies object size and content type with R2.
- Retrieve a five-minute presigned download URL only for verified, available files.
- Delete both the R2 object and its durable metadata record.

The maximum is configurable with `SDK_MAX_FILE_BYTES` and defaults to 25 MiB.

### Signed outbound webhooks

Developers can register, list, and delete webhook subscriptions, and inspect deliveries.

- Webhook URL validation requires public HTTPS and rejects localhost, local domains, literal private/link-local IPs, and redirects.
- Webhook secrets are encrypted at rest using AES-GCM and never returned after creation.
- Deliveries include an HMAC-SHA256 signature over the timestamp and raw body.
- Terminal run events are queued through a durable, leased outbox.
- Startup recovery and a 30-second worker loop retry interrupted work; deliveries have a five-attempt limit.

### Documentation, CI, and tests

- The SDK has its own README, API contract, OpenAPI description, package build, and client test suite.
- Root README and `.env.example` describe the developer API variables.
- GitHub Actions runs typechecking, root tests, root build, SDK build, SDK tests, and `git diff --check` on Node 22.

## Files added or materially updated

### API, configuration, and persistence

- `src/sdkApi.ts` — `/v1` public API, authentication, projects, threads, runs, approvals, tasks, files, audit, and webhook routes.
- `src/index.ts` — registers the developer API in webhook/API-server mode and starts webhook-outbox recovery.
- `src/config.ts` — `CHUSKY_API_KEY`, R2 settings, and `SDK_MAX_FILE_BYTES` configuration.
- `src/store.ts` — durable SDK records: threads, files, idempotency records, audit events, projects, webhook subscriptions, delivery records, and outbox state.
- `.env.example` — environment variable examples.

### Storage and delivery services

- `src/lib/storage/r2.ts` — R2 client, presigned upload/download URLs, object verification, and deletion.
- `src/lib/webhooks.ts` — URL safety checks, AES-GCM secret sealing, signing, and delivery.
- `src/lib/webhookOutbox.ts` — durable webhook queueing, recovery, leasing, and retries.

### SDK package

- `sdk/package.json`
- `sdk/tsconfig.json`
- `sdk/src/index.ts`
- `sdk/src/client.ts`
- `sdk/src/types.ts`
- `sdk/src/errors.ts`
- `sdk/src/stream.ts`
- `sdk/README.md`
- `sdk/docs/api-contract.md`
- `sdk/openapi.yaml`
- `sdk/tests/client.test.ts`

### Tests and automation

- `tests/sdk-api.test.ts` — API authentication, idempotency, files validation, webhook subscription behavior, project keys/scopes/revocation/rotation, root audit, and the non-expiring SDK control plane.
- `tests/webhooks.test.ts` — secret encryption, signatures, delivery headers, and URL safety.
- `tests/webhook-outbox.test.ts` — durable/idempotent webhook queue behavior.
- `.github/workflows/ci.yml` — CI verification for app and SDK.
- `README.md` — developer API and credential guidance.
- `package.json` and `package-lock.json` — R2/AWS SDK dependencies and SDK scripts.

## Production configuration

The normal Chusky provider configuration is still required. For the developer API layer, configure:

| Variable | Purpose |
| --- | --- |
| `CHUSKY_API_KEY` | Root/bootstrap credential used by server operators only. Do not put this in client applications. |
| `REDIS_URL` | Required production durability for sessions, runs, projects, idempotency, files, audit, and the outbox. |
| `WEBHOOK_URL` | Enables the current hosted API-server/webhook mode in `src/index.ts`. |
| `R2_ACCOUNT_ID` | Enables R2-backed file uploads. |
| `R2_ACCESS_KEY_ID` | R2 S3-compatible access key. |
| `R2_SECRET_ACCESS_KEY` | R2 S3-compatible secret key. |
| `R2_BUCKET` | R2 bucket for SDK uploads. |
| `SDK_MAX_FILE_BYTES` | Optional upload limit; defaults to 25 MiB. |

Application developers should receive a project key beginning with `chsk_...`, not the root `CHUSKY_API_KEY`, and send it as `Authorization: Bearer ...` along with `X-Chusky-User-Id`. The first-party web dashboard is also allowed to call the user-scoped `/v1` resources with its Better Auth session cookie; browser code must never receive either kind of API key.

For browser-direct R2 uploads, configure bucket CORS separately for the application origins and the required upload headers. That configuration lives in Cloudflare, not in this repository.

## Verification already performed

The implementation has been checked locally with:

```powershell
npm test
npm run typecheck
npm run build
npm run build:sdk
npm run test:sdk
git diff --check
```

The root test suite passed, including the new SDK/API, webhook, and outbox coverage. Two pre-existing PTY-oriented tests are intentionally skipped where a PTY is unavailable. The SDK client suite has five passing tests.

## What remains before a broad public launch

The foundation is production-oriented, but the following are the meaningful remaining hardening items.

1. Root-secret rotation strategy. Webhook secrets are currently encrypted with a key derived from `CHUSKY_API_KEY`. Rotating that root key without a migration path would make existing encrypted webhook secrets unreadable. Introduce an independently managed encryption-key ring/version field and a re-encryption migration before supporting routine root-key rotation.

2. Stronger webhook operations. Add exponential backoff with `nextAttemptAt`, a dead-letter/replay API, endpoint health visibility, automatic disablement after sustained failures, and DNS-resolution/rebinding protection. Current validation rejects dangerous literal hosts and redirects, but does not resolve hostnames before every delivery.

3. Atomic multi-replica control-plane writes. Project creation, rotation, revocation, and idempotency currently use durable session saves. Add Redis transactions/CAS or dedicated keyed records to prevent races when many API instances mutate the same project concurrently.

4. File-security and lifecycle controls. Add malware scanning or a scanning callback before files become available, per-project storage quotas, retention/expiry policies, lifecycle deletion, and content inspection appropriate to the accepted media types.

5. Project-wide limits and billing hooks. Current rate behavior is request/run oriented. Add project-wide concurrency, token/spend, file, webhook, and monthly quota controls, usage aggregation, and metering/billing integration if the API will be commercial.

6. Public API release process. The SDK is published as `@chusky/sdk` with MIT metadata and a prepublish verification hook. Continue maintaining semantic versioning, changelog, provenance, support, and deprecation policy.

7. Contract validation and compatibility. Validate all API request/response payloads against a shared schema, add OpenAPI contract tests/generated client checks, document pagination and error-code stability, and establish a version-deprecation policy.

8. Real infrastructure end-to-end testing. Run an authenticated deployment against real Redis, R2, a public test webhook receiver, and the configured agent provider. Cover direct browser upload CORS, completed-file verification, a full streamed run, cancellation, retry/recovery after a process restart, and webhook signature verification.

9. Observability and operator tooling. Add dashboards/alerts for queue depth, lease expiry, delivery failures, R2 verification failures, rate-limit events, per-project usage, and key/auth failures. Add carefully permissioned operator endpoints or internal tooling for replay and incident investigation.

## Recommended rollout order

1. Set `CHUSKY_API_KEY`, Redis, `WEBHOOK_URL`, and—if files are needed—R2 credentials in a staging environment.
2. Use the root key only to create a low-privilege test project; use its `chsk_...` key in the SDK.
3. Execute the real end-to-end checks above, including a webhook receiver and R2 CORS upload.
4. Complete the rotation, webhook/DLQ, atomicity, and observability items before onboarding untrusted external developers at scale.
