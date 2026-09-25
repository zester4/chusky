# Chusky SDK changelog

Releases use semantic versioning and are tagged `sdk-vX.Y.Z`.

## 1.6.0 - 2026-09-25

- Add typed operator reliability resources for timelines, outcome
  verification, compensation inspection, replay, provider proof, and health.
- Expose fail-closed durability signals without claiming live provider proof.
- Add typed media-bridge tool execution with verified image attachments and A2A
  task messages referencing owner-scoped uploaded images.

## 1.5.4 - 2026-09-25

- Add `chusky.mcp` catalog, connection, verified custom-server, and disconnect
  methods with typed request/response contracts.
- Document Streamable HTTP support, verification-before-save, encrypted bearer
  credentials, private-network protections, and per-end-user isolation.

## 1.5.3 - 2026-09-25

- Publish native tool JSON schemas through the SDK tool catalog and add a typed
  one-capability durable-run helper for tool reliability operations.
- Keep exact tool allowlisting, idempotent run creation, owner policy, and
  existing human approval behavior on the regular run path.
- Align the A2A Agent Card with the same five tool-reliability skills.

## 1.5.2 - 2026-09-24

- Add typed `run.tool_activity` stream and persisted-run events with safe
  lifecycle state, human-readable purpose, elapsed time, and content-free
  result summaries.
- Document that activity events exclude tool arguments and raw provider output.

## 1.5.1 - 2026-09-24

- Report uncertain webhook delivery outcomes as `ambiguous`, provide a stable
- Report uncertain webhook delivery outcomes as ambiguous, provide a stable
  event ID for receiver-side deduplication, and prevent automatic replay when
  a network failure leaves acceptance uncertain.
- Add owner-scoped channel delivery confirmation and successful-send duration
  to the API/SDK; confirmation records owner acknowledgement and never resends.

## 1.5.0 - 2026-09-23

- Added the owner-scoped autonomy queue and bounded reconciliation resources
  for personal and business work.
- Added typed workflow-composer resources for dependency-aware prechains,
  parallel-ready stages, retry/budget controls, and approval checkpoints.
- Published the current autonomy, meeting, A2A, artifact, and browser-capable
  API contract with synchronized package metadata and release documentation.

## 0.4.0 - 2026-09-22

- Added typed A2A discovery and durable task operations through `chusky.a2a`.
- Added Agent Card, task status, cursor pagination, cancellation, and A2A
  JSON-RPC transport coverage.
- Documented the shared owner-scoped A2A contract and usage example.

## 0.3.1 - 2026-09-21

- Rewrote the SDK README with production setup, security, durability, approvals, missions, company workflows, and resource guidance.
- Added runnable TypeScript examples for quickstarts, streaming, governed agents, missions, approvals, departments, files, and webhooks.
- Included the examples directory in published packages.

## 0.3.0 - 2026-09-21

- Added typed SDK resources for autonomous missions, proof/evidence verification, provider-event resume, replanning, context, departments, and outcome packages.
- Added matching authenticated CLI client methods and interactive commands for mission recovery, context, department handoffs, and outcome planning.
- Documented the shared autonomy contract and CLI parity.

## 0.2.0

- Added typed `calls` and `meetings` resources.
- Added live voice options and per-provider voice preference types.
- Added Recall meeting preparation, join, leave, context, and profile methods.
- Added typed connected-app, reminder, recurring-job, memory, scratchpad, channel, and CLI-device resources.
- Included `docs.json` and `openapi.yaml` in the published package.

## 0.1.2

- Added typed resources for tools, skills, artifacts, videos, workers, channels, activity, and account operations.
- Added durable `wait: false` runs, resumable budgets, direct R2 upload helpers, and binary artifact downloads.
- Added server enforced tool policies, skill loading, task retry/cancel, and webhook delivery controls.

