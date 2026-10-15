# Early responses for interactive turns

An opening describes intent while the normal agent prepares memory, routing,
skills, and tool schemas. It does not replace the main model, execute tools,
grant approval, or claim to have inspected private data. It uses only the current
user text (bounded to 3,000 characters), without history, memory, tool results,
or account credentials in its prompt.

Telegram starts the opening after authorization, rate and spend checks, before
loading the session and acquiring the execution lock. The authenticated web
stream starts after durable run admission, before skill loading and agent
preparation. Linked channels use their existing account-scoped, idempotent
outbox. Voice, delegated/background tasks, ephemeral runs, greetings, and
approval resumes do not automatically create openings.

The small model call runs concurrently with preparation, has no retries, and is
aborted at its deadline. A complete sentence is delivered once; failed, slow,
truncated, or malformed generation uses a local intent message. The main model
waits for the bounded delivery gate, then proceeds normally. Preparation errors
and cancellation close the request-scoped opening and suppress late generation.
Transport failures remain observational. A channel provider may still deliver
an already accepted outbox notification late; its stable idempotency key prevents
a retry from creating another opening.

Web/SDK transport uses existing `run.status` and `run.progress` events. The
opening status is persisted with an `evt_opening_` event ID; the existing note
evidence shape carries it to live web clients. The dashboard preserves it as
prose independently of answer deltas and restores it from the durable event on
reconnect. No new public event union or client upgrade is required. Openings
are not appended to canonical conversation history or included as task evidence.
The CLI uses a separate `status` event so the opening never contaminates answer
`delta` chunks; older CLI clients can continue ignoring unknown event types.

Configuration (no new credentials required):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TURN_OPENING_ENABLED` | `true` | Rollout/rollback switch |
| `TURN_OPENING_MODEL` | `google/gemini-2.5-flash-lite` | Separate verified low-latency text model |
| `TURN_OPENING_DEADLINE_MS` | `1200` | Generation deadline, capped at 2500 ms |

Delivery has a separate 1500 ms bound. These are server budgets after admission,
not a guarantee of end-to-end latency: authentication, durable admission,
provider queues, and client networking still affect what the user sees. Model
usage reported for the opening contributes to the agent's total run cost and
tool spend checks. Use `Agent first response latency` logs (outcome, elapsed
milliseconds, model; no message text) to compare generated/fallback rates and
p50/p95 latency before choosing a dedicated model or changing the deadline.

Verification covers overlap with blocked preparation, opening-before-execution
ordering, model failure/timeouts, late model completion, cancellation, transport
failure, unsafe output, and isolation between simultaneous requests.
