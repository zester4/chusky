# Treg external intelligence

Use Treg as Chusky's first-class server-side live-data gateway. It is separate from
Composio (authenticated actions in connected apps) and third-party MCP (user-
connected MCP servers). Treg credentials stay in the service environment or a
trusted organization mapping; never place them in prompts, tool arguments,
Telegram, SDK clients, or logs.

## Current contract

- REST base URL: `https://treg.to` by default.
- REST authentication: `X-Treg-Token`; `Authorization: Bearer` is for Treg's
  MCP endpoint, not REST. An identity token may also use `x-treg-org`.
- Search by job with `GET /catalog/search?q=...&limit=...`.
- Inspect one endpoint with `GET /catalog/endpoints/{endpoint_id}`.
- Catalog endpoint details may wrap the endpoint in `endpoint` and expose pricing as
  `cost: { type, value, usd, unit, varies }`. Keep price type, unit, and variability
  distinct. A varying catalog amount is not a safe estimate or maximum; for routed
  calls reserve the owner's approved hard cap and send it as
  `X-Treg-Route-Max-Cost`. For fixed `per_result` pricing, `row` scales with the
  requested result limit, while `target`, `domain`, and `keyword` scale with the
  corresponding inputs. `per_call` is flat. Settle using `X-Treg-Cost-Micro`.
- Compare providers with `GET /catalog/platforms/{slug}` when you need to
  inspect alternatives. For standard jobs, prefer Treg's routed `treg.*`
  capabilities (for example `treg.people.search`, `treg.people.enrich`,
  `treg.companies.search`, and `treg.companies.enrich`); Treg selects a route
  from the inputs and its available provider coverage. Named upstream provider
  endpoints are direct calls and do not imply routed failover.
- Discover organization-owned HTTP tools with authenticated `GET /tools`.
  Return only names, hosts, base URLs, and binding names. Never expose binding
  values. Call only a registered tool through `/call/`; never accept an
  arbitrary model-supplied host.
- A catalog call uses `/call/{endpoint_id}`. A registered team HTTP tool uses
  the real upstream URL or registered name/path after `/call/`.
- For routed `treg.*` calls, pass `X-Treg-Route-Max-Cost` with the owner's
  approved hard cap. Chusky reserves that amount locally before dispatch and
  marks async `202` results pending; never start another job while one is
  pending. Route metadata can identify the selected provider, attempted routes,
  and filters that could not be applied.
- `X-Treg-Route-Verify` is valid only on `treg.people.email.find` and
  `treg.people.phone.find`; other routes reject it with `422`. Person enrichment
  may return an unverified email, which must remain explicitly unverified until
  the separate verification tool is used.
- Use the same `Idempotency-Key` for a retry of the exact same call. Use a new
  key for new work. Never blindly retry a pending or provider-mutating call.
- The settled cost and provider call reference come from `X-Treg-Cost-Micro`
  and `X-Treg-Call-Id`, not from an arbitrary provider response body.
- `402` includes balance and top-up information. `503` with
  `provider_capacity_unavailable` means Treg's provider capacity is unavailable
  and may include alternatives and a reset time; do not immediately pretend the
  call succeeded or fan out to every provider.

## Chusky tool routing

For broad or multi-step Treg research, use `CHUCK_TREG_PLAN` first. It selects a
task playbook and returns a runbook, context checklist, discovery queries, and
evidence checks without calling a provider or authorizing spend. Treat its
endpoint queries as discovery suggestions: Treg's catalog is dynamic, so use
the existing tools to inspect current schemas, prices, and coverage before
execution.

1. Use `CHUCK_TREG_SEARCH` when the owner asks to explore provider coverage or
   when choosing a generic catalog endpoint.
2. Use `CHUCK_TREG_GET` before a generic paid `CHUCK_TREG_CALL`; inspect price,
   inputs, account requirements, and reliability. Fixed routed discovery tools
   such as `CHUCK_TREG_COMPANY_SEARCH` perform their own metadata and price
   preflight; do not repeat catalog search/inspection for the same route.
3. Use `CHUCK_TREG_PLATFORMS` when multiple providers can satisfy the job.
4. Use `CHUCK_TREG_MY_TOOLS` before calling an organization-owned API.
5. Use `CHUCK_TREG_ENRICH_PERSON`, `CHUCK_TREG_ENRICH_COMPANY`, or bounded
   `CHUCK_TREG_RESOLVE` for the common evidence workflows.
