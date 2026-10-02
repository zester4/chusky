# Mission execution kernel audit

Date: 2026-10-02. Branch: `mission-execution-kernel`.
Baseline: `6614164698504157227cfc9103f468e67553f183`.

## Status and evidence standard

Phase 0 is in progress. This is a defect inventory, **not a release certificate**.
Runtime repairs have been applied through the baseline above. The evidence
column names tests actually rerun for this audit; it is not a release
certificate. A path is marked
untested where the requested crash/transport/window proof does not exist or has
not been established. Broken means a concrete code path contradicts the target.
The unrelated `chusky-voice` working-tree edits are excluded from this work.

## Decisions

1. Extend the existing store/task/scheduler architecture, rather than introduce
   a second scheduler with competing ownership and retry state.
2. Build failure-injection tests before repairs. A simulated provider boundary
   must exercise the actual execution/settlement path, not manufacture a success
   slug and call that a receipt.
3. Never infer exactly-once provider effects from model prose. A crash after
   dispatch and before recording the response remains uncertain unless a
   provider idempotency key or fresh read-back resolves it. Safety takes
   precedence over automatic continuation.
4. Keep independent limits: completed plan steps, executed slices, consecutive
   no-progress failures, active execution time, wall-clock deadline, tool calls,
   and spend. Budget changes must remain within explicit owner authority.
5. Distinguish running, durable resting, approval/provider/human waits, repair,
   and terminal states. Recovery may restore delivery; it may not grant approval,
   revive owner-cancelled work, or replay an ambiguous external write.
6. Preserve legacy records and stable tool identifiers. New optional fields need
   normalization and round-trip tests at every public surface.

## Lifecycle inventory

