# Mission execution kernel audit

Date: 2026-10-02. Branch: `mission-execution-kernel`.
Audit evidence through: `ed310a0`.

## Status and evidence standard

Phase 0 is in progress. This is a defect inventory, **not a release certificate**.
Runtime repairs have been applied through the baseline above. The evidence
column names tests actually rerun for this audit; it is not a release
certificate. A path is marked
untested where the requested crash/transport/window proof does not exist or has
not been established. Broken means a concrete code path contradicts the target.
The unrelated `chusky-voice` working-tree edits are excluded from this work.

Current regression evidence: `VOICE_MAX_TOKENS=192 npm test` completed with
**1,238 tests, 1,234 passed, 0 failed, 4 skipped**. The skips are the two
platform-dependent PTY checks and two opt-in Recall staging checks. The run
included the production coordinator, 200-step mixed soak, 30-day work-window
simulation, process-crash probes, recovery sweeper, mission control, and
worker-dispatch suites.

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
| Step completion | `store.completeMissionStep`; `completeMissionStepAndAdvance` | `missions`, `task-slice-proof`, `mission-kernel-proof` tests | Partial repair: the real worker slice completes evidence-bearing steps and the 200-step strict coordinator closes every step; crash-after-completion and live provider evidence remain separate proofs. |
| Fan-out / join | `readyMissionSteps`, `scheduleMissionSteps`; step-scoped execution leases in `store` | `missions`, `mission-timing`, `task-slice-proof`, `mission-kernel-proof` tests | Partial repair: dependency-ready branches have independent durable leases, joins, duplicate/reordered deliveries, and mixed waits are covered in the production coordinator soak; multi-process Redis contention remains an integration proof. |
| Checkpoint | `checkpointMission`; `missionSliceHasPersistedProgress` | `mission-worker`, `missions`, `mission-kernel-proof` tests | Partial repair: repeated identical checkpoints no longer create a new progress frontier, and confirmed provider calls are checkpointed server-side; bounded mission context and full crash proof remain open. |
| Timer wait / wake | `waitMission`, `resumeMissionFromTimer`; HTTP timer branch | `mission-timing`, `mission-worker`, `task-wait`, `mission-kernel-proof` tests | Partial repair: timer resume now rejects future deadlines and the scheduler emits the next daily work-window wake; live QStash wake delivery remains an integration follow-up. |
| Provider event wait / resume | `resumeMissionFromProviderEvent`; Composio signed trigger route; CLI/SDK event routes | `missions`, `mission-kernel-proof`, trigger and SDK route tests | Partial repair: replay detection uses exact provider/event identity, and a retry after the mission CAS can reconcile a running mission whose continuation publication was lost; live signed delivery/restart and multi-process callback proof remain integration follow-ups. |
| Approval wait / resume | `missionApproval`; `resumeMissionFromApproval`; callbacks | `mission-approval`, `approval`, `task-slice-proof`, SDK tests | Partial repair: the production coordinator claims and resumes exact approvals on the same durable task identity; crash after approval claim and live callback delivery remain integration proofs. |
| Human-input wait | mission waiting union; `taskSlice` wait dispatch; `resumeMissionAndSchedule` | `task-slice-proof`, `mission-process-instrumentation` tests | Partial repair: the worker stops before inference, persists the exact owner-choice blocker, and resumes the same task after owner input; transport-specific resume delivery remains separate. |
| Replan | `replanMission`, `replanMissionAndSchedule`; SDK replan mapping | `missions`, `real-world-upgrade`, `task-slice-proof`, `mission-kernel-proof` tests | Partial repair: verified steps, evidence requirements, tool fences, dependency-ready branches, and a live 200-step replan are preserved; plan-revision fencing for already-running external work remains open. |
| Repair | `repairMission`; `claimMissionAutomaticRepair`; `missionRecovery.recoverMissionsForOwner`; reliability `diagnoseMissionRepair` | `missions`, `reliability`, `mission-recovery` tests | Partial repair: a server-classified no-progress exhaustion receives one CAS-claimed automatic reactivation; provider-failed and provider-uncertain outcomes remain manual and cannot be replayed. |
| Compensation | `autonomy/actions`; reliability persistence / native compensation | `autonomy-actions`, `reliability`, `mission-kernel-proof` tests | Partial repair: an uncertain mission write queues one owner-scoped, idempotent compensation; the compensation lease settles once and completed recovery is replay-safe. Native provider read-back, live approval transport, and process-crash recovery across the provider boundary remain integration follow-ups. |
| Pause | `pauseMission`, `cancelMissionTasks`; native/API/Telegram surfaces | `missions`, `handler-contract`, route tests | Partial repair: Telegram, native, CLI, SDK, and A2A pause paths cancel every mission branch, including parallel queued/running tasks; in-flight provider/model cancellation and late completion after pause across processes remain open. |
| Resume | `resumeMission`, `resumeMissionAndSchedule` | `missions`, `mission-approval`, `task-slice-proof`, `mission-timing`, `mission-recovery` tests | Partial repair: explicit waits, approved retries, no-progress repair, and provider-uncertain quarantine use distinct persisted paths; provider reconciliation is still required before replaying ambiguous work. |
| Cancel | `cancelMission`, `cancelMissionTasks`, `cancelTask`; abort polling; Telegram/A2A REST/JSON-RPC cancellation | `missions`, `tasks`, `task-runner`, `handler-contract`, `sdk-api` route tests | Partial repair: Telegram, A2A, and owner/API cancellation fan out across every active mission branch, and late slice settlement cannot mutate a cancelled terminal record. Cancellation cannot undo an already-dispatched provider effect; exhaustive cross-process late-response and lease-loss-at-every-await proof remains open. |
| Budget preflight | `missionBudgetPreflight`; HTTP worker admission | `mission-timing`, `missions`, `mission-kernel-proof` | Partial repair: completed plan steps and worker slices are separate counters, `maxSlices` is independently enforced, and detailed agent outcomes charge repeated provider calls individually; live multi-worker budget contention remains open. |
| Budget extend | `extendMissionDurationIfEligible`, duration approval | `mission-timing`, `mission-approval`, `mission-kernel-proof` tests | Partial repair: owner-approved duration extension is bounded by saved ceilings and only consumes on completed progress; general slice/tool/cost ceiling negotiation remains narrower than duration management. |
| Budget reduce | `updateMissionControl`; native, SDK, and CLI mission control routes | `mission-control`, `mission-native-limits`, `sdk-api`, `cli-client` tests | Partial repair: the worker and owner-facing API/CLI can shrink saved budgets only within owner ceilings, preserve usage, and block with an exact resume action when the active frontier is exceeded; more adversarial concurrent reductions remain open. |
| Work schedule / rest | `MissionRecord.workSchedule`; `missionScheduler.nextMissionWorkWindow`; native/API/CLI control | `task-slice-proof`, `mission-timing`, `mission-kernel-proof`, `mission-control` tests | Partial repair: UTC daily windows, cadence, active-time accounting, durable rest across 30 simulated days, and a worker-driven queued-window change are covered; DST/timezone matrix and live QStash timers remain integration proofs. |
| Lease renew / loss | `renewTaskLease`; task runner renewal; HTTP mission renewal | `task-runner`, `tasks`, `mission-kernel-proof` tests | Partial repair: renewal and settlement reject expired tokens, and replacement workers receive a new lease; post-turn mission accounting still needs a broader crash proof. |
| Duplicate delivery | deterministic task IDs; enqueue claims; task leases | `task-enqueue`, `task-runner`, `tasks`, `real-world-upgrade`, `mission-kernel-proof` tests | Partial repair: deterministic task identity, publication timestamp recovery, and lease fencing prevent immediate duplicate continuations; reordered provider siblings remain a separate proof. |
| Retry loop | `settleTaskRun`, backend claim, HTTP ten-iteration loop, `TaskFailureClass` | `task-runner`, `missions`, `mission-kernel-proof`, `mission-recovery` tests | Partial repair: healthy persisted progress resets the consecutive retry budget; terminal no-progress failures carry a typed class and receive one bounded sweeper repair. Provider uncertainty is preserved as a manual blocker. |
| Recovery sweeper | `missionRecovery.recoverAllMissions`, `recoverMissionsForOwner`; two-minute interval in `index.ts` | `tests/mission-recovery.test.ts` | Partial repair: bounded owner discovery, lost queued delivery, overdue timer wakes, conservative expired-lease quarantine, and one idempotent no-progress repair are covered; live multi-instance cadence and QStash publication remain integration follow-ups. |
| Closeout / verify | `verifyMission`, `finalizeMissionIfReady`, scheduler closeout | `missions`, `reliability`, `task-slice-proof`, `mission-kernel-proof` tests | Partial repair: strict closeout requires independent trusted evidence and the 200-step production coordinator verifies all 200 receipts; mutation testing and live provider read-back remain open. |
| Event history | `store.listMissionEvents`, owner-scoped Redis event stream, SDK events route | `missions`, replay tests, SDK API tests | Partial repair: bounded mission state remains intentional, while a 5,000-event owner-scoped stream preserves long-horizon lifecycle history and insertion order for the SDK/API; archival beyond the bounded stream and live Redis retention remain open. |
| Record retention | Redis and memory `createTaskIfAbsent` / `createMissionIfAbsent` / mission event stream | `mission-kernel-proof`, `missions` | Partial repair: unfinished tasks are retained while completed/cancelled task history is bounded; mission archival beyond the 5,000-event stream remains open. |
| Notifications / daily digest | mission update notifier; delivery/outbox paths | Delivery tests; no schedule digest proof | Untested: channel-neutral deduplicated blocker/daily digest recovery. |
| Delegation | `subagents/executor`; `/workflows/subagent` | `subagents`, delegation tests | Partial repair: delegated continuations and approval resumes now claim, renew, and release the durable task lease, so duplicate deliveries cannot run the same slice concurrently; child-to-parent mission evidence linkage and live provider receipt fencing remain open. |
| Native mission/task tools inside worker | `nativeTools`; `MISSION_WORKER_CONTROL_TOOLS`; agent catalog | `mission-native-limits`, `mission-control`, `agent-contract`, `task-slice-proof`, tool schema tests | Partial repair: real worker dispatch reaches lifecycle controls, waits, evidence, and the owner-bounded `CHUCK_MISSION_CONTROL` budget/work-window path while supervisor-only tools remain fenced; exhaustive every-slug matrix is still not a release proof. |
| Tool discovery / fences | mission allowlist and agent discovery | `mission-worker`, `agent-contract`, delegation, `task-slice-proof` tests | Partial repair: explicit step fences and inherited worker grants are validated in the real dispatch path; live schema hydration for every connected provider remains unverified. |
| Batch outcomes | agent execution, tool-activity correlation, autonomous receipts, `missionSlice.settleMissionSlice` | `tool-activity`, `autonomy-actions`, `mission-kernel-proof` tests | Partial repair: per-call outcomes distinguish success, failure, and uncertainty; mixed or unmatched batch actions are non-clean and cannot close a mission. Live provider receipt matrices remain unverified. |
| Bounded mission context | `missionWorker.boundedMissionHistory`; HTTP task slice | `mission-worker`, `mission-agent-proof` tests | Partial repair: mission turns receive a bounded recent text frontier while durable checkpoint/step state remains authoritative; compacted evidence summaries and crash/restart context proof remain open. |
| CLI | `cli.ts` mission commands and details; `index.ts` CLI routes; `store.listMissionEvents`; client | CLI tests, `mission-doctor`, `mission-control` tests | Partial repair: `/mission doctor <id>` reports bounded owner-scoped health, leases, waits, budget, and recovery action, `/mission events <id>` now reads the durable event stream, and `/mission control <id> <JSON>` edits owner-bounded budgets and work windows; the detail view still labels the legacy counter as steps. |
| SDK / API | `sdkApi.ts` mission routes; SDK types/OpenAPI; `store.listMissionEvents` | SDK API/client, `mission-doctor`, `mission-control` tests | Partial repair: owner-scoped events, doctor, and typed `missions.control()` expose durable lifecycle history, deterministic diagnosis, and bounded budget/work-schedule changes; full replan fence fields and live multi-process controls remain absent. |
| Web | `chusky-web/components/app/missions-page.tsx` | No end-to-end proof established | Untested: public response parity and full long-horizon state presentation. |

