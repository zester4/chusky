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
- Compare providers with `GET /catalog/platforms/{slug}`. Choose by the inputs
  available, then observed reliability, price, and recency. Treg does not
  automatically choose or fail over between providers.
- Discover organization-owned HTTP tools with authenticated `GET /tools`.
  Return only names, hosts, base URLs, and binding names. Never expose binding
  values. Call only a registered tool through `/call/`; never accept an
  arbitrary model-supplied host.
- A catalog call uses `/call/{endpoint_id}`. A registered team HTTP tool uses
  the real upstream URL or registered name/path after `/call/`.
- Use the same `Idempotency-Key` for a retry of the exact same call. Use a new
  key for new work. Never blindly retry a pending or provider-mutating call.
- The settled cost and provider call reference come from `X-Treg-Cost-Micro`
  and `X-Treg-Call-Id`, not from an arbitrary provider response body.
- `402` includes balance and top-up information. `503` with
  `provider_capacity_unavailable` means Treg's provider capacity is unavailable
  and may include alternatives and a reset time; do not immediately pretend the
  call succeeded or fan out to every provider.

## Chusky tool routing

1. Use `CHUCK_TREG_SEARCH` for a capability query.
2. Use `CHUCK_TREG_GET` before a paid catalog call; inspect price, inputs,
   account requirements, and reliability.
3. Use `CHUCK_TREG_PLATFORMS` when multiple providers can satisfy the job.
4. Use `CHUCK_TREG_MY_TOOLS` before calling an organization-owned API.
5. Use `CHUCK_TREG_ENRICH_PERSON`, `CHUCK_TREG_ENRICH_COMPANY`, or bounded
   `CHUCK_TREG_RESOLVE` for the common evidence workflows.
6. Use `CHUCK_TREG_CALL` for an inspected catalog endpoint or verified team
   tool. Reuse `idempotencyKey` only for the same request after a lost response.
7. Use `CHUCK_TREG_BALANCE` for Treg's upstream balance and
   `CHUCK_TREG_USAGE` for Chusky's owner-scoped spend ledger and receipts.

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

Catalog provider calls through `CHUCK_TREG_CALL` are autonomous within the
gateway's spend reservations, daily/mission/per-call budgets, rate limits,
capacity checks, and idempotency rules. Calls to registered organization-owned
tools remain approval-gated because they can change company systems. OAuth
start and revoke remain approval-gated because they change an external account
authorization.

## MCP distinction

Treg is also available as a hosted MCP server at `https://treg.to/mcp/` with
its own OAuth or bearer authentication. Chusky's native Treg gateway does not
proxy arbitrary MCP JSON-RPC or expose Treg credentials to the model; it keeps
the small, policy-checked tool surface above. Use the separate third-party MCP
registry when the user explicitly connects another MCP server.