| Path | Implementation | Existing coverage to inspect | Verdict and defect |
| --- | --- | --- | --- |
| Create / plan | `store.createMission`, `normalizeMission`; `missionScheduler.validateMissionStepsPayload`; native START | `missions`, `mission-native-limits`, `agent-contract` tests | Partial repair: input/storage bounds now support 1,000 steps and preserve the dependency graph; typed metadata is not yet an executable contract throughout every transport. |
| Schedule / enqueue | `missionScheduler.scheduleMissionSteps`, `reconcileMissionExecution`; `taskEnqueue.enqueueTaskWithClaim`; `missionRecovery.recoverAllMissions` | `missions`, `task-enqueue`, `trigger-workflow`, `mission-recovery` tests | Partial repair: expired enqueue claims and lost queued deliveries are republished idempotently by the independent sweeper; accepted-but-unrecorded provider publications still rely on provider idempotency/recovery evidence. |
| Claim / lease | store backend `claimTask`; `taskRunner.executeDurableTask`; `quarantineExpiredTask` | `tasks`, `task-runner`, `mission-recovery` tests | Partial repair: expired leases are fenced and quarantined rather than replayed; provider read-back/owner repair remains required for ambiguous in-flight work. |
| Slice execution | `index.ts` `/workflows/task`; `missionSlice.settleMissionSlice` | `mission-agent-proof`, `mission-kernel-proof`, `task-runner` tests | Partial repair: settlement is extracted and real worker dispatch now carries per-call outcomes, confirmed-provider checkpoint fallback, and durable handoff; the route still owns surrounding lease/context orchestration and lacks full crash-at-every-await proof. |
| Step completion | `store.completeMissionStep`; `completeMissionStepAndAdvance` | `missions` tests | Untested: full-route evidence-driven completion with sloppy model and crash boundaries. |
| Fan-out / join | `readyMissionSteps`, `scheduleMissionSteps`; step-scoped execution leases in `store` | `missions`, `mission-timing`, `mission-kernel-proof` tests | Partial repair: dependency-ready branches now have independent durable leases and can bypass the account lock when genuinely parallel; CAS joins and mixed wait behavior still need a full concurrent worker harness. |
| Checkpoint | `checkpointMission`; `missionSliceHasPersistedProgress` | `mission-worker`, `missions`, `mission-kernel-proof` tests | Partial repair: repeated identical checkpoints no longer create a new progress frontier, and confirmed provider calls are checkpointed server-side; bounded mission context and full crash proof remain open. |
| Timer wait / wake | `waitMission`, `resumeMissionFromTimer`; HTTP timer branch | `mission-timing`, `mission-worker`, `task-wait`, `mission-kernel-proof` tests | Partial repair: timer resume now rejects future deadlines and the scheduler emits the next daily work-window wake; live QStash wake delivery remains an integration follow-up. |
| Provider event wait / resume | `resumeMissionFromProviderEvent`; SDK signed events route | `missions`, SDK route tests, `mission-kernel-proof` | Partial repair: replay detection uses exact provider/event identity; signed delivery/restart proof remains missing. |
| Approval wait / resume | `missionApproval`; `resumeMissionFromApproval`; callbacks | `mission-approval`, `approval`, SDK tests | Untested: mixed parallel branch approval, crash after approval claim, and same-task end-to-end continuation. |
| Human-input wait | mission waiting union; HTTP waiting dispatch | None established for whole route | Broken: no explicit human-input stop branch; dispatch falls through toward execution. |
| Replan | `replanMission`, `replanMissionAndSchedule`; SDK replan mapping | `missions` tests | Broken: unfinished step reconstruction loses typed/evidence/compensation metadata; retained task IDs can preserve stale objective/fences. No plan-revision fencing of in-flight work. |
| Repair | `repairMission`; reliability `diagnoseMissionRepair` | `missions`, `reliability` tests | Broken: diagnosis exists, but exhausted task retries immediately fail the mission rather than entering bounded automatic repair. |
| Compensation | `autonomy/actions`; reliability persistence / native compensation | `autonomy-actions`, `reliability` tests | Untested: leased execution, provider read-back, approval and restart of compensation attached to a failed branch. |
| Pause | `pauseMission`, `cancelMissionTasks`; native/API surfaces | `missions`, route tests | Untested: cancellation of in-flight provider/model work and late completion after pause across processes. |
| Resume | `resumeMission`, `resumeMissionAndSchedule` | `missions`, `mission-timing` tests | Broken: scheduler retries blocked/failed/cancelled step tasks without a machine-readable safe-replay distinction. |
| Cancel | `cancelMission`, `cancelTask`; abort polling | `tasks`, `task-runner`, route tests | Untested: late external response, duplicate continuation and lease loss at every await. Cancellation cannot undo an already-dispatched provider effect. |
| Budget preflight | `missionBudgetPreflight`; HTTP worker admission | `mission-timing`, `missions`, `mission-kernel-proof` | Partial repair: completed plan steps and worker slices are separate counters, `maxSlices` is independently enforced, and detailed agent outcomes charge repeated provider calls individually; live multi-worker budget contention remains open. |
| Budget extend | `extendMissionDurationIfEligible`, duration approval | `mission-timing`, `mission-approval` tests | Broken: only narrow active-duration extension exists, not general owner-ceiling management of slices/tools/cost. |
| Budget reduce | `resumeMission` rejects smaller duration | No reduction coverage | Broken: no supported shrink operation. |
| Work schedule / rest | No mission schedule field | No coverage | Broken: healthy slices requeue approximately every five seconds; no hours/day, windows, cadence or timezone. |
| Lease renew / loss | `renewTaskLease`; task runner renewal; HTTP mission renewal | `task-runner`, `tasks`, `mission-kernel-proof` tests | Partial repair: renewal and settlement reject expired tokens, and replacement workers receive a new lease; post-turn mission accounting still needs a broader crash proof. |
| Duplicate delivery | deterministic task IDs; enqueue claims; task leases | `task-enqueue`, `task-runner`, `tasks`, `real-world-upgrade`, `mission-kernel-proof` tests | Partial repair: deterministic task identity, publication timestamp recovery, and lease fencing prevent immediate duplicate continuations; reordered provider siblings remain a separate proof. |
| Retry loop | `settleTaskRun`, backend claim, HTTP ten-iteration loop | `task-runner`, `missions`, `mission-kernel-proof` tests | Partial repair: healthy persisted progress resets the consecutive retry budget and the worker prompt no longer treats every later slice as no-progress. Automatic repair after exhaustion remains incomplete. |
| Recovery sweeper | `missionRecovery.recoverAllMissions`, `recoverMissionsForOwner`; two-minute interval in `index.ts` | `tests/mission-recovery.test.ts` | Works for bounded owner discovery, lost queued delivery, overdue timer wakes, and conservative expired-lease quarantine; live multi-instance cadence and QStash publication remain integration follow-ups. |
| Closeout / verify | `verifyMission`, `finalizeMissionIfReady`, scheduler closeout | `missions`, `reliability` tests | Untested: 200-step strict evidence retention and mutation tests. Legacy closeout is intentionally different and must stay explicitly labelled. |
| Event history | normalized `mission.events` / evidence arrays | `missions`, replay tests | Partial: bounded history remains an intentional storage limit; long-horizon archival/event-stream proof is still missing. |
| Record retention | Redis and memory `createTaskIfAbsent` / `createMissionIfAbsent` | `mission-kernel-proof` | Partial repair: unfinished tasks are retained while completed/cancelled task history is bounded; mission archival and long-horizon event retention remain open. |
| Notifications / daily digest | mission update notifier; delivery/outbox paths | Delivery tests; no schedule digest proof | Untested: channel-neutral deduplicated blocker/daily digest recovery. |
| Delegation | `subagents/executor`; `/workflows/subagent` | `subagents`, delegation tests | Broken: continuation marks task running without leased claim; child task lacks mission linkage; provider path needs mission receipt fencing; prose can be classified success. |
| Native mission/task tools inside worker | `nativeTools`; `MISSION_WORKER_CONTROL_TOOLS`; agent catalog | `mission-native-limits`, `agent-contract`, tool schema tests | Untested: every tool from actual worker context, including deliberate supervisor-only rejection and wait linkage. |
| Tool discovery / fences | mission allowlist and agent discovery | `mission-worker`, `agent-contract` tests | Untested: schema-valid discovered provider tools across explicit step fences and inherited account grants. |
| Batch outcomes | agent execution, tool-activity correlation, autonomous receipts, `missionSlice.settleMissionSlice` | `tool-activity`, `autonomy-actions`, `mission-kernel-proof` tests | Partial repair: per-call outcomes distinguish success, failure, and uncertainty; mixed or unmatched batch actions are non-clean and cannot close a mission. Live provider receipt matrices remain unverified. |
| Bounded mission context | `missionWorker.boundedMissionHistory`; HTTP task slice | `mission-worker`, `mission-agent-proof` tests | Partial repair: mission turns receive a bounded recent text frontier while durable checkpoint/step state remains authoritative; compacted evidence summaries and crash/restart context proof remain open. |
| CLI | `cli.ts` mission commands and details; client | CLI tests | Untested: complete new schedule/budget/doctor contract; current usage labels slice counter as steps. |
| SDK / API | `sdkApi.ts` mission routes; SDK types/OpenAPI | SDK tests | Broken: replan mapping drops additional typed fields/fences; public schedule/budget/doctor support absent. |
| Web | `chusky-web/components/app/missions-page.tsx` | No end-to-end proof established | Untested: public response parity and full long-horizon state presentation. |