5a. Use `CHUCK_TREG_PEOPLE_SEARCH` and `CHUCK_TREG_COMPANY_SEARCH` for bounded
  discovery. Prefer company domains plus precise titles/geography, use small
  result limits, keep source URLs, and review filters Treg says it ignored.
  Treat provider match scores as provider-specific; don't convert them to a
  universal probability. An email is verified only when the result explicitly
  says so; verification is a separate step before outreach.
5b. Use `CHUCK_TREG_EMAIL_VERIFY` for one existing address when its status is
  unknown. Preserve catch-all and unknown as distinct outcomes; verification
  results do not authorize sending.
5c. If a routed operation returns pending, use its `callId` with
  `CHUCK_TREG_CALL_STATUS` to inspect the existing job or retrieve its finished
  result. Do not start a duplicate billable call while it is pending.
6. Use `CHUCK_TREG_CALL` for an inspected catalog endpoint or verified team
   tool. Reuse `idempotencyKey` only for the same request after a lost response.
7. Use `CHUCK_TREG_BALANCE` for Treg's upstream balance and
   `CHUCK_TREG_USAGE` for Chusky's owner-scoped spend ledger and receipts.
8. Use `CHUCK_TREG_ADMIN` for Treg customer-account operations not covered by
   those research tools: organization/member/invite/project management, budget
   and policy controls, billing and usage history, call/activity audit, catalog
   search/detail, tool, bundle, secret and connection/resource inventory, health, skill
   registration, and Hub publishing/runs/listings. Start
   with `orgs.list`; pass only an organization ID returned by that account.
   The action registry is explicit; never build a Treg URL or arbitrary admin
   route yourself. Reads are bounded and credential-redacted. Changes require
   approval of the exact operation and arguments. Do not ask the model to
   create/rotate one-time API keys or submit secret values; use Treg's secure
   connection flow for credentials.

Treg returns live data from the selected external provider. Treat a successful
provider response as returned business data, and include its provider/source
when useful. If the response is empty, ambiguous, stale, or includes a
provider-supplied score, report that specific condition; do not add generic
AI-disclaimer language or call a successful provider response speculative.
Treg data is not an authorization grant for unrelated actions. Use Composio for
the user's connected CRM, email, calendar, billing, and other authenticated
apps. Shared channels do not receive Treg tools or private owner context.

Treg evidence bundles are an internal source-backed response shape. They carry
the provider field, endpoint, observation time, cost, warnings, and completeness
state. `providerScore` appears only when the upstream provider supplied a
numeric score; Chusky never fabricates confidence values.

## Approval boundary

Catalog search and inspection, provider comparison, organization-tool
discovery, person/company enrichment, bounded resolve, balance, usage, OAuth
status, and connection listing are bounded autonomous operations. The gateway
still enforces account scope, spend reservations, rate limits, provider
balance/capacity, and registered-tool checks.

The gateway verifies that a catalog call's requested method matches inspected
endpoint metadata before reserving spend or dispatching. GET/HEAD/OPTIONS
catalog reads are autonomous within the gateway's spend reservations,
daily/mission/per-call budgets, rate limits, capacity checks, and idempotency
rules. POST/PUT/PATCH/DELETE catalog calls require owner approval because they
may create or change provider data. Calls to registered organization-owned
tools remain approval-gated. OAuth start and revoke remain approval-gated
because they change an external account authorization.

`CHUCK_TREG_ADMIN` management reads are owner-scoped and autonomous. Every
management write is approval-gated, including reversible changes; billing,
membership, policy, secret deletion, and key revocation therefore cannot be
authorized by a model-selected action alone.

## Delegated business research

Muna is the Treg-first specialist for bounded people/company discovery, lead
qualification, selective enrichment, existing work-email verification, fixed
route hiring evidence, and one-time buying-signal research. Her delegated tool
grant includes routed search/enrichment, provider inspection, bounded resolve,
and pending-call status. Muna's resolve path inspects endpoint metadata,
requires an explicitly read-only GET/HEAD/OPTIONS method and known per-call
pricing within budget, and makes at most one provider call per resolution. It
excludes the generic `CHUCK_TREG_CALL`, organization-owned tool execution,
balance/usage administration, and OAuth controls. Chusky retains Treg
administration; Elena handles durable recurring signal-watch setup. Hiring
evidence is a timing signal, not confirmation of purchase intent.
Buying signals are dated evidence for qualification and timing, not proof of a
confirmed purchase or intent to buy.

## MCP distinction

Treg is also available as a hosted MCP server at `https://treg.to/mcp/` with
its own OAuth or bearer authentication. Chusky's native Treg gateway does not
proxy arbitrary MCP JSON-RPC or expose Treg credentials to the model; it keeps
the small, policy-checked tool surface above. Use the separate third-party MCP
registry when the user explicitly connects another MCP server.
