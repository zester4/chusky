# Mission execution kernel audit

Date: 2026-10-02. Branch: `mission-execution-kernel`.
Baseline: `ed4d6bb5c871315ad1933cdc15251d68b0ce9287`.

## Status and evidence standard

Phase 0 is in progress. This is a defect inventory, **not a release certificate**.
No runtime repair has been applied. Existing test-file references identify
coverage to inspect, not tests rerun or end-to-end guarantees. A path is marked
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
| Create / plan | `store.createMission`, `normalizeMission`; `missionScheduler.validateMissionStepsPayload`; native START | `missions`, `mission-native-limits`, `agent-contract` tests | Broken: 100-step input cap and normalization truncation; typed metadata is not an executable contract throughout transports. |
| Schedule / enqueue | `missionScheduler.scheduleMissionSteps`, `reconcileMissionExecution`; `taskEnqueue.enqueueTaskWithClaim` | `missions`, `task-enqueue`, `trigger-workflow` tests | Broken: recorded workflow ID prevents republication after accepted-but-lost delivery; no independent recovery scan. |
| Claim / lease | store backend `claimTask`; `taskRunner.executeDurableTask` | `tasks`, `task-runner` tests | Broken: an expired running task cannot be claimed as queued; recovery needs a fenced transition. |
| Slice execution | `index.ts` `/workflows/task` | Helper tests in `mission-worker`; no extracted whole-route harness | Broken: inline control flow, success/uncertainty collapsed to slug sets, shared session context, no work windows. |
| Step completion | `store.completeMissionStep`; `completeMissionStepAndAdvance` | `missions` tests | Untested: full-route evidence-driven completion with sloppy model and crash boundaries. |
| Fan-out / join | `readyMissionSteps`, `scheduleMissionSteps` | `missions` tests | Broken: DAG fan-out exists, but HTTP worker acquires a mission-wide lease and owner lock, serializing execution. A mission-wide wait also parks unrelated branches. |
| Checkpoint | `checkpointMission`; `missionSliceHasPersistedProgress` | `mission-worker`, `missions` tests | Broken: arbitrary event/state differences can count as progress; repeated identical checkpoint events can reset a future retry policy without advancing work. |
| Timer wait / wake | `waitMission`, `resumeMissionFromTimer`; HTTP timer branch | `mission-timing`, `mission-worker`, `task-wait` tests | Broken: low-level timer resume checks exact timestamp but not that the timestamp elapsed. No daily scheduling contract. |
| Provider event wait / resume | `resumeMissionFromProviderEvent`; SDK signed events route | `missions`, SDK route tests | Broken: replay detection uses message substring rather than exact structured event identity. Delivery/restart proof remains missing. |
| Approval wait / resume | `missionApproval`; `resumeMissionFromApproval`; callbacks | `mission-approval`, `approval`, SDK tests | Untested: mixed parallel branch approval, crash after approval claim, and same-task end-to-end continuation. |
| Human-input wait | mission waiting union; HTTP waiting dispatch | None established for whole route | Broken: no explicit human-input stop branch; dispatch falls through toward execution. |
| Replan | `replanMission`, `replanMissionAndSchedule`; SDK replan mapping | `missions` tests | Broken: unfinished step reconstruction loses typed/evidence/compensation metadata; retained task IDs can preserve stale objective/fences. No plan-revision fencing of in-flight work. |
| Repair | `repairMission`; reliability `diagnoseMissionRepair` | `missions`, `reliability` tests | Broken: diagnosis exists, but exhausted task retries immediately fail the mission rather than entering bounded automatic repair. |
| Compensation | `autonomy/actions`; reliability persistence / native compensation | `autonomy-actions`, `reliability` tests | Untested: leased execution, provider read-back, approval and restart of compensation attached to a failed branch. |
| Pause | `pauseMission`, `cancelMissionTasks`; native/API surfaces | `missions`, route tests | Untested: cancellation of in-flight provider/model work and late completion after pause across processes. |
| Resume | `resumeMission`, `resumeMissionAndSchedule` | `missions`, `mission-timing` tests | Broken: scheduler retries blocked/failed/cancelled step tasks without a machine-readable safe-replay distinction. |
| Cancel | `cancelMission`, `cancelTask`; abort polling | `tasks`, `task-runner`, route tests | Untested: late external response, duplicate continuation and lease loss at every await. Cancellation cannot undo an already-dispatched provider effect. |
| Budget preflight | `missionBudgetPreflight`; HTTP worker admission | `mission-timing`, `missions` tests | Broken: `consumedSteps` increments per slice, not completed plan step; repeated same-slug calls undercount through deduplicated tool sets. |
| Budget extend | `extendMissionDurationIfEligible`, duration approval | `mission-timing`, `mission-approval` tests | Broken: only narrow active-duration extension exists, not general owner-ceiling management of slices/tools/cost. |
| Budget reduce | `resumeMission` rejects smaller duration | No reduction coverage | Broken: no supported shrink operation. |
| Work schedule / rest | No mission schedule field | No coverage | Broken: healthy slices requeue approximately every five seconds; no hours/day, windows, cadence or timezone. |
| Lease renew / loss | `renewTaskLease`; task runner renewal; HTTP mission renewal | `task-runner`, `tasks` tests | Broken: settlement checks token but not expiry; expired holder can settle before replacement. Mission lease is released before post-turn accounting. |
| Duplicate delivery | deterministic task IDs; enqueue claims; task leases | `task-enqueue`, `task-runner`, `tasks` tests | Untested: duplicate/reordered deliveries combined with replan, restart and ambiguous provider siblings. |
| Retry loop | `settleTaskRun`, backend claim, HTTP ten-iteration loop | `task-runner` tests | Broken: healthy continuation consumes attempts; no reset on genuine progress. Prompt labels every attempt above one as prior no-progress. |
| Recovery sweeper | No mission-level independent scanner established | No coverage | Broken: recovery depends on a subsequent delivery or explicit supervisor reconciliation. |
| Closeout / verify | `verifyMission`, `finalizeMissionIfReady`, scheduler closeout | `missions`, `reliability` tests | Untested: 200-step strict evidence retention and mutation tests. Legacy closeout is intentionally different and must stay explicitly labelled. |
| Event history | normalized `mission.events` / evidence arrays | `missions`, replay tests | Broken: last 500 events and 100 mission evidence entries retained; long-horizon proof history is truncated. |
| Record retention | Redis and memory `createTaskIfAbsent` / `createMissionIfAbsent` | Existing tests do not establish active-record retention | Broken: insertion retains only the newest 100 records, regardless of status. Creating enough work can evict an unfinished task or mission. Memory task CAS also truncates the list. |
| Notifications / daily digest | mission update notifier; delivery/outbox paths | Delivery tests; no schedule digest proof | Untested: channel-neutral deduplicated blocker/daily digest recovery. |
| Delegation | `subagents/executor`; `/workflows/subagent` | `subagents`, delegation tests | Broken: continuation marks task running without leased claim; child task lacks mission linkage; provider path needs mission receipt fencing; prose can be classified success. |
| Native mission/task tools inside worker | `nativeTools`; `MISSION_WORKER_CONTROL_TOOLS`; agent catalog | `mission-native-limits`, `agent-contract`, tool schema tests | Untested: every tool from actual worker context, including deliberate supervisor-only rejection and wait linkage. |
| Tool discovery / fences | mission allowlist and agent discovery | `mission-worker`, `agent-contract` tests | Untested: schema-valid discovered provider tools across explicit step fences and inherited account grants. |
| Batch outcomes | agent execution, tool-activity correlation, autonomous receipts | `tool-activity`, `autonomy-actions` tests | Untested: per-call mixed batch failure/uncertainty through slice settlement. Wrapper return is not proof all sub-actions succeeded. |
| Bounded mission context | HTTP `runAgent` with owner session | Agent context tests | Broken: no dedicated bounded long-horizon frontier; shared history is used for mission execution. |
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
The remaining autonomy/reliability modules, complete SDK/CLI/web surfaces and
test implementations still require full inspection before runtime edits.
