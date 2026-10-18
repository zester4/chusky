# Photon 2.0 Beta transport

Chusky's Photon integration targets the Photon 2.0 **Beta** project API. It is an optional transport federation: it feeds Photon messages into the existing Chusky channel gateway, so linking, scopes, approvals, memory, tools, outbox delivery, and idempotency stay in one place.

This is deliberately separate from the existing Slack, Twilio, Bland, Sendblue, X, XChat, and voice adapters. Turning Photon off returns the service to those adapters; it does not migrate or replace them.

## Version and credentials

This integration uses the Beta documentation contract and `@photon-ai/api@0.5.0` on Node 24+. Do not mix it with the Stable Spectrum SDK. Beta uses a project API key and the Photon API origin; it does not use a Photon webhook secret or a project secret.

Server-only environment:

```dotenv
PHOTON_ENABLED=false
PHOTON_PROJECT_ID=pho_prj_...
PHOTON_API_KEY=pho_sk_...
PHOTON_API_ORIGIN=https://api.photon.codes
PHOTON_API_VERSION=
PHOTON_EVENT_CONSUMER=chusky-channel-gateway
PHOTON_MAX_PENDING_EVENTS=128
PHOTON_PROVIDERS=imessage,whatsapp,telegram
PHOTON_DEFAULT_SCOPE=shared
```

The key needs project read/write permission for runtime messaging. iMessage line assignment additionally needs the platform write permission. Never expose the key to the web client or include it in logs. `PHOTON_API_VERSION` is optional; when empty, the event subscription uses the server-selected version and persists the negotiated version with the replay cursor.

The Beta API currently exposes SMS, email, WhatsApp, WhatsApp Business, iMessage, and Telegram message contracts. Chusky accepts `imessage`, `whatsapp`, `telegram`, `sms`, and `email` in `PHOTON_PROVIDERS`; `whatsapp` maps to Photon's `whatsapp_business` platform. Discord and Photon voice are separate product surfaces and are not fabricated into this text-channel adapter. Slack remains on the existing Slack implementation. Twilio/Bland remain the existing voice implementations.

## Install

```sh
npm install @photon-ai/api@0.5.0 socket.io-client
```

The application is CommonJS while the Photon SDK is ESM, so the runtime loads the SDK dynamically. This avoids changing the module system of the rest of Chusky.

## iMessage setup

Photon iMessage uses a shared line. The test sender is the human phone number or Apple-account email that starts the conversation; Photon assigns the agent's number. Do not treat the sender as the agent and do not invent a User ID from a phone number.

Set these values locally and keep the same setup key for retries:

```dotenv
PHOTON_PROJECT_ID=pho_prj_...
PHOTON_API_KEY=pho_sk_...
PHOTON_TEST_SENDER=+14155550123
PHOTON_SETUP_KEY=first-agent-imessage-unique-key
```

Run the documented assignment operation:

```sh
npm run photon:setup:imessage
```

Save the returned `assignedPhoneNumber` as `PHOTON_AGENT_HANDLE`. The script is safe to retry with the same idempotency key. It does not put credentials in output.

Then run the bounded round-trip smoke test:

```dotenv
PHOTON_AGENT_HANDLE=+14155550188
```

```sh
npm run photon:imessage:smoke
```

Wait for `Ready`, start a new direct iMessage conversation from `PHOTON_TEST_SENDER` to the assigned agent number, and send exactly `ping`. The test replies with `Hello from your Photon agent!`. `Reply accepted` means Photon accepted the asynchronous send, not that the device has displayed it; confirm delivery in the conversation or Photon API Activities.

The smoke test intentionally filters by project, platform, received status, sender, receiving agent, direct space, current run, and exact plain-text content. It paginates correctly and uses `first-agent-reply:<incoming-message-id>` as the stable idempotency key.

## Production event delivery

Production does not poll and does not add a public Photon webhook route. `PhotonBridge` connects to the documented Socket.IO event path:

```text
https://api.photon.codes/v1/projects/{projectId}/events/ws
```

It uses WebSocket transport and the Bearer project key. On connect it subscribes with the last durable sequence cursor. The cursor is stored per Photon project and consumer in the same durable backend used by Chusky. A distributed consumer lease ensures only one Railway replica owns that cursor at a time; standby replicas retry acquisition instead of processing the same stream out of order. The owner processes deliveries serially and only advances the cursor after the message has been normalized and accepted by the Chusky gateway. A failed delivery closes the stream so Socket.IO reconnects and Photon replays from the last committed cursor.

When Photon marks a delivery with `replyExpected`, Chusky immediately emits the documented `reply` frame with a small `202` response and waits for Photon’s acknowledgement. That acknowledgement means Photon accepted the response for forwarding; it is not treated as downstream delivery proof. The application work still runs through the durable serial queue, so a reply deadline never causes the event cursor to advance early.

This gives the adapter at-least-once delivery with replay-safe behavior. The gateway and Photon send calls also retain their own idempotency boundaries; a reconnect must never be treated as proof that a message was processed successfully.

The bridge accepts only `message.received` events whose object belongs to the configured project, is actually received, has a human sender and agent recipient, and has a supported platform. Outbound messages and unsupported platform events are ignored. Attachments are fetched through Photon's attachment API, bounded to 12 MiB, and converted into the existing owner-scoped Chusky media representation. Raw Photon envelopes are not placed in agent context.

## Channel linking

Photon identities are intentionally separate from legacy provider identities. Use the exact provider name when creating a link code:

```text
photon_imessage
photon_whatsapp
photon_telegram
photon_sms
photon_email
```

An unlinked inbound message receives only the normal linking instructions and cannot enter an owner's tools, memory, or private context. Direct Photon spaces are private; group/channel/shared spaces use `PHOTON_DEFAULT_SCOPE` unless the deployment has an explicit scope policy. Shared conversations never inherit private approval authority.

## Outbound behavior

Replies use the incoming space ID and receiving agent ID. The incoming message ID is carried as `parentMessageId` when available. Every send has a stable idempotency key. Photon attachments are uploaded with separate idempotency keys before the message is sent. Interactive Chusky buttons are rendered as plain text because this adapter does not claim native button support. Typing indicators use Photon's `setSpaceTyping` operation where the platform supports them.

Photon's `sendMessage` operation is asynchronous: an accepted API response is not a delivery receipt. Delivery failures remain observable through Photon activity records and Chusky's outbox/provider logs.

## Rollout

1. Install the pinned SDK and run typecheck/tests.
2. Deploy with `PHOTON_ENABLED=false`; verify the health check reports Photon disabled.
3. Configure one Photon platform in staging and enable the flag.
4. Run the iMessage setup and smoke test or the equivalent platform-specific test.
5. Verify the event cursor advances only after gateway processing and survives a restart.
6. Verify the inbound provider is the expected `photon_*` namespace and never a legacy adapter.
7. Verify link enforcement, private/shared scope, attachment size limits, duplicate delivery, and outbound idempotency.
8. Enable additional providers one at a time and monitor connection, replay, gateway, and outbox metrics.
