# Durable storage rollout status

Updated: 2026-10-03

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
| Store missions, steps, evidence, and event history in Neon | Mission records remain in Redis; mission events have a separate Redis list. Reminders, jobs, and task definitions/results also need durable Neon ownership. | Not implemented. |
| Measure Redis commands, bytes, key sizes, cache hit ratio, and Neon query latency | Added process-local aggregates for session Redis commands/bytes, core/cache sizes, domain-cache hit ratio, Neon query count/errors/latency, message counts/byte estimates, and domain sizes through `durableStorageMetrics()`. | Local instrumentation only; it is not yet exported to a multi-instance collector/dashboard and does not cover every Redis command family. Required before broader cutover. |
| Archive large transcripts, tool outputs, files, images, and videos to R2 | Existing SDK uploads and image assets already use R2. Migration 0008 and owner-scoped Neon object metadata create/get/finalize primitives now provide the first catalog foundation; see the [R2 audit](r2-storage-audit.md). Existing asset flows do not yet write the catalog. Retained Recall transcripts and agent run/tool traces remain in Redis; encrypted archive and retention workers are not implemented. | Foundation implemented locally; consumers, live migration, and production verification remain. |
| Add retention and safe archival jobs | Existing domain-specific TTLs/limits remain; no general Neon/R2 retention or archival worker was added. | Not implemented. |
| Full CI and production verification | Current local run: typecheck, 1,286 tests (1,282 pass, 0 fail, 4 skipped), app build, SDK build, SDK tests (25 pass), and `git diff --check` passed. Live configured Neon+Redis smoke also passed and cleaned its isolated data. | Local checks passed on Windows/Node 25; CI uses Ubuntu/Node 22 and installs FFmpeg, so hosted CI and deployed-service verification remain outstanding. |

## Operational safeguards

- The live smoke uses an isolated synthetic high-range owner ID and removes only
  its own Neon rows and Redis session/domain-cache keys. It prints domain names/counts, never
  payloads, connection strings, or owner IDs.
- The backfill script is dry-run only and logs aggregate counts, never payloads
  or owner IDs. Do not add bulk apply until live session writers participate in
  a coordinated per-owner migration protocol; cross-store CAS alone is not safe.
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
   resume parity across SDK, CLI, and workers; then move missions, reminders,
   recurring jobs, and task definitions/results to Neon while retaining only
   active coordination in Redis. Keep each domain opt-in until its schema,
   backfill, parity, restart, and rollback checks pass.
5. Follow [the R2 storage audit](r2-storage-audit.md): wire existing asset
   writes into the Neon object catalog, then add encrypted R2 archival for
   retained transcript segments first and eligible large run/tool payloads;
   add bounded retention and orphan-recovery jobs. Never log or fetch full
   payloads for routine verification.
6. Add Redis command/byte/key-size metrics by bounded operation family. Use
   measurements to decide whether a small recent-history cache is worthwhile;
   cache entries are never canonical data.
