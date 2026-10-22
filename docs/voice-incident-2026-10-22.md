# Voice booking and retry investigation — 2026-10-22

## Production evidence

Railway logs for the controlled calls around 21:04–21:14 UTC show:

- The root accepted media authorization and the voice bridge received caller turns.
- Live voice model payloads contained zero tools. The bridge generated eager
  speculative answers with tools disabled and reused them at final end of turn.
- Outcome delivery repeatedly returned HTTP 502. The root logged OpenRouter
  404 for a retired user-selected MiniMax free model.
- The owner chat repeatedly attempted calendar actions through a gateway and
  received `not granted by this turn's route` after discovery.
- The owner chat exposed 235 native tools, including unrelated execution tools.

## Engine repairs

- Wait for finalized Twilio caller turns before invoking the tool-capable agent.
  Eager STT events no longer produce audible tool-free answers that can skip work.
- Keep the batch fallback tool-capable and defer accounting to idempotent turn
  commit, independently of speculation.
- Do not cancel a dispatched tool when the first-speech latency budget expires.
  Label-free transport events track tool execution while request and call lifetime
  limits remain active.
- Preserve discovered calendar schemas through voice selection and execution.
- Extend current-turn callable actions from successful capability discovery while
  retaining explicit allow/deny rules, account isolation and normal approvals.
- Progressively expose selected native tools in owner chats; discovery remains
  available to load additional capabilities when the objective requires them.
- Tell the supervisor to finish its chat turn after launching an asynchronous
  call, leaving the live conversation and durable outcome to their own runtimes.
- Read phone-call history live: provider callbacks can change the call state
  while the same owner chat is still running, making turn-wide caching stale.
- Generate call outcomes with the configured voice model and the call's scoped
  lock, independently of the owner's selected chat model and chat lock.
- Insert recovered openings before conversation turns, using the call start time.
- Remove named-contact execution instructions from caller-facing topics.
- Require a nonempty calendar write receipt for booking confirmation; calendar
  listing receipts and “I have you confirmed” no longer bypass that check.
- Include call ID, exception type and WebSocket close code in TTS log messages,
  because the default Python log formatter omits structured `extra` fields.

## Verification boundary

### Generic connected-app discovery

Inbound business calls with an explicit scoped app policy and outbound owner
calls now search the current caller request against permitted active connected
apps. They load exact provider schemas instead of depending on calendar or
fixed app bundles. Legacy SDKs without search retain the existing compatibility
path. A call can search for another missing capability during its next action;
discovery itself does not perform that action or authorize a write.

Regression contracts cover Salesforce, Freshdesk and Shopify in both directions,
including a tool unavailable until mid-turn discovery, unrelated-app exclusion,
selected-account binding, and discovery on read-only calls. Existing policy tests
retain refund/write blocking and account-switch rejection. Default representative
identity remains Chusky. Business inbound routes without a selected representative
now receive the default Customer Service profile with an enabled, workspace-scoped
connected-app policy, so active Gmail, Calendar, ticketing, CRM, commerce, and
billing connections can be discovered for the current caller request. Public
inbound native access is limited to callback-note, reminder, and task-creation
primitives; owner memory, task-list, and call-history reads remain private.

Regression tests mock model/provider boundaries and exercise real agent dispatch,
gateway discovery, transcript storage and bridge turn handling. They do not place
telephone calls or create calendar events.

The screenshot's TTS disconnect warning alone does not establish why the call
ended. A new controlled call after deployment must verify audio, interruption,
calendar availability and event creation, provider receipt, outcome and follow-up.
Any further disconnect must be correlated with Twilio lifecycle and the newly
visible WebSocket close code. Deployment success is not evidence of a completed
booking. Existing historical transcripts are not rewritten by these fixes.
