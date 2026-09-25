# Durable tasks, reminders, recurring jobs, and attention pulse

Chusky has several kinds of asynchronous work. Keep their contracts distinct;
collapsing them into “a background task” causes wrong notifications, stale
context, duplicate execution, and confusing controls.

## Choose the right primitive

| Primitive | Use it for | Continuation |
|---|---|---|
| Durable run | One SDK/API request that may outlive HTTP and has a run ID, thread, budget, and artifacts. | Run status/retry/resume APIs. |
| Durable task | One owner-scoped bounded execution unit with checkpoint, next action, lease, retry, and cancellation. | Task workflow wakes the same task. |
| Mission | A multi-step objective composed of dependency-aware durable tasks. | Mission scheduler plus task workflows. |
| Reminder | A one-time notification or one bounded check/action at a future time. | Delayed Workflow run. |
| Recurring job | A QStash CRON schedule with independent occurrences and optional bounded agent work. | New occurrence per schedule fire. |
| Attention pulse | An owner-enabled governor that reviews open loops/candidates/standing orders and handles or delegates actionable work. | Recurring job with pulse policy and delivery limits. |

Do not use a reminder for a long mission, a recurring job for a one-off wait, or
`CHUCK_TASK_WAIT` to notify a user. A task wait is internal continuation only.

## Task contract

`TaskRecord` is persisted outside the expiring chat session. It includes:

- `status`: queued, running, blocked, completed, failed, cancel_requested, or
  cancelled;
- `checkpoint` and `nextAction` for recovery;
- `attempt`, `maxAttempts`, `runAt`, and `workflowRunId`;
- a lease with token, worker ID, acquisition time, and expiry;
- bounded lifecycle events;
- optional SDK run/thread linkage;
- optional `missionId`/`missionStepId` linkage;
- optional meeting follow-up and Composer stage linkage.

The task runner in `src/taskRunner.ts` claims a task once, executes one bounded
slice, and settles it with a token-checked result. A stale worker may finish its
process, but it must not overwrite the task after lease recovery. Transient
failures are requeued only within `maxAttempts` with bounded backoff.

### Task state rules

- `queued` means eligible for a workflow enqueue, not already running.
- `running` means a worker currently owns the lease.
- `blocked` means the next action requires an external fix, permission, or
  decision; retrying without changing the condition is noise.
- `cancel_requested` means an in-flight worker must stop at its next safe
  checkpoint. Do not convert it to success if the worker returns late.
- `completed` requires a real result or durable side effect receipt.
- `failed` is terminal for the current attempt policy; retry preserves history.

Every task mutation must remain owner-scoped and should be idempotent. A
workflow payload contains IDs, not the prompt, credentials, or raw provider
payload.

## Internal durable waits

`CHUCK_TASK_WAIT` is the agent's self-continuation tool for work such as:

- a report export that says “processing”;
- a browser job that must be polled later;
- a provider operation with a known completion window;
- a meeting or external workflow that will be ready after a delay.

The model must provide a verified checkpoint, exact next action, and either a
future ISO timestamp or a delay between 60 seconds and 7 days. The current task
turn ends after the wait is recorded. The workflow wakes the same task and
rebuilds context before acting.

Never use a one-second re-enqueue loop. If a provider supports callbacks, prefer
an authenticated event wait with stable event ID and deduplication. If a timer
is unavoidable, choose the smallest provider-safe interval and record the
condition being checked.

## Reminders

`ReminderRecord` supports four modes:

- `notify`: deliver the configured text;
- `check_in`: wake the agent with linked context so it can inspect progress;
- `act`: execute one bounded autonomous slice;
- `wait_until`: check a condition at a bounded polling interval.

The record may carry links to a task, mission/step, open loop, attention
candidate, project, meeting, or conversation. It may also store preconditions,
postconditions, a next action, a delivery target, and a context snapshot.

At delivery time:

1. Verify the workflow signature and owner identity.
2. Re-read the reminder from Redis.
3. Stop if it is cancelled, paused, already sent, or expired.
4. Rebuild current context from links; treat the snapshot as a bounded hint, not
   authority.
5. Execute only the configured mode and normal tool policy.
6. Persist sent/failed/waiting state before delivery where applicable.
7. Deliver through the durable channel outbox with an idempotency key.

Pausing preserves the scheduled time and context. Resuming must not create a
duplicate delayed workflow. Run-now creates a separately identified durable
delivery/occurrence and must still re-read the record.

## Recurring jobs and occurrences

`JobRecord` is the schedule; an occurrence is the execution. A job can be:

- `notify`, delivering its configured text;
- `check_in`, reviewing linked current state;
- `act`, performing a bounded agent slice;
- an `attention_pulse`, using the pulse governor and delivery policy.

Jobs can link tasks, missions, open loops, projects, meetings, and conversations.
Specialist-created jobs may include a typed `workerBinding` with worker, exact
objective, expected output, allowlisted native/Composio tools, approval policy,
timeout, and budget. Do not broaden this allowlist at occurrence time.

