# Chusky Remote MCP Server

Load this reference whenever work involves the Chusky Model Context Protocol (MCP)
server, the `cloudflare/chusky-mcp/` Worker, an MCP client configuration, company
agent integrations, project-scoped API keys used by MCP, Composio connections used
by an MCP run, or the boundary between MCP and the first-party REST/SDK API.

This is an operational reference for the repository. It is intentionally more
specific than a marketing overview: it describes the deployed protocol, identity
model, tool contracts, approval behavior, failure modes, and verification duties.

## 1. What MCP is and is not

Chusky MCP is a remote, stateless Streamable HTTP adapter. It lets an MCP-capable
host—an AI coding agent, an internal company assistant, or another tool-using model—
discover and call a bounded set of Chusky orchestration tools.

The request path is:

```text
Company MCP host
        │ Streamable HTTP /mcp
        │ Authorization: Bearer chsk_…
        │ X-Chusky-User-Id: stable application identity
        ▼
Cloudflare Worker: cloudflare/chusky-mcp
        │ validates the MCP request and forwards only approved /v1 paths
        ▼
Chusky developer API: src/sdkApi.ts
        │ project scope, identity, policy, budget, ownership, idempotency
        ▼
Durable Chusky run/task execution
        │ OpenRouter + native tools + Composio
        ▼
Business result, approval pause, durable status, audit, usage, or failure
```

MCP does not replace the Chusky agent runtime, Redis, the durable task worker,
Composio, or the SDK. It does not store OAuth tokens, implement a second OAuth
system, expose arbitrary upstream URLs, or provide an unscoped proxy to `/v1`.

Composio owns external app authentication, connected accounts, token refresh,
toolkit discovery, tool schemas, tool execution, and triggers. Chusky owns the
company project, agent profile, policy, approval, budget, durable execution, audit,
usage, and result boundary. The MCP Worker only adapts MCP calls to those public
Chusky contracts.

Use the REST API or SDK when a backend needs deterministic application control,
webhooks, file upload, streaming, direct resource CRUD, or control-plane
provisioning. Use MCP when a model host should discover and call Chusky's governed
orchestration capabilities as tools.

## 2. Source, deployment, and ownership

The MCP server is a separate deployable surface inside this repository and also has
its own public repository:

- Source: `cloudflare/chusky-mcp/src/index.ts`
- Security helpers: `cloudflare/chusky-mcp/src/security.ts`
- Worker configuration: `cloudflare/chusky-mcp/wrangler.jsonc`
- Tests: `cloudflare/chusky-mcp/tests/security.test.ts` and
  `cloudflare/chusky-mcp/tests/contract.test.ts`
- Usage/deployment documentation: `cloudflare/chusky-mcp/README.md`
- Dedicated repository: `https://github.com/zester4/chusky-mcp`
- Current Worker: `https://chusky-mcp.adesrnd.workers.dev`

The Worker has two HTTP surfaces:

| Path | Purpose | Authentication |
| --- | --- | --- |
| `GET /health` | Liveness only; returns `{ ok: true, service: "chusky-mcp" }`. | None. Do not treat it as an authorization or dependency check. |
| `POST /mcp` and MCP protocol requests | Streamable HTTP MCP endpoint. | A valid project-scoped key plus `X-Chusky-User-Id`. |

All other paths return `404`. Legacy MCP transport is not accepted. Do not add a
second unauthenticated route for convenience; callers must use the MCP protocol.

The authenticated dashboard exposes the same onboarding under
**Organizations → select project → Connect through MCP**. It shows the endpoint,
project scope count, stable-identity guidance, and a copyable generic host config.
The config uses `${CHUSKY_API_KEY}` and `${CHUSKY_END_USER_ID}` placeholders; the
raw project key remains visible only once at project creation and is never sent to
browser code.

The Worker receives only `CHUSKY_API_ORIGIN` as configuration. It must never hold a
company project key, a root operator key, a Composio token, or a provider password.
The MCP client supplies the project key on each request. Local development may use a
loopback Chusky origin, but production origins must be trusted HTTPS origins.

