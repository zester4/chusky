# Complex model-free mission matrix

Run from the backend repository root:

```sh
npm run test:mission:qstash:complex -- --apply
```

This test publishes synthetic tasks to a real QStash endpoint and consumes
the signed deliveries through a temporary Smee relay. The mission scheduler,
task lease/settlement, mission waits, approval resume, provider-event resume,
owner scoping, app-account selection, and provider receipt accounting are the
production implementations.

The model boundary and all business-provider calls are scripted. The harness
sets Jev off, loads no local credential file, and blocks every network host
except the configured QStash region and `smee.io`. It never calls Gmail,
Google Calendar, Sheets, CRM, Notion, Twilio, Deepgram, Composio business
actions, or an inference provider.

The queue assertions follow QStash's at-least-once contract: the callback is
verified with the current/next signing keys, and duplicate business effects
are suppressed by the owner-scoped durable task lease and completion CAS. A
QStash message ID is still treated as delivery metadata, not as permission to
skip the task-state idempotency check.

## Covered mission journeys

- One 13-stage mission from goal, signals, list, shortlist, enrichment, saved
  work, next action, research, outreach, meeting, follow-up, client care, and
  feedback.
- Discovery and schema lookup before each scripted connected-app action, with
  synthetic connected accounts and exact account/tool receipt tracking.
- A real QStash-delivered durable timer wake.
- Approval pause before outreach and resume of the original task after the
  exact approval is granted.
- Calendar provider-event wait, duplicate callback, and post-event read-back.
- Human-input wait and owner resume.
- A transient failure that was not dispatched and is safely retried.
- An accepted-but-uncertain provider write that is read back without a second
  write dispatch.
- Revoked connection handling that blocks with no provider write.
- Parallel branches with a dependency join.
- Duplicate task delivery, cross-owner rejection, and cancellation before
  delivery.

## What a successful result proves

The JSON result must report `ok: true`, zero model/provider calls, no
unexpected network destinations, all expected scenario terminal states, one
approval wait, one provider wait, one timer wait, one human-input wait, one
revoked-connection block, and exactly one dispatch for the uncertain provider
write.

## Limits

The temporary relay acknowledges HTTP before local processing, so this does
not prove QStash retry behavior after a receiver crash or production Workflow
replay. Storage is intentionally isolated in memory, so Redis/Neon persistence,
multi-replica contention, and process restart recovery remain separate canary
work. The 13-stage and scheduled mission contract is real, but elapsed days
are compressed so the test can finish in one run.
