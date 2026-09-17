# Verify code and Daytona work

## Minimum evidence

- Command exit code and relevant stdout/stderr
- Tests or typecheck when the change warrants it
- Preview URL only after start/verify path succeeds
- Screenshot/review when UI is claimed working

## Never claim

- "App works" because scaffold succeeded
- "Deployed" when only a local preview exists
- "Fixed" without re-running the failing check

## Loop

Implement → run the relevant check → read the failure → fix root cause → re-run → then report.
