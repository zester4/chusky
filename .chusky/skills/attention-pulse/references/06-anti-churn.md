# Anti-churn and silence

## Silence is a feature

`NO_ACTION` is the correct result when:

- No actionable loops or candidates
- State unchanged from last digest (dedupe)
- Quiet hours / daily limit / silent preference
- Work progressed privately with nothing owner-visible

## Churn patterns to avoid

| Churn | Fix |
|-------|-----|
| Rewriting nextAction every hour | Only update when the real next step changed |
| Re-notifying same candidate | Rely on delivered status + dedupe; don't recreate duplicates |
| Closing loop after digest | Digest ≠ done |
| Creating candidates for trivia | Threshold: would a sharp chief of staff interrupt for this? |

## Snooze vs close vs leave open

- **Snooze** — waiting on a known time or external event
- **Close** — objective complete with evidence
- **Leave open** — still true, still pending, no material update

## Priority honesty

Do not inflate scores to force digests. High priority is for real deadlines,
money, blocked launches, or relationship risk.
