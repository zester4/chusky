# Chusky System Optimization & Bloat Remediation Handoff

Updated: 2026-10-26

This document records the comprehensive optimizations applied to stop Redis command bloat, eliminate premature frontend reloads, and eliminate runaway Neon Postgres data transfer.

---

## Executive Summary

Three major cost and performance bleeding points were audited and comprehensively resolved:

1. **Redis Command Bloat**: Background sweepers and reconciliation timers running every 5s–60s were hammering Upstash Redis with millions of commands per week even when completely idle. Sweeper frequencies have been relaxed to production-appropriate intervals (60s–600s), and fast-exit checks were added so empty states execute zero per-owner scans.
2. **Aggressive Frontend Return-Refresh**: When navigating away from the chat or dashboard for as little as 15 seconds, returning immediately triggered full re-fetches and re-renders, causing token bloat and repetitive database queries. The return-refresh cooldown was extended from 15 seconds to **5 minutes (300,000 ms)**, and idle polling intervals across all frontend dashboards were aligned.
3. **Neon Postgres Transfer Bloat (5 GB+ in Days)**: Neon data transfer was hitting 5 GB+ under minimal usage. The audit identified the primary culprits:
   - **SDK Run Streaming (`254 MB`)**: Every streaming token delta was being appended to `run.events` as `run.delta` and written to Neon twice on every tool activity via unbounded JSONB payload reads and writes. Deltas have been stripped from persistent storage, and duplicate snapshot writes were eliminated, reducing per-run snapshot transfer by over 98%.
   - **Self-Telemetry Amplification (`50 MB+` tables, `140,000+` rows)**: Metrics were flushing every 60s and retained for 30 days. Flushes are now every 5 minutes with a 7-day retention schedule, and 80,173 legacy rows were pruned.
   - **Voice Reconciliation Sweep (`52,982` commands)**: Idle voice call checks opened transactions and locked rows even with 0 calls; a zero-allocation pool pre-check was added.
   - **Health Check Schema Verification**: Every health check executed 4 schema introspection queries without caching; a 60s TTL cache was added.

---

## 1. Redis Command Bloat Remediation

### Sweeper Interval Reductions (`src/index.ts`, `src/channels/gateway.ts`)

| Sweeper / Service | Previous Interval | New Optimized Interval | Rationale |
| --- | --- | --- | --- |
| **Voice Call Reconciliation** | 15s (`15_000ms`) | **60s (`60_000ms`)** | Active calls use direct webhooks; reconciliation is only for dropped webhooks. |
| **Mission Recovery** | 120s (`120_000ms`) | **600s (10 min)** | Missions are multi-minute workflows; 10 min recovery is plenty for orphan pickup. |
| **WebSession Reconciliation** | 120s (`120_000ms`) | **600s (10 min)** | Reduces continuous session scans. |
| **Task Recovery** | 60s (`60_000ms`) | **300s (5 min)** | Tasks run over minutes; checking every 60s caused continuous Redis key scans. |
| **Schedule Recovery** | 300s (5 min) | **900s (15 min)** | Cron and schedule state does not drift within minutes. |
| **Memory Projection & Reflection Drains** | 60s (`60_000ms`) | **120s (2 min)** | Batches memory reflections without spinning the event loop. |
| **Daytona Workspace Retention** | 900s (15 min) | **1800s (30 min)** | Sandboxes have bounded TTLs; sweep frequency halved. |
| **SDK Webhook Recovery** | 120s (`120_000ms`) | **600s (10 min)** | Prevents redundant polling of failed webhook queues. |
| **Channel Gateway Outbox Sweep** | 120s (`120_000ms`) | **300s (5 min)** | Standard outbox retry backoff. |

### Fast-Exit Empty-State Sweepers
- **`src/taskRecovery.ts`**: Checks `await listTaskOwnerIds()`. If 0 owners exist, returns `{ claimed: 0, completed: 0, failed: 0 }` immediately instead of iterating or scanning Redis keys.
- **`src/missionRecovery.ts`**: Checks `await listMissionOwnerIds()`. If 0 owners exist, returns `{ claimed: 0, recovered: 0 }` immediately.

---

## 2. Frontend Return-Refresh & Polling Optimizations (`chusky-web`)

