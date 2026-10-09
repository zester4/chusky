# Attention Pulse checkpoint

Updated: 2026-10-09

This document records the current Attention Pulse/Elena implementation boundary,
what has been verified locally, and what still requires a deployed user test.
It is intentionally evidence-based: local tests do not certify live QStash,
Redis, Composio, Gmail, or deployment behavior.

## Pushed checkpoints

| Surface | Branch | Commit | Status |
| --- | --- | --- | --- |
| Chusky backend | `codex/fix-session-domain-contention` | `07f78e00994143fc5f9f6af09adf192ee7d48342` | PUSHED; not merged to backend `main` |
| Chusky SDK | `main` | `f7361553a94ec3492a31be05be523c2566ef45be` | PUSHED |
| `chusky-web` | `main` | `aae9b20c4062cd0885f1b6447ca1392d4143b09c` | PUSHED |

The backend `main` branch is still `6ecc3dc8e4a9b8754658e35de0f992e619372f6d`.
The backend checkpoint must be deployed from its branch or merged before the
live dashboard can exercise these backend changes.

## Completed implementation

### Attention Pulse and Elena

- Owner-scoped hourly Pulse scheduling with bounded delivery and quiet-hour
  handling.
- Elena is a real scheduled worker boundary, with a private scratchpad
  checklist that provides continuity without becoming a rigid task list or
  permission grant.
- Unconnected capability discovery can produce a small, ranked set of useful
  connection suggestions instead of stopping at “no account connected.”
- Connected accounts can receive bounded, read-only starter watches with exact
  account scoping and idempotent watch creation.
- Suggestions roll forward in small windows rather than presenting every
  capability at once.
- Connected-but-missing Composio capability gaps can become actionable
  candidates.
- Pulse health distinguishes first-run setup, missing connections, failed runs,
  in-flight runs, paused schedules, and genuinely stale scheduler state.
- Trigger observations, blocked work, approvals, failed automations, meetings,
  and other bounded signals can enter the Pulse decision path.
- Read-only work remains autonomous; consequential provider writes continue
  through existing approval and provider-safety boundaries.

### Web notification and approval flow

- A Pulse candidate can be delivered to the web activity feed even when no
  Telegram, Slack, iMessage, or WhatsApp destination is connected.
- The dashboard bell can surface the candidate and its provider branding.
- Opening the candidate carries the same Elena message and action context into
  Chat.
- Candidate actions are dynamic and can include connection, review, prepare,
  fix, archive, clear, or other action-specific labels when the candidate
  provides them; they are not limited to one hardcoded button set.
- Approval and action handling remain owner-scoped and validated before Chat
  execution.

### SDK and documentation

- The SDK exposes the Attention Pulse settings and typed cadence/idempotency
  contract.
- SDK API documentation, capabilities documentation, release documentation,
  README material, changelog, generated declarations, and package metadata were
  updated and pushed in the SDK repository.
- Root proactive documentation and the Attention Pulse skill references were
  updated.

### Reliability work included in the checkpoint

- Browser owner-private visual feedback now keeps a fresh screenshot paired with
  structured browser state for the next model decision.
- Browser progress detection and safety-stop behavior are covered by the E2B
  contract tests.
- Durable task/schedule recovery and dashboard API paths included in the
  checkpoint retain owner scoping and idempotency requirements.

## Local verification status

| Check | Result | Evidence |
| --- | --- | --- |
| Attention Pulse, proactive health, scheduler, SDK API, workflow tests | VERIFIED | 142 tests passed |
| E2B browser contract tests after final wording fix | VERIFIED | 12 tests passed |
| SDK check | VERIFIED | Typecheck/build plus 26 SDK tests passed |
| Root TypeScript typecheck | VERIFIED | `npm run typecheck` passed |
| Root TypeScript build | VERIFIED | `npm run build` passed |
| Diff safety | VERIFIED | `git diff --check` passed |
| Full root suite after the final one-line browser wording fix | NOT RERUN | The earlier full run had 1,558 passes, 4 skips, and 1 stale wording failure; the focused E2B test passed after the fix |
| Live deployment, QStash schedule, Redis persistence, Composio, and Gmail | USER TEST REQUIRED | Local tests cannot certify external provider execution |

## User test checklist

Mark these only after observing the deployed system.

- [ ] **No-channel Pulse:** enable Pulse, click **Run now**, and confirm within
  5–15 minutes that `Last run` changes from `Never run` and the web bell or
  Approvals page receives an actionable candidate.
- [ ] **Candidate-to-Chat:** click the bell item and confirm Chat opens with the
  same Elena card, provider logo, message, and custom action buttons.
- [ ] **Action context:** click one action and confirm the conversation receives
  the candidate context rather than a generic or empty prompt.
- [ ] **Safety boundary:** confirm a consequential action pauses for the normal
  approval/provider-safety boundary and that a read-only action can proceed.
- [ ] **Gmail watch:** connect Gmail, run Pulse, and confirm within 5–15 minutes
  that the watch status and last-check time update and that a useful summary or
  candidate appears when evidence exists.
- [ ] **Hourly schedule:** leave Pulse enabled for 75–90 minutes and confirm a
  subsequent scheduled run, or capture the exact next-run/last-run timestamps
  when it does not occur.
- [ ] **Recovery:** refresh or revisit the page during a run and confirm the
  status remains truthful (`queued`, `running`, `completed`, `waiting`, or
  `failed`) instead of silently returning to `Never run`.

## What is still left

1. Deploy or merge backend commit `07f78e0` into the environment being tested.
2. Collect the live evidence above from the user's authenticated account and
   provider connections.
3. Fix any live scheduling, provider authorization, delivery, or dashboard
   mismatch found by the test.
4. Add the canonical supervisor/Elena identity and provenance contract so the
   main Chusky agent can answer accurately what Elena is, what she did, and what
   evidence supports that answer.
5. Rerun the complete root suite after the final browser wording correction and
   record the final count here.

## Test report template

When reporting back, include:

- deployed commit and environment;
- local time and timezone for **Run now** and the observed run;
- Pulse status, `Last run`, next-run value, and watch status;
- whether the bell, Approvals page, and Chat each showed the candidate;
- the exact action clicked and whether approval was requested;
- provider name only, with secrets and private message contents redacted;
- screenshot or short screen recording for any mismatch.
