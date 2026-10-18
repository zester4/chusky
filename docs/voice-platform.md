# Chusky voice platform blueprint

This document records the production direction for the voice system. It is
intentionally separate from the media bridge so transport work, agent work,
and product work can evolve without another monolithic `app.py`.

## What the leaders consistently do

The strongest current voice stacks converge on the same primitives:

1. A semantic turn detector, not silence-only VAD. Flux exposes
   `StartOfTurn`, `EagerEndOfTurn`, `TurnResumed`, and `EndOfTurn`; a
   provider-neutral turn detector can combine semantic and acoustic signals
   and support adaptive endpointing.
2. A real playback clock. Audio is sent in paced frames, and interruption
   clears provider buffers immediately. Twilio explicitly documents marks for
   playback tracking and `clear` for removing buffered audio.
3. Speculative generation with cancellation. Start preparing on an eager
   endpoint, but commit and persist only on the definitive endpoint.
4. A bounded tool lane. Voice exposes only the capability bundle needed for
   the call, keeps long operations asynchronous, announces progress naturally,
   and never claims success without a provider receipt.
5. A session timeline. Production debugging needs transcript roles, turn
   events, tool events, first-token/first-audio timings, interruption timing,
   provider errors, and a post-call quality review—not just a final summary.
6. Recovery as a product behavior. Every stage needs a bounded retry or a
   truthful fallback, with idempotent writes and human handoff when the agent
   cannot safely complete the job.

## Competitive lessons beyond the media provider

The differentiator is the control plane around the model. The leading products
are converging on these patterns:

- Vapi treats tools as versioned, bounded call capabilities and exposes native
  transfer, voicemail, DTMF, SMS, end-call, and API controls. Its dynamic
  transfer flow supports warm or cold handoff and a context summary, so a human
  does not receive a blind transfer.
- Retell separates free-form prompting from deterministic conversation flows.
  Its custom functions carry call and transcript context, require signed
  requests, support bounded retry, and expect idempotent side effects. Its
  simulation and call-analysis features turn conversations into regression
  tests rather than relying on subjective listening.
- Realtime runtimes put endpointing, adaptive interruption, preemptive
  generation, false-interruption recovery, tool-step limits, handoffs, and
  observability in the session runtime. The active tool list should stay
  focused; exposing a giant catalogue hurts latency and tool selection.
- ElevenLabs makes interruption behavior a per-tool policy and provides system
  tools for transfer, voicemail detection, DTMF, state updates, skipping a
  turn, and ending a call. That is a useful distinction: a read-only lookup
  should remain interruptible, while a committed financial or scheduling write
  should finish atomically.
- PolyAI separates deterministic branching, validation, API calls, retries,
  and fallback from the language model, while using the model for the natural
  conversation. Its ASR biasing for names, numbers, dates, and addresses is
  especially important for business calls.
- Synthflow treats greetings as an explicit product state: human-first,
  static, or dynamic. This avoids spending a slow model turn on the most
  important ten seconds of an outbound call.
- Telnyx demonstrates the same architecture at the carrier edge: structured
  gather operations, message history, and webhooks make data collection a
  typed event rather than an instruction buried in a prompt.

The practical Chusky conclusion is not to copy another provider. It is to add
an explicit call-control contract: direction, represented party, objective,
caller-facing topic, verification tier, bounded capability bundle, voicemail
policy, interruption policy, escalation path, and measurable outcome. The
model then performs the conversation inside that contract.

## Chusky mapping

Already present in the current implementation:

- Twilio bidirectional μ-law transport and 20 ms pacing.
- Flux eager/final turn events and interruption handling.
- Persistent streaming TTS, `SpeechInterrupted`, playback offsets, and
  Twilio `clear`/`mark` coordination.
- OpenRouter streaming into phrase-level TTS.
- Exact Composio capability preloading for calendar, CRM, email, support,
  billing, orders, sheets, documents, and meetings.
- Outbound/inbound role contracts, caller-facing openings, bounded context,
  approval boundaries, idempotent commits, and post-call outcomes.
- Bounded owner-private voice tool payloads: the model receives only native
  read tools and the exact Composio actions selected for the current call;
  broad MCP discovery is kept out of live phone turns.
- Typed owner-safe call timeline events for start, answer, voicemail, handoff,
  tool, turn, and terminal states. These events contain no raw audio,
  credentials, or provider payloads.
