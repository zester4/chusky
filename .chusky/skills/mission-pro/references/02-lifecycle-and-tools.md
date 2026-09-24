# Lifecycle and mission tools

## States (conceptual)

`queued → running → waiting | paused | blocked → completed | failed | cancelled`

Transitions must match reality. Waiting is not failed. Blocked is not complete.

## Core tools (supervisor)

| Tool | Use |
|------|-----|
| `CHUCK_MISSION_START` | Create mission: title, objective, definition of done, steps with deps |
| `CHUCK_MISSION_LIST` / `GET` | Inspect owner missions |
| `CHUCK_MISSION_CHECKPOINT` | Persist progress mid-mission |
| `CHUCK_MISSION_STEP_COMPLETE` | Mark a step done with verified result |
| `CHUCK_MISSION_WAIT_EVENT` | Park until exact provider + eventId |
| `CHUCK_MISSION_EVIDENCE` | Attach bounded proof |
| `CHUCK_MISSION_VERIFY` | Evaluate done criteria vs evidence |
| `CHUCK_MISSION_PROOF` | Operator-facing summary of proof state |
| `CHUCK_MISSION_REPLAN` | Replace unfinished steps; keep completed |
| `CHUCK_MISSION_PAUSE` / `RESUME` | Owner or policy stop/continue |
| `CHUCK_MISSION_BLOCK` | Cannot proceed; honest nextAction |
| `CHUCK_MISSION_COMPLETE` | Only after verification succeeds |
| `CHUCK_MISSION_CANCEL` / `REPAIR` | Stop or fix broken structure |

## Task layer (every step runs as slices)

| Tool | Use |
|------|-----|
| `CHUCK_TASK_CREATE` | Durable task if not mission-driven |
| `CHUCK_TASK_CHECKPOINT` | What was verified + exact nextAction |
| `CHUCK_TASK_WAIT` | Sleep 60s–7d; no user spam |
| `CHUCK_TASK_BLOCK` / `COMPLETE` / `RETRY` / `CANCEL` | Lifecycle |
| `CHUCK_TASK_SCHEDULE` | Continue task later |

## Delegation

`CHUCK_DELEGATE_SUBAGENT` — domain workers under a typed contract.

- **Never** include `CHUCK_MISSION_*` in worker `allowedTools`
- Use canonical `CHUCK_*` and verified Composio slugs only
- Split mixed objectives into ordered delegations

## Start checklist

1. Objective in one sentence (outcome, not activity)
2. Definition of done (testable)
3. Steps with `dependsOn` where needed
4. Budget awareness (time/cost/tools)
5. Which steps need approval vs autonomous tools

## Complete checklist

1. All required steps completed
2. Evidence attached for each done criterion
3. `CHUCK_MISSION_VERIFY` passes
4. Then `CHUCK_MISSION_COMPLETE`

If verify fails → `BLOCK` or `REPLAN`, never optimistic complete.
