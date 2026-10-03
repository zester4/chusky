# Durable memory

Chusky memory has three deliberately different layers:

- Neon is the durable source of truth for scoped facts, sources, entities,
  relationships, versions, grants, profiles, and the Vector outbox.
- Upstash Vector is a searchable projection. A missing or stale embedding never
  makes a memory authoritative.
- Redis contains only a bounded purpose-specific memory brief for a short TTL.

## Enablement

Set `DURABLE_MEMORY_ENABLED=true` and configure either
`DURABLE_MEMORY_DATABASE_URL` or the existing `BETTER_AUTH_DATABASE_URL`. Run
the schema migration against the direct Neon connection:

```sh
npm run durable-memory:migrate
```

The first-party API can activate an organization scope after Better Auth has
verified membership:

```http
POST /v1/memory/scopes/:organizationId/enable
```

Organization scopes are not implicitly readable merely because an ID was put
in a tool argument. A user must have an explicit grant. Personal scope is
owner-scoped automatically when the first personal memory is written.

## Retrieval contract

Use `CHUCK_MEMORY_BRIEF` for purpose-specific context such as meetings, sales,
support, execution, and handoffs. It accepts explicit scope identifiers and
returns a bounded packet with current facts, entities, relationships, and
source IDs. It never returns the complete memory store.

Vector indexing is asynchronous through `chusky_memory_outbox`. A deployment
should run `drainMemoryVectorOutbox()` from a QStash or scheduled worker. The
Neon record is committed before the Vector projection is attempted, and failed
projections remain retryable.

## Migration policy

Keep legacy session reads while backfilling existing `session.memories` into
personal/project scopes. Enable durable writes first, observe retrieval and
outbox health, then enable durable reads. Remove the legacy memory fallback
only after counts, ownership, supersession, deletion, and Vector projection
checks pass for the entire migration window.
