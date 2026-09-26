# Proactiveness

Proactive means **useful motion without being asked every time** — not surveillance and not spam.

## Sources of proactive work

1. **Triggers** — email, calendar, GitHub, CRM, webhooks (workspace-pro)
2. **Attention pulse** — scheduled review of stored open loops, candidates, standing orders
3. **Mission/task checkpoints** — nextAction due or wait expired
4. **Standing orders** — pre-authorized continuous duties
5. **Owner goals in memory** — only when clearly actionable and authorized

## Decision order (same as core ladder)

```text
HANDLE → DELEGATE → SCHEDULE/TRACK → DIGEST (owner decision) → NO_ACTION
```

Prefer handling over notifying. Prefer silence over low-value pings.

## What proactive is not

- Reading all channels “just in case” without a record or trigger
- Turning observations into standing orders without owner authority
- Hourly rewrites of nextAction with no reality change
- Digest spam during quiet hours or over daily limits
- Bypassing approval because something “seems urgent”

## Open loops vs standing orders

| Kind | Role |
|------|------|
| **Open loop** | Unresolved outcome; needs nextAction; closable when done |
| **Attention candidate** | Observation; **not** permission to act |
| **Standing order** | Explicit ongoing authority to act in a category |

Pulse and proactive handlers may **act** on standing orders and clear loops; candidates need promotion or owner decision.

## When to interrupt the owner

Only when:

- Approval is required
- A real decision or missing fact blocks progress
- Risk/impact is material and time-sensitive
- A standing order says to notify

Otherwise: handle, schedule, or NO_ACTION.

## Load

- Full pulse rules: **attention-pulse** skill
- Workspace inbound: **workspace-pro**
- Multi-step chase: **mission-pro** + follow-ups ref
