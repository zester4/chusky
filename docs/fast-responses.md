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
| `TURN_OPENING_ENABLED` | `false` | Optional rollout/rollback switch for a separate opening model |
| `TURN_OPENING_MODEL` | `openai/gpt-4.1-nano` | Separate verified low-latency text model |
| `TURN_OPENING_DEADLINE_MS` | `600` | Generation deadline, capped at 2500 ms |
| `OPENROUTER_PREFERRED_MAX_LATENCY_SECONDS` | `5` | Soft provider-routing preference for interactive model turns; `0` disables it |
| `OPENROUTER_INTERACTIVE_MAX_TOKENS` | `2048` | Completion budget for action-bearing interactive turns |
| `OPENROUTER_CONVERSATIONAL_MAX_TOKENS` | `768` | Completion budget for short conversational turns |

Interactive and voice turns use OpenRouter's latency ranking. Structured artifact
generation uses throughput ranking instead, so long outputs do not compete with
short replies for the same provider preference. Each model request also uses a
stable hashed affinity key for its conversation, mission, task, or meeting;
unrelated chats do not share a cache session. The request sends the current
`max_completion_tokens` field and records first-text-delta and total response
latency in structured logs.

The opening frame is sent before its durable run snapshot is written. The
snapshot is queued immediately and terminal closeout waits for that queue, so a
database round trip cannot block the first user-visible response. Delivery has
a separate 1500 ms bound. These are server budgets after admission, not a
guarantee of end-to-end latency: authentication, durable admission, provider
queues, and client networking still affect what the user sees. Model usage
reported for the opening contributes to the agent's total run cost and tool
spend checks. Use `Agent first response latency` for generation/delivery and
`Agent first response frame sent` for measured request-to-frame and
stream-to-frame latency; neither log includes message text.

Verification covers overlap with blocked preparation, opening-before-execution
ordering, model failure/timeouts, late model completion, cancellation, transport
failure, unsafe output, and isolation between simultaneous requests.
