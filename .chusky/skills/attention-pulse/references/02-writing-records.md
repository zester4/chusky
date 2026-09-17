# Writing attention records

Attention state is a ledger of open work, not a second inbox archive.

## Kinds that wake or guide the pulse

| Kind | Purpose | Wakes pulse? |
|------|---------|--------------|
| `open_loop` | Incomplete work with a next step | Yes (if open/waiting/blocked, not snoozed) |
| `attention_candidate` | Possible owner-facing nudge | Yes (if pending, available, not expired) |
| `standing_order` | Ongoing owner authority | Guides action; does not alone create hasWork |
| `delivery_preference` | Quiet hours, limits, silent | Controls delivery |
| `observation` | Intermediate note | No — does not wake pulse alone |

## Open loop template

- **title**: specific, actionable ("Follow up Acme invoice #442")
- **nextAction**: one concrete step ("Send approved payment link")
- **status**: `open` | `waiting` | `blocked` | completed states when done
- **priority**: 0–1 honest score
- **dueAt**: when real
- **snoozedUntil**: when waiting on a known date

## Candidate template

- **candidateType**: e.g. nudge, risk, opportunity
- **reason**: one sentence why the owner might care
- **score**: 0–1
- **proposedAction**: optional, bounded
- **expiresAt**: so stale nudges die

## Standing order template

- **name**: short label
- **instruction**: what to do
- **authority**: `observe` | `prepare` | `act_routine` | `escalate` (use the narrowest)
- **scope**: domains this applies to
- **expiresAt**: optional

## Good vs bad

| Good | Bad |
|------|-----|
| "Partner deck reply overdue 3 days — draft follow-up" | Paste entire email thread |
| Standing order: prepare routine launch next steps | Standing order: send any email you want |
| Loop with due date and next action | Vague "check on stuff" |

## Rules

- Prefer one loop per real objective
- Link to tasks when work is multi-step (`CHUCK_TASK_*`)
- Never store secrets, passwords, or full message bodies in attention state