Additional inspected boundary defects: `renewTaskLease` can renew an already
expired token; SDK repair only records a blocked diagnosis while the dashboard
labels its action "Repair and resume". Neither behavior is currently repaired.

## Important corrections to the initial hypotheses

- New `createMission` calls explicitly default to **active** duration mode.
  Legacy records without the field normalize to **wall_clock**. These must not
  be conflated in migration or simulation.
- `autonomy/actions.ts` already auto-persists trusted successful external-write
  receipt evidence, including explicitly successful batch actions. Treg is not
  the only source. Repairs must use and harden this existing receipt system.
- A success-only slug checkpoint is insufficient: two calls to the same slug
  can have different outcomes. One success must never hide an uncertain sibling.
- The supplied Claude patch is not present in the branch baseline. Its proposed
  harness bypasses the actual agent/provider path and does not prove the stronger
  acceptance criteria here.

## Proof plan and unresolved verification

Build one harness around the extracted real worker with injectable clock,
transport and model/provider boundaries, plus real owner-scoped store behavior.
Enumerate side-effect awaits and inject crashes before/after each boundary.
Record delivery IDs, call IDs, receipt IDs, lease tokens and plan revisions;
assert no stale writer can advance the frontier. Test schedule/DST boundaries,
lost publications, genuine waits, approval expiry, replan while running,
uncertain siblings, and repeated no-op checkpoints.