Additional inspected boundary note: expired lease renewal is now rejected by
both store backends and covered by task/mission proof tests. The SDK repair
surface still records a bounded diagnosis while the dashboard labels its
action "Repair and resume"; that product-surface mismatch remains open and is
not represented as a runtime recovery guarantee.

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

The deterministic acceptance scenarios for the 200-step mixed soak,
30-day/three-hour schedule, sweeper repair, self-managed ceilings, and
sloppy-model handoff now run in the production-coordinator proof suite. The
process-kill harness also exercises the real production awaits and the
authorized Redis proof has covered lease recovery and claim races. Remaining
verification gaps are exhaustive crash-at-every-await coverage against all
provider boundaries, mutation testing of safety guards, live QStash delivery,
live provider receipts/read-backs, and public web parity. The exact
recursive-submodule CI command sequence has not been run on this Windows host;
Linux-only dependency setup remains a CI responsibility.

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
`tests/task-slice-proof.test.ts` and `tests/mission-kernel-proof.test.ts` now
pass native completion, early timer parking, human-input wait/resume, the
200-step mixed coordinator soak, and the 30-day window proof. The red results
below are retained as repair provenance, not as the current status.

Both recursive submodules were initialized without force; their existing clean
checkouts already matched the committed gitlinks. Git's submodule helper needs
the Git Bash `/usr/bin:/mingw64/bin` PATH in this Windows environment. The
earlier local Docker/scratch-Redis attempt was unavailable; the authorized
Redis proof is documented below. The repeated-checkpoint and lost-publication
regressions were historical red tests that drove the current repairs; their
current production-coordinator and recovery-sweeper counterparts now pass.
The complete kernel tranche was previously run three consecutive times as a
stable red regression before the repairs. The current full suite supersedes
that snapshot: it includes the repaired kernel, production coordinator, crash
probes, recovery sweeper, budget-control, and long-horizon schedule tests.
Exhaustive provider-boundary crash/reconciliation, independent live QStash,
and budget-ceiling concurrency proofs remain outstanding.

