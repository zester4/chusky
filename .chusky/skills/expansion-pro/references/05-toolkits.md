# Toolkits for expansion

Consume Jev's exact route first; verify the connected account and schema before
using a toolkit. Read source state before changing seats, plans, or deals, and
read back the resulting record after an authorized write.

| Need | Toolkit family |
|------|----------------|
| Opportunity / deal | `HUBSPOT_`, `SALESFORCE_`, `PIPEDRIVE_` |
| Seat / plan changes | `STRIPE_` or product admin APIs if connected |
| Proof / usage narrative | product analytics if connected; else CRM notes |
| Outreach | `GMAIL_`, `LINKEDIN_` |

Only expand green accounts (retention-pro health).

If the account is not demonstrably green, stop the expansion motion and route
the next action to retention or onboarding with the evidence gap attached.
