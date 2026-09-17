---
name: composio-routing
description: >
  Fast routing from job domain to preferred Composio toolkits. Load when choosing
  connected apps, before broad COMPOSIO_SEARCH_TOOLS, or when a skill needs the
  right integration family (ecommerce, CRM, billing, support, social, docs, dev).
  Prefer this short menu; search is the fallback.
---

# Composio Routing

Composio exposes 1500+ toolkits. Do **not** start with open-ended search for common jobs.
Use this map → confirm the user has the app connected → get schemas → execute.

## Decision order

```text
1. Match domain (tables below or skill toolkits.md)
2. Prefer listed toolkit prefixes
3. COMPOSIO_GET_TOOL_SCHEMAS / search within that family if needed
4. COMPOSIO_EXECUTE_TOOL or MULTI_EXECUTE
5. Only then broad COMPOSIO_SEARCH_TOOLS for long-tail apps
```

## Non-negotiables

1. Never invent tool slugs — resolve schema first
2. Catalog presence ≠ user connected — manage connections if missing
3. Worker `allowedComposioPrefixes` still bind specialists
4. Risky actions still follow approval policy
5. Skills teach *how*; this map teaches *which app family*

## References

| Domain | File |
|--------|------|
| E-commerce & retail | `references/01-ecommerce.md` |
| CRM & sales | `references/02-crm-sales.md` |
| Support & success | `references/03-support.md` |
| Billing & finance | `references/04-billing.md` |
| Inbox & communication | `references/05-comms.md` |
| Social & marketing | `references/06-social-marketing.md` |
| Docs & knowledge | `references/07-docs.md` |
| Dev & project ops | `references/08-dev.md` |
| Scheduling & research | `references/09-schedule-research.md` |
| Search fallback rules | `references/10-search-fallback.md` |

## Mind-blowing standard

The agent picks the obvious right app in one step, not after three exploratory searches.
