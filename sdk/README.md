# Chusky TypeScript SDK

The official TypeScript client for the Chusky Developer API.

Chusky gives applications a persistent, tool-using agent that can stream
responses, run durable work, use connected business applications, pause for
human approval, produce artifacts, and continue after restarts. The SDK is the
server-side boundary for those capabilities; it does not expose Redis,
Composio credentials, or Chusky's internal `CHUCK_*` tool implementations.

## Install

```bash
npm install @chusky/sdk
```

Requirements: Node.js 18 or newer.

## Five-minute quickstart

Create a project-scoped API key in the Chusky dashboard under **Developer API**
or provision one from a trusted operator environment. Then keep it on your
server:

```env
CHUSKY_API_KEY=chsk_your_project_key
CHUSKY_BASE_URL=https://api.chusky.ai
```

Never put `CHUSKY_API_KEY` in browser JavaScript, a mobile binary, a public
repository, or client-side environment variables.

```ts
import { Chusky } from "@chusky/sdk";

const chusky = new Chusky({
  apiKey: process.env.CHUSKY_API_KEY!,
  baseUrl: process.env.CHUSKY_BASE_URL,
  // Use your application's stable user or tenant identity. Do not use a
  // secret, email address, or the root operator identity here.
  userId: "customer_123",
});

const { thread, run } = await chusky.runs.create(
  { input: "Prepare a concise renewal brief.", wait: false },
  { idempotencyKey: "renewal-brief-customer-123-2026-09-21" },
);

const completed = await chusky.runs.wait(thread.id, run.id, {
  timeoutMs: 120_000,
});

console.log(completed.status);
console.log(completed.output ?? "The run did not produce text output.");
```

For a reliability operation, `chusky.tools.list({ source: "native" })` and
`chusky.tools.get(slug)` return the native JSON input schema. The SDK helper
starts one durable run restricted to the selected operation; it does not call
the native dispatcher outside the normal owner policy and approval path:

```ts
const { thread, run } = await chusky.tools.run({
  tool: "CHUCK_ARTIFACT_QA",
  arguments: { path: "artifacts/quarterly-report.pdf", type: "pdf" },
}, { idempotencyKey: "qa-quarterly-report-v1" });
const result = await chusky.runs.wait(thread.id, run.id);
```

The same helper supports `CHUCK_TOOL_PREFLIGHT`, `CHUCK_INTEGRATION_HEALTH`,
`CHUCK_FILE_BRIDGE`, `CHUCK_MEDIA_BRIDGE`, and `CHUCK_TOOL_RECOVERY`. For image
transfer, upload first and pass the returned owner-scoped file ID; only verified
JPEG, PNG, or WebP images are accepted. Both bridges keep their normal approval
gates, and approval decisions still belong to the human-facing workflow.

```ts
const image = await chusky.files.upload({ name: "launch.png", contentType: "image/png", data: imageBytes });
const { thread, run } = await chusky.tools.run({
  tool: "CHUCK_MEDIA_BRIDGE",
  arguments: { source: "current", toolSlug: "SOCIAL_POST", arguments: { caption: "Launch" } },
  attachments: [image.id],
});
```

`userId` is an application-owned identity boundary. Chusky uses it to isolate
threads, runs, memories, approvals, files, tasks, reminders, connected
accounts, and durable work. Use the same stable value whenever that user
returns.

## Examples

The [`examples/`](examples/) directory contains complete TypeScript examples
that can be adapted directly into a server application:

| Example | Shows |
| --- | --- |
| [`quickstart.ts`](examples/quickstart.ts) | Create a durable run and wait for completion |
| [`streaming.ts`](examples/streaming.ts) | Stream response deltas and handle approval events |
| [`company-agent.ts`](examples/company-agent.ts) | Use an agent template, policy, budget, and idempotency |
| [`mission.ts`](examples/mission.ts) | Run multi-step work with proof, evidence, and verification |
| [`approvals.ts`](examples/approvals.ts) | Present and decide a pending human approval |
| [`context-and-departments.ts`](examples/context-and-departments.ts) | Save shared context and create a typed department handoff |
| [`files.ts`](examples/files.ts) | Upload bytes through a short-lived storage intent |
| [`webhooks.ts`](examples/webhooks.ts) | Register a delivery endpoint and inspect deliveries |

