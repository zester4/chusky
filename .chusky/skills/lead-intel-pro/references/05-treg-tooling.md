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
| `CHUCK_TREG_GET` | Inspect price, constraints, own-account/BYOK before paying |
| `CHUCK_TREG_ENRICH_PERSON` | Person enrichment path |
| `CHUCK_TREG_ENRICH_COMPANY` | Company enrichment path |
| `CHUCK_TREG_RESOLVE` | Bounded multi-endpoint need with requiredFields / maxSpend |
| `CHUCK_TREG_CALL` | Specific endpoint after search/get |
| `CHUCK_TREG_BALANCE` / `USAGE` | Budget awareness and receipts |
| OAuth tools | Only if owner explicitly needs a **Treg-held** provider account |

Prefer **ENRICH_*** and **RESOLVE** over raw CALL for common jobs.

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
- Report spend in the owner brief when material  

## Full catalog, not only enrichment

SEARCH and RESOLVE cover SEO, social, ads intelligence, web data, etc. Use them
when the job is not person/company enrich — same gateway, same budgets.
