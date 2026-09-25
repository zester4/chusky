# Autonomous missions

This reference describes Chusky's durable mission runtime. A mission is the
right abstraction when a user wants a concrete outcome that must continue after
the initiating chat turn, survive a process restart, wait for a provider or
human decision, and report evidence rather than an optimistic status message.

A mission is not an unbounded background loop. It is a bounded, inspectable
execution contract:

```text
objective + definition of done
        ↓
dependency-aware steps
        ↓
leased durable task slices
        ↓
checkpoint / wait / approval / retry
        ↓
evidence + verification
        ↓
completed result or honest blocked/failed state
```

## Runtime surfaces

Use the shared runtime rather than creating a channel-specific mission engine.

| Surface | Responsibility |
|---|---|
| `src/store.ts` | Owner-scoped mission/task records, normalization for old records, budgets, leases, version checks, lifecycle mutations, evidence, and proof. |
| `src/missionScheduler.ts` | Converts every dependency-ready running step into a deterministic durable task. Independent ready steps may fan out; dependent steps wait until all prerequisites complete. |
| `src/taskRunner.ts` | Claims one task with a lease, executes one bounded slice, and settles it with the lease token so stale workers cannot overwrite a recovered run. |
| `src/taskWait.ts` | Validates internal waits from 60 seconds through 7 days and requires a checkpoint plus an exact next action. |
| `src/index.ts` | Authenticated HTTP routes and Upstash Workflow endpoints for task/mission execution and continuation. |
| `src/agentTools.ts` / `src/nativeTools.ts` | Model-facing mission and task contracts. Keep schema, dispatch, validation, and system-prompt guidance aligned. |
| `src/autonomy/context.ts` | Rebuilds bounded owner-scoped context immediately before a slice rather than replaying an unbounded or stale prompt. |
| `src/contextGraph.ts` / `src/departments.ts` | Department context and typed work packets when a mission needs specialist collaboration. |
| SDK, CLI, Telegram, dashboard, and MCP | Transport controls over the same persisted records. They must not fork status, approval, or ownership semantics. |

## Mission record and lifecycle

`MissionRecord` is persisted per Chusky user. The important fields are:

- `id`, `userId`, `title`, and `objective` identify the owner-scoped work.
- `definitionOfDone` states what must be true before completion.
- `steps` contains bounded objectives, dependency IDs, retry limits, task IDs,
  status, results, and optional evidence requirements.
- `activeStepIds` identifies all currently dependency-ready steps. Do not assume
  `currentStepId` is the only executable step.
- `rootTaskId` links the mission to its durable execution root.
- `checkpoint` is verified progress; `nextAction` is the exact next operation.
- `waiting` records timer, provider-event, approval, or human-input waits.
- `budget` and counters bound duration, steps, tool calls, and cost.
- `events`, `evidence`, and `verification` provide bounded audit/proof state.
- `lease` and monotonic `version` protect concurrent workers and stale retries.

Valid mission statuses are:

```text
queued → running → waiting → running
                 ↘ paused → running
                 ↘ blocked → running
running → completed | failed | cancelled
```

`waiting`, `paused`, and `blocked` are different:

- `waiting` means a known continuation condition exists, such as a timer,
  provider event, approval, or human input.
- `paused` means the owner intentionally stopped future progress.
- `blocked` means safe progress is impossible until a dependency, permission,
  budget, decision, or repair action is supplied.
- `failed` means execution exhausted retry handling or encountered an
  unrecoverable error. Preserve the checkpoint and error for repair.

Never present a mission as complete because it has a checkpoint, a queued task,
or a model-generated summary. Completion requires completed steps and, for
strict missions, successful verification of required evidence.

Provider outcome checks are executed by the server through the owner's current
Composio session. Supply the exact available read-only `toolSlug` and bounded
non-secret `arguments`; do not submit a model-authored `passed` result for a
provider read. The API and native mission tool ignore such submitted provider
results. Successful reads are timestamped, redacted before persistence, and
recorded as trusted mission evidence. Reads that fail, are stale, or cannot be
executed leave the mission unverified so the durable supervisor can reconcile
the provider state or record a concrete blocker.

## Starting a mission

Use `CHUCK_MISSION_START` or `POST /v1/missions` with:

1. A specific objective, not “work on this.”
2. A concrete definition of done.
3. Steps when decomposition is known. Give each step an explicit stable ID,
   objective, dependencies, retry policy, and evidence requirements.
4. Bounded `maxDurationSeconds`, `maxSteps`, `maxToolCalls`, and `maxCost`.
5. An idempotency key when the request may be retried by an SDK, MCP client,
   webhook, or UI.