### Return-Refresh Cooldown Fix
- **File**: `chusky-web/lib/polling-policy.ts` & `chusky-web/components/app/chat-page.tsx`
- **Issue**: `DASHBOARD_RETURN_REFRESH_COOLDOWN_MS` was set to `15_000` (15s), and `chat-page.tsx` hardcoded `15_000`. Leaving the browser tab to check an email or browse for 20 seconds triggered a full page reload and re-query of all messages upon return.
- **Fix**:
  - Increased `DASHBOARD_RETURN_REFRESH_COOLDOWN_MS` from 15s to **300,000 ms (5 minutes)**.
  - Replaced hardcoded `15_000` in `chat-page.tsx` with `DASHBOARD_RETURN_REFRESH_COOLDOWN_MS`.
  - Now, returning to the tab within 5 minutes keeps the existing loaded state intact without re-fetching or reloading.

### Frontend Polling Policy Adjustments
- `DASHBOARD_REFRESH_INTERVAL_MS`: 60s → **300s (5 minutes)**.
- `ACTIVE_MISSION_REFRESH_INTERVAL_MS`: 15s → **60s**.
- `ACTIVE_RUN_RECOVERY_INTERVAL_MS`: 5s → **10s**.
- `DASHBOARD_IDLE_TIMEOUT_MS`: 120s → **60s**.
- **Run Recovery Timer Guard**: In `chat-page.tsx`, the run recovery timer now only starts if there are active pending runs, avoiding idle polling.
- **Meetings Page (`components/app/meetings-page.tsx`)**: Aligned idle polling to `DASHBOARD_REFRESH_INTERVAL_MS` (active meetings poll at 10s).
- **Operations Dashboard (`components/app/operations-dashboard.tsx`)**: Aligned refresh to `DASHBOARD_REFRESH_INTERVAL_MS` (300s).

---

## 3. Neon Postgres Transfer Bloat Remediation

### Root Cause Audit
The production Neon database audit revealed:
1. `POST /v1/threads/:threadId/runs/stream | chusky_sdk_run` generated **254 MB** of transfer.
2. `chusky_query_metric_sample` and `chusky_storage_metric_sample` had accumulated **140,000+ rows** and **50 MB+** of storage, transferring **~18 MB** just to record self-telemetry.
3. `chusky_voice_call_reconciliation` executed **52,982 queries** while empty.

### Code Fixes Applied

#### A. SDK Run Streaming Optimization (`src/sdkApi.ts`)
- **Delta Elimination from Storage**: Stripped `run.delta` events from persisted payloads in `persistSdkRunSnapshot()`. The complete generated text is safely saved in `run.output`. Live streaming text deltas are still pushed instantly to the frontend over SSE (`send({ type: "run.delta", ... })`).
- **Duplicate Snapshot Write Elimination**: In `onToolActivity` and `onSubagentActivity`, `persistSnapshot()` was being called directly, and then `publishProgress()` immediately invoked `persistSnapshot()` a second time. Added `persist = false` parameter to `publishProgress()` when called from activity handlers to eliminate duplicate write roundtrips.
- **Impact**: Drops the persisted JSONB run record size from ~150 KB to ~2 KB (**>98% transfer reduction** per agent run).

#### B. Self-Telemetry Throttle & Retention (`src/store.ts`, `src/config.ts`)
- `redisMetricsFlushTimer` interval increased from 60s to **300,000 ms (5 minutes)** in `src/store.ts`.
- `durableStorageMetricsRetentionDays` default reduced from 30 days to **7 days** in `src/config.ts`.
- `pruneQueryMetrics` in `src/store.ts` updated to use `config.durableStorageMetricsRetentionDays` instead of a hardcoded 30-day window.
- **Historical Pruning**: Executed one-time database cleanup purging **80,173** metric sample rows older than 48 hours from `chusky_query_metric_sample`, `chusky_storage_metric_sample`, and `chusky_redis_route_metric_sample`.

#### C. Voice Call Reconciliation Fast-Exit (`src/neonDurableState.ts`)
- In `claimVoiceCallReconciliations()`, added a lightweight pool query pre-check:
  ```ts
  const peek = await this.measuredQuery<{ exists: number }>(this.database,
    `SELECT 1 AS exists FROM chusky_voice_call_reconciliation
     WHERE next_attempt_at <= to_timestamp($1 / 1000.0)
       AND (status = 'pending' OR lease_until IS NULL OR lease_until <= NOW())
     LIMIT 1`,
    [nowMs]);
  if (!peek.rows.length) return [];
  ```
- Avoids checking out dedicated pool connections, running `BEGIN`, acquiring `FOR UPDATE SKIP LOCKED` row locks, and executing `COMMIT` when no calls need reconciliation.

#### D. Health Check Introspection Caching (`src/neonDurableState.ts`)
- Added a 60-second in-memory TTL cache (`cachedHealthStatus`) to `NeonDurableState.healthStatus()`.
- Eliminates repeated `SELECT 1` and schema introspection queries (`assertSessionSchema()`) on frequent `/health` calls.

