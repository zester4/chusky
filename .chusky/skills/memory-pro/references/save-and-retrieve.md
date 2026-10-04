# Save and retrieve playbook

## Save decision

Save when all are true:

- The fact is explicit or strongly evidenced.
- It will help future work.
- It can be stated atomically.
- Its scope and sensitivity are known.
- Its source and freshness can be recorded.

Do not save when the information is merely conversational, speculative, secret, temporary, or already represented by an active equivalent record.

## Record shape

```text
category: the narrowest durable category
key: stable fact name
value: one factual statement
source: conversation, meeting, call, document, or provider receipt
confidence: 0..1
sensitivity: normal | sensitive
scope: exact authorized scope
reviewAt/expiresAt: required when freshness is uncertain
```

## Retrieval decision

Retrieve before acting when the fact affects identity, relationship, policy, preferences, commitments, authority, client handling, meeting preparation, call preparation, or tool choice. Retrieve a brief for the purpose; do not search everything.

On retrieval:

1. Check scope and purpose.
2. Prefer active, current, high-confidence records.
3. Check provenance and source age.
4. Detect contradictions and supersession.
5. Use only facts relevant to the objective.
6. Cite or explain uncertainty when it matters.
