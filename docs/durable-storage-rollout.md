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
| Recoverable bounded session hybrid | Migrations 0004 and 0006 add owner-scoped append-only conversation messages and the curated profile domain. Redis keeps 20 recent messages plus a five-minute, 512 KiB-capped version-aware domain cache. Neon domain and SDK run writes use optimistic versions; unchanged domains/runs are skipped. | Local full test/typecheck/build checks passed. Live configured Neon+Redis smoke wrote/read all five domains and one per-run SDK row, deleted both cache keys and recovered history/profile/run from Neon, then cleaned its synthetic rows/keys. Metrics export and deployed real-user parity remain pending; keep cutover flags off. |
| Backfill and retire legacy Redis session domains | Lazy migration occurs on session writes. `npm run durable-state:backfill` scans and reports aggregate dry-run counts only. Bulk apply is deliberately disabled: Neon write followed by Redis CAS is not atomic across stores and can race with a live session write. | Dry-run tooling only; safe bulk backfill protocol and production retirement pending. |
| Store SDK runs as per-run Neon rows | With `DURABLE_STATE_SDK_RUNS_ENABLED=true`, API, CLI, quota, and task-worker paths hydrate runs from owner/thread-scoped rows. Session writes transactionally import embedded legacy runs and store only thread metadata in the `sdk` domain. Migrations 0002, 0003, and 0005 are applied to the configured Neon database. The live smoke confirmed one run row, zero embedded run entries, cache-expiry recovery, and cleanup without logging payloads. | Local code against configured live Neon/Redis passed; deployed-service canary and real-user parity are not verified. The flag remains default-off. |
| Store missions, steps, evidence, and event history in Neon | Migrations 0009-0010 define owner-scoped mission/event rows and per-owner cutover markers. The local runtime can route marked owners through version-CAS mission writes and transactional event inserts; unmarked owners stay on Redis. `npm run durable-missions:backfill` defaults to count-only read mode and only applies after `--apply --confirm-quiesced`; it verifies complete mission/event read-backs before writing the marker. | Focused backfill/repository tests and the full local suite pass. No production backfill or deployed verification was run. All writers and workers must be stopped before apply; Redis copies are preserved. Keep the mission flag enabled after cutover because disabling it after Neon writes would expose stale Redis data. Reminders, recurring jobs, and task definitions/results still need durable Neon ownership. |
| Measure Redis commands, bytes, key sizes, cache hit ratio, and Neon query latency | Added process-local Redis command instrumentation by bounded key family and a root-only `GET /v1/admin/storage/metrics` endpoint. It aggregates command/error counts, estimated request/reply bytes, elapsed time, and estimated maximum value size without retaining keys or payloads. Existing Neon/session/cache counters remain included. | Local instrumentation only; metrics reset on process restart and are not aggregated across replicas. Byte and maximum-value figures are payload estimates (not RESP wire bytes or Redis `MEMORY USAGE`), and unclassified key families appear as `other`. A durable multi-instance exporter and deployed verification are still required before broader cutover. |
| Archive large transcripts, tool outputs, files, images, and videos to R2 | Migration 0008 and owner-scoped Neon metadata now back an opt-in SDK upload path: presigned uploads land in staging, bounded bytes are hashed and promoted to unique final keys, and Neon atomically records the winning key before download authorization. See the [R2 audit](r2-storage-audit.md). Other image/attachment flows, retained Recall transcripts, and agent run/tool traces are not fully catalogued or archived; encryption and retention/orphan workers are not implemented. | One guarded SDK file path is implemented locally; remaining consumers, backfill, cleanup, live migration, and production verification remain. |
| Add retention and safe archival jobs | `npm run r2:retention` is a bounded operator-run cleanup primitive over explicitly expired Neon object-catalog rows. Dry-run is default; apply requires two explicit flags, rechecks expiry in the Neon tombstone update, and deletes only the cataloged owner-scoped R2 key. | Local unit/store coverage is being added. No automated schedule, production inventory, retry monitoring, R2 archival for retained transcripts/traces, or live canary yet. |
| Full CI and production verification | Current Windows local run: 1,343 tests (1,339 pass, 0 fail, 4 skipped); typecheck, app build, SDK build, and 25 SDK tests pass. Configured Neon+Redis session smoke evidence is recorded above. | The exact hosted CI workflow still needs Ubuntu/Node 22 plus FFmpeg. Deployed-service verification remains outstanding; this retention runner was not applied to live objects or deployed. |

