# Redis Blowout Fix — Implementation Plan

## Goal
Cut idle Redis commands by **85–90%** while keeping voice, memory, missions, and all features fully functional. The principle: **work on demand, not on a clock.**

---

## Category 1 — Backend: Raise sweeper intervals to sane idle values

These sweepers exist only to **recover from crashes**. They don't need to be fast — they just need to eventually catch stale work. Right now they fire as if crashes happen every 15–120 seconds.

### `src/index.ts` changes

#### Fix 1a — Voice reconciliation: 15 s → 60 s
**Line 357**
```ts
// BEFORE
voiceReconciliationRecovery = setInterval(() => { void sweepVoiceCalls(); }, 15_000);

// AFTER
voiceReconciliationRecovery = setInterval(() => { void sweepVoiceCalls(); }, 60_000);
```
**Why it's safe**: Voice calls last minutes, not seconds. A 60 s recovery window still catches a crashed process within one minute — fast enough for any real call scenario.

#### Fix 1b — Task recovery: 60 s → 300 s (5 min)
**Line 421**
```ts
// BEFORE
taskRecovery = setInterval(() => { void reconcileQueuedTasks(); }, 60_000);

// AFTER
taskRecovery = setInterval(() => { void reconcileQueuedTasks(); }, 300_000);
```

#### Fix 1c — Mission recovery: 120 s → 600 s (10 min)
**Line 363**
```ts
// BEFORE
}, 120_000);

// AFTER
}, 600_000);
```

#### Fix 1d — Web session reconciliation: 120 s → 600 s
**Line 398**
```ts
// BEFORE
webSessionReconciliationRecovery = setInterval(() => { void reconcileWebSessionTasks(); }, 120_000);

// AFTER
webSessionReconciliationRecovery = setInterval(() => { void reconcileWebSessionTasks(); }, 600_000);
```

#### Fix 1e — Schedule recovery: 5 min → 15 min
**Line 442**
```ts
// BEFORE
scheduleRecovery = setInterval(() => { void reconcileSchedules(); }, 5 * 60_000);

// AFTER
scheduleRecovery = setInterval(() => { void reconcileSchedules(); }, 15 * 60_000);
```

#### Fix 1f — SDK webhook recovery: 120 s → 600 s
**Line 781**
```ts
// BEFORE
sdkWebhookRecovery = setInterval(() => { void recoverSdkWebhooks()... }, 120_000);

// AFTER
sdkWebhookRecovery = setInterval(() => { void recoverSdkWebhooks()... }, 600_000);
```

#### Fix 1g — Memory drains: 60 s → 120 s
**Lines 445 and 447**
```ts
// BEFORE (both lines)
}, 60_000);

// AFTER (both lines)
}, 120_000);
```
Memory still drains every 2 minutes. Embeddings are not time-critical.

#### Fix 1h — Daytona retention sweep: 15 min → 30 min
**Line 450**
```ts
// BEFORE
}, 15 * 60_000);

// AFTER
}, 30 * 60_000);
```

---

## Category 2 — Backend: Fast-exit when there's nothing to do

The sweepers currently hit Redis even when zero owners/tasks/missions exist. Add a **one-command early exit** so an empty system costs almost nothing.

### `src/taskRecovery.ts` — skip the full scan when no owners exist

**After line 93** (`const ownerIds = await listTaskOwnerIds(maxOwners);`):
```ts
// ADD: early exit — the lease + owner list is still 2 commands, but saves
// all the per-owner task reads (which are the expensive part)
report.owners = ownerIds.length;
if (!ownerIds.length) return report; // ADD THIS LINE
```

### `src/missionRecovery.ts` — skip when no owners exist

**After line 290** (`const ownerIds = ...`):
```ts
if (!ownerIds.length) {
  await releaseMissionRecoveryLease(token);   // ADD
  clearInterval(renewalTimer);                 // ADD
  return total;                                // ADD
}
```

### `src/index.ts` — scheduleRecovery: skip when no job owners

**Line 428–429**, inside `reconcileSchedules`:
```ts
const owners = await listJobOwnerIds(1_000);
if (!owners.length) return;   // ADD THIS LINE — saves all per-owner reconciliation
```

---

## Category 3 — Frontend: Stop ALL background polling, load on visit only

This is the most impactful frontend fix. Right now:
- Every page runs `useLiveData` → `setInterval` at 60 s → API call → multiple Redis reads
- Chat page runs a `setTimeout` loop at **5 s** while any run looks "pending"
- Missions page runs at **15 s** while any mission is active

The problem: these timers run even when you're not looking at the page and even when the SSE connection (`EventSource`) is already delivering real-time updates.

**The correct model**: SSE delivers updates instantly. Polling is only a fallback for when SSE is down. So polling should be **much longer** and **completely stop** when the page is hidden.

### Fix 3a — `chusky-web/lib/polling-policy.ts`: Raise all intervals

