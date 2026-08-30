# Chusky TypeScript SDK

This package is the public developer boundary for Chusky. It is intentionally separate from the Telegram bot, Redis store, Composio credentials, and internal `CHUCK_*` tool names. Developers place their scoped `chsk_` project key in `CHUSKY_API_KEY`. On the self-hosted Oracle server only, `CHUSKY_PROJECT_KEY` is the private root/bootstrap credential used to provision those project keys.

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

## Provisioning a project key

Run this only on a trusted backend or operator machine. Never expose the root
`CHUSKY_PROJECT_KEY` to a browser, developer, or end user.

```ts
import { createChuskyAdmin } from "@chusky/sdk";
const admin = createChuskyAdmin({ apiKey: process.env.CHUSKY_PROJECT_KEY!, baseUrl: process.env.CHUSKY_BASE_URL });
const project = await admin.projects.create({ name: "My App", scopes: ["*"] });
console.log(project.key); // save once; list() never returns it
```

## Contract and security

- The SDK targets the versioned `/v1` Developer API described in [`docs/api-contract.md`](docs/api-contract.md). Do not point it at private `/cli/*` endpoints or use CLI device tokens as developer API keys.
- `CHUSKY_PROJECT_KEY` is root-only: use it with `chusky.projects.create()` to provision a scoped `chsk_` project key. A developer stores that scoped key as `CHUSKY_API_KEY` in their own server environment. Project secrets are returned once, persisted only as hashes, may be rotated or revoked, and must never be exposed in browser code.
- Durable POST operations should receive an `idempotencyKey`; retries only reuse a key for the exact same operation. Streaming run connections are intentionally not replayed: recover their persisted state through `get()` or `events()`.
- Approval decisions always require an authenticated end-user context in the server. The SDK must never auto-approve a tool call.
- `stream()` yields NDJSON events and supports `AbortSignal`, so consumers can stop a particular run without cancelling unrelated durable work.
- The machine-readable API contract is [`openapi.yaml`](openapi.yaml).

## Available resources

`projects`, `threads`, `runs`, `tasks`, `approvals`, `files`, `webhooks`, `audit`, and `usage` are available today. Files use short-lived, direct Cloudflare R2 URLs: create an upload intent, upload with the returned URL, call `files.complete()`, then request a download URL. Webhook subscriptions are stored encrypted and return their signing secret exactly once; delivery retries and dead-letter administration remain a server-operations concern.
