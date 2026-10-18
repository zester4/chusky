# LiveKit voice transport

Chusky's LiveKit integration is an opt-in second realtime voice transport. It
does not replace Twilio, Bland, Slack, or the existing Chusky voice outcome
pipeline.

## Architecture

`livekit/` is a separate Node.js worker using the official LiveKit Agents
runtime. LiveKit owns room/SIP media, VAD, turn detection, streaming speech
recognition, language-model turns, and speech synthesis. Chusky remains the
authority for:

- owner and business identity boundaries;
- memory and knowledge selection;
- JEV routing and native/Composio/Treg/Monid tools;
- approvals, spend limits, and provider receipts;
- durable call records, transcripts, outcomes, and follow-up tasks.

The worker does not read Redis, Neon, or Chusky credentials. It exposes one
model-visible `consult_chusky` tool, which calls
`POST /internal/livekit/brain` with a short-lived HMAC request. The bridge
checks the saved `lvc_*` call record and user ownership before invoking the
normal private voice runtime.

## Agent Builder compatibility bridge

The code-based worker is the production path. If a LiveKit Agent Builder
agent is needed for a prototype or a controlled rollout, configure exactly one
HTTP action named `consult_chusky`:

```text
POST https://<public-chusky-host>/internal/livekit/builder/brain
Authorization: Bearer {{secrets.CHUSKY_LIVEKIT_BUILDER_SECRET}}
Content-Type: application/json
```

Its JSON body must contain only these fields:

```json
{
  "version": 1,
  "kind": "question",
  "callId": "{{metadata.callId}}",
  "userId": "{{metadata.userId}}",
  "turnId": "<unique id for this tool call>",
  "question": "<the caller's focused question>"
}
```

Define `callId` and `userId` as job metadata in Builder's Advanced tab. Store
the bridge value as the LiveKit Cloud secret
`CHUSKY_LIVEKIT_BUILDER_SECRET`; never put `LIVEKIT_BRAIN_SECRET` in Builder.
The Builder action must be described as a focused consultation for memory,
connected apps, research, scheduling, messages, or another real task. It must
not be used for ordinary conversation.

The adapter deliberately derives direction, purpose, profile, verification,
and the owner boundary from the active durable `lvc_*` call record. Therefore a
Builder preview room with no matching Chusky call record will receive
`unknown or inactive call`; that is expected and prevents the preview agent
from accessing anybody's brain. A real Chusky dispatch must create the call
record before the Builder room starts. The adapter then enters the same brain
path as the code worker, including memory, JEV, native tools, Composio, Treg,
Monid, approvals, spend limits, and verified outcomes.

Do not add the whole Chusky catalogue as Builder HTTP actions or MCP servers.
That would create a second authorization and memory boundary and would allow
the Builder model to bypass Chusky's routing policy.

## Safety and latency boundaries

- `LIVEKIT_ENABLED=false` is the default in both environments.
- Explicit agent dispatch is required; arbitrary rooms are never auto-joined.
- Job metadata is versioned and bounded, and never contains a brain secret.
- The worker prewarms Silero VAD and connects to the room before model setup.
- Turn handling uses local VAD, 300 ms minimum endpointing, 2 s maximum
  endpointing, interruption support, and current `turnHandling` preemptive
  generation. TTS speculation remains off by default to avoid wasted speech.
- Only one Chusky bridge tool is exposed; the whole tool catalogue is not
  copied into the realtime worker.
- Tool calls are sequential per turn, capped per call, and duplicate calls are
  rejected while one is running. The bridge tool calls `RunContext.update()`
  before the network request, so LiveKit can acknowledge the request and keep
  the conversation live while Chusky works.
- LiveKit recording is disabled for audio, transcript, logs, and traces by
  default. Traces can be explicitly enabled with `LIVEKIT_RECORD_TRACES=true`
  after reviewing the project's content-retention policy. Chusky's own
  transcript policy remains the source of truth when the telephony adapter is
  activated.
- Brain requests have bounded size, a 90-second signature window, a nonce, a
  stable idempotency key, and a strict timeout.

## Configuration

Use [livekit/.env.example](../livekit/.env.example) for the worker and the
LiveKit section in the root [.env.example](../.env.example) for Chusky. The
same random `LIVEKIT_BRAIN_SECRET` must be configured on both services. Keep
`LIVEKIT_ENABLED=false` until the worker is deployed and the call-control
adapter has been tested in staging.

## What to configure in LiveKit Cloud

For a room-based audio smoke test:

1. Create a LiveKit Cloud project and copy its WebSocket URL, API key, and API
   secret into the worker environment. Keep these credentials only on the
   worker; they are not sent to Chusky's model or browser.
2. Deploy the `livekit/` worker as a long-running Node service (Railway or a
   container is suitable): `npm ci`, `npm run build`, then `npm start`.
3. Set `LIVEKIT_ENABLED=true` and the same 32+ character
   `LIVEKIT_BRAIN_SECRET` on both the worker and the Chusky backend. Set the
   backend's `LIVEKIT_BRAIN_URL` to its public HTTPS route.
4. Create an explicit agent dispatch using the exact
   `LIVEKIT_AGENT_NAME` (`chusky-voice`). The worker intentionally does not
   auto-join arbitrary rooms.

For phone calls, also configure LiveKit SIP:

1. Bring a LiveKit Phone Number or a compatible SIP provider number.
2. Create an inbound SIP trunk for received calls and an outbound SIP trunk
   for placed calls. Record their IDs in the environment as
   `LIVEKIT_INBOUND_TRUNK_ID` and `LIVEKIT_OUTBOUND_TRUNK_ID`.
3. Create an inbound dispatch rule that routes the selected number to the
   `chusky-voice` agent. Chusky must still resolve the called number to the
   correct owner before it creates the durable call record.
4. Keep outbound dialing behind Chusky's call-control adapter so the same call
   ID, authorization, approval policy, and outcome pipeline are preserved.

The first staging sequence should be: room audio test, outbound SIP test,
inbound SIP test, tool-call test, interruption test, and only then production
traffic. LiveKit credentials and SIP trunks alone do not activate Chusky phone
calls until the existing `CHUCK_START_PHONE_CALL` and inbound number routes
are connected to `LiveKitControlPlane`.

## Current rollout boundary

The worker, signed brain bridge, provider-safe `livekit` call type, and
server-side dispatch/SIP adapter are scaffolded and tested without placing a
call. The remaining activation step is to connect `CHUCK_START_PHONE_CALL` and
the inbound number router to `LiveKitControlPlane`, create durable call
records before dispatch, and feed the final LiveKit transcript into the
existing outcome/follow-up finalizer. This is intentionally separate from
Twilio/Bland so an incomplete LiveKit rollout cannot change existing calls.

The implementation follows the stable Node.js Agents API and Server SDK
contracts installed in `livekit/package.json` (Agents `1.9.3`, Server SDK
`2.19.1`). The default LiveKit Inference LLM is
`google/gemma-4-31b-it`; benchmark alternatives only after measuring both
first-audio latency and tool-call accuracy.

