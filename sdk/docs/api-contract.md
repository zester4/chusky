# Chusky Developer API v1 contract

This document is the implementation contract for the SDK. It prevents the existing CLI service protocol from becoming an accidental public API.

## Principles

1. `/v1` is the only public prefix. Existing `/cli`, Telegram, channel, and workflow routes remain private transport endpoints.
2. `CHUSKY_PROJECT_KEY` is the root bootstrap/admin key on the Oracle server. It creates project-scoped `chsk_` keys, returned once and persisted as hashes only. A developer puts their scoped key in `CHUSKY_API_KEY` in their own server environment. An end-user identifier is supplied in `X-Chusky-User-Id` and is never inferred from a phone number, display name, or channel identity. The first-party web dashboard may use its Better Auth session cookie for user-scoped `/v1` resources; API keys remain server-side credentials.
3. Project keys are revocable and scope-enforced (`resource:read`, `resource:write`, `resource:*`, or `*`). Never use CLI device tokens for the SDK.
4. Durable mutations accept `Idempotency-Key`; persist method, normalized path, body digest, response status/body, and a 24-hour replay window. A reused key with a different body returns `409 idempotency_mismatch`. Live streaming is not replayable; reconnect through persisted run state and events.
5. Every response has `X-Request-Id`. Errors use `{ "error": { "code", "message", "requestId" } }`.
6. Runs may require approval. The server persists the exact pending action and binds a decision to its end user; neither the SDK nor a webhook payload is authorization.

## Dashboard API-key management

Verified Better Auth users may manage only their own projects through
`/v1/account/projects`. These cookie-authenticated routes create, list, update
scopes, rotate, and revoke project keys. They never accept or return
`CHUSKY_PROJECT_KEY`; raw `chsk_` keys are returned only by create and rotation.
Each verified account may have at most 10 active projects. Root-created projects
remain ownerless operator records and are not visible through account routes.

Company projects attach to a Better Auth organization ID. Owners/admins can
create and manage project credentials, policy, and up to 20 agent profiles;
verified members can list those project resources. Default company scopes are
least-privilege and intentionally exclude `approvals:write`, so a project key
cannot approve its own external tool actions. Composio app/OAuth and trigger
endpoints remain the existing integration surface and retain the stable Chusky
end-user identity supplied in `X-Chusky-User-Id`.

Company telemetry is project-scoped rather than caller-scoped: keys with the
`company:read` scope can read status-only run summaries, bounded audit events,
and monthly completed-run/model-cost totals at `/v1/company/runs`,
`/v1/company/audit-events`, and `/v1/company/usage`. The authenticated
workspace dashboard exposes the same views only to organization owners/admins.
Run inputs/outputs and user/provider payloads are never copied into this shared
ledger. Durable run completion accounting is idempotent by project and run ID.

## Resources