## 3. Company onboarding sequence

An MCP integration is ready only after the following sequence is complete:

1. Create or select a Better Auth company organization in the Chusky dashboard.
2. Create a company project under that workspace.
3. Create a project-scoped `chsk_…` API key with the minimum scopes required by
   the MCP host. The raw key is shown only on creation or rotation.
4. Decide what stable application identity the host will send in
   `X-Chusky-User-Id`. Use an internal customer, tenant-member, or service identity;
   do not use an email address, display name, phone number, IP address, or an
   arbitrary browser-provided value.
5. Connect Gmail, Salesforce, Slack, HubSpot, or another app through Composio.
   The human completes the provider consent flow. The same stable identity must be
   used when the connection is created and when the future MCP run executes.
6. List the supported templates and choose a specialist profile, or create a saved
   company agent profile.
7. Set the company policy, allowed tools, denied tools, approval requirements, and
   run budgets in the Chusky workspace.
8. Add the remote MCP server to the host application using server-side secrets.
9. Run a read-only test task first. Verify the returned `threadId`, `runId`, events,
   identity scope, and approval behavior before enabling external writes.
10. For production event delivery, add Chusky webhooks or Composio triggers. MCP
    itself is a request/response tool surface and is not a replacement for durable
    webhook delivery.

Workspace owners/admins manage company credentials and policy. Workspace members
may use resources according to their project grants, but a project key must not be
shared among unrelated companies or used as a root/operator credential.

## 4. Authentication and identity boundary

Every MCP request must carry both values:

```http
Authorization: Bearer chsk_<project-secret>
X-Chusky-User-Id: <stable-application-identity>
```

The Worker validates the header shape, forwards the key and identity to the
versioned Chusky API, and never logs either value. The Chusky API hashes project
keys at rest, checks revocation and scopes, and derives durable ownership from the
project plus the supplied identity.

The stable identity is a data-isolation boundary. It scopes:

- Threads and run history.
- Durable tasks and task results.
- Approvals and approval decisions.
- Composio sessions and connected accounts.
- Files, artifacts, memory, activity, and per-identity usage.
- Channel or trigger resources that are created for that identity.

For a multi-tenant application, map the authenticated application subject to a
deterministic identity. Examples are `acme_workspace_service` for a workspace-level
service agent or `acme_member_4821` for a user-owned assistant. Keep the mapping
server-side and document whether the identity represents a company service account
or an individual user. A service identity is convenient for shared company
automation, but all Composio accounts linked to that identity are shared by that
automation; it must not be confused with per-user isolation.

Never do any of the following:

- Put a `chsk_…` key in browser JavaScript, mobile code, a public repository, or a
  prompt.
- Accept `X-Chusky-User-Id` directly from an untrusted request body without checking
  it against the host's authenticated session.
- Use the root `CHUSKY_API_KEY` or server bootstrap key in an MCP client.
- Use a Telegram CLI device token as an MCP credential.
- Use a mutable display name or provider ID as the durable identity.
- Put Composio OAuth access or refresh tokens in the Worker, MCP configuration, or
  model context.

If a key is exposed, revoke or rotate it immediately. Rotation replaces the active
secret; existing clients must be updated, and the old key must be assumed unusable.

## 5. Project scopes and least privilege

Create a key for the actual MCP workflow rather than starting with `*`. The exact
scope check is performed by the Chusky API, not by the Worker.

| Scope | MCP capabilities that generally need it |
| --- | --- |
| `agents:read` | List templates and list saved company agent profiles. |
| `agents:write` | Create or modify a company agent profile. |
| `threads:read` | Read runs and thread-scoped state. |
| `threads:write` | Start, cancel, or resume a durable run. |
| `apps:read` | List Composio toolkits and connected accounts. |
| `apps:write` | Start a Composio app consent flow. A human still completes consent. |
| `triggers:read` | List existing Composio triggers for the identity. |
| `tasks:read` | List and inspect durable Chusky tasks. |
| `tasks:write` | Cancel or retry durable tasks. |
| `approvals:read` | Inspect approval status. This is not approval authority. |
| `usage:read` | Read usage for the current stable caller identity. |
| `company:read` | Read status-only cross-caller run summaries, bounded company audit events, and project usage. |

