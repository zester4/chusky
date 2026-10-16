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

The fix is currently local and has not yet been committed, pushed, or
deployed.
