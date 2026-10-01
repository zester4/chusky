# Chusky

Chusky is a TypeScript AI agent service you can run locally or deploy for your
team. It connects OpenRouter models to owner-authorized apps through Composio,
and exposes the same governed agent runtime through Telegram, an authenticated
CLI and dashboard, supported messaging channels, and developer interfaces.

The agent runtime owns model inference, connected-app tools, native tools,
approvals, private context, and durable work. Channel adapters handle
provider-specific identity, verification, formatting, and delivery. Access is
account-scoped. In authenticated owner-private interactive chats, calls, and
meetings, the owner's request authorizes routine in-scope actions without an
extra prompt; deletions and high-impact or provider-marked actions retain exact
approval checks. Shared rooms, project/API runs,
autonomous work, and delegated workers retain their own explicit policies.

For production, configure Redis for durable state and QStash for scheduled or
resumable work. In-memory storage is for local development and tests only; it
does not survive restarts.

## Start here

| Goal | Start with |
|---|---|
| Run the Telegram service locally | [Local quickstart](#quickstart-local-dev) |
| Deploy the service | [Deployment guide](#deploy) |
| Pair the terminal client | [Terminal CLI](#terminal-cli) |
| Integrate from a TypeScript server | [Developer SDK](sdk/README.md) |
| Connect an external agent over A2A | [A2A guide](docs/a2a.md) |
| Connect an MCP client to Chusky | [Remote MCP server](cloudflare/chusky-mcp/README.md) |
| Let Chusky call a third-party MCP server | [MCP setup below](#calling-third-party-mcp-servers) |
| Configure runtime settings | [Environment variables](#environment-variables) |

The sections below are the detailed self-hosting and operations reference.

---

## Capabilities at a glance

| Area | What it provides | Important boundary |
|---|---|---|
| Connected apps | Composio app discovery, account connections, and a large catalog of provider actions | Uses the account's connected apps; availability depends on the selected action and connection |
| Conversations | Telegram, authenticated dashboard and CLI, linked Slack, WhatsApp, Sendblue, Twilio SMS, regular X DMs, and optional encrypted XChat, plus voice and meeting workflows | Features and media support vary by channel; shared conversations do not inherit private account history |
| Durable work | Owner-scoped tasks, missions, reminders, recurring jobs, triggers, and resumable workflows | Production durability requires Redis; scheduled and continued work also requires QStash |
| Workspaces and media | Optional Daytona computer workspaces, E2B browser sessions, generated media, and verified artifacts | Optional provider configuration and capability limits apply |
| Developer access | REST API and TypeScript SDK, plus A2A and remote MCP integrations | Project scopes, stable user identity, budgets, and approvals are enforced server-side |

See [channel support and operating model](#channel-support-and-operating-model)
for channel-specific behavior, and the linked integration guides above for
developer setup.

---

## Company workspaces and remote MCP

Chusky uses Better Auth for company organizations, members, and invitations.
Workspace owners/admins can create company API projects, select one of the
built-in specialist templates, and manage per-project run policy from
/app/organizations. Developer project keys remain hashed at rest and are
shown only once. Company project defaults grant a bounded set of API scopes,
cap runs at 30 minutes / 40 tool calls / $5, and require approval before
Composio execution tools can perform external actions. A run may narrow those
grants, never widen them.

Composio remains the OAuth, connected-account, token refresh, tool discovery,
and execution system. Chusky does not copy provider tokens. Today each run uses
the Composio subject associated with its stable Chusky user identity; pass a
stable, authenticated customer user ID in X-Chusky-User-Id from your trusted
server. Do not let a browser or untrusted caller choose that value. Runs and
private history remain separated by project and external user identity.

The API exposes GET /v1/agents/templates and project-scoped agent profiles
under /v1/agents. The SDK supports `chusky.agents.*` and a durable
`chusky.runs.create()` convenience API. Select a configured profile (or a
template slug) on a run:

    const { thread, run } = await chusky.runs.create({
      input: "Research fintech leads that match our 50+ employee requirement.",
      agentId: "lead-research",
    }, { idempotencyKey: "lead-research-2026-09-14" });

For background work, use wait: false with Redis and QStash configured, then
poll the run/task status or receive signed webhook events. Run budgets,
tool scopes, approvals, audit events, and existing durable task controls apply
through the same /v1 API used by the dashboard and SDK.

### Cloudflare MCP adapter

cloudflare/chusky-mcp is a stateless Streamable HTTP MCP server for clients
that need Chusky tools. It proxies a small, explicit set of operations (list
templates/profiles, start and inspect runs, check approval status,
inspect/cancel/retry tasks, start and control autonomous missions, and read
usage) to the authenticated Chusky /v1 API. `chusky_tool_run` starts an
idempotent durable run restricted to one of the five native tool-reliability
capabilities; it does not directly execute or approve actions. It does not store project keys or
provider credentials, and it cannot approve external actions.
Configure the Cloudflare Worker with CHUSKY_API_ORIGIN; MCP clients send a
Chusky project key as Authorization: Bearer … and a trusted stable identity as
X-Chusky-User-Id.

The separate MCP Worker can be deployed independently with its own npm install
and Wrangler configuration. See its README for local development, deployment,
and client configuration. Production Chusky API durability still depends on
the backend's Redis and QStash configuration.

### Autonomous missions

New missions use pause-aware active worker time by default. A five-minute
execution budget with two minutes consumed retains three minutes after an hour
waiting for a provider or owner. A separate `maxLifetimeSeconds` deadline
includes all waits (14 days by default). Persisted legacy missions retain their
original wall-clock contract; this change does not reset existing budgets.

Owners may authorize `automaticExtensionSeconds` and `maxAutomaticExtensions`
at creation. Every extension requires new completed-step progress backed by
trusted evidence, is audited, and preserves spend, steps, tool calls, and the
overall deadline. Chat approves the initial allowance once, not every extension.
Without an allowance, exhausted missions stay blocked. Inspect `timing` and
mission proof for execution usage and extensions consumed.

Use a mission when work must continue after the initiating request: research,
lead qualification, long-running browser work, provider polling, or a
multi-stage business operation. A mission is not an unbounded background loop.
It is a sequence of short, checkpointed execution slices. Each slice observes
current ground truth, performs bounded work, records the next action, and
schedules the next slice through QStash. Waiting on an external service uses
`CHUCK_TASK_WAIT`, so the worker sleeps without holding a process open; provider
and approval waits resume from the exact callback or owner decision instead of
polling.

Every mission has a concrete objective and verifiable definition of done,
maximum duration/steps/tool calls/cost, an owner-scoped checkpoint and next
action, bounded events, and explicit queued/running/waiting/paused/blocked/
completed/failed/cancelled states. Mission creation is idempotent, so a
retried request does not create duplicate work.

The authenticated API exposes `POST /v1/missions`, `GET /v1/missions`,
`GET /v1/missions/:id`, pause/resume/cancel actions, and
`POST /v1/missions/:id/events` for an exact provider callback
(`provider + providerEventId`). Replayed callbacks are harmless. Missions can
also contain dependency-aware steps; the agent advances a step only after
`CHUCK_MISSION_STEP_COMPLETE` records its verified result. After the final
slice, the server closes legacy missions automatically or verifies strict
evidence and blocks with a concrete recovery action when proof is missing. The Telegram
`/missions` command and dashboard Missions page expose the same owner-scoped
state and controls. The dashboard also shows execution proof, evidence,
verification state, branch activity, budgets, durable events, and the governed
outcome package catalogue. The Cloudflare MCP
maps those controls to `chusky_mission_start`, `chusky_missions_list`,
`chusky_mission_get`, `chusky_mission_step_complete`,
`chusky_mission_replan`, `chusky_mission_event`, `chusky_mission_pause`,
`chusky_mission_resume`, and `chusky_mission_cancel`, plus proof, evidence,
verification, repair, context, and outcome tools/resources. Production autonomy requires Redis for durable state
and QStash for continuation delivery; without them, Chusky must fail clearly
instead of pretending that background work is durable.

### Context, departments, and business outcomes

Missions use the owner-scoped context graph to select durable facts,
preferences, decisions, open loops, meeting history, tool receipts, and
artifacts for the current purpose. Context records carry scope, sensitivity,
confidence, review/expiry times, and source references; sensitive context is
excluded from normal prompts unless the runtime explicitly requests it.

The API exposes `/v1/context`, `/v1/departments`, and `/v1/outcomes`. A
department space gives a team a mission, policies, approved capabilities,
escalation owner, and typed handoff packets. Outcome packages turn a business
result—such as qualified leads, support resolution, competitor intelligence,
employee onboarding, finance reconciliation, executive review, or incident
repair—into required inputs, allowed tools, evidence rules, approval policy,
budget, SLA, and deliverable expectations. Use `POST /v1/outcomes/:slug/plan`
to validate inputs and inspect the proposed execution graph before starting a
mission.

### Agent-to-agent (A2A) integration

Chusky also exposes a discoverable A2A 1.0 boundary for external agents. Fetch
`/a2a/.well-known/agent-card.json` to discover the supported outcome skills and
JSON-RPC interface, then use a project-scoped bearer key plus a stable
`X-Chusky-User-Id` to create, stream, inspect, list, or cancel durable tasks.
The A2A layer maps directly to the same owner-scoped mission runtime as the
SDK, CLI, dashboard, and MCP; it does not expose private prompts or provider
credentials. See [docs/a2a.md](docs/a2a.md) for the complete contract.

### Calling third-party MCP servers

Chusky can also act as an MCP client for owner-approved remote Streamable HTTP
servers. This is separate from the Cloudflare MCP adapter above: the adapter
lets another agent call Chusky, while this client lets Chusky call a configured
third-party MCP server during an ordinary agent run.

Enable it with `MCP_ENABLED=true`. Add supported public servers to
`src/mcp/mcp.json`; this catalog contains URLs, names, auth type, scopes, and
tool policy—not user tokens. Users connect their own account through the
authenticated `/v1/mcp/connections` API. Access and refresh tokens are encrypted
with `MCP_CONNECTION_ENCRYPTION_KEY` and never enter the catalog, prompt,
history, logs, or tool result. Production requires HTTPS and rejects
credential-bearing, localhost, private-network, and metadata URLs.

The built-in catalog includes Instacart and Upscrape as OAuth connections.
Mercury is cataloged but disabled until Chusky refreshes stored MCP OAuth tokens:
its official MCP supports OAuth 2.0 with PKCE and read-only access, but its
access token expires and Chusky currently does not refresh stored third-party MCP
tokens. The catalog requests Mercury's `read` and `offline_access` scopes for
when refresh support is added. Zomato is listed but disabled pending provider approval: Zomato's published MCP
manifest says third-party apps are not currently allowed and its OAuth callback
must be allowlisted before a client can connect. Do not enable it until Zomato
approves Chusky's integration and callback URL.

Plaid Dashboard and Sabre Travel are cataloged but disabled until Chusky adds
their provider-specific client-credentials token acquisition and refresh. Plaid
requires a Plaid production client ID/secret and a short-lived `mcp:dashboard`
token; Sabre's documented production MCP endpoint is `https://mcp.sabre.com/mcp`
and requires a Sabre OAuth access token. Neither token flow is equivalent to
Chusky's generic user-consent MCP OAuth connection. Sabre's `api.sabre.com/mcp`
URL was not listed as the production MCP endpoint in Sabre's current docs.

Twilio's public documentation MCP and Etsy's developer-documentation MCP are
enabled as read-only reference servers. AWS and BigQuery are cataloged disabled
pending verified OAuth setup and token-refresh support; AWS uses the documented
regional endpoint, while BigQuery's official endpoint is
`https://bigquery.googleapis.com/mcp`. Vonage Cloud Runtime is cataloged
disabled because its server requires `X-Account-ID`, `X-Account-Secret`, and
`X-Region` headers, which the current MCP connection contract does not support.
The Azure and Playwright entries in common MCP examples use local `stdio`
processes; Chusky's third-party MCP client supports remote HTTP servers only.
The Postgres example likewise launches a local process and includes a sample
database URL; Chusky does not launch local MCP commands or accept database
connection strings through this catalog. The supplied eBay URL could not be
verified in eBay's official developer documentation, so it is not registered.

```json
{
  "version": 1,
  "servers": [
    {
    "id": "linear",
    "name": "Linear MCP",
    "url": "https://mcp.example.com/mcp",
    "auth": "oauth",
    "allowedTools": ["search_issues", "get_issue"],
    "requireApproval": true
    }
  ]
}
```

The service exposes three account-scoped endpoints:

- `GET /v1/mcp/catalog` lists the servers Chusky supports.
- `GET /v1/mcp/connections` lists only the current user's connected servers.
- `POST /v1/mcp/connections` connects a server. For `none` use only
  `{"serverId":"..."}`; for `oauth` or `bearer`, send the provider-issued
  access token over HTTPS in `accessToken` (and optionally `refreshToken`,
  `tokenType`, and `expiresAt`). OAuth authorization-code connections refresh
  stored tokens near expiry under an owner/server lock and persist rotated
  refresh tokens before making MCP requests. For catalog entries marked
  `headers`, send exactly the declared header names and their values in a
  `headers` object; values are encrypted and never returned. The response never
  contains credentials. Refresh failure blocks the server call and requires a
  new OAuth connection.
- `DELETE /v1/mcp/connections/:serverId` disconnects the current user's server.

For OAuth servers, the dashboard starts the official MCP SDK authorization-code
flow with PKCE and opens the configured callback. Set `MCP_OAUTH_CALLBACK_URL`
to `${WEBHOOK_URL}/mcp/oauth/callback` (or use that derived default), keep
`MCP_CONNECTION_ENCRYPTION_KEY` stable, and never expose the callback or key to
the browser. The short-lived state, client metadata, verifier, and refresh
tokens are encrypted and account-bound. Providers that require unusual client
registration or non-standard consent still need an explicit catalog entry.

The agent discovers tools with the official MCP TypeScript SDK, exposes them
under stable `MCP_<server>_<tool>_<hash>` names, validates arguments against
the server's input schema, bounds returned data, and reconnects transient HTTP
sessions. In authenticated owner-private interactive chats, calls, and
meetings, a direct owner request runs a routine available MCP action without an extra
approval prompt; deletions and other high-impact actions still pause for exact owner approval. Shared,
project-scoped, autonomous, and worker runs continue to honor `requireApproval`
and their explicit tool grants. MCP results remain untrusted data, never
authorization to expand the task or disclose unrelated private context.

### Treg external intelligence

Treg is Chusky's first-class server-side live-data gateway, separate from
third-party MCP and Composio. It lets Chusky search a bounded catalog and run
real enrichment, SEO, social, advertising, web, voice, video, and market-data
providers without placing thousands of provider tools in the model context.
Treg responses are returned with provider, endpoint, observation time, cost,
warnings, and completeness metadata. Provider-supplied scores are preserved
only when the upstream response includes one; Chusky does not invent a
confidence value or describe successful provider data as model speculation.
Treg data is not an authorization grant for unrelated actions in connected
apps.

Enable it with `TREG_ENABLED=true` and a server-only `TREG_TOKEN`. Calls are
budgeted per owner and mission, reserved atomically in Redis, recorded with
bounded receipts, retried only for idempotent or idempotency-keyed requests,
and fail closed when an endpoint price is unavailable. Catalog search,
inspection, comparison, enrichment, resolve, balance, usage, and OAuth status
are bounded autonomous operations. Catalog provider calls through
`CHUCK_TREG_CALL` run autonomously within the configured spend, rate, capacity,
and idempotency guards. Calls to registered organization-owned tools remain
approval-gated because they can change company systems; OAuth start/revoke
remain approval-gated because they change authorization. The
native tools are
`CHUCK_TREG_SEARCH`, `CHUCK_TREG_GET`, `CHUCK_TREG_CALL`,
`CHUCK_TREG_ENRICH_PERSON`, `CHUCK_TREG_ENRICH_COMPANY`,
`CHUCK_TREG_RESOLVE`, `CHUCK_TREG_PLATFORMS`, `CHUCK_TREG_MY_TOOLS`,
`CHUCK_TREG_BALANCE`, and `CHUCK_TREG_USAGE`. `CHUCK_TREG_CALL` accepts a
caller-supplied `idempotencyKey` for an exact retry and records Treg's response
call ID, settled cost, replay flag, and served-via metadata. It can also call a
registered organization-owned HTTP tool after `CHUCK_TREG_MY_TOOLS` verifies
the host/name; it cannot call arbitrary hosts. Use Composio for actions in a
user's connected accounts; use Treg for external intelligence that needs
verification before an action.

The native gateway follows Treg's current REST contract: `X-Treg-Token` for
REST authentication, `x-treg-org` for identity-token organization selection,
`/catalog/platforms/{slug}` for provider comparison, `GET /tools` for safe
team-tool discovery, and the `X-Treg-Cost-Micro` / `X-Treg-Call-Id` response
headers for settlement and audit. Treg's `402` balance and `503` provider
capacity responses are surfaced as bounded recovery errors rather than being
silently retried or treated as evidence.

OAuth tools (`CHUCK_TREG_OAUTH_START`, `STATUS`, `CONNECTIONS`, and
`REVOKE`) let a user connect a provider-owned account through Treg. Chusky
stores only an expiring owner-scoped state hash and safe connection metadata;
Treg retains provider credentials. For company deployments, use
`TREG_ORG_TOKENS_JSON` to map trusted `org_*` IDs to server-only Treg tokens.

### Stripe Link Agent Wallet

Chusky can use Stripe's Link Agent Wallet as an owner-controlled payment rail.
Link keeps the customer's payment credentials and sends the owner an approval
request for the exact merchant, amount, currency, and purchase context before
Chusky can retrieve an approved checkout credential. Chusky stores only
encrypted Link OAuth tokens and bounded spend metadata; card numbers, CVV,
shared payment tokens, and Link Pay Tokens never enter model context, chat
history, Redis plaintext, or model tool arguments.

Enable it only after registering a confidential Link OAuth client and an exact
public HTTPS callback with Stripe:

```text
LINK_AGENT_WALLET_ENABLED=true
LINK_CLIENT_ID=...
LINK_CLIENT_SECRET=...
LINK_PUBLISHABLE_KEY=pk_live_...
LINK_AGENT_WALLET_ENCRYPTION_KEY=<stable base64url 32-byte key>
LINK_OAUTH_CALLBACK_URL=https://your-public-host.example/link/oauth/callback
```

The owner connects Link in a private conversation with `CHUCK_LINK_CONNECT`,
checks the connection with `CHUCK_LINK_STATUS`, and can inspect safe payment
method metadata with `CHUCK_LINK_PAYMENT_METHODS`. For a purchase, Chusky uses
`CHUCK_LINK_CREATE_SPEND_REQUEST`; Link sends the owner its own approval request
for the exact amount. `CHUCK_LINK_WAIT_FOR_APPROVAL` can perform a bounded
status wait, but it cannot approve or charge anything. After Link reports the
exact request approved, `CHUCK_LINK_EXECUTE_PAYMENT` uses the private E2B
browser checkout path to fill the one-time card server-side. Finally,
`CHUCK_LINK_RECEIPT` returns bounded Link transaction evidence. Chusky does not
claim merchant fulfillment until both Link and the merchant confirm the result.

Chusky supports three Link payment routes without exposing credentials to the
model: the owner-private E2B virtual-card checkout, Stripe-hosted Link Pay
Token steering when the live checkout exposes the verified Stripe markers, and
HTTP 402 Machine Payment Protocol (MPP) using a one-time Shared Payment Token.
For UCP merchants, Chusky can search the catalog, create a checkout, bind its
exact total to a Link spend request, and complete the checkout only after the
owner approves that request. MPP requests retain the original merchant request
encrypted server-side; failed or uncertain responses are never replayed
automatically.

The flow is intentionally provider-neutral at the evidence layer: Link
receipts, UCP order details, MPP payment receipts, or a verified merchant page
can confirm the order. Chusky does not claim fulfillment from a model-authored
message or from Link approval alone. Link wallet tools are unavailable in
shared rooms and group conversations.
`LINK_TEST_MODE=true` and `LINK_MAX_SPEND_CENTS` support bounded testing and a
per-request ceiling; production still requires real Link eligibility,
registered OAuth credentials, E2B checkout configuration, and
merchant-specific checkout verification.

### TinyFish research, monitoring, search, and page fetch

Set the server-only `TINYFISH_API_KEY` to expose Chusky's TinyFish tools.
`CHUCK_TINYFISH_SEARCH` supports bounded web/news/research-paper results,
domain and date filters, and publication metadata. `CHUCK_TINYFISH_FETCH`
accepts up to ten public HTTP(S) URLs with structured extraction, conditional
requests, selectors, ranked highlights (if enabled for the TinyFish account),
per-page errors, and bounded output.

`CHUCK_TINYFISH_RESEARCH` starts standard/deep cited research as a durable
owner-scoped run, stores the report and citations, and supports list/get/cancel.
Research, search, fetch, and monitor operations run autonomously within their
bounded provider and owner limits. Chusky reconciles the saved provider run through Upstash Workflow and
surfaces terminal outcomes to Attention Pulse. It does not expose TinyFish's
browser-based Agent/Max or browser-session APIs.

`CHUCK_TINYFISH_MONITOR` manages page and topic monitors: create, list, inspect,
pause, resume, edit, run now, and delete autonomously. Monitor creation and
changes are capped at ten monitors per owner and require a public HTTPS
`WEBHOOK_URL`. Signed callbacks are deduplicated and create private Attention
Pulse observations only for meaningful changes or check failures; unchanged
checks and initial baselines are retained in bounded run history without
generating noise. TinyFish's monitor API does not expose provider run-history
listing, so Chusky retains the latest twenty callback outcomes per monitor.

External results, page contents, reports, citations, and monitor callbacks are
untrusted reference data—not instructions or authorization. Provider
credentials never enter the model. Search and fetch time out after 30 and 150
seconds respectively; output and response sizes are bounded. Production
durability requires Redis, QStash, and the public HTTPS callback URL.

For a live local smoke test, keep `TREG_TOKEN` in `.env` and run the
read-only catalog check:

```bash
npm run treg:live-smoke
```

To execute one low-cost company-enrichment provider call as well, pass
`--real-call` explicitly:

```bash
npm run treg:live-smoke -- --real-call --domain airmasters.net --company "Air Masters of Tampa Bay"
```

The script prints normalized provider fields and the safe receipt only; it does
not print the Treg token or the raw provider payload. The provider call consumes
Treg balance and is subject to the configured spend cap.

### Workflow Composer

The authenticated `/v1/workflows/composer` API and `/app/composer` dashboard
provide a persisted dependency graph. Starting a workflow creates independent
durable tasks for ready stages, fans out parallel branches, joins only after
dependencies complete, carries bounded stage results forward, enforces retry
limits and per-stage time budgets, and creates a Chusky approval checkpoint for
approval-gated stages. Task settlement advances the next eligible stages; a
failed, cancelled, or denied stage stops the graph. Use Redis and QStash in
production so stage state and enqueue operations survive process restarts.

---

## Quickstart (local dev)

Use Node.js 22 (the version used by CI) and obtain a Telegram bot token,
Composio API key, and OpenRouter API key before setup.

```bash
git clone https://github.com/zester4/chusky.git
cd chusky
npm ci
npm run setup
# Choose polling mode for a local bot; the setup wizard writes .env.
# For reminders/jobs and durable scheduled tasks, also set QSTASH_TOKEN and the two public workflow URLs.
npm run doctor

npm run telegram
```

`npm run setup` is safe to rerun: it preserves existing `.env` values, hides
secret input, generates missing webhook secrets, and lets you skip optional
Redis, QStash, and Daytona integrations. `npm run doctor` reports configured
and missing settings and checks the deployed `/health` endpoint in webhook
mode. For durable reminders, recurring jobs, or continued background work,
configure Redis, QStash, and the public workflow URLs; polling mode alone does
not make those features durable.

Use `npm run telegram` to run the Telegram service and `npm run dev` for
TypeScript watch mode. For terminal chat, use `npm run chat` after pairing the
authenticated CLI with a deployed Chusky service; see [Terminal CLI](#terminal-cli).

### Terminal CLI

The CLI is a secure client of the running Chusky service. It does not create a second conversation or a second Composio session. CLI API routes are enabled in production webhook mode; configure a public `WEBHOOK_URL` and Redis before pairing. Local polling mode remains Telegram-only unless the service is deployed.

1. Deploy Chusky with `WEBHOOK_URL` and `REDIS_URL` configured.
2. In Telegram, run `/cli link`.
3. In the terminal, run:

```bash
npm run cli -- auth link --server https://your-chusky-host --code 123456 --name joe-laptop
npm run cli
```

The pairing code is one-time and expires after 10 minutes. The terminal stores a revocable device token locally; conversation history, memories, approvals, reminders, jobs, and the Composio session remain server-side. Use `/cli devices` and `/cli revoke <terminal name>` in Telegram to manage access. When installed, the optional `keytar` dependency stores the token in Windows Credential Manager, macOS Keychain, or Linux Secret Service. If native storage is unavailable, set `CHUSKY_CLI_SECRET` to enable AES-256-GCM encrypted fallback storage; otherwise Chusky retains the legacy file behavior and reports it in diagnostics.

CLI commands include `/history`, `/tasks`, `/task <id>`, `/task retry <id>`, `/task cancel <id>`, `/missions [id]`, `/mission create|pause|resume|cancel|repair|proof|events|step|evidence|verify|replan|event ...`, `/context [query]`, `/departments [catalog|provision|handoff ...]`, `/outcomes [slug|plan ...]`, `/workers`, `/worker <id>`, `/skills`, `/skill <name> [file]`, `/artifacts`, `/artifact download|delete|package`, `/videos`, `/video create|status|cancel`, `/runs`, `/run <prompt> [5m|30m|1h|3h|6h|3d|1w]`, `/webhooks`, `/webhook add|enable|disable|delete`, and `/deliveries`, alongside `/model` (interactive picker) or `/model <openrouter-model>`, `/apps [page]`, `/connect <app>`, `/tools search <query>`, `/triggers`, `/trigger create|enable|disable|delete`, `/channel list|link|notify`, `/meetings [id]`, `/meeting profile`, `/meeting prepare <client> | <objective> | <context>`, `/meeting join <url> | <client> | <objective> | <context>`, `/meeting join-prepared <preparation-id>`, `/meeting context <meeting-id> [question]`, `/meeting leave <meeting-id>`, `/voice on|off|status`, `/call <E.164 number> <purpose>`, `/usage`, `/export`, `/dashboard`, `/approve <id>`, `/deny <id>`, `/clear history`, `/clear session`, and `/exit`. Mission controls use the same durable runtime as Telegram, the dashboard, the SDK, and MCP: dependency-aware steps, bounded budgets, evidence/proof, verification, pause/resume/repair, exact provider-event continuation, cancellation, and replanning. Context, department spaces, typed handoffs, and outcome packages are owner-scoped and available from the CLI without exposing provider credentials. Meeting commands share the Recall lifecycle with Telegram and the dashboard: prepared calendar meetings, participant rosters, bounded conversation history, outcomes, and captured follow-up contacts remain owner-scoped. Durable `/run` jobs use the same QStash-backed task runner as the SDK, retain events and checkpoints, and can be resumed after failure or cancellation. Add `--model=<id>`, `--max-tools=<n>`, or `--max-cost=<usd>` to set per-run controls. Supported budgets are 5 minutes, 30 minutes, 1 hour, 3 hours, 6 hours, 3 days, and 1 week. `/call` validates the E.164 destination and purpose, then starts the configured outbound call directly. Chat response deltas are displayed as they arrive; `Ctrl+C` cancels only the active request and returns to the prompt. The prompt is a raw editor: Up/Down navigates input history, Left/Right moves the cursor, Tab completes slash commands, Ctrl+J inserts a newline, and bracketed paste preserves every pasted newline until Enter sends the complete message. Long history, memory, scratchpad, reminder, job, task, mission, context, app, tool, and trigger lists use a keyboard pager (`Space`/Down, `b`/Up, `q`); normal chat responses scroll naturally. Markdown responses are rendered for terminal output while the same assistant response is persisted for Telegram. Generated images, voice replies, and artifact files are saved to the local Chusky artifacts directory.

In owner-private interactive chats (including the paired CLI), linked private DMs, calls, and private meetings, the authenticated owner's clear request authorizes available tools for routine in-scope work without a second approval prompt. Deletions, money movement, permission changes, production deployment, remote Git pushes, and other irreversible or provider-marked high-impact actions retain exact approval checks, including when nested in `COMPOSIO_MULTI_EXECUTE_TOOL`. This rule does not grant authority to shared groups/workspace rooms, project/API runs, autonomous triggers, missions, or delegated workers; those continue to use their configured grants and approval rules. All runs remain subject to authentication, ownership, provider schemas, budgets, and verification. Daytona's private computer and sandbox are agent-controlled for ordinary workspace work; file or workspace deletion still requires approval. The authenticated service exposes bounded collection APIs at `/cli/collection/history`,
`/cli/collection/memories`, `/cli/collection/scratchpad`, `/cli/collection/reminders`, and
`/cli/collection/jobs`. Each accepts `page`, `pageSize` (capped server-side), and an optional
`query`, and returns `total`/`totalPages`; `/cli/session?page=&pageSize=` provides the same
pagination metadata for session history while returning only bounded summaries and counts.

---

## Deploy

### Stop, start, and restart Chusky on Oracle

When Chusky is running under PM2, control only the `chusky` process. This leaves the
other applications (`hubtel-gateway`, `selit-pay`, and `verifo`) and Nginx running.

```bash
cd ~/chusky
pm2 status
```

Use these commands to manage it:

```bash
pm2 reload ecosystem.config.cjs --only chusky --update-env  # safe production reload
pm2 logs chusky --lines 100      # inspect Chusky logs; Ctrl+C exits the viewer
pm2 save                         # persist the current PM2 state across reboot
```

Chusky uses a readiness-gated PM2 cluster worker. During a normal `reload`, PM2 starts
the replacement, waits for Chusky to verify Redis, Telegram, its HTTP listener, and the
Telegram webhook, then lets the old process drain active updates. Do not use `pm2 restart`
or `pm2 stop` for normal releases: both create avoidable Telegram downtime.

#### One-time PM2 migration

After pulling a release that contains `ecosystem.config.cjs`, migrate the existing fork-mode
process once. This briefly restarts only Chusky; run it after a successful build.

```bash
cd ~/chusky
pm2 delete chusky
pm2 start ecosystem.config.cjs --only chusky --update-env
pm2 save
```

#### Every future Oracle release

Use the checked-in deploy script. It refuses to deploy over tracked local changes, installs
from the lockfile, builds before touching PM2, performs the safe reload, and verifies local
liveness:

```bash
cd ~/chusky
bash scripts/deploy-oracle.sh
```

The Oracle-safe build heap defaults to `512 MB` and uses configured swap during compilation.
Override it only when necessary with `CHUSKY_BUILD_HEAP_MB=640 bash scripts/deploy-oracle.sh`.

Verify that it is listening on the configured Chusky port and that Nginx can reach it:

```bash
pm2 status
sudo ss -ltnp | grep :3003
curl -i https://YOUR_PUBLIC_URL/health
```

Do not run `npm start` while `pm2 status` shows Chusky as online: both processes try to
use port 3003 and the second one fails with `EADDRINUSE`. If a foreground process was
started before PM2, stop only that foreground process with `Ctrl+C` before the one-time
PM2 migration.

Do not use `pm2 stop all`, `pm2 delete all`, `pkill node`, or `sudo systemctl stop nginx`;
those commands can stop the other applications or the reverse proxy. `pm2 delete chusky`
removes Chusky from PM2 entirely and is only appropriate when intentionally uninstalling
its PM2 registration, not for a normal temporary stop.

### Railway
See [`railway-guide.md`](railway-guide.md) for the complete Railway deployment,
Redis, webhook, CLI pairing, and troubleshooting instructions.

### Local dashboard

From the repository root, run `npm run dashboard` to start the existing
`chusky-web` Next.js app. Visit `http://localhost:3000/app/operations` after
signing in; `/app/delivery` is the focused delivery view.

To use the same workspace on web and Telegram, sign in to the dashboard, open
**Settings**, create a Telegram link code, then send the copied `/link web_…`
command from the Telegram account that already uses Chusky. The high-entropy
code expires in 10 minutes, is one-time, and cannot rebind either account.

### Fly.io
```bash
fly launch --name chuck-agent --no-deploy
fly secrets set \
  TELEGRAM_BOT_TOKEN=... \
  OPENROUTER_API_KEY=... \
  COMPOSIO_API_KEY=... \
  WEBHOOK_URL=https://chuck-agent.fly.dev \
  WEBHOOK_SECRET=your-random-secret
fly deploy
```

### Google Cloud Run
```bash
docker build -t gcr.io/PROJECT/chuck .
docker push gcr.io/PROJECT/chuck
gcloud run deploy chuck \
  --image gcr.io/PROJECT/chuck \
  --platform managed --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "TELEGRAM_BOT_TOKEN=...,OPENROUTER_API_KEY=...,COMPOSIO_API_KEY=...,WEBHOOK_URL=https://..."
```

### Render
1. New Web Service → Docker → connect repo
2. Add env vars → deploy → copy URL → set `WEBHOOK_URL` → redeploy

---

## Setting up Composio triggers

Chusky can receive real-time events from connected apps (new Slack message, GitHub commit, incoming email, etc.).

1. Deploy Chusky and note your public URL.
2. Set `COMPOSIO_WEBHOOK_SECRET` and optionally `COMPOSIO_WEBHOOK_URL=https://your-domain.com/composio/triggers`. When the URL is blank, Chusky derives it from `WEBHOOK_URL`.
3. On startup, Chusky reconciles the project subscription through Composio's current **v3.1** API and explicitly requests the V3 `composio.trigger.message` payload. Check `/health`: `checks.composioTriggers` must be `configured` before relying on triggers.

Missions waiting for a Composio callback should store `provider: "composio"` and the exact stable trigger `eventId` with `CHUCK_MISSION_WAIT_EVENT`. After signature verification, Chusky matches that provider event to the same owner and resumes only the mission waiting for that exact event, then schedules every dependency-ready branch through the configured task queue. The generic mission-event API remains available for providers whose signed webhook adapter has not been added yet.

To create a trigger programmatically, tell Chusky:
> *"Create a trigger for new GitHub commits on my repo my-org/my-repo"*

Chusky will use `COMPOSIO_MANAGE_CONNECTIONS` to connect GitHub if needed, then set up the trigger.

---

## Commands

| Command | Description |
|---|---|
| `/start` | Welcome + current config |
| `/connect [app]` | Connect an app (e.g. `/connect github`) |
| `/apps` | See connected apps + available apps |
| `/mcp` | View and manage account-scoped third-party MCP connections |
| `/model` | Switch AI model (per-session, no restart) |
| `/clear` | Show clear-session help |
| `/clear history` | Wipe conversation history while keeping the Composio session |
| `/clear session` | Wipe history and reset the Composio session |
| `/triggers` | List your Composio triggers |
| `/trigger create|enable|disable|delete` | Manage a Composio trigger |
| `/tasks` | List durable tasks and their current status |
| `/task <id>` | Inspect a task, checkpoint, next action, and audit events |
| `/task retry|cancel <id>` | Retry or cancel an owned task |
| `/workers` / `/worker <id>` | List, inspect, or cancel delegated workers |
| `/skills` / `/skill <name> [file]` | Search skills and read nested skill files |
| `/artifacts` / `/artifact download|delete|package` | Manage generated files and ZIP packages |
| `/videos` / `/video create|status|cancel` | Queue and manage video jobs |
| `/runs` / `/run ...` | Start, inspect, stream events for, cancel, or resume durable runs |
| `/webhooks` / `/webhook ...` | Manage delivery webhooks; `/deliveries` shows delivery status |
| `/attach "path" [instruction]` | Send an image, audio, video, PDF, DOCX, PPTX, XLSX, ZIP, text, or Markdown file to Chusky |
| `/devices` | List linked terminal devices |
| `/revoke <name>` | Revoke a linked terminal device |
| `/image <description>` | Generate an image with OpenRouter |
| `/export` | Download conversation as `.txt` |
| `/usage` | Messages sent + model |
| `/info` | Full session details |
| `/help` | Help |
| `/cli link` | Create a one-time terminal pairing code |
| `/cli devices` | List linked terminals |
| `/cli revoke <name>` | Revoke a linked terminal |
| `/channel link slack|whatsapp|sendblue|sms|x|xchat` | Create a one-time verified external-channel link |
| `/channel list` | List channels linked to your Chusky account |
| `/channel notify slack|whatsapp|sendblue on|off` | Enable or disable proactive notifications for a linked channel |
| `/link web_<one-time-code>` | Link the authenticated dashboard workspace to this verified Telegram account |
| `/dashboard` | Open the authenticated Chusky web dashboard |

## Natural-language reminders, jobs, and scratchpad

Chusky's native tools are callable directly from ordinary messages:

- “Remind me in 20 minutes to check the deployment.”
- “Every weekday at 9, remind me to review the inbox.” (Chusky asks for or uses a CRON expression when needed.)
- “Save this as a scratchpad note called deploy: use the staging API.”
- “What did I save in my deploy notes?”

Configure `QSTASH_TOKEN`, `REMINDER_WORKFLOW_URL=https://your-domain/workflows/reminder`, and
`JOB_WORKFLOW_URL=https://your-domain/workflows/job`. One-time reminders are delayed durable
Workflow runs; recurring jobs are QStash schedules that invoke the authenticated Workflow endpoint.
Chusky checks ownership and cancellation state before delivering a notification.

The same autonomy controls are available from every shared surface. Use
`POST /v1/reminders/:id/pause|resume|run` and
`POST /v1/jobs/:id/pause|resume|run` from the SDK or dashboard, and
`GET /v1/jobs/:id/occurrences` for durable execution history. The SDK exposes
these as `reminders.pause()`, `reminders.resume()`, `reminders.runNow()`,
`jobs.pause()`, `jobs.resume()`, `jobs.runNow()`, and `jobs.occurrences()`.
Telegram and CLI controls update these same owner-scoped records. Pausing is
authoritative even if an older QStash delivery is still in flight; resuming or
running now creates a fresh durable attempt.

For a durable task that is waiting on an external provider, Chusky can pause the
same task without notifying the user or creating a recurring schedule. The agent
uses `CHUCK_TASK_WAIT` with a verified `checkpoint`, an exact `nextAction`, and
either `delaySeconds` or a future `runAt` timestamp. The delay is bounded to 60
seconds through 7 days. QStash sleeps the existing task workflow, then resumes
the same task and checkpoint; normal approvals, ownership checks, budgets, and
cancellation behavior still apply. This is for internal polling of work already
in progress, not for user reminders or periodic jobs.

### Proactive attention pulse

The attention state is an owner-scoped substrate for open loops, attention candidates,
standing orders, observations, autonomy watches, and delivery preferences. It becomes proactive only after the owner asks
Chusky to enable the pulse. The agent then creates one stable QStash schedule (hourly by
default) for Elena, the workflow governor. Each run reviews bounded state, applies only
active standing-order authority, preserves normal approvals for risky actions, suppresses
quiet/silent or daily-limit deliveries, and deduplicates unchanged digests. Ask Chusky:
“Enable my proactive attention pulse,” “Disable my attention pulse,” or “What is my pulse
status?” A custom CRON expression can be supplied when enabling it. Enabling creates a
default private Telegram delivery preference only when one does not already exist; existing
quiet-hour, silent, or disabled preferences are preserved. Daily limits count delivered pulse
digests on the pulse job itself, and an open loop is not closed merely because it was mentioned
in a digest—Elena must complete or explicitly snooze/update the loop. Pulse plans also surface
blocked/failed durable tasks and missions, expired non-timer waits, and due owner-configured
watches; paused work and future waits stay dormant. Watch reconciliation is mode-scoped
(personal/business) and strictly read-only. Meaningful watch changes, first failures, and
recovery are stored as deduplicated private observations. Pulse reports these observations and
tracks whether configured watches are current, scheduled, stale, failed, or not yet checked;
this is coverage of only explicitly configured watches, not a sweep of every connected app.
An observation is marked processed only after the delivery workflow confirms it was sent. If
the worker incorrectly returns `NO_ACTION` while an observation or coverage gap is pending,
Pulse sends a deterministic owner digest instead. Handling is counted only after a tool confirms
completion, not when it merely starts or is inspected. Pulse runs use a narrower task, reminder,
mission-inspection, and attention-state tool surface than ordinary Elena work; connected-app
actions require an explicit capability expansion. Redis and QStash are required in production.

### Event-driven Composio triggers

Composio trigger events are verified, ownership-checked, deduplicated, stored as a bounded safe
summary, and handed to the durable `/workflows/trigger-event` endpoint. The webhook returns `202`
before the agent runs. Set `TRIGGER_WORKFLOW_URL` explicitly when the public workflow URL differs
from `${WEBHOOK_URL}/workflows/trigger-event`; otherwise Chusky derives it from `WEBHOOK_URL`.
Trigger workflow runs use `trigger-<event-id>` as their stable QStash workflow ID, so provider
retries do not start a second agent run. If a triggered action needs approval, the workflow waits
for the approval callback and resumes with the same event context. Only a bounded, redacted summary
is persisted and shown to the model; raw provider payloads are not stored by default.

### Daytona persistence

When `DAYTONA_API_KEY` is configured, Chusky keeps a per-user Daytona workspace and stores its
provider ID in the durable Redis store under the existing `chuck:*` persistence contract. On a
later request, Chusky reconnects to that workspace, refreshes its state, recovers it when Daytona
reports a recoverable error, and starts it again after an idle pause or stop. The workspace's
filesystem is retained by Daytona across those lifecycle states; a provider-side deletion or
wall-clock TTL is permanent and causes Chusky to require a new workspace.

Daytona provides the private computer, workspace, and application surfaces. `CHUCK_DAYTONA_COMPUTER`
controls the desktop through the official Computer Use API, while `CHUCK_DAYTONA_PTY`
creates durable interactive terminal sessions for shells, dev servers, and test watchers; session
IDs are retained in the Redis-backed workspace record and can be reused with `write`, `read`,
`resize`, `status`, and `kill`. `CHUCK_DAYTONA_GIT` uses Daytona's official Git API for clone,
status, branches, checkout, pull, add, commit, and push. Local operations stay private; push is
approval-gated. Pull requests, CI checks, reviews, and deployments use verified GitHub/Composio
tools after local checks pass. Changing `DAYTONA_SNAPSHOT` does not change an existing workspace.

### E2B automated browser

When `E2B_ENABLED=true`, `CHUCK_BROWSER` routes normal browser actions through the
owner-scoped E2B Playwright/Chromium
template. E2B keeps a retained headed Playwright process per owner, returns
bounded accessibility candidates and redacted visible page text, and supports
public-site navigation, tabs, accessible controls, forms, typing, keyboard
presses, scrolling, screenshots, and verification. It does not apply a
site-domain allowlist, but blocks private/local network targets and metadata
services; individual sites can still require authentication or a human check.
Owner-private uploads, downloads, and screen recordings use bounded file sizes
and an owner-scoped 30-day file library; uploads require approval. CAPTCHA/2FA,
SSO, and passkey challenges can expose that same browser through a short-lived
private noVNC handoff. Daytona continues
to provide files, artifacts, terminals, and desktop Computer Use; it is not the
automated browser backend.

Cloudflare Web Bot Auth is an opt-in, transparent identity signal for browser
requests. Roll it out in two stages. First generate a key with
`npm run web-bot-auth:generate-key`, set `WEB_BOT_AUTH_ENABLED=true`,
`WEB_BOT_AUTH_DIRECTORY_URL`, and `WEB_BOT_AUTH_PRIVATE_KEY_B64`, while keeping
`WEB_BOT_AUTH_SIGN_REQUESTS=false`. Deploy and verify the signed, public-only
Ed25519 key directory at `/.well-known/http-message-signatures-directory`, then
submit the directory URL to Cloudflare's BotBase review. During this stage the
private key is not sent to E2B and browser requests remain unsigned. Only after
Cloudflare approves Chusky, set `WEB_BOT_AUTH_SIGN_REQUESTS=true` and deploy
again. The trusted E2B browser then signs each public HTTPS request with RFC
9421 headers; redirect hops are revalidated by the existing URL safety guard
and signed for their destination authority. The private key is never passed to
page JavaScript, model context, tool arguments, history, or logs. This does not
bypass CAPTCHA or site policies and does not guarantee that every website will
permit access. After enabling, disabling, or rotating signing, stop and restart
retained browser sandboxes so the old process environment is removed; toggling
off stops signing on subsequent commands but does not erase a key from an
already-running sandbox. Chusky's retained records store only the public key
thumbprint.

Build the template with `npm run e2b:template:build`, then configure
`E2B_API_KEY`, `E2B_BROWSER_TEMPLATE`, and `E2B_ENABLED=true`. The template
installs Chromium with Playwright into `/opt/ms-playwright`, makes it readable
by the non-root `chusky` user, and launches with safe container flags. Run
`npm run e2b:browser:live-smoke -- https://example.com` after the template is
available. E2B is the only automated browser backend; Daytona remains responsible for
computer, files, artifacts, terminals, and app work.

### Browser and vault operations

Authenticated website work follows the `browser-pro` runtime skill. Chusky plans the user's goal,
binds the operation to a clean HTTPS origin and optional account alias, checks session health, uses
the narrowest accessible browser action, and verifies the result against bounded URL/title/text
detectors. Saved playbooks are origin-scoped and contain only login labels, safe action names, and
verification metadata; they never contain passwords, cookies, screenshots, or raw page content.

Routine browsing and ordinary form interaction do not require blanket approval. Checkout, payment,
account changes, credential changes, sensitive downloads, uploads, and saved-file deletion retain
their specific approval or block rules. CAPTCHA, 2FA, SSO, passkeys, and device approvals use a
private browser handoff in the same E2B browser session. Owner-private snapshots can include bounded,
redacted visible page text; that text is not added to durable browser history.
Replacing a saved identity logs out its prior browser identities, and aliases allow separate
personal and work accounts for the same service.

The private Telegram controls are `/browser`, `/browser health`, `/browser audit`, `/browser handoffs`, and
`/browser revoke <service> [account-alias] [origin]` (with `/browser logout` retained as a compatibility
alias). Revocation blocks reuse of that saved website identity until a fresh vault login. The shared
browser workspace remains available for other identities and workspace processes. Saved
identities are keyed by account, service label, alias, and exact HTTPS origin, so one service label
can safely represent different websites. The agent can also use `CHUCK_BROWSER_PLAN`,
`CHUCK_BROWSER_SESSION_HEALTH`, `CHUCK_BROWSER_PLAYBOOK_SAVE`, `CHUCK_BROWSER_PLAYBOOK_LIST`,
`CHUCK_BROWSER_PLAYBOOK_REMOVE`, `CHUCK_BROWSER_VERIFY`, `CHUCK_BROWSER_AUDIT_LIST`,
`CHUCK_BROWSER_HANDOFF_STATUS`, and `CHUCK_BROWSER_HANDOFF_COMPLETE`. Human CAPTCHA/2FA handoffs
remain metadata-only and move from waiting to awaiting verification before the retained session is
re-authorized.

### Images across chat, Daytona, and connected apps

Images generated by `CHUCK_GENERATE_IMAGE` are retained as private image assets when R2 is available. The same generated image can be sent to the active chat, written to Daytona, and used by a connected-app image action in one run. Images attached through the dashboard or other private channels enter the same in-run image selection path.

`CHUCK_DAYTONA_IMAGE` copies a current, generated, or saved image into a unique workspace file (`action=export`). It can also read an existing JPEG, PNG, or WebP file from the owner's Daytona workspace and save it as a private image asset (`action=import`). The imported asset is available to a requested connected-app post or upload in the same run. Transfers are limited to 25 MB, validate the file bytes, and keep image bytes and workspace paths out of provider arguments. A Daytona screenshot joins the posting path only when the owner explicitly requests sending or publishing that screenshot. Live provider behavior still depends on the connected account and exact action schema.

### Artifact Studio

`CHUCK_ARTIFACT` gives Chusky a durable, user-owned deliverable registry backed by Daytona and
Redis metadata. Chusky can create Markdown reports and HTML websites directly, register verified
files generated in Daytona (DOCX, PDF, PPTX, XLSX, images, and videos), list or retrieve prior
artifacts, delete registry entries, and package verified workspace files into ZIP archives.
Registered artifacts are inspected in Daytona before promotion to the durable registry. DOCX/PDF
builder titles are checked against independently extracted rendered text, and every rendered page
is parsed and rasterized. XLSX workbooks are recalculated with LibreOffice Calc, then every formula
cell's cached value and error state is inspected; the builder can also compare selected calculated
results against declared expected values. Formula support is explicit and restricted to a bounded
safe syntax/function allowlist. The returned verification evidence contains counts and pass/fail
checks, not document contents. It establishes renderability and the checks listed, not human
editorial review or correctness of the workbook's business assumptions. Arbitrary registered
documents have no source baseline, so their extracted contents are counted but not compared to a
builder title. Large binary contents are never written into conversation history. Binary formats
must be generated and checked in Daytona before registration; an artifact record is not created
from a text claim alone. See [artifact verification](docs/artifact-verification.md) for the exact
contract and limitations.

For running sites and apps, the agent starts the process inside Daytona, verifies the service is
listening, calls `CHUCK_DAYTONA_PREVIEW`, and includes the returned temporary HTTPS URL in its
reply. Daytona filesystem paths and localhost URLs are private to the workspace and are never
presented as if the user could open them directly.

`CHUCK_DAYTONA_APP` can scaffold Vite or Next.js starters for SaaS dashboards, fintech, HR,
waitlists, portfolios, and business websites. Each archetype has its own layout and an `auto`
art direction (harbor, ledger, grove, editorial, or signal), with responsive CSS tokens and
editable source files; the palette deliberately avoids generic purple defaults. An explicit
`nocturne` style adds dark editorial treatment for product-fit marketing pages without changing
automatic defaults or overriding a stated brand palette. Generated screens
are starter previews with sample content, not connected product data. The agent should replace
that content for the user's task, run the app checks, inspect the available preview screenshot,
review the responsive breakpoints in source, and report what was not verified. Google Fonts are
progressive-enhancement imports with system fallbacks, so a preview remains usable when the font
service is unavailable.

Chusky also accepts these requests naturally, without slash commands:

```text
Generate an image of a moonlit mountain lake.
Make a short video of a red panda surfing.
Enable a trigger whenever I receive a new GitHub issue.
```

Natural-language image and trigger requests are exposed to the model as Chusky tools. Video requests are submitted to the Upstash Workflow endpoint and delivered to Telegram when generation completes.

### Slack and WhatsApp channels

The channel gateway keeps the internal account identity (`account_<telegram-user-id>`) separate from provider IDs. A Slack, WhatsApp, or Sendblue user is never trusted by display name alone: link it from the owning Telegram account with `/channel link <provider>`. Slack OAuth links the installer’s verified Slack user; WhatsApp and Sendblue use the one-time code with `/link <code>`. Unlinked messages receive instructions only and never enter an account’s history, memory, tasks, or approvals.

Enable the adapters only after their public HTTPS webhook endpoints are reachable. Slack uses `/slack/events`, `/slack/interactions`, `/slack/install`, and `/slack/oauth/callback`; WhatsApp Cloud API uses `GET/POST /whatsapp/webhook`. Requests are signature-checked against the raw body, stale Slack requests are rejected, duplicate provider events are claimed in Redis, and Slack events are acknowledged before agent work begins. Provider replies are written to the durable outbox with a stable idempotency key and a reclaimable delivery lease. WhatsApp also supports explicit approved-template delivery through the outbound contract: set `template.name`, `template.languageCode`, and optional Meta `components`; the adapter sends `type: "template"`. Normal replies remain text messages with WhatsApp formatting, and templates are never selected implicitly.

Slack setup requires an app Signing Secret, `chat:write`, `files:read`, and `files:write`, Event Subscriptions for direct messages and app mentions, Interactivity enabled at `/slack/interactions`, and OAuth Redirect URL matching `SLACK_REDIRECT_URI`. Reauthorize existing Slack installations after adding `files:write` so Chusky can upload generated images and artifacts. WhatsApp setup requires a Cloud API access token, phone number ID, verify token, and app secret. Keep all tokens in the deployment secret store; never commit `.env`.

### X Direct Messages

Regular X DMs use the official `@chat-adapter/x` adapter and the X API v2. This is X's unencrypted, standard Direct Message system. Chusky handles linked one-to-one DMs through the private account gateway; XChat credentials, identity links, and encrypted conversations remain separate.

Configure a user-context OAuth token for the X bot account. For long-running production deployments, use managed refresh so token rotation survives restarts, and configure the encryption key because refreshed OAuth tokens are persisted in the adapter's durable state:

```text
X_ENABLED=true
X_CONSUMER_SECRET=<X app consumer secret>
X_CLIENT_ID=<OAuth 2.0 client ID>
X_CLIENT_SECRET=<optional confidential-client secret>
X_REFRESH_TOKEN=<OAuth 2.0 refresh token>
X_ENCRYPTION_KEY=<base64 32-byte encryption key>
X_USERNAME=<optional bot handle>
X_API_BASE_URL=https://api.x.com
```

For a short-lived development setup, `X_USER_ACCESS_TOKEN` can replace the managed refresh credentials. The X OAuth app needs `users.read`, `dm.read`, and `dm.write`; add both `media.write` and `tweet.write` if Chusky will send images in a DM, and `offline.access` for managed refresh. R2 must be configured for generated images to be staged privately before the adapter uploads them. Keep the app consumer secret and OAuth credentials in the backend deployment secret store.

Register `https://your-domain.example/x/webhook` in the X Developer Console and subscribe the bot account to `dm.received` and `dm.sent`. X requires the bot account to authorize the app before private DM events can be subscribed. Chusky routes both the CRC challenge and signed event body through the official adapter. Subscription management stays in the X Console; startup does not create X Activity subscriptions.

From Telegram or the dashboard, create a link code for `x`, then send `/link <code>` from the X account in a regular DM to the bot. Linked X DMs use the owner's private Chusky history and are processed under the normal private-channel approval policy. Linking does not enable unsolicited notifications; opt in explicitly with `/channel notify x on`.

The installed `@chat-adapter/x` 4.40.0 exposes inbound DM text but does not surface inbound DM media in its normalized messages. Outbound media can be uploaded through X's media API when the action includes an attachment and the token has `media.write`. Public mentions are not enabled in this channel implementation.

### Encrypted XChat (optional legacy channel)

XChat uses the separate `@chat-adapter/x/chat` adapter and X's encrypted messaging system. Chusky handles DMs and explicit group mentions through the same normalized gateway as its other channels; identity linking, Redis history, shared/private scope, locks, approvals, and the durable outbox remain Chusky-owned. The adapter handles encryption, media encryption/decryption, typing pills, read receipts, reactions, edits, and webhook CRC/signature validation. It is separate from regular X DMs: do not reuse X OAuth user credentials as `XCHAT_BOT_TOKEN`, and do not expect one provider link to authorize the other.

Enable it only when the XChat bot has been provisioned with an OAuth access token, Juicebox PIN, webhook consumer secret, and a public HTTPS callback:

```text
XCHAT_ENABLED=true
XCHAT_BOT_TOKEN=<X OAuth access token>
# App-only bearer token used to list Activity subscriptions during startup
X_BEARER_TOKEN=<X app bearer token>
XCHAT_PIN=<Juicebox PIN>
X_CONSUMER_SECRET=<X app consumer secret>
X_BOT_USERNAME=<optional bot handle>
X_VERIFY_SIGNATURES=true
XCHAT_WEBHOOK_URL=https://your-domain.example/xchat/webhook
XCHAT_WEBHOOK_ID=<webhook id returned by X>
```

Configure both `GET` and `POST https://your-domain.example/xchat/webhook` in X, then copy the created webhook ID into `XCHAT_WEBHOOK_ID`. On startup Chusky verifies the bot user token, lists existing subscriptions with the app bearer token, creates or reuses the `chat.received` and `chat.conversation.join` activity subscriptions with the bot user token, and reports the setup state through `/health`. The bot account must already have registered XChat public keys and Juicebox private-key storage for `XCHAT_PIN`; webhook registration alone is not enough. From Telegram, use `/channel link xchat`, then send the generated `/link <code>` from the personal X account in a DM to the bot account. The personal account must be able to follow or trust the bot before its first encrypted DM. Group messages are handled when the bot is explicitly mentioned; they use shared channel context and never inherit private Telegram history.

### Sendblue iMessage channel

Sendblue connects Chusky to an iMessage-capable Sendblue line. It uses a verified inbound webhook and a durable Upstash Workflow so the provider request can be acknowledged quickly while agent work continues safely after retries or process restarts.

Required deployment variables:

```text
SENDBLUE_ENABLED=true
SENDBLUE_API_KEY=<Sendblue API key ID>
SENDBLUE_API_SECRET=<Sendblue API secret>
SENDBLUE_NUMBER=<your Sendblue iMessage number in E.164 format>
SENDBLUE_WEBHOOK_SECRET=<random webhook secret>
WEBHOOK_URL=https://your-domain.example
REDIS_URL=<durable Redis URL>
QSTASH_TOKEN=<Upstash QStash token>
```

Configure the Sendblue `receive` webhook as `https://your-domain.example/sendblue/webhook`. From the owning Telegram account, run `/channel link sendblue`, then send the generated six-digit code from iMessage using `/link <code>`. Confirm with `/channel list` and send a normal message.

#### Link an iMessage group

First link the owner's private Sendblue identity. Then create a group authorization code from Telegram:

```text
/channel link sendblue-group
```

Send the generated six-digit code inside the iMessage group from that same linked Sendblue number:

```text
/linkgroup <code>
```

The group receives a confirmation and uses its own shared conversation history. By default, everyone in the group can use Chusky; private Telegram, web, direct-iMessage history, and account-only memory remain unavailable to the group. The linked owner can manage access from inside the group:

```text
/group-access owner   # only the linked owner can use Chusky
/group-access all     # allow all group participants (default)
/unlink-group         # remove Chusky from this group
```

Only the linked owner can activate, change access for, or unlink the group. Group linking requires the Sendblue webhook, Redis, QStash, and HTTPS webhook-mode deployment described above.

The adapter verifies timestamped HMAC signatures when present and supports the legacy signing-secret header for compatibility. It claims provider event IDs before workflow enqueue, stores only bounded event data, hydrates permitted media, and sends replies through the durable outbox.

Apple inline voice notes arrive as Opus-in-CAF (`audio/x-caf`). Chusky accepts that documented Sendblue format and converts it privately to Ogg/Opus before transcription. The checked-in Railway Docker image includes `ffmpeg` for this conversion; no Railway variable or interactive install is needed. For outbound attachments, Sendblue relies on a real filename extension: Chusky maps MP3 to `.mp3`, M4A to `.m4a`, and CAF to `.caf` rather than deriving invalid extensions from MIME subtypes. Chusky keeps generated media private in R2, then uploads it directly to Sendblue's media endpoint before delivery because Sendblue does not accept signed URLs in `media_url`. A `.caf` file is required for an inline iMessage voice-note bubble; MP3/M4A are regular audio attachments.

#### Interactive meeting assistant (optional)

For company meetings, use the Meetings page inside an authenticated Better Auth
organization. Workspace administrators can create a meeting room for the whole
organization or attach it to a Better Auth team such as Marketing, Finance,
Sales, or Support. A room defines visibility, default interaction mode,
transcript retention, screen-understanding policy, and exact connected-app or
native action grants. Paste a supported meeting link and select the room before
joining. Chusky stores the Recall bot and live transcript under the owner who
started the join, while the workspace registry stores only a safe room pointer
and exposes sanitized status, participants, history, and durable outcomes to
authorized organization/team members. It never shares the owner's private
memories, credentials, unrelated files, or private chat history. Better Auth
membership is checked for room operations; project API keys can use
organization-wide rooms but cannot impersonate a human team membership. Run
`npm run auth:migrate` after enabling the Better Auth teams plugin so production
has the required team tables.

Chusky can join meeting links on Zoom, Google Meet, Microsoft Teams, and Webex.
Ask Chusky to join and provide the meeting URL. An explicitly enabled meeting
representative profile may also auto-join eligible Google Calendar events; a
normal calendar trigger is never blanket join authorization. A host may still need to admit the bot, and
platform-specific setup can apply. Chusky requests the name **Chusky Meeting
Assistant**, but authenticated Google Meet bots display the connected Google
account name and ignore Recall's `bot_name`; use an appropriately branded
connected account and keep the spoken/chat AI disclosure enabled. Recall supports GoTo Meeting bots, but its current Output Media
support matrix does not list GoTo, so Chusky does not enable GoTo for interactive
voice until that capability is documented and tested.

The separate [`chusky-voice`](chusky-voice/README.md) service runs Recall
Output Media, Deepgram Nova-3 transcription, and streaming Flux speech;
Chusky's configured model remains the agent
brain. When asked to join without an explicit mode, Chusky uses an enabled
company-representative profile, or proactive copilot mode if none is enabled;
addressed-only mode is reserved for an explicit wake-word-only request. It
opens with a short self-introduction using its configured name, without a canned
mission statement. In proactive modes it evaluates
ordinary conversation and speaks only when it can add value, with burst
smoothing rather than a per-call evaluation cap. An owner can
configure a sales, client-onboarding, employee-onboarding, customer-success, or
custom representative profile with its objective, approved company facts,
communication preferences, and optional account-routing aliases. In a private
owner meeting, the profile guides representation but does not restrict tool
discovery: Chusky uses relevant owner history, memories, knowledge, and the
owner's connected Composio, MCP, and native tools. It performs routine
requested actions directly; deletions and other high-impact actions retain
exact approval checks. In a
shared workspace room, exact room grants remain the boundary, and private
owner context is unavailable. Participant speech cannot change account
routing or authorize disclosure of unrelated records. The profile remains
disabled until you explicitly enable its representative behavior. The live voice bridge keeps a bounded
rolling context window in memory. Separately, proactive meetings can use
Recall's signed, low-latency, participant-attributed transcript stream to build
the post-meeting outcome from the full captured conversation, including things
said while Chusky was listening. Chusky encrypts these temporary segments in
Redis and deletes them after the outcome is durably saved; Recall recording and
media retention stay disabled. This is processing-only by default, not a
searchable transcript. Only if the owner explicitly asks to keep a transcript
does Chusky retain it encrypted and searchable for exactly 1, 7, or 30 days.
That opt-in requires a separate 32+-byte `RECALL_TRANSCRIPT_ENCRYPTION_KEY`
on the main Chusky service; keep it stable until the longest retained
transcript expires. Working transcript segments use an application-derived key
(the dedicated transcript key when configured, otherwise the media-bridge
secret) and are deleted after the recap is durably saved.
Use `CHUCK_MEETING_TRANSCRIPT_SEARCH` in a private owner chat for short matching
excerpts, or `CHUCK_MEETING_TRANSCRIPT_DELETE` to remove it early. Speaker
names are provider display labels, not verified identities. The media page and
meeting-chat notice disclose live processing and any selected retention; the
spoken intro stays short and conversational. Twilio phone calling stays
independent and unchanged.

For an owner-private meeting, the client brief is a focused, private starting
point—not a cap on context. Chusky can retrieve other relevant owner history,
memories, knowledge, and connected-app records through the normal private
tools. It keeps personal and business information appropriately separate:
business attendees do not receive unrelated personal context, and personal
meetings do not expose unrelated confidential business context. The focused
`CHUCK_MEETING_CONTEXT_LOOKUP` remains limited to company facts and the named
client's frozen mission; use the ordinary private memory, knowledge, and app
tools for other relevant context. The brief never appears in Recall metadata,
meeting chat, or the media-page URL. A direct owner request can use any
available connected action. Routine work can proceed directly, while
deletions and high-impact or provider-marked actions retain exact approval
checks. Shared rooms remain isolated and use their exact room grants.

Copilot's burst-smoothing interval is enforced atomically in the root service's
Redis store across voice-bridge reconnects and replicas. It does not impose a
per-meeting turn cap or downgrade Chusky to addressed-only. Configure
`RECALL_COPILOT_MIN_INTERVAL_SECONDS` on both services with matching values;
the voice-side gate only reduces avoidable bridge requests.

Enable it only after configuring `RECALL_MEETINGS_ENABLED=true`, the Recall API
key, region, Recall status-webhook signing secret, and matching 32+-byte
`RECALL_MEDIA_BRIDGE_SECRET` on Chusky and `chusky-voice`. Register Recall's
**Bot Status Change** webhook to `/recall/webhook`. In Recall's workspace
webhook event subscriptions, include `transcript.done` and `transcript.failed`
as well as the bot lifecycle events; `transcript.processing` is optional. These
events provide sanitized transcript-artifact status diagnostics. They do not
deliver transcript content. The signed per-bot `transcript.data` stream is
sent separately to `/recall/realtime-webhook` and powers the post-meeting
analysis. Keep `RECALL_WEBHOOK_SECRET` (workspace dashboard endpoint signing
secret) separate from `RECALL_WORKSPACE_VERIFICATION_SECRET` (real-time endpoint
verification secret). The historical `RECALL_REALTIME_SECRET` name remains a
fallback for existing deployments. See the bridge README for the full settings
and test procedure.

The voice bridge briefly retries an authenticated `425` while the signed bot
status webhook is still progressing through joining/waiting-room states. This
avoids rejecting a valid Output Media page during startup without authorizing
pre-call or ended sessions. The voice service's `/recall/health` endpoint
shows content-free aggregate counters for ticket checks, audio frames, Flux
turns, agent requests, and speech output.

Optional in-meeting chat adds a signed per-bot `participant_events.chat_message`
endpoint without enabling retained recordings/transcripts. The same endpoint
receives Recall participant join/leave/update and `speech_on`/`speech_off`
events. Chusky aligns the temporary active-speaker timeline with Deepgram Flux
word timestamps and labels a spoken turn only when exactly one rostered person
matches; overlapping or uncertain speech stays unattributed. That display name
follows the turn only in the bridge's short-lived meeting context, then is
discarded when the meeting ends. Meeting-chat replies can use the signed sender's
display name directly. Set
`RECALL_WORKSPACE_VERIFICATION_SECRET` to the Recall **workspace verification
secret** (the historical `RECALL_REALTIME_SECRET` name remains supported; this
may differ from the Svix `RECALL_WEBHOOK_SECRET`), and ensure Chusky has Redis,
`QSTASH_TOKEN`, and a public HTTPS `WEBHOOK_URL`. Health reports this separately
as `checks.recallChat`. Recall sends a short AI/live-processing disclosure on
join for Zoom, Meet, and Teams. Participants can address Chusky naturally or
use `/chusky <question>`, `/chusky status`, `/chusky help`, or `/chusky leave`.
With an enabled representative profile, relevant ambient chat may also be
evaluated and answered proactively; otherwise unaddressed chat is ignored.
Public prompts receive public replies, while Zoom direct messages are answered
only to that sender. Representative actions use only the owner's explicitly
granted tools and account routing, without access to private memories. Chat
text is held briefly in Redis only while a durable reply is processed, then
cleared; only answered meeting turns are added to the owner's bounded meeting
history. Webex supports incoming chat events but not chat replies, so only its
leave command is actionable through chat.

### Optional shared-screen understanding

The owner can explicitly ask Chusky to inspect slides, a shared screen, or a
visual demo while joining. Chusky enables `analyzeScreenShare` only for that
requested meeting; normal and calendar-triggered joins remain audio-only.
Recall's separate PNG stream is supported here for Zoom, Google Meet, and
Microsoft Teams, not Webex. The join fails closed unless the signed meeting
webhook, public disclosure/chat path, QStash, Redis, and voice bridge are
configured, so participants receive notice that screen frames may be briefly
analyzed.

The Recall video endpoint is created per bot, so no additional static video
webhook needs to be registered in the Recall dashboard. Set the same
`RECALL_WORKSPACE_VERIFICATION_SECRET` workspace verification secret on root
and `chusky-voice`, plus `CHUSKY_RECALL_VISUAL_FRAME_URL` on the voice service.
The historical `RECALL_REALTIME_SECRET` name remains supported as a fallback.
Changed frames are rate-limited; a static screen is refreshed every eight
seconds into an AES-GCM encrypted Redis cache that expires after twelve seconds.
Frames are passed as temporary multimodal context to live meeting turns, never
written into durable meeting history or a transcript. Visible screen content is
treated as untrusted input, not as instructions. See the bridge README for the
configuration and staging smoke test.

When a proactive **copilot** or **representative** meeting ends, Chusky queues a
durable post-meeting workflow. It creates a structured summary of decisions,
explicit follow-up actions, and open questions from the bounded meeting
history, then saves it privately in the owner's scratchpad as
`meeting:<meeting-id>` and sends the owner a Telegram recap. Chusky can retrieve
that note later with its scratchpad read tool when asked about the meeting.
In representative mode, if the owner has granted one exact Notion
page-creation action and that connected action is available, Chusky also
creates a Notion page and records the verified page URL in the scratchpad.
Owner-granted task and CRM tools may be used only for follow-through grounded
in clearly agreed meeting actions; the participant transcript itself never
grants authority. This workflow requires Redis and QStash. Conversation-only
copilot mode produces the private recap without connected-app actions.

During a representative meeting, Chusky can save a compact private contact card
when a participant shares their contact details and the discussed interest or
next step. The card is scoped to the owner and meeting, and is not general
memory. The post-meeting workflow can use an explicitly owner-granted email
action for an agreed immediate follow-up. For a later agreed email, it creates
an idempotent durable task tied to that one contact and one exact send action;
at execution it reloads the meeting, contact, and current representative
configuration, then runs without general conversation history or other tools.
The task is marked before sending so an ambiguous provider result is not
automatically retried and duplicated. Redis and QStash are required for delayed
follow-ups.

Meeting Runtime v2 also records a content-free operator timeline for the live
turn path: speech detected, eager transcript, final transcript, agent first
token, first audio, final audio, degraded recovery, and reconnect state. The
meeting record keeps only bounded numeric latency samples and exposes p50/p95
first-audio and final-response metrics to the dashboard, CLI, SDK, and MCP
views; transcript text and provider payloads are never placed in these runtime
diagnostics. Multilingual Flux meetings can auto-detect a language and update
recognition hints between turns. Owners can separately enable transient,
speaker-labelled live captions; those captions stay on the authenticated
meeting surface and are discarded with the session rather than becoming a
searchable transcript.

#### Twilio voice calls

Twilio handles inbound calls and default outbound calls; Bland can be enabled
as an optional outbound alternative. Outbound calls start after normal destination and purpose validation. Verify
`TWILIO_CALLER_ID` in Twilio, then configure
`TWILIO_VOICE_ENABLED=true`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_WEBHOOK_BASE_URL=https://chusky.up.railway.app`, and
`TWILIO_MEDIA_STREAM_URL=wss://voice.selithub.shop/twilio/stream`, plus the
same high-entropy `TWILIO_MEDIA_BRIDGE_SECRET` in Chusky and `chusky-voice`.
The bridge implementation lives in [`chusky-voice/`](chusky-voice/README.md).
Chusky validates signed TwiML and status callbacks; the bridge uses Twilio's
bidirectional Media Streams with Deepgram and stores only safe call metadata.
For inbound calls, purchase a Twilio voice number and configure its incoming
Voice URL as `https://chusky.up.railway.app/twilio/inbound` (POST). Set
`TWILIO_INBOUND_ENABLED=true`, `TWILIO_INBOUND_OWNER_USER_ID` to the owner’s
Telegram numeric ID, and `TWILIO_INBOUND_ALLOWED_CALLERS` to a comma-separated
E.164 allowlist. Unknown callers are rejected before they can access private
memory or the agent. Use `TWILIO_INBOUND_CALL_PROFILE=business` for a company
line and configure `TWILIO_INBOUND_VERIFIED_CALLERS` for the higher identity
verification tier before disclosing sensitive account details. An authenticated
private call gets relevant owner history, knowledge, memory, and connected
Composio/MCP/native tools; the call profile supplies personal/business
representation guidance, not a tool allowlist. Carry out in-scope requested
routine work directly, while deletions and high-impact or provider-marked
actions retain exact approval checks. Verification tiers still
govern disclosure of sensitive information. Outbound calls likewise receive
relevant owner context and connected tools, not just a short call brief.

The private bridge routes are `/internal/twilio/turn`,
`/internal/twilio/turn-stream`, `/internal/twilio/commit-turn`, and
`/internal/twilio/status`. The voice bridge validates Twilio's WebSocket
signature and a short-lived server-issued stream ticket. It uses Deepgram Flux
conversational STT turn events plus streaming Flux TTS in Twilio-compatible
8 kHz μ-law. `EagerEndOfTurn` starts the actual streamed reply early;
`TurnResumed` cancels it, and a matching `EndOfTurn` reuses that same generation
and commits it exactly once. Caller speech interrupts TTS and clears Twilio's
buffered playback. Telephone turns use the dedicated `VOICE_MODEL` and the
same owner-private Composio, MCP, and native tools as private chat, along with
relevant owner history, memory, and knowledge. Turns remain ephemeral in the
agent-run ledger; the account's conversation history is retained through the
existing session path. The live prompt has a bounded recent window, while
summaries and memory retain longer context. Deletions and high-impact or
provider-marked actions retain exact approval checks; inbound verification
still controls sensitive disclosure. OpenRouter receives a two-second
latency preference, a throughput preference, a per-call affinity key, and
optional `VOICE_FALLBACK_MODELS`; this is not a hard real-time guarantee.
Configure the same `TWILIO_AUTH_TOKEN` and `TWILIO_MEDIA_STREAM_URL` inside
`chusky-voice/.env`; see [`chusky-voice/README.md`](chusky-voice/README.md)
for latency tuning and Nginx WebSocket settings.

Per-account live-call voice choices are available in Telegram at `/home` →
`Voice`. Twilio calls and Recall meetings use the verified Deepgram Flux
streaming voice catalogue; Bland choices are loaded from its public curated
BTTS_V3 catalogue (private voice clones are not exposed in the shared menu).
The chosen voice applies to the next call or meeting. “Use service default”
clears the account override and returns to `VOICE_TTS_MODEL`/`BLAND_VOICE`.

Bland outbound calls also require a one-time Bland v1 Custom Tool resource so
the live call can consult Chusky with relevant owner-scoped history and tools,
without receiving a raw dump of unrelated chat history. Set `BLAND_WEBHOOK_SECRET` and a separate high-entropy
`BLAND_CONSULT_TOOL_SECRET` (32-256 URL-safe characters; generate one with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`), then run
`npm run setup:bland-tool` with `BLAND_API_KEY` and the public HTTPS
`BLAND_WEBHOOK_URL` configured. The command provisions the `/v1/tools` resource
and prints its `TL-*` ID; set that as `BLAND_CONSULT_TOOL_ID` in the Chusky
service. Keep the same `BLAND_CONSULT_TOOL_SECRET` in the Chusky service and
the Bland custom tool. Chusky validates the tool bearer secret, resolves Bland's
provider call ID through a short-lived Redis owner index, and answers through
the owner's selected OpenRouter model using the owner-authorized call purpose,
relevant private context, and the current caller question in an ephemeral
owner-private run. It can use connected Composio, MCP, and native actions;
deletions and other high-impact actions retain exact approval checks. Keep
actions within the owner-authorized
call objective, verify provider results, and do not disclose unrelated personal
or confidential business context. Bland call creation attaches the provisioned tool ID (the documented `/v1/calls` contract), and
status callbacks use a separate signed, per-call opaque URL. Health reports
Bland as misconfigured until all five settings are valid.

Sendblue `content` is plain text, not rendered Markdown. Chusky converts common Markdown at the provider boundary: emphasis markers are removed, bullets become `•`, headings become uppercase, and links become `label: URL`. Typing indicators are sent through `POST /api/send-typing-indicator` before linked one-to-one agent work and stopped after delivery. Verified one-to-one inbound messages are marked read through `POST /api/mark-read`; this is best-effort and never blocks the reply. Generated images and supported audio/video artifacts are stored in R2 and sent using short-lived HTTPS URLs when R2 is configured. A linked user can reply to an iMessage and send `/react love`, `/react like`, `/react dislike`, `/react laugh`, `/react emphasize`, or `/react question` to send a tapback to the replied message. Reactions are private-chat only. Sendblue status callbacks are sent to `/sendblue/status` and update the durable outbox receipt. The Sendblue dashboard's “Typing Indicators” webhook section is only needed if Chusky later needs to receive user-typing events.

### Channel support and operating model

| Channel | Current status | Conversation behavior |
|---|---|---|
| Telegram | Active | Primary bot transport; private history is retained in the account session |
| CLI | Active | Authenticated client of the deployed service; shares the user's private account session |
| Slack | Implemented | DMs use private account history; channel threads are shared-scope conversations |
| WhatsApp | Implemented | Linked private chats use the account session; proactive notifications require explicit opt-in |
| Sendblue | Implemented | Linked private iMessages use the account session; groups use shared scope; replies use the durable outbox |
| SMS | Twilio Messaging | Configure a Twilio sender or Messaging Service, `/twilio/sms` webhook, and signature validation |
| X Direct Messages | Implemented | Official regular, unencrypted X DMs through `/x/webhook`; inbound DM media is not exposed by the installed adapter |
| Encrypted XChat | Implemented | Separate encrypted X DMs/groups, media, mentions, typing, receipts, edits, and reactions through `/xchat/webhook` |
| Voice | Implemented | Twilio phone calls plus optional Recall meeting bots; the two transports and their credentials stay separate |

To connect Slack, WhatsApp, Sendblue, SMS, X DMs, or XChat, first run `/channel link <provider>` in the owning Telegram account. Complete the provider OAuth or send the one-time code from the external channel. Unlinked messages are rejected before they reach Chusky’s history, memory, tasks, or approvals. Sendblue requires `SENDBLUE_ENABLED`, API credentials, an iMessage-capable line, a `receive` webhook at `/sendblue/webhook`, Redis, QStash, and an HTTPS `WEBHOOK_URL`. Use `/channel list` to inspect links and `/channel notify <provider> on` only when the user wants proactive delivery.

In webhook mode, provider routes must be publicly reachable over HTTPS. Slack uses `/slack/events` and `/slack/interactions`; WhatsApp Cloud API uses `GET` and `POST /whatsapp/webhook`. Both routes verify the raw request signature, reject invalid requests with a non-2xx status, acknowledge provider webhooks quickly, and dispatch work asynchronously. Duplicate events are claimed in Redis, and every outbound reply is persisted in the Redis outbox before provider delivery.

The channel gateway is intentionally provider-neutral. It resolves provider identity to `account_<telegram-user-id>`, applies private/shared conversation scope, obtains the distributed account lock, runs the shared agent handler, and recovers queued outbound messages after a process restart. Keep provider parsing, signature verification, and formatting inside `src/channels/`; do not add provider payload parsing to `agent.ts` or `handlers.ts`.

### Production readiness and remaining gates

The core agent, durable missions, outcome verification, replay evaluation, operator
timeline, compensation queue, memory conflict checks, autonomy policy compiler,
provider matrix, and owner-scoped execution quotas are implemented and covered by
the local regression suite. The authenticated `/v1/ops/health` and
`/v1/operator/readiness` surfaces expose the same operational state to the dashboard,
SDK, and CLI integrations.

The remaining gates are deployment evidence rather than unbounded feature claims:

- Configure Redis and QStash in the target environment; production readiness fails
  closed when durable persistence is unavailable.
- Run fresh, real inbound/outbound text-and-image smoke tests for every enabled
  provider and persist the resulting proof. Configuration alone is never treated as
  live provider certification.
- Configure `PROVIDER_SMOKE_SIGNING_SECRET` and have a deployment-side smoke runner
  submit its complete, fresh results to the root-only `POST /v1/operator/provider-proof`
  endpoint. Each report must include separate inbound-text, inbound-image,
  outbound-text, and outbound-image checks, each with a fresh observation time and
  a SHA-256 hash of its provider event or delivery receipt ID. Raw provider IDs and
  payloads are never stored. The attestation is HMAC-bound and expires; missing,
  duplicated, stale, or incomplete evidence is rejected and never changes readiness.
- For a non-mutating signed-webhook boundary check against an explicitly allowlisted
  staging deployment, run `npm run provider:webhook-smoke` with
  `CHUSKY_PROVIDER_SMOKE_TARGET_STAGE=staging`,
  `CHUSKY_PROVIDER_SMOKE_BASE_URL`, and
  `CHUSKY_PROVIDER_SMOKE_ALLOWED_ORIGINS`. Add only the staging callback secrets for
  providers to check (`SLACK_SIGNING_SECRET`, `WHATSAPP_VERIFY_TOKEN` plus
  `WHATSAPP_APP_SECRET`, `SENDBLUE_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN`, and/or
  `X_CONSUMER_SECRET`). The runner only submits synthetic signed verification/status
  callbacks with random unknown receipt IDs; it never calls provider send APIs, creates
  provider proof, or changes readiness. This is not a real provider, inbound-message,
  agent, media, or outbound-delivery test. If Twilio uses a configured status callback
  URL, set `TWILIO_SMS_STATUS_CALLBACK_URL` to the exact staging route.
- Run the real-provider matrix, Redis/QStash outage tests, duplicate-webhook tests,
  and long-running worker tests against the deployed services before declaring that
  deployment production-certified.
- Add Sendblue App Cards for interactive actions where a plain URL is not sufficient.

Until those external checks have fresh evidence, the readiness endpoint intentionally
reports `degraded` or `blocked`; local unit and integration tests do not override it.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | From @BotFather |
| `OPENROUTER_API_KEY` | ✅ | — | From openrouter.ai/keys |
| `COMPOSIO_API_KEY` | ✅ | — | From app.composio.dev |
| `WEBHOOK_URL` | prod | — | Public URL (blank = polling) |
| `DASHBOARD_URL` | dashboard | — | Public Next.js dashboard URL; `/dashboard` opens its `/app` route |
| `WEBHOOK_SECRET` | — | — | Secures Telegram webhook |
| `DEFAULT_MODEL` | — | `minimax/minimax-m3:free` | Any OpenRouter model ID |
| `GROUP_DEFAULT_MODEL` | — | same as `DEFAULT_MODEL` | Model for shared group conversations; `/group-model default` restores this value |
| `VOICE_MODEL` | — | `google/gemini-3.5-flash` | Dedicated low-latency model used for live voice turns |
| `VOICE_FALLBACK_MODELS` | — | `google/gemini-2.5-flash` | Comma-separated tool-capable fallback candidates for live calls |
| `VOICE_MAX_TOKENS` | — | `192` | Maximum model output tokens for one live voice turn |
| `TRANSCRIPTION_MODEL` | — | `openai/gpt-transcribe` | OpenRouter speech-to-text model |
| `TTS_MODEL` | voice replies | `deepgram/flux-tts:free` | OpenRouter text-to-speech model |
| `TTS_VOICE` | — | `flux-kit-en` | Voice ID accepted by the selected TTS model |
| `QSTASH_TOKEN` | reminders/jobs/triggers | — | Upstash QStash token |
| `QSTASH_URL` | QStash client | `https://qstash-us-east-1.upstash.io` | Regional Upstash QStash API URL |
| `PROVIDER_SMOKE_SIGNING_SECRET` | provider certification | — | HMAC secret used only by the deployment smoke runner when posting fresh proof to `/v1/operator/provider-proof` |
| `MISSION_WEBHOOK_SECRET` | signed mission events | — | HMAC secret for provider callbacks to `/v1/missions/:id/events/signed` |
| `REMINDER_WORKFLOW_URL` | reminders | — | Public `.../workflows/reminder` URL |
| `JOB_WORKFLOW_URL` | recurring jobs | — | Public `.../workflows/job` URL |
| `TRIGGER_WORKFLOW_URL` | Composio triggers | — | Public `.../workflows/trigger-event` URL; defaults from `WEBHOOK_URL` |
| `SYSTEM_PROMPT` | — | Chusky's default | Agent personality |
| `ENABLE_MANAGE_CONNECTIONS` | — | `true` | OAuth link tool |
| `COMPOSIO_CALLBACK_URL` | — | — | Post-connect redirect URL |
| `ENABLE_SANDBOX` | — | `true` | Bash + workbench tools |
| `SANDBOX_SIZE` | — | `standard` | `standard`/`medium`/`large`/`xlarge` |
| `DAYTONA_API_KEY` | Daytona | — | Enables an isolated per-user Daytona workspace |
| `DAYTONA_API_URL` | — | `https://app.daytona.io/api` | Daytona API endpoint |
| `DAYTONA_TARGET` | — | provider default | Optional Daytona execution target |
| `DAYTONA_IMAGE` | — | — | Optional image source; required for inline resource sizing |
| `DAYTONA_SNAPSHOT` | — | provider default | Optional reusable snapshot |
| `DAYTONA_CPU` | — | provider default | CPU cores for newly created workspaces, up to 4 |
| `DAYTONA_MEMORY_GIB` | — | provider default | Memory in GiB for newly created workspaces, up to 8 |
| `DAYTONA_DISK_GIB` | — | provider default | Disk in GiB for newly created workspaces, up to 10 |
| `E2B_ENABLED` | automated browser | `false` | Routes normal Playwright browser work through E2B when true |
| `E2B_API_KEY` | automated browser | — | E2B server-side API key; never expose to the model or client |
| `E2B_BROWSER_TEMPLATE` | automated browser | `chusky-browser-playwright` | Built E2B template containing Playwright and Chromium |
| `E2B_ALLOW_INTERNET` | automated browser | `true` | Allow public web access; the browser still blocks local, metadata, private, and reserved network targets |
| `E2B_TIMEOUT_MS` | automated browser | `900000` | Owner sandbox lifetime, bounded to 60 seconds–24 hours |
| `E2B_REQUEST_TIMEOUT_MS` | automated browser | `120000` | E2B command/request timeout |
| `WEB_BOT_AUTH_ENABLED` | browser identity | `false` | Publish the signed Web Bot Auth directory; does not enable request signing |
| `WEB_BOT_AUTH_SIGN_REQUESTS` | browser identity | `false` | Sign browser requests only after Cloudflare approves the identity |
| `WEB_BOT_AUTH_DIRECTORY_URL` | browser identity | — | Exact public HTTPS URL ending in `/.well-known/http-message-signatures-directory` |
| `WEB_BOT_AUTH_PRIVATE_KEY_B64` | browser identity | — | Unique Ed25519 PKCS#8 DER private key, base64 encoded; server/E2B process only |
| `LINK_AGENT_WALLET_ENABLED` | Stripe Link Agent Wallet | `false` | Enable owner-controlled Link spend requests |
| `LINK_CLIENT_ID` | Stripe Link OAuth | — | Confidential Link OAuth client ID |
| `LINK_CLIENT_SECRET` | Stripe Link OAuth | — | Server-only Link OAuth client secret |
| `LINK_PUBLISHABLE_KEY` | Stripe Link OAuth | — | Publishable key used for Link OAuth authentication |
| `LINK_AGENT_WALLET_ENCRYPTION_KEY` | Stripe Link | — | Stable base64url-encoded 32-byte key for encrypted wallet tokens |
| `LINK_OAUTH_CALLBACK_URL` | Stripe Link OAuth | derived from `WEBHOOK_URL` | Public HTTPS `/link/oauth/callback` URL registered exactly with Link |
| `LINK_API_BASE_URL` | Stripe Link API | `https://api.link.com` | Link API origin; override only for a verified environment |
| `LINK_AUTH_BASE_URL` | Stripe Link OAuth | `https://login.link.com` | Link OAuth origin; override only for a verified environment |
| `LINK_TEST_MODE` | Stripe Link | `false` | Ask Link for test-mode spend behavior when the account supports it |
| `LINK_MAX_SPEND_CENTS` | Stripe Link | `50000` | Per-request ceiling in the currency minor unit |
| `LINK_REQUEST_TIMEOUT_MS` | Stripe Link | `20000` | Link API/OAuth request timeout |
| `DAYTONA_NETWORK_BLOCK_ALL` | — | `true` | Blocks outbound sandbox network by default; set false only deliberately |
| `DAYTONA_DOMAIN_ALLOW_LIST` | — | — | Comma-separated domains for a restricted browser/network allowlist on new workspaces |
| `DAYTONA_AUTO_PAUSE_INTERVAL` | — | `0` | Pause interval in minutes; use only with a pausable Daytona target such as `linux-vm` |
| `MAX_TOOL_ROUNDS` | — | `70` | Max model/tool cycles per run (bounded to 1-100; durable tool-call and cost budgets still apply) |
| `OPENROUTER_TIMEOUT_MS` | — | `45000` | First-attempt OpenRouter timeout in milliseconds; transient retries expand up to 120s |
| `OPENROUTER_MAX_ATTEMPTS` | — | `2` | Maximum OpenRouter attempts for a model turn (hard-bounded to 1-5) |
| `OPENROUTER_ARTIFACT_MAX_TOKENS` | — | `12000` | Output budget for structured PDF/document/artifact tool calls |
| `RATE_LIMIT` | — | `10` | Messages per window |
| `RATE_WINDOW_SECONDS` | — | `60` | Rate window |
| `ALLOWED_USERS` | — | (all) | Telegram user IDs allowlist |
| `MAX_HISTORY` | — | `10` | Conversation turns to keep (clamped to 7–12) |
| `REDIS_URL` | — | (memory) | Redis for persistence |
| `SESSION_TTL` | — | `2592000` | Redis TTL (30 days) |
| `BETTER_AUTH_DATABASE_URL` | Neon | — | Production Better Auth PostgreSQL connection string; required when `NODE_ENV=production` and auth is enabled |
| `BETTER_AUTH_MIGRATION_DATABASE_URL` | Neon | — | Direct PostgreSQL connection used only by `npm run auth:migrate` for Better Auth schema migrations |
| `BETTER_AUTH_DATABASE` | — | `./data/better-auth.sqlite` | Local-development Better Auth SQLite fallback only |
| `PORT` | — | `8080` | HTTP port |
| `LOG_LEVEL` | — | `info` | trace/debug/info/warn/error |
| `SLACK_ENABLED` | — | `false` | Enable the verified Slack adapter |
| `SLACK_SIGNING_SECRET` | Slack | — | Slack app Signing Secret |
| `SLACK_BOT_TOKEN` | — | — | Optional single-workspace token; OAuth installations are preferred |
| `SLACK_CLIENT_ID` | Slack OAuth | — | Slack app client ID |
| `SLACK_CLIENT_SECRET` | Slack OAuth | — | Slack app client secret |
| `SLACK_REDIRECT_URI` | Slack OAuth | — | Public `/slack/oauth/callback` URL |
| `WHATSAPP_ENABLED` | — | `false` | Enable WhatsApp Cloud API adapter |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp | — | Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp | — | Sending phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | WhatsApp | — | Webhook verification token |
| `WHATSAPP_APP_SECRET` | WhatsApp | — | Meta app secret for `X-Hub-Signature-256` |
| `WHATSAPP_GRAPH_VERSION` | — | `v23.0` | Graph API version |
| `X_ENABLED` | — | `false` | Enable regular, unencrypted X Direct Messages |
| `X_USER_ACCESS_TOKEN` | X OAuth 2.0 | — | Static OAuth user token for development; expires and is not suitable for a long-running production bot |
| `X_CLIENT_ID` | X OAuth 2.0 | — | OAuth client ID for managed token refresh |
| `X_CLIENT_SECRET` | X OAuth 2.0 | — | Optional confidential OAuth client secret |
| `X_REFRESH_TOKEN` | X OAuth 2.0 | — | Refresh token with `offline.access`; use with `X_CLIENT_ID` |
| `X_ENCRYPTION_KEY` | — | — | Base64 32-byte key required in production to encrypt persisted refreshed OAuth tokens |
| `X_USERNAME` | X account | — | Optional bot handle used by the adapter |
| `X_API_BASE_URL` | — | `https://api.x.com` | X API base URL override |
| `X_CONSUMER_SECRET` | X developer app | — | Consumer secret used for CRC and webhook signature verification by X DM and XChat adapters |
| `XCHAT_ENABLED` | — | `false` | Enable the encrypted XChat adapter |
| `XCHAT_BOT_TOKEN` | X OAuth 2.0 | — | OAuth 2.0 user token for the XChat bot account |
| `X_BEARER_TOKEN` | X developer app | — | App-only bearer token used to list Activity API subscriptions |
| `XCHAT_PIN` | Juicebox | — | PIN used to unlock the bot's encrypted XChat keys |
| `XCHAT_WEBHOOK_ID` | X developer app | — | Existing X Activity API webhook ID |
| `SENDBLUE_ENABLED` | — | `false` | Enable the Sendblue iMessage adapter |
| `SENDBLUE_API_KEY` | Sendblue | — | Sendblue API key ID |
| `SENDBLUE_API_SECRET` | Sendblue | — | Sendblue API secret |
| `SENDBLUE_NUMBER` | Sendblue | — | Sending iMessage-capable number in E.164 format |
| `SENDBLUE_WEBHOOK_SECRET` | Sendblue | — | Secret used to verify Sendblue receive webhooks |
| `SENDBLUE_WORKFLOW_URL` | — | derived | Optional public `/workflows/sendblue-event` URL override |
| `CHUSKY_PROJECT_KEY` | — | — | Optional private Oracle root/bootstrap key for the self-hosted Developer API; enables `/v1` and provisions scoped project keys |
| `MCP_ENABLED` | — | `false` | Enable Chusky as a client of configured third-party Streamable HTTP MCP servers |
| `MCP_SERVERS_JSON` | legacy MCP | `[]` | Temporary backwards-compatible server registry; prefer `src/mcp/mcp.json` |
| `MCP_CONNECTION_ENCRYPTION_KEY` | MCP connections | — | Stable base64url-encoded 32-byte key used to encrypt connected-account tokens |
| `MCP_OAUTH_CALLBACK_URL` | MCP OAuth | derived from `WEBHOOK_URL` | Public HTTPS `/mcp/oauth/callback` URL used for authorization-code + PKCE callbacks |
| `MCP_TOOL_TIMEOUT_MS` | — | `20000` | Maximum time for one third-party MCP tool call |
| `MCP_MAX_SERVERS` | — | `20` | Maximum configured MCP servers loaded at startup |
| `MCP_MAX_TOOLS_PER_SERVER` | — | `100` | Maximum discovered tools exposed from each MCP server |
| `MCP_MAX_RESULT_CHARS` | — | `20000` | Maximum MCP output passed back into the model |
| `TREG_ENABLED` | — | `false` | Enable the server-side Treg external intelligence gateway |
| `TINYFISH_API_KEY` | — | — | Server-only TinyFish key; enables TinyFish search and page fetch tools |
| `TREG_BASE_URL` | — | `https://treg.to` | Treg REST API origin |
| `TREG_TOKEN` | Treg | — | Server-only Treg token; never place it in prompts or client config |
| `TREG_TIMEOUT_MS` | — | `30000` | Maximum time for one Treg request |
| `TREG_MAX_RETRIES` | — | `2` | Retries for transient idempotent or idempotency-keyed requests |
| `TREG_DAILY_BUDGET_USD` | — | `5` | Per-owner daily Treg spend cap |
| `TREG_MISSION_BUDGET_USD` | — | `1` | Per-mission Treg spend cap |
| `TREG_PER_CALL_SOFT_CAP_USD` | — | `0.25` | Maximum estimated cost of one Treg call |
| `TREG_RATE_LIMIT_PER_MINUTE` | — | `30` | Per-owner Treg call-attempt limit per minute |
| `TREG_ORG_TOKENS_JSON` | Treg | `{}` | Server-only organization-to-token map; never put this in client config |
| `JEV_MODE` | — | `off` | Jev decision routing for skills, Composio toolkits/actions, Treg, and optional native-tool exposure: `off`, `shadow` (log only), or `enforce` (apply with deterministic fallback). See `.agents/skills/chusky/references/jev.md` |
| `JEV_PROVIDER` | — | `openrouter` | `openrouter` reuses `OPENROUTER_API_KEY`; `typesafe` needs `JEV_API_KEY` |
| `JEV_SURFACES` | — | `skills,composio,treg,autonomy,browser` | Jev surfaces: skills, Composio, Treg, bounded autonomy, inspected browser next-step proposals, and opt-in `native` tool exposure |
| `JEV_NATIVE_TOOL_ROUTING` | — | `false` | With `native` enabled, select a compact native-tool schema set in enforce mode; false preserves the existing full native catalog |
| `JEV_NATIVE_TOOL_MAX_CANDIDATES` | — | `16` | Maximum compact native candidates considered by Jev (4-32) |
| `JEV_NATIVE_TOOL_MIN_CONFIDENCE` | — | `0.6` | Minimum Jev confidence required before native schemas are reduced |
| `JEV_NATIVE_TOOL_MIN_PROBABILITY` | — | `0.12` | Minimum per-tool probability for a selected native schema |
| `JEV_COMPOSIO_ROUTE_UNCONNECTED` | — | `true` | Route across Composio's full toolkit catalogue so requests can target apps that are not connected yet (connect-first hint, never executable until connected) |
| `JEV_COMPOSIO_CATALOG_LIMIT` | — | `500` | Most-used Composio toolkits considered for routing (cached 6h) |
| `JEV_TURN_BUDGET_MS` | — | `3000` | One shared per-turn deadline for all routing before the first model call; slower routes fall back to keywords |

---

## Architecture

```
src/
├── index.ts      Entry point — webhook (prod) / polling (dev), Composio trigger endpoint
├── config.ts     All env vars, typed + validated at startup
├── logger.ts     pino — pretty in dev, JSON in prod
├── store.ts      Redis + memory — sessions, rate limits, Composio session IDs
├── agent.ts      Chusky's brain — Composio session + OpenRouter agentic loop
├── agentTools.ts Native tool schemas exposed to the model
├── types.ts      Shared API, media, and tool-call types
├── policy.ts     Risk detection and human progress messages
├── nativeTools.ts Native reminders, CRON, scratchpad, and Daytona dispatch
├── channels/     Provider-neutral gateway, identity, scopes, outbox, formatters, and adapters
├── lib/daytona/  Daytona SDK client, workspace lifecycle, files, and process engine
├── handlers.ts   grammY commands, live status bar, /connect, /apps, inline mode
└── markdown.ts   LLM markdown → Telegram HTML
└── cli/           Authenticated terminal client, API client, and Markdown renderer
```

### Agentic loop

```
composio.create(userId) → session with 1000+ tools + meta tools
        │
session.tools() → OpenAI-compatible tool schemas
        │
POST openrouter.ai/chat/completions (model + messages + tools)
        │
   finish_reason?
   ┌────┴────────────┐
 stop           tool_calls
   │                 │
 return          for each call:
  text           session.execute(slug, args) → Composio routes it
                 (meta tools → Composio server,
                  app tools → Composio → provider API)
                      │
                 append result → loop (max MAX_TOOL_ROUNDS)
```

### Adding a custom tool

```typescript
// In src/agent.ts — after sessionObj is created:
const myTool = {
  type: "function",
  function: {
    name: "MY_CUSTOM_TOOL",
    description: "What this does",
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
  },
};

// Add to composioTools array before the agentic loop:
composioTools.push(myTool);

// Handle in the loop:
if (slug === "MY_CUSTOM_TOOL") {
  result = await myCustomExecute(args);
}
```