```ts
// BEFORE
export const DASHBOARD_REFRESH_INTERVAL_MS = 60_000;
export const ACTIVE_MISSION_REFRESH_INTERVAL_MS = 15_000;
export const DASHBOARD_IDLE_TIMEOUT_MS = 120_000;
export const DASHBOARD_RETURN_REFRESH_COOLDOWN_MS = 15_000;
export const ACTIVE_RUN_RECOVERY_INTERVAL_MS = 5_000;

// AFTER
export const DASHBOARD_REFRESH_INTERVAL_MS = 300_000;        // 5 min — SSE handles real-time
export const ACTIVE_MISSION_REFRESH_INTERVAL_MS = 60_000;    // 1 min — was 15 s
export const DASHBOARD_IDLE_TIMEOUT_MS = 60_000;             // 1 min idle = stop polling sooner
export const DASHBOARD_RETURN_REFRESH_COOLDOWN_MS = 30_000;  // 30 s cooldown
export const ACTIVE_RUN_RECOVERY_INTERVAL_MS = 10_000;       // 10 s — was 5 s
```

**What this means in practice**:
- Dashboard background refresh: every **5 minutes** instead of every 60 s (SSE still delivers instantly)
- Active missions: refresh every **1 min** instead of every 15 s
- Chat run recovery: retry every **10 s** instead of every 5 s
- Idle timeout: if no user interaction for **60 s**, stop all polling (was 2 minutes)

### Fix 3b — `chusky-web/lib/live-sync.ts`: Only poll when visible AND active

The `useLiveData` hook already calls `shouldPollDashboard` which checks `visibilityState`. The logic is correct — the intervals are just too short. No code change needed here beyond Fix 3a.

### Fix 3c — `chusky-web/components/app/chat-page.tsx`: Stop the 5 s run recovery loop when no pending runs

The chat page currently starts the recovery loop on mount and **always** fires once, even if there are no pending runs. Look at line 1087:

```ts
// BEFORE — fires immediately on mount regardless
timer = window.setTimeout(() => void poll(), ACTIVE_RUN_RECOVERY_INTERVAL_MS);

// AFTER — only start the loop if there are actually pending runs
const runIds = [...new Set(messagesRef.current.filter(
  (item) => item.role === "assistant" && item.pending && item.runId
).map((item) => item.runId!))];
if (runIds.length) {
  timer = window.setTimeout(() => void poll(), ACTIVE_RUN_RECOVERY_INTERVAL_MS);
}
```

This means the 5 s loop **never starts** unless a run is actually in progress. When the run finishes (`runIds.length === 0` after polling), line 1085 already stops the loop correctly.

---

## Expected Impact

| Metric | Before | After |
|---|---|---|
| Voice sweeps/day | 5,760 (15 s) | 1,440 (60 s) |
| Task recovery hits/day | 1,440 (60 s) | 288 (5 min) |
| Mission recovery hits/day | 720 (120 s) | 144 (10 min) |
| Schedule reconciliation/day | 288 (5 min) | 96 (15 min) |
| Memory drains/day | 1,440 each (60 s) | 720 each (120 s) |
| Dashboard API polls/tab/day | 1,440 (60 s) | 288 (5 min) |
| Active mission polls/tab/hour | 240 (15 s) | 60 (1 min) |
| Chat run recovery polls/run | every 5 s | every 10 s, only when run active |
| **Total idle Redis cmds/day** | **~240k–680k** | **~25k–65k** |
| **Reduction** | | **~85–90%** |

---

## What does NOT change
- ✅ Voice still works — reconciliation still runs, just every 60 s instead of 15 s
- ✅ Memory still works — drains every 2 min instead of 1 min
- ✅ Missions still recover — sweeper runs every 10 min instead of 2 min
- ✅ SSE real-time push still instant — polling is only the fallback
- ✅ Chat still shows run progress — recovery loop still runs at 10 s while a run is active
- ✅ All features fully functional

## Files changed
1. [`src/index.ts`](file:///c:/Users/mseyy/Downloads/tg-agent-main-fresh/src/index.ts) — 8 interval changes (lines 357, 363, 398, 421, 442, 445, 447, 450, 781)
2. [`src/taskRecovery.ts`](file:///c:/Users/mseyy/Downloads/tg-agent-main-fresh/src/taskRecovery.ts) — 1 early-exit line after owner list
3. [`src/missionRecovery.ts`](file:///c:/Users/mseyy/Downloads/tg-agent-main-fresh/src/missionRecovery.ts) — early-exit when no owners
4. [`chusky-web/lib/polling-policy.ts`](file:///c:/Users/mseyy/Downloads/tg-agent-main-fresh/chusky-web/lib/polling-policy.ts) — 5 constant changes
5. [`chusky-web/components/app/chat-page.tsx`](file:///c:/Users/mseyy/Downloads/tg-agent-main-fresh/chusky-web/components/app/chat-page.tsx) — guard initial run recovery timer

## Verification
- `npm run typecheck` + `npm run build`
- `cd chusky-web && pnpm run typecheck`
- Monitor Upstash Redis command count over 24 hours — should drop by ~85%
