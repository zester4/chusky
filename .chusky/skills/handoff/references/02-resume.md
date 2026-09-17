# Resume and failure recovery

## Resume

1. Load task / handoff record by id
2. Read last checkpoint and nextAction
3. Continue from evidence, not from chat vibes
4. Write a new checkpoint after meaningful progress

## Failure

- Record error in task without destroying prior evidence
- Retry only if idempotent or safe
- Otherwise block with a clear owner-facing question

## Cancellation

Honor cancel signals; leave state consistent and report what stopped.
