# Durable state architecture

Chusky uses three stores with deliberately different responsibilities:

| Store | Canonical data | Not used for |
| --- | --- | --- |
| Neon Postgres | Durable structured user state: conversation context, memories, asset metadata, SDK thread state; later mission definitions, evidence, and audit history | File bytes, locks, leases, or short-lived delivery coordination |
| Redis | Task leases, cancellation signals, locks, rate limits, QStash/delivery deduplication, and cache-like operational records | Long-lived conversation blobs or large audit payloads |
| Cloudflare R2 | Private files, images, videos, transcripts, screenshots, and large provider/model payloads | Queryable application state or authorization decisions |

The existing Cloudflare D1 vault remains scoped to the vault Worker. It is not a second application database for the Railway/Node service.

## Initial Neon migration

`DURABLE_STATE_ENABLED=true` activates four canonical Neon documents per owner:

- `conversation`: history and summaries
- `memories`: normalized owner memory facts
- `assets`: R2 metadata, SDK file metadata, and artifact metadata; never bytes
- `sdk`: SDK thread metadata, runs, and indexes

The Redis session record retains small operational/profile fields and a
`durableSessionFormat` marker. On every first save after enablement, Chusky
writes all four Neon documents in one Postgres transaction and only then
writes the Redis marker. Until that marker exists, legacy Redis records remain
the source of truth. If Neon cannot be written, the legacy record is left
unchanged. If a marked record cannot be read from Neon, Chusky fails the read
instead of silently serving an empty or stale session.

This is an online, lazy migration; no production backfill is required to turn
it on. It does not move active task coordination, and it does not move data to
R2 retroactively.

## Rollout

1. Set `DURABLE_STATE_MIGRATION_DATABASE_URL` to Neon's direct (non-pooler)
   URL and run `npm run durable-state:migrate` once. When Chusky shares the
   Better Auth Neon database, the script safely falls back to
   `BETTER_AUTH_MIGRATION_DATABASE_URL`.
2. Verify `chusky_session_domain` exists and that the application role can
   read and write it.
3. Set `DURABLE_STATE_DATABASE_URL` to the Neon pooled runtime URL and deploy
   with `DURABLE_STATE_ENABLED=false` first.
4. Enable `DURABLE_STATE_ENABLED=true` for one non-critical owner. Confirm
   the four rows appear after a normal session save and Redis retains only the
   small core document.
5. Observe Postgres errors, Redis command/byte metrics, and session-read
   failures before enabling more owners. Roll back by disabling the flag only
   before a user has migrated; a migrated user must keep the Neon URL present
   until a deliberate reverse migration is implemented.

The next migration should make SDK runs individually addressable rows, then
move mission records/evidence/event history to normalized Neon tables. Those
are intentionally separate changes because they require cross-store
idempotency and recovery semantics beyond a session-document migration.
