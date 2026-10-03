# Mission live-validation report

Date: 2026-10-03
Release commit: `07c5b6eae16e0b5274d9a7ba578a507be6960c01`
Railway deployment: `ce11d728-709b-4cf4-b9a7-8624f0dd1b16`
Environment: Railway production, Redis-backed task and mission state

## Purpose

This report records why the live tests were chosen, what they exercised, and
what persisted evidence proves the outcomes. The goal was to validate the
mission handoff fix on the deployed worker rather than infer success from a
chat response or from a local unit test.

The tests were deliberately different:

1. A linear three-step mission tested ordinary step-to-step handoff.
2. A four-step mission tested parallel branches and a dependency join.
3. A three-step mission with a real durable timer tested sleep, wake, resumed
   state, and final closeout. The timer was set long enough to expose a lost
   handoff or hot-loop bug without creating an unnecessary multi-hour test.

All three missions used native Chusky mission/task tools only. They did not
send email, modify a spreadsheet, call a provider, browse the web, or use a
connected account. This isolated the durable execution kernel from provider
side effects.

## Why these cases matter

### Linear handoff

A mission that completes one step but cannot transfer ownership to the next
step is the basic failure mode this release was intended to address. The
linear test proves that the worker can persist progress, release one task,
schedule the next dependency-ready task, and close the mission without the
model needing to continue the work in the original chat turn.

### Parallel branches and join

The mission scheduler must not treat a branch as the whole mission. Both
branches must receive independent durable work, and the join must remain
pending until both predecessors are complete. This catches duplicate branch
execution, premature join completion, and missing fan-in scheduling.

### Durable wait and wake

Long-running work must be able to sleep without a hot loop and resume from
persisted state after the worker delivery returns. The timer case therefore
checks that there is one wait, one wake, no repeated completed work, and a
terminal closeout after the wake.

## Live mission results

| Test | Mission ID | Persisted result | Evidence |
|---|---|---|---|
| Linear three-step handoff | `mis_203a24ef7ccc6a39c69010215f28a9daecf607717dc3fa92` | `completed`; 3/3 steps; 3 slices; 10 tool calls | Dashboard showed `step-1` → `step-2` → `step-3`, with two server-derived trusted internal checkpoint records. |
| Parallel branches and join | `mis_1132b39fd653063842ba251a659896a77c1774edceab0073` | `completed`; 4/4 steps; 4 slices; 12 tool calls | Dashboard showed the two branch tasks completing independently before the final join step. Trusted internal lifecycle evidence was persisted for the branch and join transitions. |
| Durable 120-second wait | `mis_46d939c2bee9bb670db4616e84fb1cab01f58be521e4486b` | `completed`; 3/3 steps; 3 slices; 10 tool calls; 9 evidence records | The persisted proof contained one waiting event, one resumed event, two checkpoints, all three completed steps, and a final definition-of-done closeout. |

### Timer proof

For `mis_46d939c2bee9bb670db4616e84fb1cab01f58be521e4486b`:

- The wait-entry checkpoint was `mcp_952607cd-b86a-4a85-90fb-c9bd99addd62`.
- The mission recorded exactly one `waiting` event and exactly one `resumed`
  event; no duplicate timer was created.
- The wake event recorded `elapsedMs: 204079`, or **204.079 seconds**.
- The persisted baseline-to-wake interval was **210.142 seconds**.
- The mission completed after the wake, rather than merely reporting progress
  from the initiating chat.
- The baseline checkpoint `mcp_91af2add-4c0e-4c48-bc18-307345b934c1` preserved
  the mission ID, the three-step chain, and the trusted runtime timestamp.

This proves the functional requirement that the worker slept for at least 120
seconds and resumed the same mission. It also proves that state survived the
handoff and that the completed step was not replayed.

## Deployment and infrastructure evidence

Railway deployment `ce11d728-709b-4cf4-b9a7-8624f0dd1b16` reported `SUCCESS`
for commit `07c5b6e`. Runtime logs showed:

- Redis connected before the service began accepting work.
- Chusky listening and registering its webhook.
- Task workers claiming and settling durable tasks.
- The timer mission being claimed after its scheduled wake and settling with
  status `completed`.
- `/v1/missions`, mission detail, proof, events, doctor, and `/v1/ops/health`
  requests returning HTTP 200 during inspection.
- No HTTP 5xx responses in the inspected Railway HTTP log sample.

This is stronger evidence than a browser success banner: the dashboard read
the persisted mission, proof, events, and doctor projections from the deployed
API after the worker had finished.

## Local regression evidence

The release was also checked locally before the live run:

- `npm.cmd test`: **1,267 tests, 1,263 passed, 0 failed, 4 skipped**.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `git diff --check`: passed; only existing line-ending warnings were present.
- The release commit was pushed to `origin/main` and matched the deployed
  Railway commit.

The four skipped tests are existing platform-dependent or opt-in checks; they
were not converted into false passes.

## Related provider-path evidence

The native-only tests above intentionally did not test connected providers.
Separate live missions also exercised read-only Gmail and Google Sheets paths:

- `mis_c2478e3dad3aff42e25b14f90faad10faa0b9d5062a7f143` completed with
  system-trusted Gmail and Sheets receipt records and made no writes.
- `mis_9644bf82ba3f25589fecb7abe0679d014215938c981b9de5` completed a two-step
  Gmail/Sheets read-only mission with trusted provider receipt records.

Those provider receipts prove the connected-account path separately from the
native durability path. The aggregate mission verification field was
agent-stamped in those records, so this report relies on the individual
system-trusted provider receipt records rather than treating the aggregate
field alone as independent proof.

## Observed limitations and interpretation

The timer mission passed the required measured wait, but its metadata reported
`scheduledDelayMs: 118224`, which is 1.776 seconds below the requested
120,000-millisecond delay. The actual persisted elapsed interval was 204.079
seconds, so this did not shorten the real wait below the requirement. It does
mean the runtime should not yet advertise exact scheduled-delay precision;
that is a separate timing-calibration concern.

Railway also contains validation errors from model attempts that submitted an
unsupported `verifiedBy` value or an evidence summary over the schema limit.
Those calls were rejected at the tool boundary and the affected workers
continued through corrected calls. An older mission inspection also produced
“mission not found or not owned” diagnostics. These were not failures of the
three accepted missions, but they remain useful evidence that schema and
ownership guards are active.

## Conclusion

The deployed release successfully demonstrated three distinct durable mission
paths: sequential handoff, parallel fan-out/fan-in, and a real multi-minute
timer wait followed by resumed execution and terminal closeout. The proof is
based on persisted mission state, durable events, worker settlement logs,
dashboard/API read-back, and local regression checks—not on model prose.

The evidence supports the claim that these tested paths work on the deployed
Redis/QStash-backed runtime. It does not certify every possible provider,
crash point, timezone, or multi-instance race; those remain separate
integration boundaries documented in [`mission-audit.md`](mission-audit.md).