- Optional per-call controls for quiet hours, voicemail, human handoff,
  opt-out handling, recording policy, and retention metadata.
- A deterministic `voice:evaluate` replay harness and `voice-qa-v1`
  scorecard covering role, disclosure, purpose, latency, tool accuracy,
  interruptions, and resolution.

The remaining platform work is being delivered in bounded slices:

### Phase A — conversation quality

- Adaptive endpointing behind a rollout flag.
- A single provider-neutral turn state machine for Twilio and meetings.
- First-audio, final-response, barge-in, tool-wait, fallback, and silent-turn
  SLOs measured per call.
- A replayable voice evaluation harness with inbound, outbound, noisy,
  interrupted, wrong-person, voicemail, and tool-failure scenarios.
- Adaptive endpointing and interruption policy remain rollout-controlled; the
  current implementation is deliberately off by default until a canary proves
  fewer false cuts without increasing blank turns.

### Phase B — agentic call execution

- A call plan created before dialing: role, represented party, objective,
  contact identity, allowed capability bundle, approval policy, and escalation
  route.
- Separate read, reversible-write, irreversible-write, and financial tool
  classes.
- Async tool jobs with spoken progress, cancellation semantics, provider
  receipts, and human transfer when a commitment cannot be verified.
- Warm per-call Composio sessions and capability cache without exposing the
  full connected-app catalogue to the voice model.
- Deterministic call-control plans are now generated before the voice model
  runs. They select bounded capability bundles from the purpose and classify
  tool interruption behavior so reads stay conversational and committed writes
  are not cut off halfway through.
- Provider-neutral handoff and voicemail events are now recorded in the call
  timeline. External tool lifecycle events are also recorded with safe slugs;
  provider receipts remain the source of truth for completion.

### Phase C — enterprise operating layer

- Owner-scoped live and post-call transcripts with retention controls.
- QA scorecards: correct identity, objective adherence, disclosure, tool
  correctness, interruption quality, unsupported-claim rate, and resolution.
- Consent, recording/transcription policy, quiet hours, opt-out, regional
  caller-ID rules, voicemail detection, and configurable human handoff.
- Provider-neutral transport adapters so Twilio remains the current carrier
  without making the agent runtime Twilio-specific.
- Business-admin controls for greeting mode, quiet hours, opt-out, recording
  consent, retention, caller-ID policy, transfer rules, and per-scenario
  capability bundles.
- A scorecard and simulation runner that grades every release on role,
  disclosure, purpose, latency, interruption, tool correctness, handoff, and
  resolution—not only whether the call connected.

## SLOs to earn a world-class score

These are targets, not claims about the current live deployment:

- Simple turn: first audio p50 at or below 350 ms after definitive end of
  turn, p95 at or below 800 ms.
- Barge-in: local audio stop plus provider buffer clear p95 at or below 250 ms.
- Silent turns: below 0.5% in a canary set, with every fallback classified.
- Tool truthfulness: 100% of external writes have a verified receipt or a
  spoken failure/pending state.
- Role/objective correctness: at least 99% on a frozen outbound/inbound
  evaluation set.
- Recovery: no duplicate external write after retry or reconnect.

The 98% product goal should mean passing these measurable scenarios, not a
marketing score. A live canary and replay suite are required before claiming
it.

## Verification commands and canary boundary

`npm run voice:evaluate` prints the built-in scenario catalogue. Passing
`--fixture path/to/trace.json` scores one sanitized trace without contacting a
provider. A fixture contains `scenarioId` and a bounded `trace` object; it
must not contain raw audio, credentials, or full provider responses.

The remaining production proof is a user-authorized Twilio canary using a
controlled test number. Record first-audio latency, final-turn latency,
interruption recovery, tool receipts, voicemail behavior, handoff behavior,
and the resulting timeline. Local tests and a successful bridge connection do
not prove carrier or deployed-service behavior.

## Design choice

We are keeping the chained architecture—Twilio → Flux STT/turn detection →
OpenRouter/Chusky agent → streaming TTS → Twilio—and strengthening its control
plane. A full realtime model would reduce some orchestration work, but would
also move our tools, approvals, owner isolation, and fallback behavior into a
new runtime. The current design lets Chusky keep its agentic advantage while
borrowing the best voice-runtime patterns without a risky platform migration.