The normal run-only starter set is `agents:read`, `threads:read`, and
`threads:write`, plus `approvals:read` if the host needs to explain approval pauses.
Add `apps:read`/`apps:write` only when the host itself manages Composio connection
setup. Add `tasks:*` only when the host needs independent task operations. Add
`company:read` only to an explicitly trusted operational host; it exposes project
telemetry across callers, although it does not expose prompts, outputs, or provider
payloads.

Company-project defaults intentionally do not grant `approvals:write`. An MCP host
must not approve its own email send, CRM mutation, calendar change, deletion,
publication, financial action, or other externally visible effect. Approval is a
human decision in the authenticated Chusky dashboard or another separately
authorized control-plane application.

Scope errors are expected behavior. Do not “fix” a `403` by switching to the root
key or granting `*`; identify the missing capability and add only that scope after
review.

## 6. MCP host configuration

The generic Streamable HTTP configuration is:

```json
{
  "mcpServers": {
    "chusky": {
      "url": "https://chusky-mcp.adesrnd.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${CHUSKY_API_KEY}",
        "X-Chusky-User-Id": "${CHUSKY_END_USER_ID}"
      }
    }
  }
}
```

The exact environment-variable interpolation syntax differs between Claude,
Cursor, IDE agents, and custom MCP clients. Use the host's secret store and its
documented interpolation syntax; do not copy the literal `${…}` values into a
production header.

For a custom backend, configure the MCP client in the trusted server process:

```ts
const mcp = {
  name: "chusky",
  url: process.env.CHUSKY_MCP_URL ?? "https://chusky-mcp.adesrnd.workers.dev/mcp",
  headers: {
    Authorization: `Bearer ${process.env.CHUSKY_API_KEY}`,
    "X-Chusky-User-Id": authenticatedApplicationSubject,
  },
};
```

Do not construct the identity from the user's natural-language request. Resolve it
from the host's authenticated session before creating the MCP connection. If the
host supports per-request headers, set the identity per customer while keeping the
project key in the server-side secret store.

The MCP server is remote and stateless. A host should be prepared to reconnect and
rediscover tools. Durable Chusky state lives behind the API; an interrupted MCP
connection does not imply that a durable run failed. Query the run or task by ID.

For repeatable deployment verification, run `npm test` for local security and
contract tests, then set `CHUSKY_MCP_API_KEY` and `CHUSKY_MCP_USER_ID` and run
`npm run test:live`. The live check only discovers tools and reads templates. A
separate staging test must exercise run idempotency, duplicate durable completion,
approval pause/resume, cross-identity isolation, project-key telemetry, and task
cancellation against real Redis/QStash/Composio infrastructure.

## 7. Registered MCP tools

The current Worker registers the following tools. Tool names are public integration
identifiers; preserve them when changing implementation.

### Discovery and setup

- `chusky_agent_templates` — list supported specialist templates and their allowed
  tool categories.
- `chusky_agents_list` — list profiles available to the scoped company project.
- `chusky_agent_create` — create a profile from a supported template. Inputs are
  `template`, optional `name`, and optional bounded `instructions`. The profile's
  grant cannot exceed the template or company policy.
- `chusky_composio_apps_list` — list available Composio toolkits and connected
  accounts for the current identity.
- `chusky_composio_connect_app` — request a short-lived Composio consent URL for a
  toolkit. Inputs are `toolkit` and optional `alias`. A human must complete the
  consent flow; the returned URL is sensitive and must not be logged.
- `chusky_triggers_list` — list Composio triggers for the current identity.

### Durable execution

- `chusky_run_start` — create a thread and start a background durable run. Inputs:
  `input`, optional `agentId`, optional bounded `metadata`, optional `budget`,
  optional `tools`, and optional `idempotencyKey`. The Worker creates the thread
  and run with separate derived idempotency keys and returns `threadId` plus the run
  record.