Required acceptance scenarios remain **not run**: 200-step mixed soak,
30-day/three-hour schedule, exhaustive crash injection, sweeper repair,
self-managed ceilings, sloppy-model completion, and safety-guard mutation tests.
The exact recursive-submodule CI command sequence has not been run on this
branch. No live Redis, QStash or provider behavior is certified by this audit.
The autonomy/reliability modules and mission SDK/CLI/web implementations have
been inspected. Coverage inspection and the worker extraction remain in progress.

### First executable proof tranche

`tests/mission-kernel-proof.test.ts`, backed by the real in-memory store and
`tests/helpers/missionKernelHarness.ts`, was run before runtime repairs: **1
passed, 7 failed, 0 skipped**. It reproduces expired lease renewal, stranded
expired claims, unfinished-task eviction, the 100-step plan limit, early timer
resume, substring/provider-mismatched event replay, and replan contract loss.
The fake delivery transport supports dropped, duplicated, delayed and reordered
publications. Its crash injector supports named before/after await boundaries.
This is a first regression tranche, not the full acceptance harness: real agent
execution, exhaustive await injection, schedule simulation and soak proofs are
still outstanding. No Redis/process-crash guarantee follows from this tranche.

The production post-turn settlement block was extracted unchanged into
`src/missionSlice.ts`. `tests/mission-agent-proof.test.ts` exercises the real
`runAgent` tool dispatcher, native mission controls, store, scheduler, task
runner and settlement; only model HTTP and Composio transport are scripted.
Both tests passed: three dependency handoffs reach persisted completion, and
prose alone cannot fabricate completion. Typecheck passed after extraction.
The HTTP wait/lease/approval coordinator is not yet extracted or certified.

Full baseline suite result (before runtime repairs): 1,182 tests, 1,177 passed,
one failed, four skipped. The failure is the existing private-voice catalog
assertion in `tests/agent-contract.test.ts:1056` (128 tools versus 192 expected).
Skips are two optional PTY tests and two opt-in Recall staging tests. They are
not counted as verification success and must be resolved or explicitly reported
before acceptance. The baseline does not include subsequently added proof tests.

The agent/worker/task-runner regression group passed **19/19, zero skipped,
three consecutive runs** after the behavior-preserving extraction. Build and
`git diff --check` passed. The red kernel tranche now has ten tests: one passes
and nine fail, including consecutive-retry reset and an uncertain sibling being
incorrectly permitted despite a successful checkpoint. The latter is a safety
defect in the old settlement path, not permission to relax uncertain outcomes.

The complete production task slice is now extracted to `src/taskSlice.ts`.
`index.ts` keeps the durable workflow adapter/replay loop; model execution and
publication are injectable but default to the unchanged production paths.
`tests/task-slice-proof.test.ts` passes native completion and early timer parking,
and reproduces human-input fallthrough. Its 200-step mixed coordinator soak is
defined and currently fails at creation's 100-step cap. The 30-day window proof
is defined and fails on the initial midnight publication instead of 09:00.
These are red acceptance fixtures, not successful soak/schedule evidence.

Both recursive submodules were initialized without force; their existing clean
checkouts already matched the committed gitlinks. Git's submodule helper needs
the Git Bash `/usr/bin:/mingw64/bin` PATH in this Windows environment. Docker's
client exists but its daemon is unavailable, so no local Redis/container crash
proof has been established. The repeated-checkpoint regression now fails as
expected: changed event IDs make an identical checkpoint look like progress.
The lost-publication regression also fails: after a full day without delivery,
reconciliation retains the accepted workflow ID and schedules no replacement
wake for the original queued task. This tests the existing recovery entry point;
it does not claim that an independent sweeper exists.
The complete kernel tranche was run three consecutive times: **13 tests,
one passed, twelve failed, zero skipped** on each run. These are stable red
regressions, not an acceptance pass. `git diff --check` passed afterwards.
Exhaustive await/crash, independent recovery and budget-ceiling
proofs remain outstanding, as do the runtime repairs.

### Process-kill harness (in progress)

