# Connected Apps & Storage

Enrichment is useless if leads die in chat. Persist them in systems the company already runs.

## Pick the system (default guidance)

| System | Best when | Typical Composio use |
|--------|-----------|----------------------|
| **HubSpot** | Sales/marketing CRM is source of truth | Create/update contacts, companies, deals, notes, lists |
| **Salesforce** | Enterprise CRM already mandated | Same pattern: account, contact, opportunity, task |
| **Google Sheets** | Fast lists, ops handoffs, no CRM yet | Append/update rows; one sheet per campaign or segment |
| **Notion** | Pipeline boards, account war rooms, docs | Database pages: Account, Contact, Status, Next step |
| **Airtable** | Flexible base (GTM ops, recruiting, partnerships) | Records in Leads/Accounts tables with status fields |
| **Slack** | Visibility, not system of record | Channel briefs, @owner alerts — still write CRM/sheet |

Prefer **one system of record** per motion. Sheets can feed CRM later; don’t dual-write blindly.

## Field mapping (minimum viable)

### Contact
- name, email, title, linkedin_url  
- company, domain  
- source = `chusky/treg` or campaign name  
- tier / fit_score / fit_reasons  
- last_enriched_at  

### Company / Account
- name, domain, industry, size_band, geo  
- tier, triggers, notes  
- owner / segment  

### Status (wherever stored)
Use a short, stable vocabulary:

```text
new → enriched → qualified → contacted → replied → meeting → opportunity → won | lost | nurture
```

Update status on every real step (email sent, meeting booked, deal created).

## HubSpot pattern

```text
1. Search contact by email / company by domain (avoid duplicates)
2. Create or update company
3. Create or update contact linked to company
4. Note: qualification card + sources
5. Optional: add to static/active list for sequence
6. Optional: create deal only when stage justifies it (not for every cold lead)
```

## Google Sheets pattern

```text
Headers (example):
domain | company | name | title | email | linkedin | tier | status | sources | next_step | updated_at

1. Read existing rows; match on domain+email
2. Append new; update changed fields on existing
3. Never invent rows without enrichment or owner-provided data
```

## Notion / Airtable pattern

- One database/table for **Accounts**, one for **Contacts** (or a single Leads table if simple)
- Properties mirror the field mapping above
- Views: A-tier, Needs email, Contacted, This week  

## Slack pattern

- After a batch: short digest (counts, top 5, spend, link to CRM/sheet)
- Not a substitute for CRM — a notification layer

## When multiple apps exist

1. Ask which system is **source of truth** if unclear  
2. Write there first  
3. Optional secondary: sheet export or Slack notify  
4. Don’t sync three systems on every lead unless the owner asked  

## Quality rule

Every enrich run that the owner accepts should leave a **durable record** somewhere connected — not only a chat reply.