- `chusky_run_get` — read a run by `threadId` and `runId`.
- `chusky_runs_list` — list runs in one thread with optional `limit` and `cursor`.
- `chusky_run_events` — read progress events for one run, optionally after a
  millisecond timestamp.
- `chusky_run_cancel` — cancel one queued or running run. It does not approve or
  execute pending external actions.
- `chusky_run_resume` — resume a failed, cancelled, or approval-paused run under
  its original policy. Resuming does not grant approval.

### Approvals and task operations

- `chusky_approval_status` — inspect a pending approval's safe status, tool slug,
  and expiry. It intentionally cannot approve or deny.
- `chusky_tasks_list` — list durable tasks for the current identity.
- `chusky_task_get` — read a task's status, checkpoint, and result.
- `chusky_task_cancel` — cancel one queued or running task.
- `chusky_task_retry` — retry a failed or retryable task under its original policy.
- `chusky_usage_get` — read usage for the current identity.

### Company-level operational views

- `chusky_company_runs_list` — list bounded, status-only run summaries across
  callers of the company project. It excludes prompts, outputs, and connected
  account data.
- `chusky_company_audit_list` — read bounded project/workspace audit events. It
  excludes request bodies, prompts, secrets, and provider payloads.
- `chusky_company_usage_get` — read monthly completed-run and model-cost totals
  aggregated across identities using the project key.

MCP output is deliberately bounded. The Worker rejects upstream responses larger
than 1 MB and truncates individual tool result text around 24 KB. Hosts that need a
narrower response should use list limits, cursors, event timestamps, or direct
resource queries rather than trying to make the MCP result unbounded.

## 8. Agent templates and policy behavior

The supported company templates are:

| Slug | Intended outcome | Default behavior |
| --- | --- | --- |
| `sales-development` | Qualify target accounts, prepare personalized outreach, and update CRM when authorized. | Evidence and source citation; external Composio execution requires approval. |
| `lead-research` | Find and qualify leads against explicit company/role criteria. | Prefer first-party sources; prepare CRM-ready fields without writing them automatically. |
| `competitive-intelligence` | Monitor public competitor information and produce change reports. | Public information only; no private-account access or publishing. |
| `customer-support` | Triage cases and draft accurate responses. | No reply, refund, entitlement change, or case closure without approval. |
| `executive-assistant` | Prepare briefs, coordinate schedules, and track follow-ups. | Confirm dates/time zones/attendees; no invitations or commitments without approval. |
| `recruiting` | Research candidates against job requirements. | Job-relevant evidence only; no protected-trait inference or unapproved contact. |
| `marketing-operations` | Prepare campaign research, copy, segmentation, and CRM-ready operations. | Respect consent/suppression; no publishing, sending, or production updates without approval. |

The template's instructions are not a permission grant. A caller may specify
business criteria such as “only target companies with more than 50 employees,” but
that instruction cannot expand the template's tool allowlist, company policy, or
project-key scope.

At execution time Chusky intersects the relevant constraints:

```text
project-key scopes
  ∩ company policy
  ∩ saved agent profile
  ∩ template allowlist
  ∩ per-run allow/deny/requireApproval
  ∩ budget and usage limits
```

The strictest applicable budget wins. `tools.allow` narrows capability;
`tools.deny` removes capability; `tools.requireApproval` adds a gate. Risky
external actions remain approval-gated even when the caller does not list them in
`requireApproval`.

## 9. Recommended run lifecycle

Use this lifecycle for a new integration:

### Before the first run

1. Call `chusky_agent_templates`.
2. Call `chusky_agents_list` and reuse an existing profile when possible.
3. Call `chusky_composio_apps_list` to confirm the required toolkit/account is
   linked to the same `X-Chusky-User-Id`.
4. If setup is incomplete, call `chusky_composio_connect_app`; present the consent
   URL to an authorized human and wait for completion.

### Starting work