---

## 4. Verification & Test Evidence

### Backend
- **Typecheck**: `npm run typecheck` passed (0 errors).
- **Production Build**: `npm run build` passed (0 errors).
- **Targeted Test Suites**:
  - `tests/neon-durable-state.test.ts`: **41/41 passed** (100%).
  - `tests/sdk-api.test.ts`: **97/97 passed** (100%).
  - Sweeper & recovery tests: **19/19 passed** (100%).

### Frontend (`chusky-web`)
- **Typecheck**: `pnpm run typecheck` passed (0 errors).

---

## 5. File Change Summary

| File | Changes Made |
| --- | --- |
| `src/index.ts` | Relaxed sweeper intervals for voice, missions, websessions, tasks, schedules, memory, daytona, and webhooks. |
| `src/channels/gateway.ts` | Relaxed channel gateway outbox sweeper to 300s. |
| `src/taskRecovery.ts` | Added fast-exit on empty owner index. |
| `src/missionRecovery.ts` | Added fast-exit on empty owner index. |
| `src/config.ts` | Changed `durableStorageMetricsRetentionDays` default from 30 to 7 days. |
| `src/store.ts` | Increased metrics flush timer to 300s; aligned query metrics pruning to retention config; added 60s in-memory TTL caching for `getTelegramUserIdForWebAuth`, `getWebAuthUserIdForTelegram`, and `findCompanyBrandingByDomain` with event-based cache invalidation. |
| `src/neonDurableState.ts` | Added 60s cache for `healthStatus()`; added pool pre-check fast-exit for voice reconciliation claims. |
| `src/sdkApi.ts` | Stripped `run.delta` from persisted run events; removed duplicate snapshot writes on tool activities; added 10s singleflight cache for Better Auth session and organization membership resolution. |
| `chusky-web/lib/polling-policy.ts` | Changed return-refresh cooldown to 5 min (300s); relaxed dashboard refresh intervals. |
| `chusky-web/lib/live-sync.ts` | Initialized `lastRefreshAtRef` to `Date.now()` so tab returns respect the 5-minute cooldown instead of treating 0 as expired. |
| `chusky-web/components/app/authenticated-app.tsx` | Fixed root cause of tab-switch reload: prevented unmounting the entire application tree on Better Auth session focus events by caching the verified user ID. |
| `chusky-web/components/app/chat-page.tsx` | Initialized `lastReturnRefreshAtRef` to `Date.now()`; enforced `DASHBOARD_RETURN_REFRESH_COOLDOWN_MS` (5 min). |
| `chusky-web/components/app/app-shell.tsx` | Initialized `lastActivityRefreshAtRef` to `Date.now()`; prevented repeated activity polling on focus. |
| `chusky-web/components/app/meetings-page.tsx` | Aligned polling to `DASHBOARD_REFRESH_INTERVAL_MS`. |
| `chusky-web/components/app/operations-dashboard.tsx` | Aligned polling to `DASHBOARD_REFRESH_INTERVAL_MS`. |

---

## 6. Real-Time Upstash Log Audit & Redis Traffic Breakdown

An audit of the real-time Upstash Redis log revealed:
1. **Old Container Rollover Traffic (`10:21:59`)**: The prior container (IP `184.72.40.155`) was running the previous aggressive sweeper loops (task sweeper every 10s, mission sweeper every 15s, outbox sweeper every 1s).
2. **New Container Cold Boot (`10:23:11`)**: The new container connected (`152.55.177.255`), ran the one-time boot recovery check, and then went completely silent for 44 seconds (0 sweeper commands between `10:23:14` and `10:23:58`), verifying the relaxed background intervals.
3. **Empty-Database Hydration Burst (`10:23:58` - `10:24:03`)**: Because the Upstash Redis account was brand new and empty, when user `72020117437160` opened the dashboard, every key missed cache. The backend queried Neon and hydrated all session domains (`profile`, `sdk`, `conversation`, `assets`, `calls`, `autonomy`), tasks, and approvals into Redis via `EVAL / SETEX`. This is a one-time cold cache event.
4. **Parallel In-Request Redundancy (Eliminated)**: Six concurrent dashboard requests (`/overview`, `/activity`, `/threads`, `/approvals`, etc.) each called:
   - `better-auth:session` (6 times in 1s)
   - `chuck:web-telegram:web:*` (6 times in 1s)
   - `chuck:organization:branding-domain:*` (repeated on page loads)
   
   These redundant queries have now been eliminated via in-memory singleflight deduplication and short TTL caching.
