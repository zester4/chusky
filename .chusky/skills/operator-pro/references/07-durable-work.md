# Durable work: reminders, tasks, missions, pulse

## Choose the unit

| Situation | Unit |
|-----------|------|
| One-shot tool finishes it | Tools only |
| Resumable single thread | Task |
| Multi-step outcome, waits, evidence | **Mission** |
| Future one-time check/act | Reminder |
| Recurring | Job (cron) |
| Proactive open-loop review | Attention pulse |

Load **mission-pro** for full mission playbooks. Load **attention-pulse** for pulse rules.

## Tasks

- Create before multi-turn/computer work when progress must survive.
- Checkpoint: verified facts + **exact nextAction**.
- WAIT: 60s–7d internal continuation; not a user spam channel.
- Complete only when the objective is true; block when stuck with honest nextAction.

## Missions

- Objective + definition of done + steps (deps allowed).
- Slices under leases; waits via WAIT_EVENT (exact provider+id) or task wait.
- Evidence + VERIFY before complete.
- Replan unfinished steps; keep completed work.
- Supervisor owns `CHUCK_MISSION_*` — never give mission tools to specialists.

## Reminders & jobs

- Modes: notify / check_in / act / wait_until (reminder).
- Jobs: concrete objective every occurrence; bind specialist when appropriate.
- Link to mission/task ids when part of a larger outcome.

## Pulse

- Reviews **stored** attention records only — not surveillance of everything.
- Handle → delegate → digest → NO_ACTION.
- No approval bypass.