`tests/helpers/missionProcessHarness.ts` compiles an isolated copy of the real
production runtime with test-only probes before/after every project `await`.
Probes run in child processes and the parent can issue `SIGKILL`; this does not
throw a recoverable exception or execute worker `finally` cleanup. Production
source and deployed builds contain no crash hooks. The production-coordinator
instrumentation smoke test passed; real-store process recovery is a separate
gate: `npm run test:mission:crash` with an isolated `MISSION_PROCESS_REDIS_URL`.
That gate enumerates observed boundaries, kills/restarts each original task,
and requires matching persisted mission and task terminal states. Fixtures now
cover internal and strict completion, timer/provider/approval waits, checkpoint,
failure, prose-only output, cancellation and replan. Memory-only coordinator
smokes exercise these branches; they do not certify restart recovery or real
provider writes. Cancellation before its request is durably persisted and
approval before its exact action is recorded still need explicit recovery
expectations, not a completion-shaped recovery script that bypasses authority.

Additional red budget proofs require worker access to the existing resume
control, extension and reduction inside explicit owner-approved ceilings, and
separate plan-step versus slice accounting. The latest kernel run has 16 tests:
1 passed and 15 failed, with no skips. No runtime budget repair is claimed.

Local Node is **25.2.1**, installed TypeScript **5.9.3**; CI targets Node 22.
An isolated, synthetic-only scratch Redis database was provisioned using the
official agent scratch-storage service (ID
`b3b38ec8-9c83-486e-8fce-0c627b53d8a1`, expires 2026-10-05). Its TCP endpoint
times out (`ETIMEDOUT`) from this host. No token was written to repository files
or logs; no production database was used. Docker startup did not expose an
engine socket. The durable process-kill gate is therefore **not verified**;
memory-only instrumentation does not substitute for cross-process persistence.

### User-authorized account Redis proof (2026-10-02)

The user explicitly authorized the Redis connection in `.env`. A read-only
TCP/TLS `PING` succeeded outside the sandbox. The installed production client
is ioredis **5.11.1**. Test workers now prefix every physical key with a fresh
`chusky-proof:{UUID}:` namespace. A command guard rejects unprefixed keys,
database-wide flush/config operations and pattern scans before dispatch. The
real client key transformation is tested for ordinary keys, WATCH and Lua KEYS;
production source/client configuration is unchanged. Known synthetic keys are
tracked over IPC and receive 24-hour retention after a proof run, with no scan
or deletion of existing account data. External model/provider work stays fake.

Three repeated real-account proof runs each had **2 tests: 1 passed, 1 failed,
0 skipped**. Normal coordinator completion passed; killing a leased worker and
restarting the same mission/task failed each time, leaving the mission
`running`. This verifies a real durability defect, not recovery success.
The exhaustive per-await matrix remains unverified; account Redis reachability
is no longer the blocker. Credentials were not printed or persisted in tests.

The fake clock now optionally drives actual production heartbeat/deadline
timers and drains async store continuations. A new 30-day proof uses the full
coordinator rather than manually renewing leases. Three repeated local runs
each had **9 tests: 6 passed, 3 failed, 0 skipped**. The failing paths remain
human-input inference fallthrough, the 100-step plan cap, and the absent daily
scheduled wake. Passing clock/isolation tests do not certify those repairs.

### Lease recovery repair checkpoint

Both store backends now allow a running task with an explicitly expired lease
to be claimed under a new token. Expiry itself also revokes renewal and
settlement authority; it does not depend on a replacement arriving first.
Blocked, cancelled and completed tasks remain ineligible. The public task
regressions first failed, then passed (10 tests, no skips). The isolated account
Redis process-kill proof now passes both tests in one run, preserving mission
and task identity. This is not exhaustive crash acceptance: shared-connection
WATCH/MULTI atomicity, provider replay safety and recovery without a delivery
still require separate repairs and proofs. Context7 ioredis documentation was
consulted; installed client remains 5.11.1, and no client API was changed.

### Shared-client claim race

A real-account Redis regression launches eight simultaneous public task claims
on the production store's shared client. The original WATCH/MULTI path failed
the exactly-one-owner check. The claim path now compares the complete raw owner
task record and writes its replacement in one Lua operation, returning success
only when the comparison matches. Its first real-Redis rerun and a subsequent
three-fixture repetition passed; the memory task suite (10 tests), typecheck
and build also passed. Stored keys and formats
are unchanged. Other WATCH/MULTI mutators are still under audit; this repair
does not certify all task/mission transitions or cross-process races.