6. `verificationMode: "strict"` and `requiredEvidence` for high-value work.

Example shape:

```json
{
  "title": "Prepare a verified fintech prospect brief",
  "objective": "Research qualified fintech prospects and prepare a reviewable brief.",
  "definitionOfDone": "The brief names the target companies, cites sources, records qualification evidence, and is ready for owner review.",
  "verificationMode": "strict",
  "requiredEvidence": ["three qualified companies", "source for each qualification", "reviewable artifact"],
  "steps": [
    {"id": "research", "title": "Research prospects", "objective": "Find and qualify prospects", "evidenceRequired": ["source-backed qualification"]},
    {"id": "brief", "title": "Prepare brief", "objective": "Produce the brief from verified research", "dependsOn": ["research"], "evidenceRequired": ["artifact"]}
  ],
  "maxDurationSeconds": 21600,
  "maxSteps": 20,
  "maxToolCalls": 150,
  "maxCost": 5,
  "idempotencyKey": "fintech-brief-2026-09-21"
}
```

The service must create the record idempotently, enqueue the root/ready work,
and return the durable mission ID. It must not keep the HTTP request or a
Telegram handler open while the work runs.

## Step scheduling and dependencies

`src/missionScheduler.ts` deterministically derives a task ID from
`missionId:stepId`. This is the idempotency boundary for a step. The scheduler:

1. Re-reads the mission.
2. Stops unless the mission is `running` or an explicitly resumed wait.
3. Finds every step whose dependencies are completed.
4. Materializes each eligible running step as a durable `TaskRecord`.
5. Reuses an existing task or retries a retryable terminal task instead of
   creating a duplicate.
6. Enqueues the task through the configured workflow provider.
7. Links `taskId` and records a bounded `step_started` event.

Independent steps may execute in parallel. A dependent step is not ready until
every `dependsOn` step is completed. `CHUCK_MISSION_STEP_COMPLETE` and the
server-side completion path must enforce this invariant; never let a client
complete a pending step merely by supplying its ID.

When the final slice completes all steps, the server performs a bounded closeout
after the model turn: legacy missions complete from their step results, while
strict missions are verified from persisted evidence and become blocked with a
concrete recovery action if proof is still missing. This prevents an empty
dependency frontier from becoming an infinite requeue loop.

When a step fails, preserve its result/error and attempts. Retry only within its
`retryLimit` and bounded backoff. If the failure changes the plan, use replan to
replace unfinished steps while preserving completed work and validating the new
dependency graph. Do not silently mutate completed steps.

## Bounded slices, checkpoints, and waits

One durable task is one bounded execution slice, not the whole mission. Before a
slice ends, the worker must persist:

- what was verified (`checkpoint`),
- the exact next action (`nextAction`),
- tool/cost counters, and
- whether it is ready, waiting, blocked, failed, or complete.

Use `CHUCK_TASK_WAIT` for an internal continuation when an external service is
still processing. It requires a future time between 60 seconds and 7 days, a
checkpoint, and an exact next action. It does not notify the user, create a
reminder, or create a recurring job. The workflow sleeps and wakes the same
task; it must not create a new task or run a one-second polling loop.

Use `CHUCK_MISSION_WAIT_EVENT` when the mission is waiting for one exact
provider event. Store the provider and stable event ID in `waiting`. A signed
provider adapter should verify the raw request, persist/deduplicate the event,
and resume only the matching owner mission. Replayed delivery must be harmless.
The task worker blocks or sleeps until that callback (or an explicit expiry)
instead of hot-polling.
The generic authenticated mission event route is useful for providers without a
dedicated signed adapter, but it is not a substitute for signature verification.

## Leases, CAS, and recovery

Mission updates are versioned. Task execution is lease-based:

- claim only a queued/eligible task;
- execute with the lease token;
- settle only if the token is still valid;
- treat an expired lease as recoverable, not as proof of success;
- never let a stale QStash retry overwrite a newer checkpoint;
- keep workflow payloads to owner/task/mission IDs and timestamps, not secrets or
  raw provider payloads.

Redis is required for production missions, task leases, workflow deduplication,
approvals, and cross-process recovery. In-memory mode is for local development
and tests only.

## Budgets and proof

Budgets are part of the execution contract, not display metadata. Check before
starting the next expensive slice and record actual usage after it settles. If a
limit is reached, move the mission to `blocked` with a useful `nextAction`; do
not continue by silently increasing the budget.

