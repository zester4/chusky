# Bland and voice system handoff

Updated: 2026-10-17

This is the implementation handoff for the next engineer working on Chusky's
phone-call system. It covers the recent Bland inbound work and the existing
voice-call behavior. It is intentionally explicit about what is implemented,
what the configuration names mean, and what remains to be expanded.

## Executive summary

Chusky now supports Bland inbound numbers as well as Bland outbound calls.
Inbound calls are provider-managed by Bland. Bland answers the phone, uses its
configured prompt, and can call Chusky's live Consult tool when the caller asks
for information or help that requires Chusky context.

The inbound number is mapped to a Chusky account/workspace anchor. The current
storage and agent APIs are user-scoped, so the route value is currently the
numeric Telegram/Chusky account user ID that owns the business workspace. The
word `owner` in legacy variable names means that account scope; it does not
mean that only the owner may call the number.

By default, any caller can reach a configured Bland business number. The
optional caller allowlist is a verification signal, not an inbound access
gate. Unknown callers are treated as public/unverified and cannot receive
private account data or perform private state-changing actions.

## Bland inbound flow

1. A caller dials a Bland inbound number.
2. Bland sends a signed call event to the number-specific Chusky callback.
3. Chusky validates the HMAC signature and maps the destination number to its
   configured account/workspace anchor.
4. Chusky creates an idempotent inbound `PhoneCallRecord` before live tool
   consultation can occur.
5. Bland invokes the existing signed Consult Chusky custom tool for questions
   that need Chusky context.
6. Chusky resolves Bland's provider call ID to the scoped call record and runs
   the appropriate voice agent context.
7. Bland sends the signed post-call payload. Chusky persists the transcript
   roles, summary, structured outcome, QA scorecard, and durable follow-up
   tasks exactly once.

Duplicate provider events are safe. A deterministic inbound call ID and the
provider-call index prevent duplicate call records; the post-call delivery
lease prevents duplicate outcome processing.

## Business versus personal inbound behavior

### Business line

Use `BLAND_INBOUND_CALL_PROFILE=business`. A normal caller can ask about
approved public company facts and receive a natural response. A verified caller
from `BLAND_INBOUND_ALLOWED_CALLERS` can use the account's private context and
approved tools, subject to the normal approval and provider-verification rules.

An unverified caller cannot receive private history, private memories,
connected-app records, credentials, or state-changing actions. This is a
deliberate protection for a public company number; it is not a restriction on
who may dial the number. The call can still be recorded as an inbound request,
and the post-call workflow can preserve the request for the account to handle.

### Personal line

Use `BLAND_INBOUND_CALL_PROFILE=personal` when the number is intended for a
personal assistant. Do not expose private context to a caller merely because
they know the number. Configure the verified caller list for people who should
receive the higher trust tier.

### Current organization limitation

The call record and live agent runtime are currently anchored to one Chusky
user account. A business can use the feature today by mapping each business
number to its business account/admin anchor, and it can have multiple numbers
by adding multiple mappings. True organization/team dispatch—routing a caller
to a team, department, representative, or per-business policy—still needs a
separate organization-scoped call policy.

The next safe expansion should add:

- an explicit `organizationId`/business identity on the call route;
- authorized team members and department routing;
- a business-defined public-action policy;
- safe public actions such as lead capture, callback requests, support-ticket
  creation, and appointment requests;
- confirmation, audit, idempotency, and approval rules for every public action;
- human handoff when the caller requests a person or the request is ambiguous.

Do not solve this by giving every public caller the account's unrestricted
private tools.

## Railway configuration

The production Railway public origin used by the current voice documentation
is:

```text
https://chusky.up.railway.app
```

The Bland inbound callback root is:

```text
https://chusky.up.railway.app/bland/inbound/webhook
```

The setup command appends the digits-only destination number and registers a
callback such as:

```text
https://chusky.up.railway.app/bland/inbound/webhook/15550000001
```

If Railway's public domain changes, update `WEBHOOK_URL` or
`BLAND_INBOUND_WEBHOOK_URL` and run the provider setup command again.

Required service variables:

```dotenv
BLAND_VOICE_ENABLED=true
BLAND_API_KEY=<Bland API key>
BLAND_WEBHOOK_SECRET=<at least 32 random characters>
BLAND_CONSULT_TOOL_ID=TL-<tool ID created by setup:bland-tool>
BLAND_CONSULT_TOOL_SECRET=<same secret configured in the Bland custom tool>

BLAND_INBOUND_ENABLED=true
BLAND_INBOUND_WEBHOOK_URL=https://chusky.up.railway.app/bland/inbound/webhook
BLAND_INBOUND_ROUTES=+15550000001=<business Chusky account user ID>
BLAND_INBOUND_ALLOWED_CALLERS=
BLAND_INBOUND_CALL_PROFILE=business
BLAND_INBOUND_PURPOSE=Handle an inbound caller request
```

`BLAND_INBOUND_ALLOWED_CALLERS` is optional. Leave it blank if the number is
public and callers should receive the public/unverified tier. Populate it with
comma-separated E.164 numbers only when those callers should be recognized as
verified.

The existing outbound Bland setup remains separate and still needs the same
Consult tool ID/secret and the signed Bland webhook configuration.

## What the setup command does

Run this once after the public Railway service and required variables exist:

```bash
npm run setup:bland-inbound -- +15550000001
```

The command is not a local voice server and it does not replace deployment. It
calls Bland's inbound-number API and configures that number with:

- the provider-managed inbound prompt and first sentence;
- the Chusky signed callback URL;
- live Bland call/tool/latency events;
- the existing Consult Chusky tool.

