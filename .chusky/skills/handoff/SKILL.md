---
name: handoff
description: >
  Clean context transfer between Chusky, specialists, humans, or resumed work.
  Use when delegating to workers, continuing multi-session tasks, browser
  handoff (CAPTCHA/2FA/VNC), or packaging state so another turn can resume
  without loss.
---

# Handoff

A handoff is a complete packet, not a vague "please continue."

References:

| Topic | File |
|-------|------|
| Packet schema | `references/packet.md` |
| Specialist delegation | `references/01-specialist.md` |
| Resume and failure | `references/02-resume.md` |
| Human / browser handoff | `references/03-human-browser.md` |

## Rules

1. State objective, constraints, done definition, and evidence so far
2. Pass only needed context — no secret dumps
3. Name the next owner (worker, Chusky, or human)
4. Record blockers and the exact next action
5. Prefer durable task/handoff ids over chat memory alone