### Process-kill harness status

`tests/helpers/missionProcessHarness.ts` compiles an isolated copy of the real
production runtime with test-only probes before/after every project `await`.
Probes run in child processes and the parent can issue `SIGKILL`; this does not
throw a recoverable exception or execute worker `finally` cleanup. Production
source and deployed builds contain no crash hooks. The production-coordinator
instrumentation and process-kill proof suites now pass their deterministic
fixtures, covering internal and strict completion, timer/provider/approval
waits, checkpoint, failure, prose-only output, cancellation and replan. The
authorized Redis proof also covers lease recovery and claim races. This still
does not certify every observed await against live provider writes; cancellation
before durable persistence and approval before its exact action is recorded
need explicit production-boundary recovery expectations.

The budget proof now covers worker access to the existing resume control,
bounded extension and reduction inside explicit owner-approved ceilings, and
separate plan-step versus slice accounting. Remaining budget work is limited
to adversarial concurrent live-Redis reductions and public UI parity.

Local Node is **25.2.1**, installed TypeScript **5.9.3**; CI targets Node 22.
An isolated, synthetic-only scratch Redis database was provisioned using the
official agent scratch-storage service (ID
`b3b38ec8-9c83-486e-8fce-0c627b53d8a1`, expires 2026-10-05). Its TCP endpoint
timed out (`ETIMEDOUT`) from this host and Docker had no engine socket. That
scratch resource is not used as evidence. The authorized production Redis
proof is the evidence for the narrower lease and claim tests; no token was
written to repository files or logs.

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

