# Chusky company platform: operating guide

This document explains how the company layer is intended to be used in
production. Chusky is the orchestration and policy layer. Composio remains the
integration layer: it owns OAuth consent, connected accounts, token refresh,
tool discovery, and provider execution.

## Runtime shape

```text
Customer backend or MCP host
        |
        | scoped project key + stable customer identity
        v
Chusky REST API / SDK
        |
        | templates, policy, approvals, durable runs, audit, usage
        v
Chusky execution engine
        |
        v
Composio connected accounts and tools
```

The project key is a backend credential. It must never be placed in browser
JavaScript, a mobile bundle, a widget attribute, or a public MCP URL.

## First-time workspace setup

1. Enable Better Auth and create a Chusky workspace.
2. Invite teammates. Owners and admins can create company projects and edit
   project policy; members can inspect the project but cannot rotate keys or
   change policy.
3. Create a company project and copy its one-time `chsk_…` key into the
   company server's secret manager.
4. Connect Gmail, Slack, HubSpot, Salesforce, or another supported app through
   the existing Composio connection flow. Use the same stable Chusky identity
   that the server will send later in `X-Chusky-User-Id`.
5. Choose a specialist template, such as `lead-research` or
   `sales-development`, then narrow its instructions and project policy.
6. Run a read-only test task. Keep external execution tools approval-gated
   until the company has reviewed the resulting audit events and costs.

## Backend run example

```ts
import { Chusky } from "@chusky/sdk";

const chusky = new Chusky({
  apiKey: process.env.CHUSKY_API_KEY!,
  userId: "acme_customer_42",
});

const { thread, run } = await chusky.runs.create({
  input: "Find fintech companies with more than 50 employees and prepare sourced outreach drafts.",
  agentId: "agt_lead_research",
  wait: false,
}, { idempotencyKey: "acme-leads-2026-09-15" });

console.log({ threadId: thread.id, runId: run.id, status: run.status });
```

Use `runs.get()` or `tasks.get()` for durable status. Deliver webhook events to
an idempotent endpoint and use the run ID as the deduplication key. Approval
decisions should be made by an authenticated human in the company console or
an explicitly authorized backend—not by an agent or its MCP connection.

## Embedded chat

The embeddable widget uses a customer-owned server route. The browser sends a
message to that route; the route creates a Chusky thread/run with the project
key and the authenticated customer's stable ID, then streams bounded NDJSON
events back to the widget.

```html
<script type="module" src="https://cdn.example.com/chusky-widget.js"></script>
<chusky-chat endpoint="/api/chusky/chat" title="Acme assistant"></chusky-chat>
```

The customer server must authenticate its own visitor/session, validate the
request origin, rate-limit the route, and derive `userId` from its session. It
must not accept an arbitrary user ID from the browser. See
[`sdk/docs/embedded-chat.mdx`](../sdk/docs/embedded-chat.mdx).

## White-label dashboard and custom domains

Workspace owners/admins configure the display name, logo URL, color palette,
and custom hostname in the Organizations screen. The branding record is
workspace-scoped and served by a public, read-only hostname lookup; private
workspace data still requires the Better Auth session.

Custom domains are intentionally DNS-first:

1. Add the hostname in Chusky.
2. Point the hostname to the deployed dashboard host using the provider's
   CNAME/custom-domain flow.
3. Verify TLS and the host routing at the deployment provider.
4. Open the hostname and confirm the public branding lookup returns the
   workspace brand before inviting customers.

Chusky stores the requested hostname and returns a `pending_dns` status. The
deployment provider remains responsible for certificate issuance and routing;
Chusky does not pretend that a DNS record or certificate exists until the
operator has configured it.

## MCP repository decision

The MCP adapter should become a separate repository when it has its own release
cadence, Cloudflare account, deployment secrets, or external contributors. A
recommended split is:

- `chusky` — orchestration engine, REST API, SDK contract, dashboard, and
  Composio policy boundary.
- `chusky-mcp` — stateless Cloudflare Worker adapter, MCP tool descriptions,
  Worker CI/CD, and deployment configuration.

Until the split is created, `cloudflare/chusky-mcp` is a self-contained package
with its own lockfile, Wrangler config, tests, and README. Move that directory
to the new repository with history preserved, then replace this repository's
directory with a versioned dependency or deployment reference. Do not copy
project keys or Composio credentials into the Worker repository.

## Production checklist

- Redis is configured; in-memory persistence is development-only.
- Better Auth uses Neon/Postgres and email verification is enabled.
- Composio connections are linked for the exact stable identities used by
  server calls.
- Project scopes, budgets, and approval rules are reviewed.
- Customer proxy/widget endpoints have authentication, origin checks, rate
  limits, and request-size limits.
- Webhook consumers are idempotent and verify signatures.
- The MCP Worker has only `CHUSKY_API_ORIGIN`; keys arrive per request and are
  never stored in Worker configuration.
- Custom-domain DNS/TLS routing is verified outside Chusky before launch.
