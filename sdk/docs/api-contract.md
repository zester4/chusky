# Chusky Developer API v1 contract

This document is the implementation contract for the SDK. It prevents the existing CLI service protocol from becoming an accidental public API.

## Principles

1. `/v1` is the only public prefix. Existing `/cli`, Telegram, channel, and workflow routes remain private transport endpoints.
2. The initial self-hosted slice authenticates with the dedicated server-side `CHUSKY_API_KEY`; an end-user identifier is supplied in `X-Chusky-User-Id` and is never inferred from a phone number, display name, or channel identity.
3. Project-scoped, hash-only, rotatable keys are the next multi-tenant control-plane slice. Never use CLI device tokens for the SDK.
4. All mutation endpoints accept `Idempotency-Key`; persist method, normalized path, body digest, response status/body, and expiry. A reused key with a different body returns `409 idempotency_mismatch`.
5. Every response has `X-Request-Id`. Errors use `{ "error": { "code", "message", "requestId" } }`.
6. Runs may require approval. The server persists the exact pending action and binds a decision to its end user; neither the SDK nor a webhook payload is authorization.

## Resources

| Resource | Endpoint | Notes |
| --- | --- | --- |
| Threads | `POST /v1/threads`, `GET /v1/threads/:threadId` | Conversation/memory boundary for one explicit SDK end user. |
| Runs | `POST /v1/threads/:threadId/runs` | Executes durable Chusky work. `wait` is bounded. |
| Run stream | `POST /v1/threads/:threadId/runs/stream` | `application/x-ndjson`; emits typed run events. |
| Runs | `GET /v1/threads/:threadId/runs/:runId`, `POST .../cancel` | Cancellation is request-specific; durable task results stay queryable. |
| Tasks | `GET /v1/tasks`, `GET /v1/tasks/:taskId` | Cursor pagination, project and end-user authorized. |
| Approvals | `GET /v1/approvals/:approvalId`, `POST /v1/approvals/:approvalId` | Decision body is `{ decision: "approve" | "deny" }`. |

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
