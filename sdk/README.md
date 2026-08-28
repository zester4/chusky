# Chusky TypeScript SDK

This package is the public developer boundary for Chusky. It is intentionally separate from the Telegram bot, Redis store, Composio credentials, and internal `CHUCK_*` tool names. On a self-hosted instance, set one server secret: `CHUSKY_API_KEY`.

```ts
import { Chusky } from "@chusky/sdk";

const chusky = new Chusky({ apiKey: process.env.CHUSKY_API_KEY!, userId: "customer_123" });
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

## Contract and security

- The SDK targets the versioned `/v1` Developer API described in [`docs/api-contract.md`](docs/api-contract.md). Do not point it at private `/cli/*` endpoints or use CLI device tokens as developer API keys.
- API keys belong to a developer project, are scoped, prefix-identifiable, revocable, and stored only as hashes. They must never be exposed in browser code.
- POST operations should receive an `idempotencyKey`; retries only reuse a key for the exact same operation.
- Approval decisions always require an authenticated end-user context in the server. The SDK must never auto-approve a tool call.
- `stream()` yields NDJSON events and supports `AbortSignal`, so consumers can stop a particular run without cancelling unrelated durable work.

## Planned server parity

The initial public API comprises `threads`, `runs`, `tasks`, and `approvals`. Webhooks, files, channel installations, server-side tools, and usage/billing will be introduced only after their authorization and delivery contracts are specified.