Call `chusky_run_start` with a concrete outcome, a selected profile or template,
bounded budgets, and an idempotency key:

```json
{
  "input": "Find fintech companies with more than 50 employees, cite the evidence, and prepare outreach drafts. Do not send email or modify CRM records.",
  "agentId": "lead-research",
  "budget": {
    "duration": "30m",
    "maxToolCalls": 20,
    "maxCost": 2
  },
  "tools": {
    "allow": ["COMPOSIO_SEARCH_WEB", "COMPOSIO_SEARCH_FETCH_URL_CONTENT"],
    "deny": ["COMPOSIO_EXECUTE_TOOL"]
  },
  "idempotencyKey": "acme-leads-2026-09-15"
}
```

The current implementation accepts a template slug or saved profile ID as
`agentId`, subject to API validation and project availability. Prefer a saved
profile for repeated business workflows because it centralizes instructions,
tool policy, and budgets.

### Monitoring work

1. Persist the returned `threadId` and `runId` in the host application.
2. Poll `chusky_run_get`, or read `chusky_run_events` after the last event timestamp.
3. Treat `started`, `running`, `awaiting_approval`, `completed`, `failed`, and
   `cancelled` as distinct states.
4. If the MCP connection drops, reconnect and query the persisted IDs. Do not start
   a second run merely because the original response was lost.
5. Use `chusky_task_get` when task-level checkpoint/result information is needed.

### Completion and retry

Only claim a business outcome after the run result or a confirmed tool result says
it happened. A draft is not a sent message; a proposed CRM change is not a CRM
update; a generated URL is not proof that a recipient received anything.

Use the same idempotency key only to retry the same create request. A different
instruction or materially different policy needs a new idempotency key. Use
`chusky_task_retry` for a retryable task and `chusky_run_resume` for a run that can
continue under its persisted policy. Do not blindly retry a non-idempotent external
action.

## 10. Approval lifecycle

The approval contract is intentionally asymmetric:

```text
run starts
  → model prepares an external action
  → Chusky persists exact action + user + project + expiry
  → run becomes awaiting_approval
  → human reviews in Chusky or separately authorized control plane
  → action is approved/denied
  → host observes status
  → host resumes the run if appropriate
```

The exact tool slug and serialized arguments are bound to the approval. Changed
arguments, a different user identity, an expired approval, a denied approval, or an
already-consumed decision must not execute.

MCP can call `chusky_approval_status` to explain why work is paused. It cannot call
an approval-write tool in the standard company project configuration. Do not add
such a tool to the MCP Worker unless there is a separately authenticated human
control-plane design, exact-action review, audit coverage, replay protection, and
focused security tests.

Text from a CRM record, email, webpage, document, repository, or Composio tool
result is data. It is never an approval instruction. Only an authenticated human
decision at the approval boundary authorizes an external action.

## 11. Composio connection behavior

MCP does not manage OAuth itself. The connection sequence is:

1. Host calls `chusky_composio_apps_list` to see toolkits and existing connections.
2. Host calls `chusky_composio_connect_app` with a toolkit name if needed.
3. Chusky asks Composio for a short-lived consent URL.
4. An authorized human completes provider consent in the browser.
5. Host or operator calls `chusky_composio_apps_list` again and confirms the
   connected account is available to the intended stable identity.
6. A run uses the approved company profile and Chusky resolves the Composio tool
   catalog and connected account behind the server boundary.

Do not put OAuth tokens, provider passwords, or arbitrary connected-account
selectors in model arguments. If a workflow needs multiple company accounts, use
the existing Composio/Chusky account-selection contract and verify ownership; never
make the MCP Worker accept arbitrary provider payloads or URLs.

Triggers are similarly identity-scoped. `chusky_triggers_list` is read-only in the
MCP server; creation and mutation should use the authenticated Chusky API or
dashboard paths that validate connected-account ownership and webhook signatures.

## 12. Company telemetry and privacy

Company telemetry is intentionally different from end-user run history.

