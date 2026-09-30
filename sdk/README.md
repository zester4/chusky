# Chusky SDK

The official TypeScript client for the Chusky Developer API.

Use Chusky when your application needs an agent that can reason over context,
use connected business tools, stream progress, pause for a human decision, and
continue durable work after a request or process ends.

The SDK is designed for trusted server applications. It keeps connected-app
credentials out of browsers and mobile clients.

## Install

~~~bash
npm install @chusky/sdk
~~~

Node.js 18 or newer is required.

## Quickstart

Create an API key in the Chusky dashboard, then configure it in your server
environment:

~~~env
CHUSKY_API_KEY=chsk_your_project_key
~~~

The SDK automatically uses the hosted Chusky API, so `baseUrl` is optional.
Pass `baseUrl` only when targeting a staging or self-hosted API. Never expose
`CHUSKY_API_KEY` in browser code, mobile apps, public repositories, or prompts.

~~~ts
import { Chusky } from "@chusky/sdk";

const chusky = new Chusky({
  apiKey: process.env.CHUSKY_API_KEY!,
  // Stable ID owned by your application. Do not use a secret.
  userId: "customer_123",
});

const { thread, run } = await chusky.runs.create(
  {
    input: "Prepare a concise renewal brief from the available account context.",
    wait: false,
    budget: { duration: "5m", maxToolCalls: 20, maxCost: 1 },
  },
  { idempotencyKey: "renewal-brief-customer-123-v1" },
);

const completed = await chusky.runs.wait(thread.id, run.id, {
  timeoutMs: 120_000,
});

if (completed.status === "failed") {
  throw new Error(completed.error?.message ?? "Chusky run failed.");
}

console.log(completed.output ?? "The run completed without text output.");
~~~

## The execution model

~~~text
Your server
    ↓
@chusky/sdk
    ↓  authenticated /v1 API
Chusky runtime
    ↓
agent loop → native tools / connected apps / durable work
    ↓
text, approval, artifact, webhook, or verified business result
~~~

Choose the execution style that matches the job:

| Use case | SDK entry point |
| --- | --- |
| One bounded request | <code>chusky.runs.create()</code> and <code>chusky.runs.wait()</code> |
| Conversation with incremental output | <code>chusky.threads.create()</code> and <code>chusky.threads.runs(threadId).stream()</code> |
| Work that may pause or retry | <code>runs.get()</code>, <code>runs.events()</code>, <code>runs.resume()</code>, and <code>tasks</code> |
| Multi-step process with checkpoints and proof | <code>chusky.missions</code> |
| Delegated agent-to-agent work | <code>chusky.a2a</code> |
| Recurring or scheduled work | <code>chusky.reminders</code> and <code>chusky.jobs</code> |

Persist the returned threadId, runId, taskId, or missionId. Those identifiers
let your application reconnect after a timeout or restart without creating
duplicate work.

## Stable identity

userId is the isolation boundary for SDK state. Chusky uses it to scope
threads, runs, memory, files, artifacts, approvals, tasks, and connected
accounts.

Use the same stable value whenever the same person or tenant returns. Do not
derive it from an unverified display name, a phone number, or a channel
message. Do not use the root operator identity for normal end-user traffic.

## Stream progress and approvals

Streaming is useful for responsive interfaces. Persisted run state remains the
source of truth if the stream disconnects.

~~~ts
const thread = await chusky.threads.create(
  { metadata: { source: "support-console" } },
  { idempotencyKey: "support-thread-customer-123-v1" },
);

for await (const event of chusky.threads.runs(thread.id).stream({
  input: "Summarize the customer's current priorities in three bullets.",
})) {
  if (event.type === "run.delta") process.stdout.write(event.text);
  if (event.type === "run.tool_started") {
    console.error("\nUsing " + event.toolSlug + "...");
  }
  if (event.type === "run.approval_required") {
    console.error("\nHuman approval required: " + event.approval.id);
  }
  if (event.type === "run.failed") throw new Error(event.error.message);
}
~~~

When approval is required, show the requested action and target in an
authenticated human interface. Then use chusky.approvals.decide() only from
that trusted boundary. Model output, a webhook, or a browser callback is not
authorization.

