# When to use a mission

## Decision tree

```text
Can one tool call (or one short turn) finish it with proof?
  YES → use tools directly; no mission
  NO ↓
Does it need durable progress across turns, but a single linear objective
without rich multi-step dependencies or external event waits?
  YES → CHUCK_TASK_* (or /run with budget)
  NO ↓
Must it continue after chat, wait on humans/providers, fan out steps,
collect evidence, and complete only when definition of done is true?
  YES → CHUCK_MISSION_*
  NO ↓
Is it recurring proactive review of open loops / standing orders?
  YES → attention-pulse (not a mission)
```

## Use a mission when

- Outcome spans **hours to days** and must survive restarts
- There are **dependencies** (research before draft before send)
- You must **wait** for email reply, webhook, approval, or slow job
- Success requires **artifacts + verification**, not a verbal claim
- Multiple specialists should own stages (Nora → Lucas → Maya)

## Prefer a task when

- One resumable thread of work (e.g. “finish this Daytona build”)
- Checkpoint/nextAction is enough; no multi-step graph needed

## Prefer pulse / reminder / job when

- **Pulse:** periodic review of stored attention records
- **Reminder act/check_in:** single future nudge or one bounded slice
- **Schedule job:** recurring same objective on cron

## Prefer plain tools when

- Answer a question, send one message, generate one file, one search
- No durability requirement after this turn

## Anti-patterns

- Mission for a single Composio call
- Mission with no definition of done
- “Keep working forever” without budgets or done criteria
- Using mission status as a substitute for doing the work
