# Launch day

The war room coordinates verified state; it does not widen authority. Use the
current decision owner, deployment/channel receipts, and source-of-truth health
signals rather than relying on a worker's narration.

## War-room rules

- Single decision owner
- Status board: green/yellow/red per workstream
- Cadence updates (e.g. every 30–60 min) only when state changes
- Customer-facing incidents: acknowledge, fix path, public note if needed

## Sequence

1. Final go/no-go
2. Enable feature / publish
3. Verify live (not assumed)
4. Fire channel sequence
5. Monitor metrics and support

If no-go: communicate hold clearly; do not half-launch.

If a publish or enablement result is ambiguous, stop the sequence and reconcile
the live state before retrying. Never create duplicate announcements or rollouts
because a provider call timed out.
