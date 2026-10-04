# Durable Memory Implementation Status

## Overview

Chusky now has the foundation for a durable, scoped, multi-agent memory
system. Neon is the durable source of truth, Redis is the short-lived hot
operational layer, and Upstash Vector is the semantic-search projection.

No external memory API was added.

## What was implemented

### Durable Neon memory model

The migration in `migrations/0007_durable_memory.sql` creates tables for:

- Explicit personal, organization, team, project, client, meeting,
  conversation, and channel scopes.
- User, agent, and service grants with read/write permissions.
- Atomic memory facts with confidence, sensitivity, provenance, expiry,
  review dates, and supersession history.
- People, organizations, projects, clients, products, tools, and meeting
  entities.
- Typed relationships such as `works_for`, `client_of`, and `approved_tool`.
- Compact purpose-specific memory profiles.
- A reliable outbox for synchronizing memory changes to Vector.

### Canonical memory behavior

The previous memory paths are unified behind one canonical model. Memories
saved by the main agent and specialist workers now use the same lifecycle and
retrieval rules.

The implementation also fixes the previous issues where:

- Main-agent memories could be missing `active` status and become invisible to
  workers.
- Superseded memories could be returned as current facts.
- Organization labels could be mistaken for authorization boundaries.
- Memory and context were stored only inside the growing Redis session blob.

### Redis and Vector roles

Redis now stores bounded, short-lived purpose-specific briefs instead of being
the permanent source of truth for durable memories. Cache keys include the
owner and retrieval scope, and invalidation uses bounded scanning rather than
unbounded key reads.

Upstash Vector receives asynchronous projections through the Neon outbox.
Neon commits are authoritative even when Vector indexing is delayed or
temporarily unavailable.

### Agent and SDK integration

The following capabilities were added:

- `CHUCK_MEMORY_BRIEF` for bounded personal, meeting, sales, support,
  execution, reporting, and handoff context.
- `CHUCK_MEMORY_LINK` for creating typed entity relationships.
- Organization-scope activation through the SDK after Better Auth membership
  verification.
- Organization-aware memory search and storage.
- Sensitivity filtering to prevent private memory from entering business or
  shared-channel briefs.
- Periodic Vector outbox draining from the application runtime.

### Automatic reflection and consolidation

Migration `migrations/0013_durable_memory_reflection.sql` adds a separate,
owner-scoped reflection queue. Completed owner-authored conversation turns are
checked for a small set of explicit, explainable statements. Normal explicit
statements can be consolidated through the canonical Neon writer with a source
receipt and reflection ID in their metadata. Uncertain observations and
sensitive candidates remain in `needs_review`; they are never silently written
as active durable facts. Duplicate candidates are idempotently suppressed,
and scope grants are checked before queueing and again before consolidation.

The queue worker runs alongside the Vector outbox sweep. A future review UI or
owner-facing tool can call the review operation to accept or reject staged
candidates before they become durable memory.

## Verification completed

- TypeScript typecheck passes.
- Production build passes.
- Focused memory, context, routing, and native-tool tests pass.
- Migration filename references were updated to `0007_durable_memory.sql` after combining with the durable-session migrations.
- Reflection candidate extraction and review gating tests pass.
- No external memory provider was introduced.

## Production activation checklist

Still required before calling this fully production-complete:

- Run the Neon migration in your environment.
- Enable `DURABLE_MEMORY_ENABLED=true`.
- Backfill existing Redis/session memories into Neon.
- Apply migration `0013_durable_memory_reflection.sql` (the migration command
  now applies it after the durable-memory base schema).
- Enable the reflection sweep with the durable-memory runtime.
- Run production leakage, authorization, and retrieval evaluations.

The core system is built, but production activation and historical migration
are still outstanding.

## Recommended rollout

1. Run `npm run durable-memory:migrate` against the direct Neon connection.
2. Enable durable writes while retaining legacy fallback reads.
3. Backfill and reconcile historical memories, ownership, scopes, and
   supersession state.
4. Monitor Neon writes, Redis brief usage, Vector outbox latency, retrieval
   correctness, and authorization failures.
5. Enable durable reads after the migration checks pass.
6. Review staged uncertain/sensitive candidates and tune extraction against
   real conversations; remove the legacy fallback only after an observation
   period.
