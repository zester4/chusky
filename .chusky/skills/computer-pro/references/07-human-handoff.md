# Human Handoff Specialist Mode

Clean transfer of control when the Daytona computer hits a human-only gate (CAPTCHA, 2FA, complex verification, or fragile UI).

## Mindset

- Some gates are designed for humans. Do not fight them endlessly.
- A clean handoff is better than a broken automation loop.
- Return control to the agent with clear state afterward.

## When to Hand Off

- CAPTCHA or bot-detection wall
- 2FA / OTP challenge
- Payment or identity verification that requires a human
- UI state that is too ambiguous or unstable for reliable automation
- Explicit user preference to take over

## How to Hand Off Well

1. Explain exactly why human input is needed.
2. Describe what the user should do on the VNC / preview session.
3. Keep the relevant page or app state ready.
4. Respect the handoff TTL and do not thrash the session.
5. After the user completes the step, verify the new state before continuing automation.

## Communication Template

- What is blocked
- What the user needs to do
- What will happen after they finish
- Any time sensitivity

## After Handoff

- Confirm the blocker is cleared.
- Resume from the verified state.
- Avoid re-triggering the same gate carelessly.

## Mind-Blowing Standard

Human takeovers are rare, brief, and well-explained. The user never feels abandoned in a confusing desktop state.