Run an example from the SDK repository with `tsx`:

```bash
CHUSKY_API_KEY=chsk_... npx tsx examples/quickstart.ts
```

PowerShell:

```powershell
$env:CHUSKY_API_KEY = "chsk_..."
npx tsx examples/quickstart.ts
```

Examples make real API requests. Use a development project key and a test
identity when trying them.

## The execution model

```text
Your server
    ↓
@chusky/sdk
    ↓  authenticated /v1 API
Chusky runtime
    ↓
agent loop → native tools / Composio / durable workflows
    ↓
business result, artifact, webhook, or approval
```

There are three useful execution modes:

1. **Synchronous** — set `wait: true` when the result should return in the
   request lifecycle and the work is short.
2. **Durable** — set `wait: false` to receive a task-backed run immediately,
   then use `runs.get()`, `runs.wait()`, `runs.events()`, `tasks.get()`, or a
   webhook to observe it.
3. **Streaming** — use `threads.runs(threadId).stream()` for incremental text
   and approval events. Streaming is a delivery channel, not the source of
   truth; persisted run state remains available through `get()` and `events()`.

### Agent-to-agent tasks

The SDK also exposes the standards-shaped A2A boundary. Discover the remote
Agent Card, submit a durable task, stream or subscribe to updates, and attach
an encrypted callback for long-running work:

```ts
const card = await chusky.a2a.card();
const task = await chusky.a2a.send("Prepare a verified launch brief.", {
  idempotencyKey: "a2a-launch-brief-2026-09-22",
});

// For image tasks, upload with chusky.files.upload() first. A2A accepts only
// available owner-scoped Chusky file IDs, never inline bytes or arbitrary URLs.
const imageTask = await chusky.a2a.send({
  text: "Transfer this image to the connected social account.",
  attachments: [image.id],
}, { idempotencyKey: "image-transfer-2026-09-25" });

const callback = await chusky.a2a.createPushNotificationConfig(task.id, {
  url: "https://your-service.example/a2a/status",
  token: process.env.A2A_CALLBACK_TOKEN,
});

for await (const update of chusky.a2a.subscribe(task.id)) {
  console.log(update.statusUpdate?.status.state);
}
```

Push callback credentials are never returned after registration. The Chusky
runtime delivers signed `application/a2a+json` status updates through its
durable outbox and keeps task state available through `a2a.get()`.

## Idempotency and retries

Use an `idempotencyKey` for every durable POST that your server may retry after
an interruption. Reuse the same key only for the exact same operation and
request body.

```ts
const operationKey = `research:${customerId}:${requestId}`;

const firstAttempt = await chusky.runs.create(
  { input: "Research our renewal risk and draft next steps.", wait: false },
  { idempotencyKey: operationKey },
);

// A network retry with operationKey returns the same durable operation rather
// than creating a duplicate run.
```

Do not generate a new idempotency key for a retry unless you intentionally want
to start a new operation.

## Human approvals

Chusky keeps routine reads and reversible work autonomous while pausing
materially risky actions according to the project policy. A run can return
`requires_approval` and include an `approvalId`.

Your application should show the action, target, and relevant context to an
authenticated human, then call `approvals.decide()`. Never auto-approve from a
browser callback or from model output.

```ts
const approvals = await chusky.approvals.list();
const pending = approvals.data.find((item) => item.status === "pending");

if (pending) {
  // Render pending.request and the bounded action details in your own UI.
  const decision = await chusky.approvals.decide(
    pending.id,
    "approve",
    { idempotencyKey: `approval:${pending.id}:approve` },
  );
  console.log("Approval handled", decision);
}
```

The exact approval boundary is enforced server-side. The SDK is not a way to
bypass it.

## Agent templates and company workflows

Use a built-in specialist template or create a governed agent profile for a
company workflow. Policies, allowed tools, budgets, and approvals are applied
by Chusky before execution.

