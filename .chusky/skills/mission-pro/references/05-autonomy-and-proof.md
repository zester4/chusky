# Autonomy, approvals, evidence, recovery

## Autonomous by default (routine)

Within policy and connected tools:

- Read/search, triage, draft (when send not required)
- Routine email/message send when owner policy allows
- Artifact creation, memory maintenance
- Triggers, reminders, validated outbound calls under current policy
- Ordinary Daytona workspace work

## Always approval-gated

- Payments, refunds, money movement
- Deletion of important data, permission changes
- Production deploy, remote git push
- Destructive workspace actions
- Anything the owner marked sensitive / high-impact

After approval: **resume the mission** (do not restart from zero). Telegram approval can wake the waiting mission.

## Evidence kinds

Use `CHUCK_MISSION_EVIDENCE` with bounded, attributable items:

- `source` — URL or document reference
- `tool_receipt` — safe summary/hash of tool result (no secrets)
- `artifact` — registered file id/path
- `assertion` — factual claim with basis
- `before_after` — state change
- `human_confirmation` — owner approved X

## Verification

`CHUCK_MISSION_VERIFY` before complete. Strict missions stay incomplete until evidence matches definition of done.

## Recovery

- Re-read mission + latest checkpoint
- Respect leases: stale workers must not overwrite newer progress
- Retry within step retry limits; then block or replan
- Provider event waits must match **exact** provider + event id; replays are harmless

## Budgets

Budgets are real. On limit: `BLOCK` with nextAction (raise budget / narrow scope / owner decision). Never silently continue past limits.

## Communication to owner

- Silent when work is progressing inside autonomy
- Notify on need for approval, true blockers, or completed outcome with proof
- Do not spam intermediate “still working” unless asked or policy requires
