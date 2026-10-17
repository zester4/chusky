# Live Mission Smoke Test

Date: 2026-10-16

## What was tested

Ran the mission workflow against the staging Neon database, the new staging
Redis instance, and real QStash. The test used a fake model boundary and did
not send Telegram messages or call a real model.

The mission contained three durable stages. Each stage slept for 60 seconds,
woke through QStash, resumed the same task, and then advanced to the next
stage. The final result was:

```json
{ "ok": true, "status": "completed" }
```

## Fix applied

Fixed the QStash replay step ordering. After a named sleep completes, the
workflow now advances to the next execution step instead of registering the
same sleep again. This prevents errors such as:

```text
Incompatible step name. Expected 'execute-task-1', got 'retry-delay-0'
```

Workflow publishers and handlers were also changed to use the explicitly
validated QStash configuration rather than diverging process environment
values.

## Verification

- Real staging mission: passed.
- TypeScript typecheck: passed.
- Production build: passed.
- Focused workflow tests: 36 passed.
- Diff checks: passed.
- Full suite: 1,839 passed, 1 unrelated peer-worker handoff test failed, and 4 were skipped.

## Extended wait verification

A second real staging run used longer waits of 120 seconds, 5 minutes, and
10 minutes:

```text
LIVE_MISSION_DELAYS_SECONDS=120,300,600
```

The run used real staging Neon, Redis, and QStash with the fake model boundary
and no Telegram delivery. Mission `mis_facb30de-6977-4182-9a9f-3b7f27b723dc`
completed successfully with:

```json
{
  "ok": true,
  "status": "completed",
  "modelCalls": 6,
  "delays": [120, 300, 600]
}
```

All three durable tasks completed once with one attempt each. The final task
settlement arrived after the terminal mission snapshot, confirming that the
10-minute stage also completed successfully. No QStash timeout, duplicate
task, Redis contention, or replay-step error occurred.

The wait-and-continue fix is committed and pushed to `origin/main` in
`b9d7315` (`fix durable mission QStash replay`). Deployment still needs to be
confirmed independently on the target environment.

## Prompt for the live mission agent

Use this prompt with the agent responsible for the live staging test:

> Run the live mission smoke test from the latest `main` checkout. Use the
> staging Neon database, staging Redis, and real QStash. Do not use a real
> model, Telegram, email, browser, provider, or any external side effect; use
> the scripted/fake model boundary already provided by the smoke test.
>
> Start one mission with three sequential stages and use
> `LIVE_MISSION_DELAYS_SECONDS=60,60,60`. Use an HTTPS tunnel for
> `WEBHOOK_URL` and set `LIVE_MISSION_TIMEOUT_MS` high enough for all three
> wakes. Verify the complete lifecycle: each stage must persist its checkpoint,
> enter a durable waiting state, receive a real QStash wake, resume the same
> task, verify the checkpoint, complete exactly once, and advance to the next
> stage.
>
> Confirm all of the following before reporting success:
>
> - QStash authentication succeeds with no `401 Invalid API key` errors.
> - Every QStash wake reaches the callback through the tunnel.
> - No `Incompatible step name` or repeated-sleep error occurs.
> - Each stage resumes its existing task rather than creating a duplicate.
> - The mission ends as `completed`, all stage tasks are completed, and no task
>   remains queued or running.
> - The fake model is called only for the initial wait and post-wake
>   continuation of each stage; no real model call is made.
>
> Report the mission ID, task IDs, final mission status, task statuses, model
> call count, QStash delivery evidence, and any errors. Do not call the test a
> pass if the process merely reaches the timeout while the mission is still
> running.
