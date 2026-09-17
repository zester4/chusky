# Search fallback

Use broad `COMPOSIO_SEARCH_TOOLS` / `COMPOSIO_SEARCH_TOOL` only when:

1. Domain map has no fit, or
2. Mapped toolkit is not connected and user wants an alternative, or
3. Long-tail app is explicitly named by the owner

## Procedure

1. Search with precise keywords (app name + verb)
2. Pick candidate → `COMPOSIO_GET_TOOL_SCHEMAS`
3. Execute only verified slugs
4. If not connected → connection flow, do not pretend success

## Anti-patterns

- Searching "email" when the job is clearly Gmail
- Guessing `SHOPIFY_CREATE_ORDER` without schema
- Exploring 20 toolkits for a one-step task
