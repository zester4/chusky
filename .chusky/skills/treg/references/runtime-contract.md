# Treg runtime contract

Use the smallest native capability that matches the request. `CHUCK_TREG_PLAN`
is a read-only planning step for broad work; it does not select a permanent
endpoint or authorize spend.

## Tool sequence

- Generic catalog work: `CHUCK_TREG_SEARCH` → `CHUCK_TREG_GET` → optional
  `CHUCK_TREG_PLATFORMS` → `CHUCK_TREG_CALL`.
- Organization-owned HTTP work: `CHUCK_TREG_MY_TOOLS` → registered tool call.
  Never call an arbitrary host.
- Routed identity work: use the bounded company/people/search/enrichment
  tools, which perform their own live route and price preflight.
- Pending work: `CHUCK_TREG_CALL_STATUS` with the same `callId`; never submit
  a second call while the original is pending or uncertain.

## Spend and retry rules

Inspect the current price before generic paid work. Chusky reserves local
owner/day, mission, per-call, and rate limits; a local reservation is not a
provider-enforced hard ceiling. Keep limits and requested fields small.

Reuse an idempotency key only when the exact request may have succeeded but its
response was lost. A new question, changed filter, or new time window needs a
new key. Do not blindly retry a 4xx, a pending call, or a provider-mutating
request.

## Result contract

Read provider status, call status, source, observation time, filters, date
range, units, completeness, and warnings. `200` does not guarantee useful
data, and `COMPLETED` does not guarantee a non-empty or semantically correct
provider response. Preserve `no-match`, `unknown`, `catch-all`, and partial
coverage instead of converting them into a confident conclusion.

For a final response, include the provider/source, retrieval date, actual or
pending spend, scope, missing fields, and material caveats. Never expose
tokens, binding values, raw credentials, or unbounded provider payloads.