Every occurrence needs a stable `occurrenceId` and idempotency key. Persist its
status, context, result/next action, wait reason, cost, tool calls, timestamps,
and version. A QStash retry must resolve to the existing occurrence rather than
start a second agent slice. The schedule and local job record are separate
resources; pause/resume/cancel must report partial provider failures honestly.

The SDK/API and dashboard expose pause, resume, run-now, and occurrence history.
The CLI and Telegram should map to the same service functions, not implement a
second scheduler.

## Attention pulse

The pulse is proactive work, not surveillance and not a generic “summarize my
account” prompt. It is enabled only after explicit owner intent and runs on a
stable QStash schedule. `buildAttentionPulsePlan()` bounds open loops,
attention candidates, active standing orders, blocked/failed durable tasks and
missions, expired non-timer mission waits, and due autonomy watches, then
creates a compact plan with a dedupe key. It excludes owner-paused work and
waits that are not due. Watches are personal/business scoped; legacy watches
normalize to personal, and reconciliation filters by the matching mode.

The pulse must:

1. Re-read active open loops, candidates, standing orders, blocked/failed
   durable work, due watches, delivery preference, quiet hours, and daily
   delivery count.
2. Prefer handle/delegate/prepare over a status-only digest when actionable
   work exists.
3. Use only the matching item's existing authority and scope. Tasks/missions
   retain their owner-defined objective and grants; watches use exact
   owner-configured read-only scopes and the matching autonomy profile.
4. Leave irreversible, financial, destructive, permission-changing, or other
   high-impact actions at the normal approval boundary.
5. Close an open loop only after real handling evidence, not because it was
   mentioned in a digest.
6. Suppress duplicates through the plan/digest key and delivery limits.
7. Count only confirmed-completed tools as handling evidence; started, missing,
   failed, cancelled, and read-only inspection entries do not count. Record what
   was handled, delegated, deferred, or delivered.

`NO_ACTION` is a valid quiet result only when no actionable work remains or the
delivery policy suppresses it. It must not hide a failed tool call or an
unhandled open loop.

## Context awareness

Autonomous work should be context-aware without receiving the whole account.
Before each slice, `buildAutonomyContextBundle()` selects:

- the linked task/mission and its current checkpoint/next action;
- narrowly relevant memories, with sensitivity and project scope preserved;
- linked open loops;
- recent conversation only when allowed;
- an explicit context snapshot and freshness age.

The objective and links are the routing contract. If a reminder/job has stale or
missing links, do not guess; report what cannot be resolved and ask for a new
link or owner decision. Never allow a provider payload, web page, document, or
memory value to change tools, budgets, approvals, or ownership.

## Approval and autonomous action boundaries

Autonomy means the system can continue and recover without a user message; it
does not mean policy is bypassed. Routine reads, memory maintenance, reversible
internal work, ordinary reminders, and bounded reporting can proceed. Payments,
purchases, deletions, permission changes, production deploys, remote Git pushes,
and materially risky external actions still require the normal exact-argument
approval boundary. An outbound call remains governed by the current call policy.

If a task or occurrence hits approval:

1. Persist the exact approval ID and safe action summary.
2. Mark the task/run/mission waiting for approval.
3. Stop the current slice; do not keep retrying the same call.
4. Resume the same durable work after one matching, unexpired approval is
   consumed.
5. Reject changed arguments or approvals belonging to another owner.

## Recovery and operations checklist

When a reminder/job/task appears not to run, inspect in this order:

1. Redis is configured and the record exists for the correct owner.
2. QStash token, public workflow URL, signature validation, and deployment env
   are correct.
3. The record is active and not paused/cancelled/expired.
4. `runAt`, schedule ID, workflow run ID, occurrence ID, and idempotency key are
   present and consistent.
5. The linked task/mission has a valid checkpoint, next action, and lease state.
6. The latest bounded event/error explains the next recovery action.
7. The durable outbox has not already delivered the result.

When a task is stuck in `running`, compare lease expiry and worker ID before
retrying. When a pulse repeats itself, compare dedupe key, occurrence ID,
delivery count, and open-loop status. When context is wrong, inspect links and
freshness rather than adding more history to the prompt.

## Test matrix

Tests should cover normal and failure paths for:

- reminder cancellation before delayed delivery;
- pause/resume/run-now without duplicate schedules;
- recurring occurrence dedupe and occurrence history;
- task lease claim, stale settle, retry, cancellation, and wait wake-up;
- mission-linked task continuation and owner isolation;
- pulse quiet hours, daily limit, dedupe, handle/delegate evidence, and loop
  closure;
- approval wait/resume and changed-argument rejection;
- Redis/QStash signature failures and provider retries;
- Telegram, CLI, SDK, MCP, and dashboard reads showing the same persisted truth.