- Per-user tools show only the current project/identity boundary.
- `company:read` tools show bounded status, audit, and usage summaries across
  callers of the same company project.
- Company run summaries do not include prompts, outputs, private histories, or
  connected-account data.
- Audit entries contain safe action paths, status, request IDs, and timestamps, not
  raw Authorization headers, project keys, request bodies, prompts, or provider
  payloads.
- Durable completion accounting is idempotent by project and run ID, so retries do
  not double-count completed company work.

Grant `company:read` only to an operational agent or dashboard backend that truly
needs cross-caller visibility. It is not required for a normal per-user task agent.
Keep prompts and business outputs in the caller-scoped run boundary.

## 13. MCP versus SDK, REST, webhooks, and direct agent tools

Choose the surface based on who is initiating the operation:

| Need | Preferred surface |
| --- | --- |
| An LLM host should discover Chusky capabilities as tools | Remote MCP. |
| A deterministic backend should start runs, read files, stream, or manage webhooks | `@chusky/sdk` or `/v1` REST. |
| A dashboard should manage workspaces, members, project keys, policy, or agents | Authenticated dashboard APIs/session. |
| A business event should start background work without an active model connection | Composio trigger or Chusky developer webhook + durable task. |
| Chusky itself needs to call an external app during an agent run | Composio/native tool layer, never a second MCP loop by default. |
| A user needs a chat UI | First-party dashboard or the separate embedded-chat implementation, with the key kept server-side. |

Do not use MCP as a general-purpose JSON proxy. The Worker intentionally exposes
named, bounded tools so project scopes, identity, policy, budgets, approvals, and
audit remain enforceable.

## 14. Changing the MCP server safely

When adding or modifying a tool:

1. Inspect the corresponding `/v1` route and its scope/ownership checks in
   `src/sdkApi.ts` before changing the Worker.
2. Preserve the Worker path allowlist: internal calls must remain under `/v1/` and
   must reject `//`, backslashes, arbitrary hosts, and redirects.
3. Define a bounded Zod input schema in `cloudflare/chusky-mcp/src/index.ts`.
4. Use `encodeURIComponent` for every caller-supplied path segment.
5. Reuse the `chusky()` helper so Authorization, identity, JSON parsing, response
   size limits, and typed API failures stay consistent.
6. Return safe, bounded output. Never return raw credentials, full provider payloads,
   hidden prompts, or unbounded private histories.
7. Add tests for valid input, malformed input, missing identity, wrong scope,
   cross-identity access, upstream failure, oversized output, and retry behavior as
   applicable.
8. Update `cloudflare/chusky-mcp/README.md` and this skill reference when the public
   tool contract changes.
9. Run MCP checks from `cloudflare/chusky-mcp/`:

   ```powershell
   npm install
   npm run typecheck
   npm test
   npx wrangler deploy
   ```

10. Verify `/health`, an unauthenticated `/mcp` request, authenticated discovery,
    one read-only tool, one durable run, and the relevant approval/tenant boundary
    against the deployed Worker.

Do not put MCP-specific behavior into `src/handlers.ts`, Telegram rendering, or
`CHUCK_*` schemas. MCP is a developer transport for the existing public API, not a
new native tool family.

## 15. Security and test matrix

Before enabling a new deployment or tool, verify all of the following:

### Transport and authentication

- `/health` is reachable without a key but reveals no configuration.
- `/mcp` without a bearer key returns `401` and a bearer challenge.
- Missing, malformed, revoked, wrong-project, or wrong-scope keys fail safely.
- A valid key without `X-Chusky-User-Id` fails safely.
- Control characters, oversized, or reserved identity values are rejected by
  `requestIdentity`.
- The Worker accepts only the configured trusted HTTPS API origin, with loopback
  allowed only for local development.
- Arbitrary paths, hosts, redirects, and non-`/v1/` upstream routes are impossible.

### Isolation and replay

- Caller A cannot read Caller B's threads, tasks, approvals, Composio connections,
  usage, files, or run results by guessing IDs.