## Operational safeguards

- The live smoke uses an isolated synthetic high-range owner ID and removes only
  its own Neon rows and Redis session/domain-cache keys. It prints domain names/counts, never
  payloads, connection strings, or owner IDs.
- The session-domain backfill remains dry-run only. Mission backfill is
  operator-gated and requires stopping every Chusky API, worker, and webhook
  process; its Redis key lock serializes migration processes but cannot stop
  application writers. It logs aggregate counts only, preserves Redis copies,
  and marks an owner only after count/digest and row/event read-back checks.
- `DURABLE_STATE_ENABLED` must remain opt-in until the deployed service has the
  correct database URL, successful health/read/write evidence, and a rollback
  plan. A table's existence alone does not establish runtime use.
- Railway production configuration lists `DURABLE_STATE_ENABLED`,
  `DURABLE_STATE_DATABASE_URL`, and `DURABLE_STATE_MIGRATION_DATABASE_URL`,
  but the connected Railway view withheld their values. The live `/health`
  response was operational for Redis but did not contain durable-state health
  fields, and the latest Chusky deployment was still building during inspection.
  Therefore deployed Neon enablement/reachability and real-user writes are not
  verified by this rollout.

## 2026-10-04 local live verification

Using the configured local `.env` without printing connection values:

- `npm run durable-state:migrate` completed against the configured direct
  migration URL. A read-only Neon catalog query before migration found the
  session, conversation, SDK-run, and memory tables, but not object-catalog or
  mission tables. A subsequent application startup with mission/catalog
  assertions enabled succeeded, proving the runtime URL sees the newly applied
  `0008`-`0010` schemas. The migration runner recorded all 10 file checksums;
  a second invocation skipped all 10 without replaying DDL.
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
proof that Railway's deployed process uses those same URLs or feature flags.
There is still no live R2 object canary, and the zero-record mission/retention
dry runs do not prove those paths against populated production data.

## Next implementation slices

1. Run the exact CI command sequence on a recursive-submodule checkout in
   Ubuntu/Node 22 (CI also installs FFmpeg).
2. Verify the deployed Chusky service's Neon health and observe actual user
   session-domain writes by aggregate domain/count/timestamp only.
3. Keep the guarded backfill in dry-run until stable reads/writes are observed;
   then apply in bounded batches with post-migration parity checks and rollback
   evidence before removing legacy payloads.
4. Complete the ordered durable-record cutover: observe stable session-domain
   writes; canary per-run SDK persistence and verify list/get/events/cancel/
   resume parity across SDK, CLI, and workers; then migrate mission owners only
   during an explicitly quiesced window using the verified backfill. Preserve
   Redis copies and keep the flag on after first Neon write; rollback must use
   compatible Neon-aware code or verified reverse reconciliation. Reminders,
   recurring jobs, and task definitions/results still need Neon ownership.
   Keep each domain opt-in until schema, backfill, parity, restart, and rollback
   checks pass.
5. Follow [the R2 storage audit](r2-storage-audit.md): complete inventory and
   backfill for existing images/files, wire every attachment flow into the
   Neon catalog, then add encrypted R2 archival for retained transcript
   segments and eligible large run/tool payloads. Turn the guarded manual
   retention primitive into a monitored scheduled job only after dry-run
   inventory and deletion retry/restart checks. Never log or fetch full
   payloads for routine verification.
6. Extend the root-only local Redis command/byte/value-size telemetry to a
   durable multi-instance collector, validate estimates against provider billing
   and Redis-native measurements, then use the results to decide whether a small
   recent-history cache is worthwhile; cache entries are never canonical data.
