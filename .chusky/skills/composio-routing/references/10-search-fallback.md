# Search fallback

Use broad `COMPOSIO_SEARCH_TOOLS` / `COMPOSIO_SEARCH_TOOL` only when:

1. Domain map has no fit, or
2. Mapped toolkit is not connected and user wants an alternative, or
3. Long-tail app is explicitly named by the owner

If Jev already returned a matching toolkit, action, account, or schema, use it
and skip this fallback. Do not issue separate searches for each possible
capability in the same turn; one route bundle is the planning input and the
runtime's exact tool list is authoritative.

## Procedure

1. Search with precise keywords (app name + verb)
2. Pick candidate → `COMPOSIO_GET_TOOL_SCHEMAS`
3. Confirm the intended connected account and required fields
4. Execute only verified slugs
5. Read back the provider state or receipt; if not connected → connection flow,
   do not pretend success

## Anti-patterns

- Searching "email" when the job is clearly Gmail
- Guessing `SHOPIFY_CREATE_ORDER` without schema
- Exploring 20 toolkits for a one-step task
- Repeating discovery after a transient execution failure instead of reconciling
  the original action and provider state
