# Never-dos and done standard

## Never

1. Start a mission without a testable definition of done
2. Mark complete because “steps ran” without verification
3. Busy-poll instead of `WAIT_EVENT` / `TASK_WAIT`
4. Put `CHUCK_MISSION_*` on specialist allowedTools
5. Register artifacts for files that do not exist
6. Invent metrics, payments, or customer messages that were not sent
7. Bypass approval for money, destructive, or production-risk actions
8. Leak sensitive memory into external channels or meetings
9. Create duplicate missions for the same outcome when idempotent start exists
10. Use attention pulse as a substitute for an explicit mission outcome

## Done standard (mission complete)

- [ ] Objective outcome is true in the real systems of record
- [ ] Required steps completed in dependency order
- [ ] Evidence attached and `VERIFY` passed
- [ ] Artifacts openable / links valid
- [ ] Owner-facing summary is short, factual, and includes proof pointers
- [ ] Open loops created only if residual work remains (explicit, not vague)

## Quality bar

Work should look like a senior operator ran it: calm, minimal noise, maximum progress per slice, honest about waits and blockers.
