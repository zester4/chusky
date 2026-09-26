# Follow-ups

Follow-up is **owned work until the outcome is true or explicitly closed** — not a polite “checking in” habit.

## When to open a follow-up

Open or continue a follow-up when any of these are true:

- Someone owes a reply, decision, payment, document, or action
- You sent something and the outcome is not yet verified
- A deal, ticket, invoice, hire, or onboarding step is waiting on an external party
- The owner asked you to chase or “make sure this happens”

Do **not** invent follow-ups from vague vibes. Prefer a concrete nextAction + target date/channel.

## How to store it

Prefer durable state over chat memory:

| Need | Use |
|------|-----|
| One future nudge or act | Reminder (`notify` / `check_in` / `act` / `wait_until`) |
| Multi-step chase with waits | **Mission** (or task) with checkpoint + nextAction |
| Recurring cadence | Job (cron) with a concrete objective each run |
| Pulse-visible open item | Attention open loop / standing order (only with authority) |

Always record: **who**, **what**, **channel**, **last action**, **next action**, **when**.

## Cadence (defaults — owner prefs override)

```text
T+0     Send / request (clear ask, one CTA)
T+2–3d  First follow-up if no response (add value or clarify, don’t nag)
T+5–7d  Second follow-up (shorter; state consequence or alternative)
T+10–14d Escalate to owner or close with reason if dead
```

Adjust by context:

- **Hot deal / incident:** tighter (hours–1 day)
- **Collections:** tiered dunning per billing policy (see billing-ops-pro)
- **Internal teammate:** shorter, direct
- **Cold outbound:** fewer touches; stop on unsubscribe/no

## Message quality

- Reference the **last concrete thread** (date, ask, artifact)
- One clear ask per message
- Match owner voice from memory
- Never invent commitments, deadlines, or threats
- Log send as evidence when part of a mission

## Closing a follow-up

Close only when:

1. Desired outcome is verified in systems of record, or
2. Owner says stop, or
3. Policy max touches reached and you leave a factual summary + recommended next step

A digest or “still waiting” note does **not** close the loop.

## Tools

- Schedule: `CHUCK_SET_REMINDER`, `CHUCK_SCHEDULE_JOB`, `CHUCK_TASK_WAIT`, `CHUCK_MISSION_WAIT_EVENT`
- Act: channel/Composio send tools under autonomy policy
- Track: mission/task checkpoint with exact nextAction
