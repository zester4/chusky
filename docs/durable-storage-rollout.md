# Durable storage rollout status

Updated: 2026-10-03

## Decision

- Neon/Postgres is the durable source of truth for structured conversation and
  account data.
- Redis remains the operational layer for task leases, cancellation, locks,
  rate limits, and short-lived workflow/deduplication state.
- Cloudflare R2 stores binary and other large objects; Neon should retain
  ownership, content metadata, hashes, sizes, and object keys.
- Do not retire or bulk-rewrite legacy Redis data until production reads and
  writes have been observed stable and the migration can be rolled back.

## Acceptance status

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Verify conversation, memories, assets, and SDK session writes in Neon | `npm run durable-state:live-smoke` exercised Chusky `getSession`/`saveSession` against the configured Neon endpoint and Redis; all four domains round-tripped, payloads were not logged, and synthetic rows/key were removed. | Local live smoke passed; deployed-user writes remain unverified. |
| Backfill and retire legacy Redis session domains | Lazy migration occurs on session writes. `npm run durable-state:backfill` scans and reports aggregate dry-run counts only. Bulk apply is deliberately disabled: Neon write followed by Redis CAS is not atomic across stores and can race with a live session write. | Dry-run tooling only; safe bulk backfill protocol and production retirement pending. |
| Store SDK runs as per-run Neon rows | SDK threads and runs are currently nested in the `sdk` session-domain JSON document. | Not implemented. |
| Store missions, steps, evidence, and event history in Neon | Mission records remain in Redis; mission events have a separate Redis list. | Not implemented. |
| Measure Redis commands, bytes, key sizes, and operation families | No Redis-family telemetry was added in this change. Neon session read/write/failure counters are process-local and not Redis metrics. | Not implemented. |
| Archive large transcripts, tool outputs, files, images, and videos to R2 | Existing SDK uploads and image assets already use R2. This change does not migrate transcript/tool-output payloads or add their Neon metadata records. | Partial existing capability; requested archival path not implemented. |
| Add retention and safe archival jobs | Existing domain-specific TTLs/limits remain; no general Neon/R2 retention or archival worker was added. | Not implemented. |
| Full CI and production verification | Clean `npm ci`, typecheck, 1,269 tests (1,265 pass, 0 fail, 4 platform skips), app build, SDK build, SDK tests (25 pass), `git diff --check`, and a synthetic live Neon/Redis round-trip passed locally. | Local checks passed on Windows/Node 25; CI uses Ubuntu/Node 22 and installs FFmpeg, so the exact hosted CI job and deployed production verification remain outstanding. |

## Operational safeguards

- The live smoke uses an isolated synthetic high-range owner ID and removes only
  its own Neon rows and Redis session key. It prints domain names/counts, never
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
4. Design and test normalized SDK thread/run tables and mission tables/events,
   with explicit concurrency and Redis coordination semantics before cutover.
5. Add sampled Redis command/operation-family metrics and R2 archival/retention
   manifests with owner-scoped metadata and recovery tests.