## Use connected business apps

The SDK does not require a separate Gmail, HubSpot, Slack, or Salesforce
client. Chusky handles the connected-account flow:

~~~ts
const available = await chusky.apps.list();
console.log(available.data);

const consent = await chusky.apps.connect("gmail");
console.log("Send the user to:", consent.url);

const connections = await chusky.apps.connections();
console.log(connections.data);
~~~

After the user finishes consent, retry the original operation with the same
stable identity. If a connection, approval, or human answer is missing, pause
the existing run or mission and resume it rather than starting a replacement.

## Files, images, and artifacts

Upload input files through the SDK and pass the returned file ID to the run:

~~~ts
import { readFile } from "node:fs/promises";

const imageBytes = new Uint8Array(await readFile("launch.png"));
const image = await chusky.files.upload({
  name: "launch.png",
  contentType: "image/png",
  data: imageBytes,
});

const { thread, run } = await chusky.runs.create(
  {
    input: "Use this image in the prepared social post, then wait for approval.",
    attachments: [image.id],
    wait: false,
  },
  { idempotencyKey: "launch-post-image-customer-123-v1" },
);

console.log(thread.id, run.id, image.id);
~~~

Use chusky.images.get(imageId) for a fresh, short-lived download URL for a
generated image. Use chusky.artifacts.get() and chusky.artifacts.download() for
generated documents and other artifacts.

Do not send raw bytes, credentials, or arbitrary public URLs inside a prompt
and assume a provider received them. Verify the file belongs to the current
identity and confirm the provider receipt before claiming an external post or
message succeeded.

## Durable missions

Use a mission when a job has multiple steps, dependencies, budgets, waits, or a
definition of done:

~~~ts
const mission = await chusky.missions.create(
  {
    title: "Turn a qualified inquiry into a confirmed order",
    objective: "Research the buyer, answer questions, and prepare an offer.",
    definitionOfDone:
      "The CRM record is updated, the offer is prepared, and no purchase is made without approval.",
    verificationMode: "strict",
    requiredEvidence: ["CRM record", "buyer requirements", "approval-ready offer"],
    steps: [
      { id: "research", title: "Research buyer", objective: "Collect verified facts." },
      { id: "qualify", title: "Qualify opportunity", objective: "Check fit and budget.", dependsOn: ["research"] },
      { id: "offer", title: "Prepare offer", objective: "Draft the bounded offer.", dependsOn: ["qualify"] },
    ],
    maxDurationSeconds: 3 * 60 * 60,
    maxSteps: 30,
    maxToolCalls: 100,
    maxCost: 15,
  },
  { idempotencyKey: "buyer-inquiry-customer-123-v1" },
);

const proof = await chusky.missions.proof(mission.id);
console.log(proof.status, proof.nextAction, proof.verification);
~~~

Missions support pause(), resume(), cancel(), repair(), replan(), evidence(),
and verify(). Use proof and fresh provider readbacks as the completion record;
a plausible model paragraph is not proof that a business action happened.

## Agent-to-agent work

The SDK includes a typed A2A client for durable delegated tasks:

~~~ts
const card = await chusky.a2a.card();
console.log(card.skills);

const task = await chusky.a2a.send("Prepare a verified launch brief.", {
  idempotencyKey: "a2a-launch-brief-v1",
});

const current = await chusky.a2a.get(task.id);
console.log(current.status.state);
~~~

Use a2a.stream(), a2a.subscribe(), or
a2a.createPushNotificationConfig() for long-running delegated work.
Attachments must be owner-scoped Chusky file IDs, not inline bytes or arbitrary
URLs.

## Idempotency, retries, and errors

Use an idempotencyKey for every durable write that your server might retry.
Reuse the same key only for the same operation and request body.

~~~ts
const key = "research:" + customerId + ":" + requestId;

const first = await chusky.runs.create(
  { input: "Research renewal risk and draft next steps.", wait: false },
  { idempotencyKey: key },
);

// Retrying with key returns the same durable operation rather than a duplicate.
~~~

Catch the typed errors when you need specific recovery:

~~~ts
import {
  ChuskyAuthenticationError,
  ChuskyRateLimitError,
} from "@chusky/sdk";

