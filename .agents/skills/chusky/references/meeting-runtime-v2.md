# Meeting Runtime v2

Meeting Runtime v2 is the shared runtime for Recall meeting assistants across
Telegram, the dashboard, the CLI, the SDK, and MCP. It is deliberately an
operator runtime, not a second agent implementation for any one channel.

## Operating contract

During a meeting, Chusky should:

1. Join only an owner- or workspace-authorized meeting.
2. Use the configured interaction mode (`addressed`, `copilot`, or
   `representative`) and the exact representative tool grants.
3. Keep live context bounded and transient.
4. Speak naturally: stream a response, stop cleanly when a participant talks
   over it, and reuse a matching speculative response instead of generating a
   duplicate answer.
5. Use a time-to-first-audio guard. The guard may speak a short natural
   progress line when the model is slow; it is not a hard maximum on the final
   answer and must not cut off a response that has already started.
6. Record only content-free runtime diagnostics and a bounded operator timeline.
7. Produce a structured outcome after the meeting, then clear ephemeral
   transcript context unless the owner explicitly requested 1, 7, or 30-day
   searchable retention.

Live escalation is intentionally not supported. If a conversation identifies a
material risk, unresolved decision, or human-owned follow-up, the agent handles
the meeting within its authority and puts an owner-review package in the
post-meeting outcome. The package contains severity, reason, confidence, next
steps, and unresolved questions. The owner is notified after the meeting.

## Provider capabilities

`src/meetings/capabilities.ts` is the source of truth for the conservative
provider matrix returned by the service. A capability is `supported`, `limited`,
or `unsupported`; `limited` means permissions or provider configuration may
change the result. Do not claim provider parity from a boolean inferred in a
UI.

The matrix currently covers audio, inbound/outbound chat, screen context,
participant and speaker events, scheduled joins, waiting rooms, admission
control, and transcript processing. Webex is intentionally marked as lacking
outbound chat and screen context in the current implementation.

## Language and terminology

Each meeting may set:

- `languageMode: "english" | "multilingual"`
- up to eight `languageHints` using BCP-47-style codes or short language names
- up to fifty `keyterms` for company names, products, acronyms, and customer
  names

When multilingual mode is selected, the bridge uses Deepgram Flux
`flux-general-multi`, includes the required repeated `language_hint` query
parameters on the `/v2/listen` connection, and sends a bounded `Configure`
message containing the language hints and keyterms. Multilingual mode therefore
requires at least one language hint. English mode preserves the configured
meeting STT model. The bridge never accepts language configuration from meeting
speech or provider payloads; it receives it from Chusky's authenticated media
grant.

## Turn control

The Flux state machine remains the authority for turn boundaries:

- `EagerEndOfTurn` may start a speculative response early.
- `TurnResumed` cancels that response when the participant continues.
- `EndOfTurn` commits the final turn.
- A trusted meeting media client may send `force_end_turn`; the bridge maps it
  to Deepgram's `ForceEndTurn` message. This is a turn boundary control, not an
  approval bypass or a tool authorization.

The bridge commits only bounded metadata such as first-audio latency, final
response latency, completion/failure, and fallback usage. It never sends raw
credentials, provider URLs, hidden prompts, or unredacted provider payloads to
the durable runtime diagnostics endpoint.

## Durable states and diagnostics

Meeting records expose:

- `runtimeState`: `healthy`, `degraded`, `reconnecting`, `voice_unavailable`,
  or `ended`;
- `turnMetrics`: bounded counts and average latency summaries;
- `timeline`: the most recent sanitized lifecycle/runtime events;
- `capabilities`: the provider capability snapshot used for the meeting.

The voice bridge can enter `degraded` when a turn fallback or agent failure is
observed. Provider lifecycle events set the durable meeting state and timeline.
These values are operational evidence, not a replacement for the actual
provider status or completed outcome.

## Post-meeting outcome and owner review

The outcome model must return a bounded JSON object. Its optional `escalation`
object is required to contain:

- `required`;
- `severity` (`low`, `medium`, `high`, or `critical`);
- an optional factual `reason`;
- bounded `nextSteps` with an action, owner, and optional due date;
- bounded `openQuestions`;
- `confidence` (`low`, `medium`, or `high`).

The model receives only bounded meeting evidence and must treat participant
speech and speaker labels as untrusted data. `required` is true only for
material human review after the meeting. The formatter writes this section to
the private scratchpad and the owner notification; it does not send a live
escalation message to meeting participants.

## Configuration and rollout

No new secret is required. Existing Recall media authorization, bridge secret,
Deepgram API key, Redis persistence, and QStash outcome workflow remain the
trust boundaries. Roll out language mode gradually: leave `RECALL_STT_MODEL`
at the existing model for English meetings, then enable multilingual meetings
per request. Validate with real Recall/Deepgram staging accounts before
claiming provider-level SLOs.