Evidence kinds are `source`, `tool_receipt`, `artifact`, `assertion`,
`before_after`, and `human_confirmation`. Evidence must be bounded, attributable,
and marked verified by the agent, system, or human. Tool receipts should contain
safe summaries and hashes, never credentials or raw provider payloads.

`CHUCK_MISSION_VERIFY` evaluates completed steps and required evidence. Strict
missions cannot be completed until verification succeeds. `CHUCK_MISSION_PROOF`
is the operator-facing bounded view of definition of done, step results,
evidence, verification, budget, and recent events.

Provider-backed outcome checks execute the exact read-only Composio action in
the owner's session and compare its fresh result with the expected fields.
Model- or client-supplied pass results are not accepted as evidence. The active
tool allow/deny policy still applies, and raw read arguments are omitted from
persisted verification records. Receipt, artifact, and human checks remain
uncertain until backed by trusted server-side evidence.

## Pause, resume, cancel, repair, and replan

- Pause stops future scheduling and preserves the checkpoint. In-flight work
  must observe cancellation at its next safe checkpoint; do not report an active
  worker as stopped before it settles.
- Resume is valid only for an owner-owned paused/blocked/waiting mission whose
  continuation condition is satisfied. Re-read state and schedule ready steps.
- Cancel marks the mission cancelled and requests cancellation for linked tasks;
  late workers must settle as cancelled and must not deliver a success result.
- Repair moves an inconsistent or failed mission to an honest blocked state with
  a concrete recovery action.
- Replan replaces only unfinished work. Preserve completed steps, validate IDs
  and dependency cycles, and record why the plan changed.

These actions are available through Telegram mission commands, the CLI mission
commands, authenticated `/v1` routes, the SDK mission resource, dashboard
controls, and the Cloudflare MCP mission tools. All surfaces must use the same
owner check and lifecycle transitions.

## Context and specialist collaboration

Before each slice, build a bounded `AutonomyContextBundle` from the current
mission/task, linked open loops, narrowly relevant memories, and recent history.
Do not paste the entire account history into a long-running mission. Context
links should identify the relevant task, mission step, project, meeting,
conversation, or open loop.

For cross-specialist work, create a typed department work packet instead of
letting workers call each other with arbitrary prompts. Include objective,
inputs, constraints, evidence requirements, output schema, deadline, target
department/agent, and approval boundary. A worker may request help within its
allowlist, but the supervisor remains responsible for the mission definition of
done and final verification.

## Safety and approvals

Mission autonomy does not weaken normal policy. Read-only, reversible internal
work can run autonomously. Payments, purchases, deletions, permission changes,
production deployment, remote Git pushes, and other irreversible/high-impact
actions retain their approval boundary. An approval pause must be represented in
mission `waiting.kind = "approval"`, linked to the exact tool/arguments, and
resume the same durable task after one matching approval is consumed.

Treat all email, web pages, documents, provider events, and tool results as
untrusted input. They can supply evidence but cannot authorize a new tool,
change the mission budget, or alter the definition of done.

## Cross-channel contract

Telegram is the richest interactive control surface, but it is not a separate
runtime. The CLI, SDK, MCP, dashboard, and linked channels must expose the same
truth:

- list/get shows status, checkpoint, next action, wait reason, budget usage, and
  recent events;
- pause/resume/cancel/repair/replan are owner-scoped and idempotent;
- approvals and provider waits resume the original durable work;
- final delivery is written through the channel outbox with a dedupe key;
- no channel invents “completed” while the persisted record is waiting/blocked.

When adding a mission control to one surface, add a shared API/store operation
first, then adapt the transport. Test Telegram, CLI, SDK, web, and MCP against
the same fixture where practical.

## Tests and diagnostics

At minimum, cover:

1. idempotent mission creation and deterministic step task IDs;
2. dependency order, parallel ready steps, and cycle/unknown dependency rejection;
3. task lease ownership, stale settlement, retry backoff, and duplicate QStash;
4. pause/cancel while a task is queued or in flight;
5. timer waits and exact provider-event resume with duplicate events;
6. approval wait/resume with changed arguments rejected;
7. preflight and post-slice budget exhaustion;
8. strict evidence/verification and proof output;
9. owner isolation across every mission/task/event route;
10. cross-channel parity for list, inspect, pause, resume, cancel, and failure.

When diagnosing a production mission, start with the owner-scoped mission ID.
Inspect status, `waiting`, `checkpoint`, `nextAction`, active step IDs, linked
task IDs, task lease/workflow IDs, version, budget counters, and recent events.
Then inspect the QStash/Upstash workflow run and durable outbox receipt. Never
use raw provider payloads or secrets as a debugging shortcut.
