# Chusky TypeScript SDK

## Documentation

The complete Mintlify-style documentation is in [`docs/`](docs/index.mdx), including the quickstart, concepts, streaming, model selection, files, approvals, durable tasks, tools, skills, artifacts, video jobs, workers, channels, webhooks, security, errors, release operations, and production guidance. The Mintlify navigation configuration is [`docs.json`](docs.json).

This package is the public developer boundary for Chusky. It is intentionally separate from the Telegram bot, Redis store, Composio credentials, and internal `CHUCK_*` tool names. SDK applications use `CHUSKY_API_KEY`, containing their scoped `chsk_` API key. `CHUSKY_PROJECT_KEY` is used only by the self-hosted Chusky operator to provision those API keys; it is never an SDK application credential.

```ts
import { Chusky } from "@chusky/sdk";

const chusky = new Chusky({ apiKey: process.env.CHUSKY_API_KEY!, baseUrl: process.env.CHUSKY_BASE_URL, userId: "customer_123" });
const thread = await chusky.threads.create();

for await (const event of chusky.threads.runs(thread.id).stream(
  { input: "Prepare a concise renewal brief." },
  { idempotencyKey: crypto.randomUUID() },
)) {
  if (event.type === "run.delta") process.stdout.write(event.text);
  if (event.type === "run.approval_required") {
    // Present the exact approval to an authenticated human.
  }
}
```

## Operator-only API key provisioning

Run this only on a trusted backend or operator machine. Never expose the root
`CHUSKY_PROJECT_KEY` to a browser, developer, or end user.

```ts
import { createChuskyAdmin } from "@chusky/sdk";
const admin = createChuskyAdmin({ apiKey: process.env.CHUSKY_PROJECT_KEY!, baseUrl: process.env.CHUSKY_BASE_URL });
const project = await admin.projects.create({ name: "My App", scopes: ["*"] });
console.log(project.key); // save once; list() never returns it
```

## Dashboard self-service keys

A verified Chusky dashboard user can create up to 10 project keys from
**Developer API** in the dashboard. The raw `chsk_` secret appears only when a
key is created or rotated. Put that scoped value in the application's trusted
server environment:

```env
CHUSKY_API_KEY=chsk_...
```

The dashboard never exposes `CHUSKY_PROJECT_KEY`; that Oracle-only root secret
remains solely for trusted operator `/v1/admin/*` provisioning.

## Contract and security

- The SDK targets the versioned `/v1` Developer API described in [`docs/api-contract.md`](docs/api-contract.md). Do not point it at private `/cli/*` endpoints or use CLI device tokens as developer API keys.
- SDK applications authenticate with `CHUSKY_API_KEY` and send it only from a trusted server. `CHUSKY_PROJECT_KEY` is root-only operator infrastructure for provisioning or rotating scoped `chsk_` API keys; it must never be shipped in an SDK application or browser bundle. Project secrets are returned once, persisted only as hashes, may be rotated or revoked, and must never be exposed in browser code.
- Durable POST operations should receive an `idempotencyKey`; retries only reuse a key for the exact same operation. Streaming run connections are intentionally not replayed: recover their persisted state through `get()` or `events()`.
- Approval decisions always require an authenticated end-user context in the server. The SDK must never auto-approve a tool call.
- `stream()` yields NDJSON events and supports `AbortSignal`, so consumers can stop a particular run without cancelling unrelated durable work.
- The machine-readable API contract is [`openapi.yaml`](openapi.yaml).

## Available resources

The current resources are `projects`, `threads`, `runs`, `tasks`, `approvals`, `files`, `tools`, `skills`, `artifacts`, `videos`, `workers`, `channels`, `activity`, `webhooks`, `audit`, and `usage`. Files use short-lived, direct Cloudflare R2 URLs: create an upload intent, upload with the returned URL, call `files.complete()`, then request a download URL. `files.upload()` is a convenience helper for this sequence. Artifact downloads return verified bytes from the Daytona workspace through the API.

See [`docs/architecture.mdx`](docs/architecture.mdx) for the request, durability, capability, storage, and delivery boundaries that implement these resources.

Runs can be short and synchronous or durable and asynchronous. Pass `wait: false` to `runs.create()` to receive a task-backed run immediately; inspect it with `tasks.get()`, retry or cancel it, and resume a failed or approval-paused run with `runs.resume()`. Use `budget.duration` (`5m`, `30m`, `1h`, `3h`, `6h`, `3d`, or `1w`) together with `budget.maxToolCalls` and `budget.maxCost` to bound work. Tool and skill allowlists are enforced server-side before the agent receives its catalog.

Webhook deliveries are queryable and can be retried through the SDK. Keep the endpoint idempotent and treat delivery IDs as deduplication keys.
