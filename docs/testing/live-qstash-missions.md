# Model-free live QStash mission tests

Run from the backend repository root with Node 24.5+ and the existing QStash
token, current signing key, next signing key, and optional regional QStash URL
in the environment:

```sh
npm run test:mission:qstash:live -- --apply
```

The explicit flag permits real, billable QStash publications. The script loads
no local credential file, generates synthetic owners, uses isolated in-memory
storage, and creates a temporary Smee webhook relay. Only synthetic test payloads
reach the relay. It cleans up only the message IDs created by this run.

## Scenarios

- Three dependent mission steps, delivered through real QStash.
- A root, two independent branches, and a join that requires both branches.
- Two signed deliveries for one task; only one execution is permitted.
- A signed task delivery using a different synthetic owner; no execution.
- A native 60-second task wait, a real delayed QStash publication, and a resume
  of the same task after its persisted deadline.
- Cancellation before delivery; the scripted agent must never run.
- A synthetic ended call and an internal follow-up task, scheduled using the
  production enqueue-claim wrapper. Reconciliation must not publish a duplicate
  or run the follow-up more than once. No phone number is dialed.

The production mission scheduler, task lease/settlement, task-slice coordinator,
native lifecycle dispatch, call follow-up scheduler, enqueue claims, and QStash
signature verifier run with a scripted agent boundary. Synthetic task records
and statuses are checked after real callback delivery.

The network guard permits only QStash and the relay. Model inference and real
app actions are blocked before network I/O. Package-version checks and SDK
telemetry attempts may be blocked and appear separately in the result. Any
other attempted destination fails the proof.

The expected successful run has 14 publications/deliveries, 11 scripted agent
invocations, one rejected cross-owner delivery, and zero model-provider calls.
Queue timing or an early unclaimable wake can require extra deliveries. Allow
roughly two minutes; the callback collection deadline is 150 seconds after
setup, and total publications are bounded at 40.

## What this does not prove

Smee acknowledges delivery before forwarding it to the local receiver. Therefore
this test cannot establish QStash retries after local receiver failure or
production Upstash Workflow replay semantics. It tests the QStash transport and
mission coordinator using a test publisher, not the full production HTTP route.

Storage is isolated in memory. Redis/Neon persistence, distributed contention,
and process-restart recovery still need separate integration tests. This test
does not call Twilio, Deepgram, Composio business actions, or an LLM and cannot
certify live audio, booking behavior, or production call quality.

The accompanying offline tests cover additional coordinator cases, including
a 200-step mission and a simulated 30-day work schedule. Those use fake queue
delivery and clocks; report them separately from this live transport proof.

## Verified result — 2026-10-22 UTC

The final matrix exited successfully with 14 real publications, 14 verified
signed deliveries, 11 scripted agent invocations, and zero model-provider calls.
The native 60-second timer resumed 339 ms after its saved deadline. All chain
and branching steps completed once. Duplicate delivery did not repeat execution;
cancellation prevented execution; the cross-owner delivery did not find or
execute the other owner's task. Call follow-up reconciliation reused its task,
published once, and completed once after explicit native task completion.

The network guard blocked the Composio SDK's package-version check and telemetry
hosts. These were not inference or business-tool calls. A preliminary fixture
that only returned completion prose correctly remained blocked; the final
script verifies state and uses CHUCK_TASK_COMPLETE before claiming success.

Additional validation: 55 offline mission/task/call tests passed, including the
200-step and simulated 30-day cases. Backend typecheck/build, standalone strict
typecheck of the live script, and diff checks passed. Production service code,
Redis records, Neon records, and deployment settings were not changed.