| Resource | Endpoint | Notes |
| --- | --- | --- |
| Threads | `POST /v1/threads`, `GET /v1/threads/:threadId` | Conversation/memory boundary for one explicit SDK end user. |
| Projects | `GET/POST /v1/admin/projects`, `DELETE /v1/admin/projects/:id` | Root-key-only project provisioning and key revocation. |
| Dashboard projects | `GET/POST /v1/account/projects`, `PATCH /v1/account/projects/:id`, `POST .../rotate-key`, `DELETE .../:id` | Better-Auth-cookie-only, verified-user project management. |
| Company policy | `GET/PUT /v1/account/projects/:id/policy` | Organization members may read; only owners/admins may change bounded tool grants and per-run budgets. |
| Company agents | `GET/POST/PATCH/DELETE /v1/account/projects/:id/agents` and `/v1/agents` | Dashboard management is role-checked; SDK routes require project `agents:read/write` scopes. Templates are listed at `GET /v1/agents/templates`. |
| Runs | `POST /v1/threads/:threadId/runs` | Executes durable Chusky work. `wait` is bounded. |
| Run stream | `POST /v1/threads/:threadId/runs/stream` | `application/x-ndjson`; emits typed run events. |
| Runs | `GET /v1/threads/:threadId/runs/:runId`, `POST .../cancel` | Cancellation is request-specific; durable task results stay queryable. |
| Tasks | `GET /v1/tasks`, `GET /v1/tasks/:taskId` | Cursor pagination, project and end-user authorized. |
| Approvals | `GET /v1/approvals/:approvalId`, `POST /v1/approvals/:approvalId` | Decision body is `{ decision: "approve" | "deny" }`. |
| Files | `POST /v1/files`, `POST /v1/files/:fileId/complete`, `GET/DELETE /v1/files/:fileId` | Direct R2 upload URLs are short-lived; a `HEAD` verification must succeed before download; deletion is owner-scoped. |
| Webhooks | `POST /v1/webhooks`, `GET /v1/webhooks`, `DELETE /v1/webhooks/:id` | HTTPS-only subscription; secret is encrypted at rest and returned only on creation. |
| Delivery history | `GET /v1/webhooks/:id/deliveries` | Bounded, safe delivery status for operational diagnosis; delete disables future deliveries. |
| Trigger catalogue | `GET /v1/triggers/catalog/toolkits`, `GET /v1/triggers/catalog/toolkits/:toolkit` | Composio-backed, paginated trigger types for connected apps; the dashboard uses the same catalogue as Telegram. `POST /v1/triggers` can pin creation to a verified `connectedAccountId`. |
| Observability | `GET /v1/audit-events`, `GET /v1/usage` | Bounded per-user audit trail and current usage snapshot. |
| Company telemetry | `GET /v1/company/runs`, `/v1/company/audit-events`, `/v1/company/usage`; dashboard `GET /v1/account/projects/:id/company/{runs,audit-events,usage}` | Requires `company:read` for project keys; dashboard reads require workspace owner/admin. Run summaries contain no prompt or output. |
| Calls | `GET/POST /v1/account/calls` | Lists redacted call metadata and starts a validated outbound call. SDK callers use `calls:read/write`; dashboard callers must be verified and Telegram-linked. |
| Voice | `GET /v1/account/voice-options`, `PATCH /v1/account/preferences` | Lists Flux and optional Bland catalogue entries and stores the account's live voice preference. Use `voice:read` for the catalogue and `account:write` for preferences. |
| Meetings | `GET/POST /v1/meetings`, `POST /v1/meetings/prepare`, `GET/PATCH /v1/meetings/profile`, `POST /v1/meetings/preparations/:id/join`, `GET /v1/meetings/:id`, `POST /v1/meetings/:id/leave`, `GET /v1/meetings/:id/context`, `DELETE /v1/meetings/contacts/:id` | Recall lifecycle for Zoom, Google Meet, Microsoft Teams, and Webex. SDK callers use `meetings:read/write`; meeting URLs and sealed calendar links are never returned by list endpoints. |
| Connected apps | `GET /v1/apps`, `POST /v1/apps/:toolkit/connect`, `GET /v1/apps/connections`, `DELETE /v1/apps/connections/:id` | Composio toolkit discovery, OAuth connection links, connected-account listing, and disconnect. Credentials remain server-side. |
| Native schedules | `GET/POST/DELETE /v1/reminders`, `GET/POST/DELETE /v1/jobs` | One-time reminders and recurring QStash schedules owned by the SDK user. Create supports `mode`, context `links`, `nextAction`, preconditions, postconditions, and bounded polling. |
| Schedule controls | `POST /v1/reminders/:id/pause|resume|run`, `POST /v1/jobs/:id/pause|resume|run`, `GET /v1/jobs/:id/occurrences` | Pause/resume/run-now controls and owner-scoped recurring execution history. `run` returns `202` because execution is durable and asynchronous. |
| Memory and scratchpad | `GET/POST/DELETE /v1/memory`, `GET/PUT/DELETE /v1/scratchpad` | Explicit structured memory and temporary working notes; both are user-scoped. |
| Channel and device management | `GET/POST/PATCH/DELETE /v1/channels`, `GET/DELETE /v1/devices` | Link supported channels, control proactive delivery, and revoke CLI devices without exposing credentials. |

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
