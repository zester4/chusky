# Durable storage rollout status

Updated: 2026-10-04

## Decision

- Neon/Postgres is the durable source of truth for every user-owned structured
  record, including sessions, SDK runs/events, reminders, recurring jobs,
  task definitions/results, and missions/steps/evidence/events.
- Redis is a cache and coordination layer only: active leases, cancellation
  markers, locks, rate limits, short-lived queues/deduplication, and an optional
  bounded recent-history cache justified by latency metrics.
- Cloudflare R2 owns private encrypted large objects. Neon retains owner,
  object key, content hash, size/type, retention, and access-control metadata;
  authorization is checked against Neon before R2 access.
- Structured memory facts live in Neon. Embeddings/search vectors live in the
  configured vector store and are rebuildable from authorized facts.
- Legacy Redis data is migration input, not a second durable authority. Do not
  retire it until production parity, restart recovery, and rollback evidence
  are recorded; Redis must not remain the permanent source for user records.

## Acceptance status

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Recoverable bounded session hybrid | Migrations 0004 and 0006 add owner-scoped append-only conversation messages and the curated profile domain. Redis keeps 20 recent messages plus a five-minute, 512 KiB-capped version-aware domain cache. Neon domain and SDK run writes use optimistic versions; unchanged domains/runs are skipped. | Local Neon+Redis smoke recovered all five domains and one synthetic SDK run after cache-key deletion and cleaned up its test data. Railway production `/health` currently reports durable state enabled and reachable. This is health evidence, not a deployed write/read parity test. The base session switch is enabled; call-turn text appended to the normal owner conversation therefore uses this same durable conversation store. The voice bridge/audio service is separate and was not redeployed. |
| Backfill and retire legacy Redis session domains | `npm run durable-state:backfill` defaults to aggregate dry-run counts. Apply is opt-in and bounded (`--apply --max-sessions=N`, 1-100). It acquires the same owner-scoped renewable Redis lease as durable session writers before reading a snapshot, writes all five domains in one Neon transaction, appends history idempotently, then atomically promotes the exact Redis snapshot while preserving its remaining TTL. A busy/lost lease fails closed; divergent pre-existing Neon state is not overwritten. | Local tests cover lease serialization/loss, promotion, interrupted-history repair, concurrent Redis change, divergent/partial Neon state, owner-zero rejection, and already-migrated sessions. This protects online batches when every serving instance uses the coordinated build; it does not establish production parity, verify all users, or retire Redis. Inactive sessions remain Redis-only until backfilled and can still expire under the existing TTL; preserve Redis and run only explicitly bounded batches with post-migration parity checks. |
| Store SDK runs as per-run Neon rows | With `DURABLE_STATE_SDK_RUNS_ENABLED=true`, API, CLI, quota, and task-worker paths hydrate runs from owner/thread-scoped rows. Session writes transactionally import embedded legacy runs and store only thread metadata in the `sdk` domain. Migrations 0002, 0003, and 0005 are applied to the configured Neon database. The live smoke confirmed one run row, zero embedded run entries, cache-expiry recovery, and cleanup without logging payloads. | Local code against configured live Neon/Redis passed; deployed-service canary and real-user parity are not verified. The flag remains default-off. |
| Store missions, steps, evidence, and event history in Neon | Migrations 0009-0010 define owner-scoped mission/event rows and per-owner cutover markers. The local runtime can route marked owners through version-CAS mission writes and transactional event inserts; unmarked owners stay on Redis. `npm run durable-missions:backfill` defaults to count-only read mode and only applies after `--apply --confirm-quiesced`; it verifies complete mission/event read-backs before writing the marker. | Focused backfill/repository tests and the full local suite pass. No production backfill or deployed verification was run. All writers and workers must be stopped before apply; Redis copies are preserved. Keep the mission flag enabled after cutover because disabling it after Neon writes would expose stale Redis data. Reminders, recurring jobs, and task definitions/results still need durable Neon ownership. |
| Measure Redis commands, bytes, key sizes, cache hit ratio, and Neon query latency | Added process-local Redis command instrumentation by bounded key family and a root-only `GET /v1/admin/storage/metrics` endpoint. With `DURABLE_STORAGE_METRICS_ENABLED=true`, aggregate family samples are transactionally persisted to Neon migration 0011 every 60 seconds and combined with live process counters by the endpoint. Shutdown and store reinitialization attempt a final flush. | The exporter is implemented but opt-in; production enablement and multi-replica observation are not verified. A hard process crash can lose up to one flush interval of in-memory samples. Byte and maximum-value figures are payload estimates (not RESP wire bytes or Redis `MEMORY USAGE`), and unclassified key families appear as `other`; compare estimates with provider billing and Redis-native measurements before using them for capacity decisions. |
| Archive large transcripts, tool outputs, files, images, and videos to R2 | Migration 0008 and owner-scoped Neon metadata back an opt-in SDK upload path. Migration 0012 adds the owner/meeting lookup index for explicitly retained Recall transcripts. Retained transcript segments archive existing encrypted bytes to immutable owner-scoped R2 objects, verify checksum/read-back before marking metadata available, and merge with the bounded Redis cache on read. See the [R2 audit](r2-storage-audit.md). Agent run/tool traces and several image/attachment flows are not fully catalogued or archived. | Focused archive/store tests and typecheck pass. Migration 0012 was applied to the configured local migration database and verified through the runtime URL. A synthetic live canary against the configured R2/Neon/Redis services passed and cleaned up its generated object and row; this does not verify the deployed service or real-user archival. The archive flag remains off. Automated retry/retention, complete inventory/backfill, and production feature verification remain outstanding. |
| Add retention and safe archival jobs | `npm run r2:retention` is a bounded operator-run cleanup primitive over explicitly expired Neon object-catalog rows. Dry-run is default; apply requires two explicit flags, rechecks expiry in the Neon tombstone update, and deletes only the cataloged owner-scoped R2 key. `npm run r2:live-smoke` is a separate synthetic-only canary requiring two confirmation flags and both durable-storage feature flags; it verifies R2 HEAD and bounded checksum read-back, Neon owner denial and expiry metadata, then tombstones and removes only its generated object. | Unit tests cover successful canary cleanup, checksum-failure cleanup, and refusal to touch mismatched metadata. The synthetic live canary passed and confirmed cleanup. No automated retention schedule, production inventory, or retry monitoring exists. |
| Full CI and production verification | Hosted CI run 37177213563 passed on `main` SHA `5208c7df2cd42cdc4db8726d78eed736e964ba5d`: typecheck, 1,375 tests (1,371 pass, 0 fail, 4 skipped), app build, SDK build, 25 SDK tests, and `git diff --check`. | Railway production reports `chusky` and the separate `chusky-voice` service online with one running replica each and no recent failures. The deployed base durable-state health check is enabled/reachable. No production synthetic read/write canary or populated-data parity verification was run; retention has not been applied to live catalog objects. |

