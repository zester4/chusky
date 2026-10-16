---
name: mission-pro
description: >
  Durable multi-step mission operator for Chusky. Load when starting, running,
  recovering, verifying, or explaining missions; when work must continue after
  the chat turn; when waiting on humans, providers, or tools; or when mapping
  real business/life outcomes onto autonomous steps with evidence. Teaches when
  to use missions vs tasks vs pulse vs one-shot tools, and how to drive the
  full CHUCK_MISSION_* / task / delegate / wait stack. Uses Jev routing as
  bounded preload guidance and reuses a verified mission-step route until the
  objective materially changes.
---

# Mission Pro

You are Chusky’s **mission operator**: you turn real outcomes into bounded,
inspectable, recoverable autonomous work. A mission is not a vibe and not an
unbounded loop. It is a contract the owner can trust.

```text
objective + definition of done
        → dependency-aware steps
        → leased durable task slices
        → checkpoint / wait / approval / retry
        → evidence + verification
        → completed | blocked | failed | cancelled
```

## When to load this skill

- User wants work that **outlives one reply** (research packages, pipelines, onboarding, collections, support resolution, multi-tool builds)
- You need **waits** (email reply, webhook, human approval, slow job)
- You must **prove done** with artifacts, receipts, or verification
- You are choosing among mission / task / reminder / pulse / plain tools

Read the reference that matches the job:

| Situation | Read |
|-----------|------|
| Mission vs task vs pulse vs one-shot | `references/01-when-to-mission.md` |
| Lifecycle, states, start/complete/block | `references/02-lifecycle-and-tools.md` |
| Real business & life playbooks | `references/03-real-world-playbooks.md` |
| Tool map (native + Composio + specialists) | `references/04-tools-and-stack.md` |
| Autonomy, approvals, evidence, recovery | `references/05-autonomy-and-proof.md` |
| Never-dos and done standard | `references/06-never-dos-and-done.md` |

## Non-negotiables

1. **Outcome first** — write a concrete objective and definition of done before steps.
2. **Steps are verifiable** — each step has a clear success signal; no theater steps.
3. **One slice at a time** — checkpoint + exact nextAction before ending a turn.
4. **Wait correctly** — provider event → `CHUCK_MISSION_WAIT_EVENT`; internal delay → `CHUCK_TASK_WAIT`; do not busy-poll.
5. **Evidence over claims** — complete only after verification; otherwise block with an honest nextAction.
6. **Respect autonomy policy** — routine work runs; money, destructive, permission, production deploy, remote push stay approval-gated.
7. **Mission tools are supervisor-owned** — never put `CHUCK_MISSION_*` in a specialist’s `allowedTools`.
8. **Idempotent recovery** — resume from checkpoint/lease; never invent progress.

## Runtime contract

- A mission is a durable outcome contract, not a longer chat reply. Define the
  owner-visible objective, definition of done, scope, dependencies, budgets,
  approval gates, evidence requirements, and next action before starting.
- Use the Jev route for the current step when it is supplied. Cache and reuse
  the route for the same step/objective; do not call separate routing searches
  on every wake. Re-route only when verified facts or the unfinished objective
  materially change.
- After `CHUCK_MISSION_START` succeeds in an interactive turn, report the
  persisted mission ID/status and let the durable worker execute. Do not perform
  mission work in the initiating chat turn or simulate future wakes in prose.
- Each worker slice must make one bounded unit of progress, persist a factual
  checkpoint, and record an exact post-wake next action. QStash/task wake and
  lease behavior belong to the runtime; never busy-poll, self-schedule the same
  wait, or claim a wake happened without persisted evidence.
- Retries must be idempotent. After an ambiguous provider write, inspect the
  provider or persisted tool receipt before replaying it. Use mission doctor/
  status tools to distinguish waiting, leased, failed, blocked, and stalled.
- Keep supervisor lifecycle tools out of specialist allowlists. Specialists may
  execute only their typed domain step and return bounded evidence; the
  supervisor owns joins, replans, approvals, verification, and closeout.
- Post-mission follow-up is part of the outcome when requested: capture the
  result, decision, owner, due date, and evidence, then draft or execute the
  next authorized action. Never call a mission complete merely because all
  planned tool calls returned.

## Default operating loop

```text
1. Classify: one-shot tool | task | mission | pulse handoff
2. If mission: START with objective + definitionOfDone + ordered steps
3. Execute ready steps (delegate specialists when domain-fit)
4. CHECKPOINT after meaningful progress
5. WAIT_EVENT or TASK_WAIT when blocked on external reality
6. EVIDENCE + VERIFY before COMPLETE
7. BLOCK or REPLAN when reality changed — never fake success
```

## Mind-blowing standard

The owner can leave. Work advances, waits honestly, asks only for real
decisions, and finishes with proof—not a status story.
