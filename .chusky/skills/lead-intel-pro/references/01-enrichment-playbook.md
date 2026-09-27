# Enrichment Playbook

## Mindset

Enrichment is **retrieval of provider data**, not creative writing. You pull
what vendors know about a person or company, normalize it, and make it useful
for the owner’s next decision.

Treat successful Treg/provider responses as **real third-party data**. Do not
describe them as speculative AI guesses. Still watch for weak matches, stale
roles, and empty coverage.

## Order of operations

### 1. Company before person (when you have a domain)

Firmographics stabilize the story: industry, size, HQ, product focus. Then
attach people who fit the buying committee.

```text
domain or company name
  → CHUCK_TREG_ENRICH_COMPANY (or SEARCH → CALL)
  → note domain, industry, size, description
  → only then enrich decision-makers
```

### 2. Person enrichment

Minimum useful input (use what you have):

- full name + domain, or
- full name + company, or
- LinkedIn URL

```text
CHUCK_TREG_ENRICH_PERSON
  name, domain, company, linkedinUrl as available
  missionId when inside a mission (spend attribution)
```

Return fields with **source** (endpoint/provider). Prefer structured fields:
email, title, company, domain, linkedin_url.

### 3. When the first path is thin

- Try alternate query (domain vs company name spelling)
- SEARCH for a better endpoint; GET before expensive calls
- RESOLVE only for a bounded need with requiredFields and maxSpendUsd
- Stop when coverage is honestly empty — say what’s missing

## Quality bar for a person record

A usable enriched contact usually has at least:

| Field | Why |
|-------|-----|
| Name | Identity |
| Title / function | Buying role |
| Company + domain | Account anchor |
| Email **or** LinkedIn | Path to reach |
| Source | Auditability |

If email is missing, do not invent one. Offer LinkedIn or “no email in provider coverage.”

## Quality bar for a company record

| Field | Why |
|-------|-----|
| Legal/brand name | CRM cleanliness |
| Domain | Dedup and outreach |
| Industry / category | ICP filter |
| Size signal (employees, band) | Segment |
| One-line product/focus | Personalization fuel |
| Source | Auditability |

## Ambiguity handling

- Common names → require domain or LinkedIn before asserting email
- Multiple companies with similar names → disambiguate by domain
- Personal emails on business outreach → flag; prefer work email when policy says so

## Output shape (to owner or mission log)

```text
## Account
- Company / domain
- What they do (1 line)
- Size / geo if known
- Sources

## Contacts
| Name | Title | Email | LinkedIn | Source | Notes |
...

## Gaps
- What we could not find
```

Never pad with guessed titles or fabricated contacts to look complete.
