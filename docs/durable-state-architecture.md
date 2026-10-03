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

Numbered SQL files are applied in order by `npm run durable-state:migrate`.
The runner holds a PostgreSQL session advisory lock while it checks/applies
files, stores each applied file's SHA-256 in
`chusky_durable_state_migration`, skips matching files on later runs, and
fails closed if an applied file was removed or edited. Add a new numbered
migration instead of rewriting applied SQL. If a process exits after the SQL
commits but before its checksum is recorded, rerunning is safe because the SQL
migrations are idempotent; the runner serializes that retry with the same lock.

`DURABLE_STATE_ENABLED=true` activates five canonical Neon domains per owner:

- `profile`: selected preferences and small session metadata; encrypted provider
  credentials and active coordination are deliberately excluded
- `conversation`: summaries plus append-only `chusky_conversation_message` rows.
  Redis stores only the latest 20 messages for normal turns. Older history is
  retrieved from Neon with an owner-scoped cursor and a bounded page size.
- `memories`: normalized owner memory facts
- `assets`: R2 metadata, SDK file metadata, and artifact metadata; never bytes
- `sdk`: SDK thread metadata, idempotency/audit/webhook indexes. With
  `DURABLE_STATE_SDK_RUNS_ENABLED=true`, run payloads are written to the
  owner-scoped `chusky_sdk_run` table in the same Neon transaction and are
  hydrated for API, CLI, and worker operations. The default-off flag preserves
  the existing embedded-run behavior until the run-table migration is applied.

The Redis session core keeps its compatibility fields and at most 20 recent
messages. Domain documents are held in a size-capped (512 KiB), five-minute
Redis cache. A cache miss reconstructs the durable domains from Neon; it never
returns a fresh blank session when Neon records exist. Domain saves carry
optimistic versions and write only changed documents. Separately stored SDK
runs use row versions and content hashes so unchanged runs are not rewritten.
Conversation messages are inserted idempotently by stable owner-scoped message IDs. Legacy embedded
conversation history is accepted and backfilled lazily, then compacted out of
the conversation document on the next save. If Neon cannot be read or a
version conflicts, Chusky fails the operation instead of overwriting newer
state.

`durableStorageMetrics()` exposes process-local aggregate counts, latencies,
conversation/domain byte estimates, domain sizes, and Redis domain-cache hit ratio without owner
IDs or payloads. These metrics are instrumentation, not yet a multi-instance
metrics backend or production dashboard. The rest of the broad session core
still has Redis-resident fields and needs an explicit domain-by-domain cutover;
this release does not claim the entire Redis session has migrated.

This is an online, lazy migration; no production backfill is required to turn
it on. It does not move active task coordination, and it does not move data to
R2 retroactively.

## Rollout

1. Set `DURABLE_STATE_MIGRATION_DATABASE_URL` to Neon's direct (non-pooler)
   URL and run `npm run durable-state:migrate` once. When Chusky shares the
   Better Auth Neon database, the script safely falls back to
   `BETTER_AUTH_MIGRATION_DATABASE_URL`.
2. Apply migrations through `0006_neon_session_profile_domain.sql`; verify
   `chusky_session_domain`, `chusky_conversation_message`, and the SDK run
   version column exist and the application role can read/write them.
3. Set `DURABLE_STATE_DATABASE_URL` to the Neon pooled runtime URL and deploy
   with `DURABLE_STATE_ENABLED=false` first.
4. Enable `DURABLE_STATE_ENABLED=true` for one non-critical owner. Confirm
   the five domain rows and message rows appear after a normal save; verify
   Redis stores no more than 20 conversation messages and the domain cache is
   under its cap/TTL.
5. Observe Postgres errors, the exported process-local Redis command/byte and
   cache-hit metrics, Neon query latency, domain sizes, and session-read
   failures before enabling more owners. Roll back by disabling the flag only
   before a user has migrated; a migrated user must keep the Neon URL present
   until a deliberate reverse migration is implemented.

Migrations `0002_neon_sdk_runs.sql`,
`0003_neon_sdk_run_cli_thread_ids.sql`, and `0005_neon_sdk_run_versions.sql`
prepare individually addressable, compare-and-swap SDK
run rows and preserve existing CLI thread IDs. Apply them before enabling
`DURABLE_STATE_SDK_RUNS_ENABLED=true`; startup checks the table exists and
fails closed if the schema is absent. On each
session save after cutover, embedded legacy runs are imported transactionally
while thread metadata is saved with empty run arrays. SDK API, CLI, quota, and
durable task-worker paths hydrate runs from the per-run repository. Existing
`cli_thread_` identifiers remain supported. The flag remains off by default;
production enablement and real-user parity are not verified by local tests.
Migrations `0004_neon_conversation_messages.sql` and
`0006_neon_session_profile_domain.sql` add durable message rows and the safe
profile domain. Mission records/evidence/event history remain a separate
future migration because they require their own cross-store idempotency and
recovery semantics.
The same source-of-truth rule applies to reminders, recurring jobs, task
definitions/results, and provider-event receipts: move their durable records to
Neon, retaining only live coordination tokens and bounded delivery markers in
Redis.