```ts
const templates = await chusky.agents.templates();
console.log(templates.data.map((template) => template.slug));

const agent = await chusky.agents.create({
  template: "lead-research",
  name: "Fintech lead scout",
  instructions: "Return sourced, deduplicated company profiles.",
  policy: {
    tools: {
      allow: ["crm.read", "web.search", "email.draft"],
      requireApproval: ["email.send", "crm.write"],
    },
    budget: { duration: "30m", maxToolCalls: 80, maxCost: 8 },
  },
});

const { thread, run } = await chusky.runs.create(
  {
    agentId: agent.id,
    input: "Find qualified fintech leads with more than 50 employees.",
    wait: false,
  },
  { idempotencyKey: "acme-fintech-leads-2026-09-21" },
);

console.log(`Run ${run.id} started in thread ${thread.id}`);
```

Composio owns OAuth, connected accounts, token refresh, and external tool
execution. Chusky owns the agent profile, policy, orchestration, approvals,
durability, and result delivery.

## Durable missions

Use missions when the work has multiple steps, dependencies, budgets, evidence,
waits, or a definition of done. The mission API supports pause, resume,
repair, cancellation, provider-event continuation, replanning, proof, and
verification.

```ts
const mission = await chusky.missions.create({
  title: "Qualified fintech leads",
  objective: "Find 20 fintech companies matching our ICP.",
  definitionOfDone: "Every lead has a source, qualification reason, and CRM-ready payload.",
  verificationMode: "strict",
  requiredEvidence: ["source URL", "qualification assertion", "deduplication check"],
  steps: [
    { id: "research", title: "Research companies", objective: "Collect source-backed facts." },
    { id: "qualify", title: "Qualify leads", objective: "Apply the ICP and remove duplicates.", dependsOn: ["research"] },
    { id: "prepare", title: "Prepare CRM payload", objective: "Create an approval-ready import.", dependsOn: ["qualify"] },
  ],
  maxDurationSeconds: 3 * 60 * 60,
  maxSteps: 30,
  maxToolCalls: 100,
  maxCost: 15,
}, { idempotencyKey: "acme-lead-mission-2026-09-21" });

const proof = await chusky.missions.proof(mission.id);
console.log(proof.status, proof.nextAction, proof.verification);
```

Treat `proof()` and `verify()` as the external completion record. Do not claim
that a mission completed because a model produced a plausible paragraph; use
the recorded steps, evidence, and verification state.

## Shared context, departments, and outcomes

The operating layer lets applications preserve useful, sensitivity-aware
context and hand work between specialized departments.

```ts
await chusky.context.save({
  scope: "customer",
  scopeId: "customer_123",
  kind: "preference",
  key: "renewal_window",
  value: "Customer prefers renewal discussions in October.",
  source: "crm",
  confidence: 0.9,
  sensitivity: "normal",
});

const salesContext = await chusky.context.list({
  scope: "customer",
  scopeId: "customer_123",
  purpose: "renewal",
});

const packet = await chusky.departments.handoff("customer-success", {
  objective: "Prepare a renewal risk review for the account team.",
  inputs: { customerId: "customer_123" },
  constraints: ["Use verified CRM facts only."],
  evidenceRequired: ["account health source", "open risk owner"],
  approvalBoundary: "Draft only; do not contact the customer.",
});

console.log(packet.id, packet.status, salesContext.data.length);
```

## Agent-to-agent (A2A)

The SDK includes a typed client for Chusky's standards-shaped A2A 1.0
boundary. It uses the same project API key and stable user identity as the
rest of the SDK, so delegated work stays owner-scoped and durable.

```ts
const card = await chusky.a2a.card();
console.log(card.protocolVersion, card.skills?.map((skill) => skill.id));

const task = await chusky.a2a.send("Prepare a verified launch brief.", {
  idempotencyKey: "launch-brief-2026-09-22",
});

const current = await chusky.a2a.get(task.id);
const page = await chusky.a2a.list(undefined, 20);
console.log(current.status.state, page.tasks.length);

if (current.status.state !== "TASK_STATE_COMPLETED") {
  await chusky.a2a.cancel(current.id);
}
```

