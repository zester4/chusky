# Browser Pro tool contract

This is the agent-facing sequence for the current Chusky browser tools. Tool
names are stable `CHUCK_*` slugs; do not substitute provider or invented names.

## Canonical sequence

1. `CHUCK_BROWSER_PLAN`
2. `CHUCK_BROWSER_SESSION_HEALTH` when an identity may be reused
3. `CHUCK_VAULT_LOGIN` or `CHUCK_BROWSER` with `session_acquire`/`start`
4. `CHUCK_BROWSER_OBSERVE`
5. `CHUCK_BROWSER_NEXT` when the next bounded action is uncertain
6. `CHUCK_BROWSER_ACT` for one action, or `CHUCK_BROWSER_AGENT` for a short
   grounded sequence
7. `CHUCK_BROWSER_VERIFY` for a business postcondition
8. `CHUCK_BROWSER_AUDIT_LIST` or a checkpoint when the workflow pauses

| Tool | Use | Never use it for |
| --- | --- | --- |
| `CHUCK_BROWSER_PLAN` | classify goal, boundary, evidence, recovery | opening or mutating a site |
| `CHUCK_BROWSER_OBSERVE` | fresh controls, forms, metadata, screenshot | claiming success |
| `CHUCK_BROWSER_ACT` | one fresh bounded action | replaying stale selectors |
| `CHUCK_BROWSER_AGENT` | short grounded sequence with fresh post-action state, bounded deadline, optional assertions, and no-progress stopping | bypassing approval/challenges or submitting irreversible actions |
| `CHUCK_BROWSER_EXTRACT` | explicit schema fields | arbitrary private dumps |
| `CHUCK_BROWSER_NEXT` | propose next action | executing or approving |
| `CHUCK_BROWSER_VERIFY` | URL/title/text postconditions | trusting narration |
| `CHUCK_BROWSER_HANDOFF` | owner-only CAPTCHA/2FA takeover | asking for secrets in chat |
| `CHUCK_BROWSER_HANDOFF_COMPLETE` | acknowledge owner return | authorizing action |
| `CHUCK_BROWSER_HANDOFF_RESUME` | inspect and safely resume same origin | bypassing a live challenge |

## Fresh selector shape

Pass the role/name and, when returned, `observationId`, `pageGeneration`,
`frameIndex`, `frameUrl`, `id`, or `nodeId` from the latest observation. If the
browser returns `stale_observation`, discard the selector and observe again.

## Forms

Use `form_inspect` or `CHUCK_BROWSER_OBSERVE(includeForms=true)` first. The
planner recognizes labels, roles, autocomplete, checkbox/radio state, native
select options, disabled state, and validation messages. A form plan is not
submit authorization. After `form_fill`, inspect `workflowCheckpoint`,
`validationErrors`, `forms`, and `formState`, then verify the result.

## Bounded agent sequences

Use `CHUCK_BROWSER_AGENT` only after a current observation. Keep sequences
short enough to understand and recover: `maxSteps` is capped at 50,
`maxActions` caps executed actions, `maxDurationMs` caps wall-clock time, and
`noProgressLimit` stops repeated identical actions whose URL/title/accessibility
state does not change. Add `expected` assertions to mutation steps when the
next state is knowable. Supported assertions are `url`, `title`, `text`,
`field`, `checked`, `selected`, and `visible`; required assertions fail closed.

For the requested business result, also provide `completionAssertions` on the
agent call. These are evaluated against the final fresh page state after the
last step. A run can execute every step while still failing to prove the
requested outcome. Treat `verified: true` and passing required completion checks
as the business result; `completion_assertion_failed` means the sequence ran
but the promised final state was not proven.

The result includes an ordered, bounded trace and `stoppedReason`, including
observed URL/title/page-generation/accessibility evidence for each step. Treat
the verified completion result—not a tool-call success alone—as proof. A
`challenge` stops the sequence and routes to the retained owner-only handoff.
A stale, ambiguous, missing, or timed-out step returns a fresh observation for
replanning. Do not replay the same step after a `no_progress` stop; inspect and
choose a different action.

## E2B-only live browser

Chusky’s browser execution backend is E2B. The retained Chromium display can be
exposed with `stream_start`, `stream_status`, and `stream_stop`, or through the
private handoff. The stream URL/password is owner-private, short-lived, and must
never be persisted in a playbook or sent to a shared conversation.

## Official documentation

- [E2B JavaScript SDK](https://docs.e2b.dev/sdk-reference/js-sdk)
- [E2B computer use](https://docs.e2b.dev/use-cases/computer-use)
- [E2B Desktop SDK](https://github.com/e2b-dev/desktop-templates-sdk)

The repository’s installed E2B version is authoritative; check
`package-lock.json` before changing SDK calls.