## Operational safeguards

- The live smoke uses an isolated synthetic high-range owner ID and removes only
  its own Neon rows and Redis session/domain-cache keys. It prints domain names/counts, never
  payloads, connection strings, or owner IDs.
- Session-domain backfill now supports bounded opt-in apply using an
  owner-scoped renewable Redis lease, Neon transaction, and exact-value Redis
  CAS; all app instances must run the coordinated build before apply. Only
  explicitly selected batches should be run.
  Mission backfill is
  operator-gated and requires stopping every Chusky API, worker, and webhook
  process; its Redis key lock serializes migration processes but cannot stop
  application writers. It logs aggregate counts only, preserves Redis copies,
  and marks an owner only after count/digest and row/event read-back checks.
- Production currently has `DURABLE_STATE_ENABLED=true`; do not turn it off
  after any Neon writes without a compatible rollback/reconciliation plan.
  Keep the independent SDK-run, mission, metrics, object-catalog, and transcript
  archive switches off until their own schema, parity, and recovery gates pass.
  A table's existence or a health probe alone does not establish data parity.
- Railway's connected view withholds variable values. On 2026-10-04, the live
  `/health` endpoint reported `durableState.enabled=true` and
  `durableState.reachable=true`; the production Chusky deployment was healthy.
  `DURABLE_STATE_ENABLED=true` was explicitly written to the Chusky production
  service with redeploys skipped, so the running deployment was not restarted.
  Do not infer user-data parity or a verified write from this health response.
- The Twilio voice bridge/audio service is a separate Railway service and was
  not changed or redeployed. Voice-call text saved through the normal private
  conversation history shares the base session durability path; this changes
  its persistence destination, not the bridge/audio path. The optional Recall
  transcript archive remains off, and meeting transcript retention behavior is
  unchanged.

