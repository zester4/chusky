# Twilio production activation checklist

The backend exposes the redacted machine-readable checklist at
`GET /v1/operator/twilio/activation` and includes the same payload in
`GET /v1/operator/readiness` as `twilioActivation`. It never returns Twilio,
Neon, Redis, Deepgram, or bridge-secret values.

## Before activation

- [ ] Apply migration `0020_voice_call_reconciliation.sql` to the production
  Neon branch using `DURABLE_STATE_MIGRATION_DATABASE_URL` (direct, not pooled).
- [ ] Verify Redis is configured and durable state is enabled.
- [ ] Deploy the root `chusky` backend and `chusky-voice` from their `main`
  branches.
- [ ] Configure the same high-entropy `TWILIO_MEDIA_BRIDGE_SECRET` on both
  services.
- [ ] Set `CHUSKY_VOICE_STREAM_AUTHORIZE_URL` on `chusky-voice` to the root
  backend's `/internal/twilio/stream-authorize` endpoint.
- [ ] Verify `TWILIO_WEBHOOK_BASE_URL` is HTTPS and
  `TWILIO_MEDIA_STREAM_URL` is WSS.
- [ ] Keep `TWILIO_CUSTOMER_BILLING_READY=false` and
  `TWILIO_REGULATORY_READY=false` until those integrations are externally
  verified.
- [ ] Run the real canary on a dedicated number: inbound, outbound, no-answer,
  busy, failed, voicemail, interruption, Composio action, human handoff,
  transcript/outcome persistence, duplicate webhook, Deepgram reconnect, and
  ambiguous provider response without redial.
- [ ] Run the distributed capacity/load test and confirm the global active-call
  limit is enforced across replicas.

## Activation order

1. Set `VOICE_CALL_PROVIDER=twilio`.
2. Leave `TWILIO_VOICE_ENABLED=false` while the migration, deployment, and
   canary gates are incomplete.
3. After the gates pass, set `TWILIO_VOICE_ENABLED=true` for controlled calls.
4. Enable `TWILIO_INBOUND_ENABLED=true` only after a dedicated Twilio number,
   durable route/profile, caller policy, and Voice URL are verified.
5. Keep `TWILIO_SUBACCOUNT_MANAGEMENT_ENABLED=false` until tenant credentials,
   webhook routing, suspension, and reconciliation have passed the canary.
6. Keep `TWILIO_NUMBER_MANAGEMENT_ENABLED=false` until customer billing,
   cancellation/release, regulatory bundles, and emergency-address handling
   are verified. Number sales are the final switch.

## Required production URLs

The root service should use:

- `TWILIO_WEBHOOK_BASE_URL=https://<root-domain>`
- `TWILIO_MEDIA_STREAM_URL=wss://<voice-domain>/twilio/stream`

The voice service should use:

- `CHUSKY_VOICE_TURN_URL=https://<root-domain>/internal/twilio/turn`
- `CHUSKY_VOICE_CONTEXT_URL=https://<root-domain>/internal/twilio/context`
- `CHUSKY_VOICE_STATUS_URL=https://<root-domain>/internal/twilio/status`
- `CHUSKY_VOICE_STREAM_AUTHORIZE_URL=https://<root-domain>/internal/twilio/stream-authorize`

Never put tenant subaccount auth tokens in `chusky-voice`. The root service
resolves and verifies the tenant credential for each call.
