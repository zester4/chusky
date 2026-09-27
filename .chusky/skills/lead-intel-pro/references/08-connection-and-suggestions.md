# Connections & App Suggestions

If the owner wants leads **saved or emailed** and the right app is not connected, do not fake success. Guide them to connect.

## Detect missing access

Before CRM/sheet/email actions:

1. Prefer existing “list connected accounts” / Composio connection tools when available  
2. If a required toolkit fails with auth/connection errors → treat as **not connected**  
3. Never claim “saved to HubSpot” without a successful tool result  

## How to ask (clear, helpful, not naggy)

```text
To save and track these leads in your stack, connect one system of record.
Recommended for what you’re doing:
1. HubSpot — CRM contacts, companies, deals
2. Google Sheets — simple shared list / ops tracking
3. Notion — pipeline database and notes
4. Airtable — flexible GTM base
5. Gmail — send or draft outreach in your own mailbox

Say which you use (or connect via the app link I provide), and I’ll continue:
enrich → save → update status → draft/send as you allow.
```

Tailor the **3–5 apps** to the job:

| Job | Suggest first |
|-----|----------------|
| Sales pipeline | HubSpot, Salesforce, Gmail, Slack, Sheets |
| Lightweight list | Google Sheets, Notion, Airtable, Gmail |
| Marketing webinar follow-up | HubSpot or Sheets, Gmail, Slack |
| CS expansion | Salesforce/HubSpot, Slack, Sheets |
| Recruiting targets | Sheets or Airtable, Notion, Gmail/LinkedIn if connected |

Always include **one CRM-class**, **one list/doc-class**, and **one messaging-class** when unsure.

## Rules

- Suggest **3–5** apps max — not a catalog dump  
- Explain **why** each fits this task in half a line  
- After they connect, **retry** the failed step; don’t restart research from zero if data is still valid  
- If they refuse CRM, offer Sheets/Notion as a fallback and say tradeoffs  
- Bulk send / first cold email: follow approval policy even after Gmail is connected  

## Composio manage connection

When the product exposes `COMPOSIO_MANAGE_CONNECTIONS` (or equivalent), use it to start the connect flow for the chosen app. Point the owner at the auth link; wait for success; then continue the mission.

## After connect checklist

```text
1. Confirm toolkit is usable (list or light search)
2. Write the pending leads/accounts
3. Confirm counts and links/IDs back to the owner
4. Offer next step: draft emails, sequence, or meeting prep
```
