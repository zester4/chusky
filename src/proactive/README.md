# Proactive operating layer

`src/proactive/` is the provider-neutral vocabulary and policy layer for
Attention Pulse/Elena. It does not contain credentials, provider payloads, or
unbounded tool authority.

## Boundaries

- `catalog.ts` defines the twenty proactive behaviors the governor can choose
  from. A catalogue entry is not permission to access a provider.
- `capabilityDiscovery.ts` compares a verified owner-scoped connected-account
  inventory with the catalogue and creates a small, deduplicated set of
  capability-gap candidates. Elena can say what connecting Gmail, Calendar,
  Drive/Notion, Sheets, team chat, project systems, billing, or CRM would
  unlock even before any provider is connected. This is public capability
  discovery only: it never reads an unconnected provider, starts OAuth, or
  grants a tool. Suggestions are staged in a rolling window of at most three;
  once that window is delivered or resolved, the next highest-value gaps may
  enter the queue. The same module can compare active connected toolkits with
  their public Composio action metadata and report a connected-but-unavailable
  capability without claiming that provider data was read.
- `watches.ts` defines the two universal safe starter reads created after
  explicit Pulse opt-in: five recent Gmail inbox items and the next 24 hours
  of Calendar. During the hourly owner-scoped run, active connected accounts
  may also receive one bounded read-only starter watch for Slack/Teams/Discord,
  Drive/Notion, GitHub/Linear/Jira, Sheets, Stripe, or HubSpot. These watches
  are keyed to the exact connected account, capped at twelve, and created
  idempotently; unconnected providers are never polled.
- `detectors.ts` converts normalized provider evidence into bounded findings.
Findings create owner-scoped candidates; they never send, spend, delete,
change permissions, or treat source text as authorization.
- `heartbeat.ts` creates honest owner-facing run summaries. The recurring job
  still enforces quiet hours and the configured daily delivery cap.
- `checklist.ts` reserves the owner-private `attention-pulse/checklist`
  scratchpad entry as Elena's evolving working plan. The Pulse tells Elena to
  read it before acting and update it after meaningful progress, but explicitly
  treats it as continuity context rather than an exhaustive queue, permission,
  or final decision-maker. Elena may investigate valuable work outside the
  checklist when current evidence warrants it.

## Onboarding and settings API

The authenticated dashboard uses `GET /v1/account/attention-pulse` to read the
current owner-scoped Pulse projection and `PUT /v1/account/attention-pulse` to
apply onboarding or later settings changes. The write accepts an explicit
cadence, authority (`observe`, `prepare`, or `execute_reversible`), opted-in
delivery targets, daily notification cap, UTC quiet hours, and monitored app
domains. Input is bounded and deduplicated before it reaches the scheduler or
attention store.

Pulse setup is intentionally separate from profile memory. Saving a profile
does not grant app access; enabling Pulse creates the read-only Gmail and
Calendar starter watches, while the next verified hourly run can prepare
bounded watches for already-active connected accounts. The hourly pulse also
checks whether the owner has connected useful capability groups. Missing-connection suggestions are stored
as owner-scoped attention candidates, shown through the web notification bell
and Approvals page, and delivered through the selected Pulse channel. They are
one-shot and resolve when the matching app becomes active. Later provider work
still goes through the existing connected-account and approval boundaries.

Provider calls remain in `src/autonomy/reconciliation.ts`, where exact
read-only tool slugs, account ownership, profiles, leases, checkpoints,
deduplication, and failure handling are enforced. Consequential actions remain
on the existing approval path.
