# Proactive operating layer

`src/proactive/` is the provider-neutral vocabulary and policy layer for
Attention Pulse/Elena. It does not contain credentials, provider payloads, or
unbounded tool authority.

## Boundaries

- `catalog.ts` defines the twenty proactive behaviors the governor can choose
  from. A catalogue entry is not permission to access a provider.
- `watches.ts` defines the two safe starter reads created after explicit Pulse
  opt-in: five recent Gmail inbox items and the next 24 hours of Calendar.
  Existing owner watches are preserved and repeated enable operations are
  idempotent. It also registers an explicit read-only contract for every one
  of the twenty capabilities; unconnected providers are not silently polled.
- `detectors.ts` converts normalized provider evidence into bounded findings.
Findings create owner-scoped candidates; they never send, spend, delete,
change permissions, or treat source text as authorization.
- `heartbeat.ts` creates honest owner-facing run summaries. The recurring job
  still enforces quiet hours and the configured daily delivery cap.

## Onboarding and settings API

The authenticated dashboard uses `GET /v1/account/attention-pulse` to read the
current owner-scoped Pulse projection and `PUT /v1/account/attention-pulse` to
apply onboarding or later settings changes. The write accepts an explicit
cadence, authority (`observe`, `prepare`, or `execute_reversible`), opted-in
delivery targets, daily notification cap, UTC quiet hours, and monitored app
domains. Input is bounded and deduplicated before it reaches the scheduler or
attention store.

Pulse setup is intentionally separate from profile memory. Saving a profile
does not grant app access; enabling Pulse creates only the read-only Gmail and
Calendar starter watches, and later provider work still goes through the
existing connected-account and approval boundaries.

Provider calls remain in `src/autonomy/reconciliation.ts`, where exact
read-only tool slugs, account ownership, profiles, leases, checkpoints,
deduplication, and failure handling are enforced. Consequential actions remain
on the existing approval path.
