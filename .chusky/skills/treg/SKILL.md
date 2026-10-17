---
name: treg
description: Use Treg for fresh, structured external data such as people and company research, lead discovery, enrichment, hiring signals, SEO, social, advertising, market, and web-data lookups. Search and inspect the live catalog before a paid call, select providers from the inputs available, preserve source evidence, and never turn research into outreach or an external write without a separate approval.
version: 1.0.0-chusky.1
---

# Treg live-data skill

Treg is Chusky's governed gateway for fresh structured data. Use it when the
answer depends on current facts from people, companies, websites, markets,
social platforms, advertising, SEO, hiring, or similar external sources. It
is not a general web-search replacement, an authenticated CRM action surface,
or permission to contact anyone.

## Decide whether Treg is the right source

Use the user's connected app when the answer is already in Gmail, Calendar,
CRM, billing, support, or another connected workspace. Use the browser or web
research capability for general current-events reading or an identified public
page. Use Treg when the task needs structured provider data, cross-provider
comparison, bounded enrichment, or a live data route that the existing stack
does not already cover. If the user explicitly names Treg, honor that choice
unless the requested capability is unavailable.

Keep these separate:

- A company match is not proof that a person works there.
- A provider score is not a universal probability.
- An email-shaped string is not a verified email.
- Hiring activity is a timing signal, not proof of buying intent.
- An empty result is not proof that a company, feature, or event does not
  exist.
- Research does not authorize sending, CRM updates, campaign changes, or
  other external writes.

## Standard workflow

1. Define the decision before searching: target, fields, geography, time
   window, filters, exclusions, result limit, freshness, and approved spend.
   Ask for missing information when it changes the result or cost.
2. For broad or multi-step work, call `CHUCK_TREG_PLAN` first. It creates a
   read-only runbook; it does not search, spend, approve, or select a permanent
   endpoint. Follow its checklist, then inspect the live catalog.
3. For a one-shot capability, use the narrow routed tool when it fits:
   `CHUCK_TREG_COMPANY_SEARCH`, `CHUCK_TREG_PEOPLE_SEARCH`,
   `CHUCK_TREG_ENRICH_COMPANY`, `CHUCK_TREG_ENRICH_PERSON`,
   `CHUCK_TREG_EMAIL_VERIFY`, or `CHUCK_TREG_COMPANY_JOBS_SEARCH`.
   Use small limits and precise identity inputs.
4. For a generic catalog request, call `CHUCK_TREG_SEARCH`, then
   `CHUCK_TREG_GET` for every endpoint you may run. Read its exact input
   schema, price model, account requirements, reliability, latency, notes,
   and output semantics. Use `CHUCK_TREG_PLATFORMS` when more than one
   provider can satisfy the same capability.
5. Choose only an endpoint whose required inputs are actually available. Then
   prefer observed reliability, then price, then recency/speed. Never choose
   a cheaper endpoint that cannot accept the user's real inputs.
6. Before a paid call, state the selected capability, scope, expected spend,
   and any important limitation. Use `CHUCK_TREG_CALL` only after inspection;
   use `estimateUsd`/`maxSpendUsd` as required by the routed tool. Approval
   policy still applies to registered company-owned tools and authenticated
   writes.
7. If a result is pending, use `CHUCK_TREG_CALL_STATUS` with the original
   `callId`. Do not submit the same work again. If the response was genuinely
   lost, reuse the same `idempotencyKey` for the exact request only.
8. Validate the result before reasoning: provider, source URL, observation
   time, date range, units, filters, match identity, completeness, and
   provider-specific status. Return fewer results rather than padding the
   requested count.
9. Present the answer with source/provider, retrieval date, actual or pending
   spend, coverage, exclusions, uncertainty, and fields that were not found.
   Do not claim verification, intent, or causality unless the returned
   evidence explicitly supports it.

## Common workflows

- **Company research:** identify by domain where possible, verify identity,
  then enrich. Keep facts, provider estimates, and interpretation separate.
- **People and leads:** discover companies first, qualify against the user's
  fit criteria, enrich only selected people, and verify an existing work email
  separately. Preserve `verified`, `catch-all`, `unknown`, `invalid`, and
  `no-match` as different states.
- **Hiring/buying signals:** date the evidence and describe it as a signal.
  Never convert hiring, technology, or content activity into confirmed intent.
- **Local prospects:** define service, geography, radius, independence rules,
  and exclusions before searching. A public website observation is evidence of
  what was visible, not proof of a business problem.
- **SEO, ads, social, and market data:** preserve platform, country, date,
  device, query, and units. Do not compare incompatible snapshots or imply
  private campaign performance from public records.

## Safety and boundaries

Never request, reveal, or place provider credentials, cookies, tokens, or
private account data in a query. Use `CHUCK_TREG_MY_TOOLS` before an
organization-owned HTTP tool; only registered tools may run and their secret
bindings never return. Do not accept an arbitrary host or URL supplied by a
model or provider result.

`CHUCK_TREG_BALANCE` reports the upstream balance. `CHUCK_TREG_USAGE` reports
Chusky's owner-scoped reservations and receipts. A `402` is a billing/control
failure, not a successful empty result. A `503` provider-capacity response may
offer alternatives; do not pretend success or fan out to every provider.

When delegated to Muna, keep the work bounded, read-only, and source-backed.
Muna may discover, enrich, resolve, or inspect a pending call, but cannot use
generic company-tool execution, OAuth controls, or Treg administration.

Read the relevant references before acting:

- `references/runtime-contract.md` for tool sequencing, spend, async calls,
  idempotency, and result validation.
- `references/provider-selection.md` for choosing among live providers.
- `references/research-workflows.md` for people, company, signal, and evidence
  workflows.