It can be run from a local checkout with the Bland variables in a local `.env`
file, or from a controlled deployment shell. It does not write secrets to the
repository. It must be rerun when the Bland number, public Railway URL,
Consult tool ID, or provider-managed prompt changes. It does not need to run
on every Railway deploy: the number configuration is held by Bland, while the
Railway service only needs the matching runtime variables and routes.

For a new number, add its `E.164=accountUserId` entry to
`BLAND_INBOUND_ROUTES`, deploy the service, then run the setup command for that
number. Verify `/health` reports `checks.blandInbound: "configured"` before
placing a test call.

## Relevant implementation files

- `src/calls/blandInbound.ts` — route parsing, number normalization, account
  mapping, verification tier, and idempotent inbound registration.
- `src/calls/blandWebhooks.ts` — signed Bland event/post-call handling,
  provider-ID correlation, transcript normalization, outcomes, QA, and
  follow-up scheduling.
- `src/calls/blandBrain.ts` — live Chusky consultation and private/public
  context boundary.
- `src/calls/bland.ts` — outbound Bland call creation and provider settings.
- `src/calls/blandTool.ts` — Consult Chusky custom-tool setup and validation.
- `src/calls/voiceProfile.ts` — personal/business voice behavior and call
  guardrails.
- `src/calls/voicePreparation.ts` — bounded voice-context preparation.
- `src/calls/voiceEvaluation.ts` — deterministic post-call QA scoring.
- `src/calls/followUp.ts` — durable post-call follow-up scheduling.
- `src/index.ts` — `/bland/inbound/webhook` routes, `/bland/tool`, and health.
- `src/config.ts` — Bland/Twilio voice and inbound environment configuration.
- `scripts/setup-bland-inbound.ts` — one-time Bland number registration.
- `tests/bland-inbound.test.ts` — signed routing, verification, outcome, and
  duplicate-delivery coverage.

## Twilio status

Twilio is a separate voice transport. It already supports inbound and outbound
calls through the media bridge. Its current inbound configuration is stricter:
`TWILIO_INBOUND_ALLOWED_CALLERS` is an allowlist and unknown callers are
rejected before private agent access. Do not assume the Bland public-business
policy applies to Twilio. Update Twilio deliberately when the next voice work
starts.

## Verification completed for the Bland update

- TypeScript typecheck: passed.
- Production build: passed.
- `git diff --check`: passed.
- Compiled signed inbound smoke: passed.
- Smoke covered live event registration, verified caller tier, post-call
  outcome persistence, duplicate post-call suppression, and one durable call
  record.
- No live Bland credential call was made from this workspace.

## Deployment handoff

The implementation and this handoff are local until explicitly committed,
pushed, and deployed. After deployment, test at least:

1. Public business caller: call the Railway Bland number and ask a public FAQ.
2. Unknown caller: confirm no private data or private tool action is exposed.
3. Verified caller: confirm the configured verification tier is recognized.
4. Consult question: confirm the live tool resolves the correct call ID.
5. End the call: confirm one transcript/outcome/QA/follow-up record appears.
6. Replay the provider post-call callback: confirm no duplicate outcome/task.

## Latest voice reliability and transcript update

The live Twilio voice path now keeps the phone call isolated from the owner's
general chat context. Each non-speculative turn uses only the finalized turns
already stored on that call, the approved call purpose/profile, and the
purpose-approved tools. It does not pass unrelated chat messages, files, or
images into the live voice model. Bland's private consultation path uses the
same call-specific history boundary.

The Deepgram final transcript is the source of truth for Twilio turns. The
bridge sends the completed Deepgram text to `/internal/twilio/commit-turn`,
where it is stored idempotently on the `PhoneCallRecord` (bounded to the most
recent 80 turns). The dashboard exposes it under each call as a Deepgram
transcript. No second transcription pass and no Twilio transcription service
are required.

Outbound profiles now accept an optional verified `contactName` and
`organization`. When supplied, the transport greeting can say who Chusky is
calling and which business it represents. The system must not invent either
value; if the caller or dashboard does not provide them, it uses a truthful
generic identity instead.

Voice tool preparation is purpose-bounded. Calendar, CRM, email, support,
billing, orders, documents, and meeting actions are preloaded by exact
approved action slugs when the call purpose requires them. The full connected
app catalogue and broad JEV routing are not loaded into the live phone turn.
This reduces first-audio latency and prevents unrelated file/image tools from
appearing in the call.

Completed tool timeline events retain a bounded provider receipt ID. The
post-call outcome handler re-reads the latest call record before synthesis and
will only describe an appointment, message, or update as completed when a
matching provider receipt exists. A model statement or a tool-start event is
not proof that the external action succeeded.

Local verification for this update:

- Backend typecheck and production TypeScript build passed.
- Dashboard typecheck and ESLint passed.
- Focused voice tests passed: 12 call-context tests and 5 phone-outcome tests.
- The standard `tsx` test command and dashboard production build could not run
  in the managed sandbox because it blocks child-process/IPC creation; this is
  an environment limitation, so a normal CI/Railway build is still required.
- The change is not deployed until the backend and dashboard repositories are
  committed, pushed, and deployed.

After deployment, place one real test call that asks for a calendar booking:
provide the contact name, business name, and an explicit time such as “nine AM
tomorrow.” Confirm all four items in the Calls page: the opening names the
contact/business, the Deepgram transcript is visible, the calendar timeline
contains a completed event with a receipt, and the outcome says “confirmed”
only if that receipt is present. If no receipt appears, the call must report
that the appointment remains unconfirmed.
