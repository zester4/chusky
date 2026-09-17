# Human and browser handoff

Use when CAPTCHA, 2FA, age gates, or site challenges block automation.

## Packet to human

- Why handoff is needed
- Exact URL / service
- What they should complete
- What Chusky will do after resume
- Expiry of the handoff session

## Rules

- Never ask the human to paste passwords into chat if vault/handoff UI exists
- Pause shopping/browser flows cleanly
- On complete: verify session health before continuing automation