### Human-input handoff repair

The full production slice regression first confirmed that a human-input wait
fell through to inference. It now returns a blocked task with the saved owner
next action, preserving the mission's wait key and checkpoint without calling
the model. Unknown or missing wait conditions also fail closed. Extending the
test through explicit owner resume exposed a second failure: generic resume
rejected human-input waits. Resume now accepts only this additional wait kind;
timer, provider-event and approval waits retain their distinct gates. The same
mission and task then complete through real native dispatch and settlement.
Three repeated runs of normal completion, early timer and human wait/resume
each passed all three tests without skips. Typecheck and build passed. This
does not prove notification delivery or live human-input transport behavior.

### 200-step coordinator proof

Creation and replanning previously rejected plans above 100 steps, and store
normalization silently truncated persisted dependency graphs at 100. The
internal bound is now 1,000; normalization preserves the full graph. Execution
budgets and approval authority are unchanged. The full coordinator's 200-step
mixed soak passed in three repeated runs: 200 distinct confirmed fixture
effects, 200 completed steps, strict verification, dependency joins, timer and
provider waits, approvals, a replan, forced failures, and duplicate/reordered
deliveries. Restoring the old read-time truncation made the proof fail with
100 versus 200 outcomes; removing that mutation restored the repair.
The existing mission/worker suite passed 32 tests with no skips; typecheck and
build passed. This is an internal deterministic runtime proof, not public
contract parity: tool schemas, SDK/API bounds and release artifacts still need
alignment. It also does not certify live provider effects, exhaustive crashes,
arbitrary plan growth beyond the current bound, or the 30-day work schedule.

### Durable work-window scheduling proof (2026-10-02)

Mission records now persist an optional validated `workSchedule` containing an
IANA timezone, same-day opening/closing times, daily execution allowance, and
slice cadence. Native mission start exposes the contract, idempotency includes
it, and the scheduler calculates the next local opening without changing the
immediate behavior of unscheduled missions. A new slice is deferred to the
next day when the remaining window is shorter than one cadence, preventing a
same-day hot loop at the closing boundary.

The real coordinator proof passed all five tests: normal production slice,
timer wait, human-input wait/resume, the 200-step mixed soak, and the 30-day
mission with a three-hour daily UTC window. The 30-day case renewed the active
lease while advancing through the window, scheduled exactly one 09:00 durable
wake per day, retained no heartbeat timers during rest, and completed all 30
strictly evidenced steps. Typecheck, build, focused mission suites, and
`git diff --check` passed. The proof uses the real store and scheduler with a
fake clock/QStash boundary; it does not publish a live QStash message or claim
live provider delivery.

The configured production QStash token, signing keys, public workflow URL, and
workflow endpoints were confirmed present by variable name only; secret values
were not printed. The local workflow contract suite passed 28 tests. Per the
QStash SDK contract, publishing is an external side effect, so no live probe
was sent during this audit.
## Durable recovery sweeper proof (2026-10-02)

The recovery path is now independent of a fresh QStash delivery. Mission creation registers the owner in a durable owner index (`chuck:missions:owners` in Redis; a process-local set in memory-only tests). `recoverAllMissions()` scans bounded owner/mission sets and delegates owner-scoped reconciliation to `recoverMissionsForOwner()`.

| Failure state | Recovery behavior | Proof |
|---|---|---|
| Running mission with a queued task whose workflow publication was lost | Clears/reuses the expired enqueue claim and republishes through the existing idempotent enqueue path | `tests/mission-recovery.test.ts`: lost-delivery case passed |
| Overdue timer wait | Resumes the exact persisted mission wait and schedules the existing task; it does not create a replacement task | `tests/mission-recovery.test.ts`: timer case passed |
| Expired in-flight worker lease | Quarantines the task, clears stale lease authority, blocks the mission, and requires provider receipt/read-back before repair; no blind replay | `tests/mission-recovery.test.ts`: expired-lease case passed |
| Provider-event, approval, or human-input wait | No automatic resume; the exact external control remains authoritative | Covered by existing provider-event, approval, and human-input wait suites |

The application starts a bounded two-minute recovery interval after store and handler initialization. The interval is `unref()`'d and cleared during shutdown. The sweeper is intentionally conservative around expired leases: lease loss is not proof that a provider write did not happen.
