# Treg Tooling

## What Treg is here

Treg is Chusky’s **external intelligence** path: live third-party catalog data
(enrichment, firmographics, SEO, social, web intelligence, and more).

It is **not** a substitute for Gmail, CRM, Slack, or other owner-connected apps.
Those actions use **Composio**.

## Primary tools

| Tool | Use when |
|------|----------|
| `CHUCK_TREG_SEARCH` | You need endpoints for a **task** (not a vendor name) |
| `CHUCK_TREG_PEOPLE_SEARCH` | Discover a bounded set of people from a market, company domain, title, or geography |
| `CHUCK_TREG_COMPANY_SEARCH` | Discover a bounded set of companies from a market, firmographic, technology, domain, or geography query |
| `CHUCK_TREG_COMPANY_JOBS_SEARCH` | Find a bounded set of hiring listings for one named company or domain |
| `CHUCK_TREG_EMAIL_VERIFY` | Verify an already found work email before outreach |
| `CHUCK_TREG_CALL_STATUS` | Inspect a pending routed search or enrichment using the returned `callId` |
| `CHUCK_TREG_GET` | Inspect price, constraints, own-account/BYOK before paying |
| `CHUCK_TREG_ENRICH_PERSON` | Person enrichment path |
| `CHUCK_TREG_ENRICH_COMPANY` | Company enrichment path |
| `CHUCK_TREG_RESOLVE` | Bounded multi-endpoint need with requiredFields / maxSpend |
| `CHUCK_TREG_CALL` | Specific endpoint after search/get |
| `CHUCK_TREG_BALANCE` / `USAGE` | Budget awareness and receipts |
| OAuth tools | Only if owner explicitly needs a **Treg-held** provider account |

Prefer **ENRICH_*** and **RESOLVE** over raw CALL for common jobs.
For company hiring evidence, use `CHUCK_TREG_COMPANY_JOBS_SEARCH` with a specific company name or domain and a small result limit. It uses one fixed routed search with an enforced per-call cost cap; it does not expose arbitrary provider calls. Preserve listing URLs and posting dates where returned. Hiring may indicate a timing change, but it is not proof of a purchase or confirmed intent. An empty result means no listings were returned for those inputs, not that the company is not hiring.
When delegated to Muna, `CHUCK_TREG_RESOLVE` inspects catalog endpoint methods
and skips everything except endpoints explicitly declared `GET`, `HEAD`, or
`OPTIONS`, with known per-call pricing within budget; it performs at most one
provider call.
If no read-only endpoint covers the signal query, report the gap to Chusky so
the owner can decide the next safe step.
For standard discovery, prefer Treg's routed people/company search over picking
one upstream provider yourself. Use precise filters and small result limits;
route output can name its provider and any filters it could not apply. Campaign
searches consume the same campaign-level Treg allowance as enrichment.

## How to talk about results

**Do:**

- “Provider data via Treg (source: …)”  
- “Work email returned for this domain match”  
- “No email in coverage for this person”  

**Don’t:**

- “This is just low-confidence AI evidence”  
- “Not guaranteed truth” as a blanket disclaimer on solid provider returns  
- Invent confidence scores the provider did not supply  

Still **sanity-check** before irreversible outreach when the match is ambiguous
or the role looks stale.

## Budget discipline

- Pass `missionId` inside missions for spend attribution  
- On spend/rate denial: narrow list, fewer fields, A-tier only — don’t retry blindly  
- GET/estimate before large paid batches  
- Treat `202`/pending as an existing job: inspect its receipt/call state before
  doing anything else; do not repeat the search to get a faster answer
- Report spend in the owner brief when material  

## Signal and identity discipline

- A provider signal is a time-sensitive fact to investigate, not a purchase
  probability or proof that the named person wants to buy.
- Separate fit, freshness, and signal strength in the explanation. Preserve the
  provider's score as a provider score; do not relabel it as Chusky confidence.
- Join people with a company domain and a stable profile URL when available.
  A name alone is not enough to treat a result as a confirmed match.
- Keep `found`, `verified`, `invalid`, and `unknown` email states distinct. Do
  not infer or fabricate an email pattern; verify before outreach.
- Use `CHUCK_TREG_EMAIL_VERIFY` for addresses without an explicit verified
  status. Verification is evidence about deliverability only; it does not grant
  permission to contact the person.

## Full catalog, not only enrichment

SEARCH and RESOLVE cover SEO, social, ads intelligence, web data, etc. Use them
when the job is not person/company enrich — same gateway, same budgets.
