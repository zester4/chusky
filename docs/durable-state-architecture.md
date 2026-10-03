# Durable state architecture

Chusky uses three stores with deliberately different responsibilities:

| Store | Canonical data | Not used for |
| --- | --- | --- |
| Neon Postgres | Durable source of truth for user-owned structured state: session domains, SDK threads/runs/events, reminders, recurring jobs, task definitions/results, missions/steps/evidence/events, and object metadata | File bytes, active leases, locks, or short-lived delivery coordination |
| Redis | Transient coordination: active task leases, cancellation signals, locks, rate limits, short-lived deduplication/queue markers, and an optional bounded recent-history cache | Canonical user-owned records or unbounded histories/audit payloads |
| Cloudflare R2 | Private files, images, videos, transcripts, screenshots, and large tool/provider/model payloads (target: encrypted at rest and in transit) | Queryable application state or authorization decisions |

Neon is the durable authority even while a domain is being migrated. Legacy
Redis records are migration inputs/fallbacks only; they are not a second
long-term source of truth. A cutover must preserve owner-scoped reads and
transactional state changes, and must not delete the Redis copy until bounded
backfill, read/write parity, restart recovery, and rollback evidence are all
recorded. Redis may cache recent data only when measurements show a latency
benefit; cache entries must be bounded and safely rebuildable from Neon.

Large R2 objects must be private and use the configured encryption controls.
Neon stores their owner, object key, content hash, size, content type,
retention/expiry policy, and access metadata. The application must authorize
against Neon metadata before issuing a scoped R2 operation; a guessed R2 key is
never an authorization check. Structured memory facts remain in Neon, while
embeddings and semantic-search indexes live in the explicitly configured
vector store and can be rebuilt from authorized facts.

The existing Cloudflare D1 vault remains scoped to the vault Worker. It is not
a second application database for the Railway/Node service; Neon remains the
application's relational source of truth.

## Initial Neon migration

`DURABLE_STATE_ENABLED=true` activates four canonical Neon documents per owner:

- `conversation`: history and summaries
- `memories`: normalized owner memory facts
- `assets`: R2 metadata, SDK file metadata, and artifact metadata; never bytes
- `sdk`: SDK thread metadata, idempotency/audit/webhook indexes. With
  `DURABLE_STATE_SDK_RUNS_ENABLED=true`, run payloads are written to the
  owner-scoped `chusky_sdk_run` table in the same Neon transaction and are
  hydrated for API, CLI, and worker operations. The default-off flag preserves
  the existing embedded-run behavior until the run-table migration is applied.

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

Migrations `0002_neon_sdk_runs.sql` and
`0003_neon_sdk_run_cli_thread_ids.sql` prepare individually addressable SDK
run rows and preserve existing CLI thread IDs. Apply them before enabling
`DURABLE_STATE_SDK_RUNS_ENABLED=true`; startup checks the table exists and
fails closed if the schema is absent. On each
session save after cutover, embedded legacy runs are imported transactionally
while thread metadata is saved with empty run arrays. SDK API, CLI, quota, and
durable task-worker paths hydrate runs from the per-run repository. Existing
`cli_thread_` identifiers remain supported. The flag remains off by default;
production enablement and real-user parity are not verified by local tests.
Mission records/evidence/event history remain a separate future migration
because they require their own cross-store idempotency and recovery semantics.
The same source-of-truth rule applies to reminders, recurring jobs, task
definitions/results, and provider-event receipts: move their durable records to
Neon, retaining only live coordination tokens and bounded delivery markers in
Redis.