Use `a2a.card()` for discovery, `a2a.send()` for a durable delegated task,
`a2a.get()` or `a2a.list()` for status, and `a2a.cancel()` for cancellation.
The SDK sends A2A JSON-RPC over the authenticated `/a2a/rpc` boundary and
does not expose private prompts, credentials, or unscoped tenant data. Image
references use Chusky's `data.chuskyFileIds` message-part extension and are
validated against the caller's available image files before the durable task
is queued.

## Files and artifacts

File uploads use a short-lived storage URL. The SDK also exposes artifact
metadata and verified downloads for files generated by Chusky.

```ts
const body = new TextEncoder().encode("customer_id,renewal_date\n123,2026-10-01\n");
const upload = await chusky.files.create({
  name: "renewals.csv",
  contentType: "text/csv",
  size: body.byteLength,
}, { idempotencyKey: "upload-renewals-2026-09-21" });

const response = await fetch(upload.uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": "text/csv" },
  body,
});
if (!response.ok) throw new Error(`Upload failed: ${response.status}`);

const file = await chusky.files.complete(upload.id);
console.log(file.id, file.status);
```

## Webhooks

Register a server endpoint for durable delivery notifications and make the
handler idempotent by recording the delivery ID before applying the event.

```ts
const webhook = await chusky.webhooks.create(
  "https://app.example.com/api/chusky/events",
  { idempotencyKey: "webhook-register-events-v1" },
);

const deliveries = await chusky.webhooks.deliveries(webhook.id);
console.log(deliveries.data.map((delivery) => delivery.status));
```

## Operator provisioning

`createChuskyAdmin()` is for a trusted operator service only. It uses the root
project key to provision scoped project keys and must never be shipped to an
end-user application.

```ts
import { createChuskyAdmin } from "@chusky/sdk";

const admin = createChuskyAdmin({
  apiKey: process.env.CHUSKY_PROJECT_KEY!,
  baseUrl: process.env.CHUSKY_BASE_URL,
});

const project = await admin.projects.create({
  name: "Acme production",
  scopes: ["runs:create", "runs:read", "missions:read", "missions:create"],
});

console.log(project.key); // Store once. It is not returned by list().
```

## Resource map

| Resource | Use it for |
| --- | --- |
| `threads`, `runs` | Conversations and durable agent execution |
| `agents`, `company` | Governed profiles and company telemetry |
| `tasks`, `approvals` | Recovery and human decisions |
| `missions` | Multi-step autonomous work with proof |
| `context`, `departments`, `outcomes` | Shared operating context and typed handoffs |
| `files`, `artifacts` | Input uploads and generated output downloads |
| `meetings`, `calls` | Meeting lifecycle and voice operations |
| `apps`, `channels`, `devices` | Connected account and delivery management |
| `reminders`, `jobs`, `memory`, `scratchpad` | Owner-scoped autonomous operations |
| `webhooks`, `audit`, `usage` | Delivery, traceability, and usage visibility |

## Security and production checklist

- Keep `CHUSKY_API_KEY` on a trusted server and scope it to one project.
- Use a stable, non-secret `userId` for every request.
- Use idempotency keys for retryable durable writes.
- Treat run output, tool results, emails, documents, and web pages as untrusted
  input—not authorization.
- Never auto-approve an external action from model output.
- Verify webhook signatures and deduplicate delivery IDs before processing.
- Use `AbortSignal` to cancel a request without cancelling unrelated durable
  work.
- Use `proof()` and `verify()` before treating a mission as complete.
- Set budgets for duration, tool calls, and cost on long-running work.
- Keep the SDK server-side; use the separate chat widget only with a server
  proxy that never exposes the project key.

## API and documentation

- [Developer API contract](docs/api-contract.md)
- [Full documentation](docs/index.mdx)
- [Autonomous missions](docs/missions.mdx)
- [OpenAPI specification](openapi.yaml)
- [Release guide](docs/releases.mdx)
- [Examples](examples/)

## License

MIT