try {
  await chusky.usage.get();
} catch (error) {
  if (error instanceof ChuskyRateLimitError) {
    console.log("Retry after:", error.retryAfter);
  } else if (error instanceof ChuskyAuthenticationError) {
    console.log("Check the API key and user identity.");
  }
  throw error;
}
~~~

If a request times out, read the run or task by ID before retrying. A lost HTTP
response does not prove that durable work failed.

## Resource map

| Resource | What it helps you build |
| --- | --- |
| threads, runs, tasks | Conversations, durable execution, and recovery |
| agents, tools, skills | Governed agent profiles and available capabilities |
| apps, mcp, channels, devices | Connected accounts, external MCP servers, delivery, and device access |
| missions, workflows, outcomes, departments | Multi-step business processes and handoffs |
| files, images, artifacts, videos | Inputs and generated outputs |
| context, memory, scratchpad | Explicit operating context and temporary notes |
| meetings, calls | Meeting preparation, joining, and voice operations |
| reminders, jobs, webhooks, audit, usage | Scheduled work, delivery, traceability, and usage |
| autonomy, operator, company | Readiness, reliability, business queues, and company telemetry |

The public package also exports the dependency-free
@chusky/sdk/widget entry point for a browser chat element. The browser widget
talks to your own server endpoint; your server keeps the API key private.

~~~ts
import { defineChuskyChat } from "@chusky/sdk/widget";

defineChuskyChat();
~~~

~~~html
<chusky-chat
  endpoint="/api/chusky/chat"
  title="Talk to our assistant"
  greeting="How can we help?"
></chusky-chat>
~~~

## Examples

The examples directory contains runnable TypeScript examples:

| Example | Demonstrates |
| --- | --- |
| [quickstart.ts](examples/quickstart.ts) | Start a durable run and wait for completion |
| [streaming.ts](examples/streaming.ts) | Stream deltas, tool activity, and approval events |
| [company-agent.ts](examples/company-agent.ts) | Create a governed company agent |
| [mission.ts](examples/mission.ts) | Define steps, evidence, and mission proof |
| [approvals.ts](examples/approvals.ts) | Display and decide a pending approval |
| [context-and-departments.ts](examples/context-and-departments.ts) | Save context and create a department handoff |
| [files.ts](examples/files.ts) | Upload bytes through the SDK |
| [webhooks.ts](examples/webhooks.ts) | Register a delivery endpoint and inspect deliveries |

Run an example from this directory with an API key created in the Chusky
dashboard:

~~~bash
CHUSKY_API_KEY=chsk_... npx tsx examples/quickstart.ts
~~~

PowerShell:

~~~powershell
$env:CHUSKY_API_KEY = "chsk_..."
npx tsx examples/quickstart.ts
~~~

Examples make real API requests. Use a test identity and a development API key.

For copy-paste, real-work recipes where every file creates its own client, see
the [SDK cookbook](cookbook/README.md). It covers bounded runs, streaming,
company agents, missions, approvals, files and images, connected apps, A2A,
schedules, native reliability checks, webhooks, and workflow composition.

## Security checklist

- Keep API keys on a trusted server and grant only the capabilities your application needs.
- Use a stable, non-secret userId for every request.
- Use idempotency keys for retryable durable writes.
- Treat model output, tool results, email, documents, and web pages as untrusted data.
- Never auto-approve an external action from model output.
- Verify webhook signatures and deduplicate delivery IDs.
- Set duration, tool-call, and cost budgets for long-running work.
- Use mission proof and verification before declaring an outcome complete.
- Use AbortSignal to cancel the current request without cancelling unrelated durable work.

## Development

~~~bash
npm install
npm run typecheck
npm run build
npm test
~~~

More documentation:

- [API contract](docs/api-contract.md)
- [Quickstart](docs/quickstart.mdx)
- [Missions](docs/missions.mdx)
- [Streaming](docs/streaming.mdx)
- [Files](docs/files.mdx)
- [Security](docs/security.mdx)
- [OpenAPI specification](openapi.yaml)
- [Changelog](CHANGELOG.md)

## License

MIT