## 2026-10-04 local live verification

Using the configured local `.env` without printing connection values:

- `npm run durable-state:migrate` completed against the configured direct
  migration URL. A read-only Neon catalog query before migration found the
  session, conversation, SDK-run, and memory tables, but not object-catalog or
  mission tables. A subsequent application startup with mission/catalog
  assertions enabled succeeded, proving the runtime URL sees the newly applied
  `0008`-`0010` schemas. On 2026-10-04, migration `0011` was then applied
  through the configured migration URL (`1` applied, `10` already applied).
  It adds only the aggregate Redis-metric sample table and index; it does not
  enable metric collection or insert telemetry rows. A read-only
  `assertStorageMetricsSchema()` query against the separately configured
  runtime Neon URL then succeeded. Metric collection remains disabled.
- `npm run durable-state:live-smoke` passed against configured Neon and Redis:
  all five session domains round-tripped, one SDK run was stored separately,
  embedded SDK run arrays were empty, a no-op repeat save left versions
  unchanged, and deleting only the generated test owner's Redis session/cache
  keys caused Neon recovery to succeed. Synthetic Neon rows and Redis keys were
  then confirmed cleaned up. No payloads or owner identifiers were printed.
- `npm run durable-missions:backfill` in default read-only mode reported zero
  mission owners/records/events in the configured Redis scope and zero writes.
  No mission owner was migrated.
- `npm run r2:retention` in default dry-run mode scanned zero expired catalog
  objects and deleted none. No R2 object was read or changed.

- The migration runner now serializes concurrent invocations with a PostgreSQL
  session advisory lock, records each numbered SQL file's SHA-256 after it
  succeeds, skips unchanged applied files, and refuses checksum drift or a
  missing applied file. Tests cover ordering, repeat runs, drift, failure, and
  missing-file protection.

This is local-process verification against the configured Neon/Redis URLs, not
proof of real-user data parity. Railway production separately reports durable
state enabled/reachable, but that health signal is not a deployed read/write
canary.
The synthetic R2 canary ran successfully against the configured local
R2/Neon/Redis services and cleaned up its generated object and metadata row.
This does not prove that the deployed service uses the same configuration or
that real-user archival works. The zero-record mission/retention dry runs do
not prove those paths against populated production data. Hosted CI run
37177213563 passed on the merged `main` SHA recorded above.

## Next implementation slices

1. Open/update a pull request for the current feature tip to run the exact CI
   command sequence on a recursive-submodule checkout in Ubuntu/Node 22 (CI
   also installs FFmpeg).
2. Verify the deployed Chusky service's Neon health and observe actual user
   session-domain writes by aggregate domain/count/timestamp only.
3. Keep the session backfill in dry-run until stable reads/writes are observed;
   then run small `--apply --max-sessions=N` batches with post-migration parity
   checks and rollback evidence before removing legacy payloads. The script
   preserves Redis copies and does not delete data.
4. Complete the ordered durable-record cutover: observe stable session-domain
   writes; canary per-run SDK persistence and verify list/get/events/cancel/
   resume parity across SDK, CLI, and workers; then migrate mission owners only
   during an explicitly quiesced window using the verified backfill. Preserve
   Redis copies and keep the flag on after first Neon write; rollback must use
   compatible Neon-aware code or verified reverse reconciliation. Reminders,
   recurring jobs, and task definitions/results still need Neon ownership.
   Keep each domain opt-in until schema, backfill, parity, restart, and rollback
   checks pass.
5. Run `npm run r2:live-smoke -- --apply --confirm-synthetic-r2-canary` only
   with explicit durable Neon, object-catalog, Redis, and R2 configuration;
   then follow [the R2 storage audit](r2-storage-audit.md): complete inventory and
   backfill for existing images/files, wire every attachment flow into the
   Neon catalog, then add encrypted R2 archival for retained transcript
   segments and eligible large run/tool payloads. Turn the guarded manual
   retention primitive into a monitored scheduled job only after dry-run
   inventory and deletion retry/restart checks. Never log or fetch full
   payloads for routine verification.
6. Apply migration 0011 and opt in to the durable aggregate exporter only after
   the database and rollback plan are confirmed. Observe the root-only metrics
   endpoint across multiple replicas, validate estimates against provider
   billing and Redis-native measurements, then decide whether a small
   recent-history cache is worthwhile; cache entries are never canonical data.
