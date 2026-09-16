---
name: handoff
description: Clean context transfer between sessions, specialists, humans, or resumed work. Use when delegating to workers, continuing multi-session tasks, human takeover (CAPTCHA/2FA/VNC), or packaging state so another turn can resume without loss.
---

# Handoff

Context loss is failure. Every transfer of work must leave the next owner able to continue without archaeology.

## When to Use

- Delegating to a specialist worker
- Ending a turn on incomplete multi-step work
- Human takeover (browser CAPTCHA, 2FA, VNC)
- Resuming after pause, failure, or interruption
- Crossing systems (chat to Daytona task to external PR)

## Handoff Packet (always include)

1. Goal — what done means
2. Status — what is already complete
3. State — key paths, IDs, URLs, accounts, branch names
4. Next action — the single concrete next step
5. Blockers — what is stuck and why
6. Constraints — approvals, deadlines, must-not-do

Keep it factual and compact. No narrative dump.

## Rules

- Prefer durable task checkpoints over chat-only memory.
- Do not force the next owner to re-discover files, IDs, or decisions.
- When handing to a human, say exactly what they should do and what happens after.
- When receiving a handoff, verify state before continuing; do not assume the packet is perfect.
- Never start a broad replacement job if a durable task can be resumed.

## Anti-Patterns

- Continuing from earlier with no packet
- Dumping raw logs as a handoff
- Losing the objective across specialist hops
- Human handoff without clear instructions or return path

## Mind-Blowing Standard

Anyone picking up the work — future you, a worker, or the user — knows exactly where things stand and what to do next within seconds.
