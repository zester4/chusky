# Chusky Developer API v1 contract

This document is the implementation contract for the SDK. It prevents the existing CLI service protocol from becoming an accidental public API.

## Principles

1. `/v1` is the only public prefix. Existing `/cli`, Telegram, channel, and workflow routes remain private transport endpoints.
2. `CHUSKY_PROJECT_KEY` is the root bootstrap/admin key on the Oracle server. It creates project-scoped `chsk_` keys, returned once and persisted as hashes only. A developer puts their scoped key in `CHUSKY_API_KEY` in their own server environment. An end-user identifier is supplied in `X-Chusky-User-Id` and is never inferred from a phone number, display name, or channel identity. The first-party web dashboard may use its Better Auth session cookie for user-scoped `/v1` resources; API keys remain server-side credentials.
3. Project keys are revocable and scope-enforced (`resource:read`, `resource:write`, `resource:*`, or `*`). Never use CLI device tokens for the SDK.
4. Durable mutations accept `Idempotency-Key`; persist method, normalized path, body digest, response status/body, and a 24-hour replay window. A reused key with a different body returns `409 idempotency_mismatch`. Live streaming is not replayable; reconnect through persisted run state and events.
5. Every response has `X-Request-Id`. Errors use `{ "error": { "code", "message", "requestId" } }`.
6. Runs may require approval. The server persists the exact pending action and binds a decision to its end user; neither the SDK nor a webhook payload is authorization.

## Resources

| Resource | Endpoint | Notes |
| --- | --- | --- |
| Threads | `POST /v1/threads`, `GET /v1/threads/:threadId` | Conversation/memory boundary for one explicit SDK end user. |
| Projects | `GET/POST /v1/admin/projects`, `DELETE /v1/admin/projects/:id` | Root-key-only project provisioning and key revocation. |
| Runs | `POST /v1/threads/:threadId/runs` | Executes durable Chusky work. `wait` is bounded. |
| Run stream | `POST /v1/threads/:threadId/runs/stream` | `application/x-ndjson`; emits typed run events. |
| Runs | `GET /v1/threads/:threadId/runs/:runId`, `POST .../cancel` | Cancellation is request-specific; durable task results stay queryable. |
| Tasks | `GET /v1/tasks`, `GET /v1/tasks/:taskId` | Cursor pagination, project and end-user authorized. |
| Approvals | `GET /v1/approvals/:approvalId`, `POST /v1/approvals/:approvalId` | Decision body is `{ decision: "approve" | "deny" }`. |
| Files | `POST /v1/files`, `POST /v1/files/:fileId/complete`, `GET/DELETE /v1/files/:fileId` | Direct R2 upload URLs are short-lived; a `HEAD` verification must succeed before download; deletion is owner-scoped. |
| Webhooks | `POST /v1/webhooks`, `GET /v1/webhooks`, `DELETE /v1/webhooks/:id` | HTTPS-only subscription; secret is encrypted at rest and returned only on creation. |
| Delivery history | `GET /v1/webhooks/:id/deliveries` | Bounded, safe delivery status for operational diagnosis; delete disables future deliveries. |
| Observability | `GET /v1/audit-events`, `GET /v1/usage` | Bounded per-user audit trail and current usage snapshot. |

## Event stream

The stream contains one JSON object per line and may emit:

`run.started`, `run.delta`, `run.tool_started`, `run.approval_required`, `run.completed`, `run.failed`.

Events are append-only for a single run. The terminal `completed` or `failed` event includes the canonical run record. Connections can be retried by querying the run; do not assume an interrupted stream means work failed.

## Required test cases before enabling `/v1`

- API-key malformed, revoked, expired, wrong-project, wrong-scope, and hash-only storage.
- Idempotency replay and mismatch; retry after a lost response.
- Cross-tenant thread/task/approval denial, including guessed IDs.
- Stream ordering, client cancellation, backend failure, and reconnect-to-run status.
- Approval expiry, exact-action binding, double-click race, and user/project mismatch.
- Cursor tampering and stable pagination under new writes.
- Per-project/end-user rate and spend limits, `429`/`Retry-After`, audit records, and request IDs.
- R2 intent expiry, content-type/size verification, pending-file download denial, and tenant isolation.
- Webhook signature verification, retry/backoff, endpoint disablement, and dead-letter replay.