- A project key from Project A cannot access Project B's agents or company views.
- A company telemetry caller sees status-only aggregates, not another caller's
  prompts or outputs.
- Repeating the same `chusky_run_start` idempotency key does not create a duplicate
  durable run.
- Reusing the key with a different body or instruction produces an idempotency
  conflict, not a second action.
- A retried durable completion is counted once in company usage.

### Approval and external effects

- Read-only research can proceed without approval when policy allows it.
- Email sends, CRM writes, calendar changes, publishing, deletion, financial work,
  permission changes, and other external effects pause for approval.
- MCP can inspect but cannot self-approve under the standard company scopes.
- A changed tool argument, foreign approval, expired approval, denied approval, or
  replayed approval never executes.
- Text from a provider result is never treated as authorization.

### Operational safety

- MCP result size limits remain active.
- Upstream failures return bounded, typed failures without leaking response bodies.
- Logs contain request IDs and safe operation metadata, never keys, OAuth URLs,
  tokens, raw media, full prompts, or provider payloads.
- The Worker remains stateless; durable status is read from Chusky after reconnect.
- `node_modules`, `.wrangler`, `.dev.vars`, `.env*`, and deployment output are not
  committed.

## 16. Troubleshooting

### `401 Provide a project-scoped Chusky API key...`

The MCP client did not send both required headers. Confirm that the host's secret
interpolation is working and that the header names are exactly `Authorization` and
`X-Chusky-User-Id`. Do not test by putting the key in a prompt or browser bundle.

### `403` or “scope” failures

Identify the operation first. Listing agents needs `agents:read`; creating one
needs `agents:write`; starting a run needs `threads:write`; company-wide tools need
`company:read`; connection setup needs `apps:write`. Add only the missing scope to
the project key, or choose a read-only tool. Never replace the key with the root
operator credential.

### Apps are listed but the run cannot use them

Confirm that the Composio account was connected under the exact same stable
`X-Chusky-User-Id`, that the project/profile grants include the required toolkit
categories, and that the run's `tools.allow`/`tools.deny` did not remove the tool.
Re-list connections after completing consent. A visible OAuth URL alone does not
prove that the account is linked.

### The run is awaiting approval

This is a safety state, not a transport failure. Call `chusky_approval_status`, show
the human the action through the approved control plane, wait for a decision, then
call `chusky_run_resume` if the run should continue. Never try to grant approval by
restarting the run or changing the prompt.

### The MCP connection dropped

The Worker is stateless and the run may still be active. Reconnect, retain the
original `threadId`/`runId`, and call `chusky_run_get` or `chusky_run_events`. Do not
start a replacement run until the original is known to be terminal and a new
idempotency key is appropriate.

### `/health` works but tools fail

`/health` only proves the Worker is alive. Check `CHUSKY_API_ORIGIN`, Chusky API
availability, project key status/scopes, identity mapping, Redis/QStash durability,
Composio connection state, and the returned request ID. Inspect server-side logs
without printing secrets or upstream payloads.

### Company usage is missing or double-counted

Confirm `company:read`, the project identity, and that the run was submitted through
the project key rather than a private Telegram/CLI session. Check the durable run ID
and completion ledger; retries must be idempotent by project and run ID. Do not infer
company totals by summing caller-visible responses when the company endpoint is
available.

## 17. Release checklist

Before declaring an MCP change complete:

- The public tool name and input schema are documented.
- The route maps only to an existing, authenticated `/v1` contract.
- Project scopes and identity semantics are explicit.
- The tool cannot bypass company policy, budget, approval, or ownership checks.
- Outputs are bounded and redacted.
- Cross-project and cross-identity tests exist where relevant.
- `npm run typecheck`, `npm test`, and `git diff --check` pass for the changed
  surface.
- The Worker deploy succeeds and the deployed `/health` and `/mcp` boundaries are
  verified.
- `cloudflare/chusky-mcp/README.md`, SDK API docs, OpenAPI, and this reference are
  updated together when the public contract changes.
- No `.env`, token, OAuth secret, generated deployment artifact, or dependency
  directory is staged.
