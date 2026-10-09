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
- `watches.ts` defines the two universal safe starter reads available after
  explicit Pulse opt-in: five recent Gmail inbox items and the next 24 hours
  of Calendar. They are created only when the matching account is connected.
  When an account is missing, Elena creates a 1–3 item capability candidate
  with a connection action and a concise explanation of what it unlocks. Those
  candidates appear in the web notification bell and Approvals page without
  waiting for the first hourly run; unconnected providers are never polled or
  represented as overdue watches. During the hourly owner-scoped run, active
  connected accounts may also receive one bounded read-only starter watch for
  Slack/Teams/Discord, Drive/Notion, GitHub/Linear/Jira, Sheets, Stripe, or
  HubSpot. These watches are keyed to the exact connected account, capped at
  twelve, and created idempotently.
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
domains. The read response also exposes a pure, typed health projection with
the current run state, bounded watch counts, pending capability suggestions,
and a non-authorizing recovery hint (`connect_app`, `run_now`, or `inspect`).
Input is bounded and deduplicated before it reaches the scheduler or attention
store.

Pulse setup is intentionally separate from profile memory. Saving a profile
does not grant app access; enabling Pulse reconciles only the starter watches
whose accounts are active, and immediately checks for useful capability groups
that are not connected. Missing-connection suggestions are stored as
owner-scoped attention candidates, shown through the web notification bell and
Approvals page even when no external channel is linked. When an external Pulse
channel is selected, the same candidate can also be delivered there. The web
dashboard is not treated as an external provider send: the candidate stays
actionable until the owner opens Chat/Approvals and selects an action. They are
one-shot and resolve when the matching app becomes active or the owner handles
the suggestion. Later provider work still goes through the existing
connected-account and approval boundaries.

The health projection deliberately distinguishes a missing connection from a
stalled scheduler: an enabled Pulse with no active watch and pending capability
suggestions is `waiting_for_connection`, while a configured watch with no
completed run is `never_run` and an old run is `stale`. This prevents the
dashboard, SDK, and Elena from reporting an overdue provider watch that was
never authorized.

The worker also runs a bounded QStash schedule-recovery sweep. It discovers
owners from durable job state, takes one provider schedule snapshot, removes
orphaned cancelled schedules, recreates missing or changed active schedules,
and preserves locally paused jobs as paused. A repair failure—including a
shared provider-snapshot failure—is recorded for each affected owner as a
bounded `scheduleError` on its recurring jobs and projected into Pulse health
and the dashboard. The error clears after a later verified repair; the sweep
never retries an agent occurrence or replays a provider action.

Each durable Pulse occurrence also carries a bounded `pulseEvidence` receipt.
It records whether the run completed, waited, or was suppressed; how many due
watches were reconciled; how many observations and candidates remained; whether
Elena handled or delegated a step; whether approval was required; and whether
the result was surfaced on the dashboard or an external channel. The receipt is
execution evidence for Chusky's control plane, not provider payload or proof
that an external write succeeded.

## Candidate-to-Chat lifecycle

The web bell, Autonomy page, and Approvals page route an owner-scoped candidate
ID into a fresh Chat thread. Chat renders the same candidate card with its
provider logo, explanation, and suggested actions. Selecting an action sends
the candidate ID and action ID as run metadata; the API verifies ownership,
candidate status, and the action list before accepting it. The dashboard never
marks a candidate handled before a real Chat run is admitted, so a failed
connection, stale candidate, quota rejection, or interrupted request leaves
the suggestion recoverable instead of silently removing it. Elena then handles
the request through the normal connected-account, tool, and approval
boundaries.

Enabling a new Pulse also admits one bounded first run immediately; the hourly
schedule is still the governor for later runs. Manual runs persist a queued
occurrence before publishing the workflow, so the dashboard can show queued,
running, failed, or completed state even when the worker or provider is delayed.
Pulse workflow payload validation accepts both owner-scoped `pulse_<id>` records
and ordinary `job_<id>` recurring jobs.

Provider calls remain in `src/autonomy/reconciliation.ts`, where exact
read-only tool slugs, account ownership, profiles, leases, checkpoints,
deduplication, and failure handling are enforced. Consequential actions remain
on the existing approval path.
