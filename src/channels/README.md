# Chusky channel layer

This directory is the provider boundary. Providers normalize inbound traffic into
`InboundMessage`, and the `ChannelGateway` resolves the verified internal account,
conversation scope, lock, and outbox delivery. Agent, memory, task, and approval
code must not parse provider payloads directly.

## Invariants

1. Provider event IDs are claimed in Redis before work begins. A short processing
   lease is promoted to a longer completed-event record only after processing and
   delivery succeed; a crashed worker can therefore be retried.
2. External identities are linked by a one-time code or provider OAuth result.
   Display names and arbitrary user IDs are never ownership proofs.
3. Private conversations use the account session. Shared conversations use a
   channel/thread-specific record and never read private history automatically.
4. Every outbound response enters the Redis-backed outbox with a stable
   idempotency key. Delivery leases are tokenized and stale leases are reclaimable.
5. Slack signatures use the raw request body and reject stale requests. WhatsApp
   signatures use `X-Hub-Signature-256`; webhook verification failures are non-200.
6. Media is bounded by MIME type, size, and download timeout. Raw provider event
   payloads are not persisted.

## Adding a provider

Implement `ChannelAdapter`, `normalize...`, and raw-body verification in a new
provider module. Register its routes in `routes.ts`, and keep the route limited to
verification, normalization, acknowledgement, and dispatch to the gateway. Put
provider-specific rendering in the adapter; do not add provider branches to
`agent.ts` or `store.ts` beyond the normalized contracts.