The authorized real-account Redis proof now passes the lease-recovery and
shared-claim-race fixtures used by the kernel. This verifies key isolation,
lease fencing, replacement claims, and task identity preservation without
publishing provider work. It is not an exhaustive per-await matrix and does
not certify live QStash or provider behavior. Credentials were not printed or
persisted in tests.

The fake clock now drives actual production heartbeat/deadline timers and
drains async store continuations. The 30-day proof uses the full coordinator,
renews leases during the daily window, and persists one durable wake per day.
The current production-coordinator run passes the human-input,
200-step, and 30-day paths; live delivery and provider effects remain outside
its claim.

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
alignment. It does not certify live provider effects, exhaustive crashes, or
arbitrary plan growth beyond the current bound; the separate 30-day schedule
proof is recorded below.

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

### Mission-control proof (2026-10-02)

Owner-facing mission control is now a single bounded path shared by the store,
SDK API, CLI, and scheduler. A control request may reduce or extend a budget
only inside the saved owner ceiling and may set a validated timezone-aware daily
work window. Consumption is never reset by a control edit. If a reduction is
already below the consumed frontier, the mission becomes explicitly blocked
with a resume action rather than silently exceeding the new limit. Changing a
work window reschedules queued branches while leaving a live lease untouched;
late deliveries still pass through the task claim CAS.

`tests/mission-control.test.ts` proves ceiling enforcement, consumption
preservation, schedule rescheduling, and active-budget blocking. The SDK API,
SDK client, and CLI client contract tests prove the owner-scoped public paths.
This does not yet prove concurrent live Redis control edits or a live QStash
delivery race.

### Bounded retry-repair proof (2026-10-02)

Task settlement now persists a typed `lastFailureClass` rather than forcing the
recovery layer to infer safety from prose. Only `no_progress` is eligible for
one automatic repair claim; the claim is CAS-protected, resets the consecutive
task attempt counter, and resumes the existing mission/step/task identity.
`provider_uncertain` and `provider_failed` never enter this path and retain the
manual receipt/read-back boundary. `tests/mission-recovery.test.ts` proves the
repair, the second-sweep idempotency, and the uncertain-provider refusal.
