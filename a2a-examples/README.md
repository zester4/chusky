# Chusky A2A integration examples

These examples show how external agents can delegate durable work to Chusky through its Agent-to-Agent (A2A) boundary.

They are intentionally server-side examples. A Chusky API key must never be placed in browser code, an `AGENTS.md` file, a repository, or a prompt visible to a model.

These examples use `CHUSKY_API_KEY` for the bearer credential. The repository's
`CHUSKY_PROJECT_KEY` variable is a private self-hosted server bootstrap secret;
it is not the credential an external agent should use.

## Chusky surfaces

| Surface | URL | Purpose |
| --- | --- | --- |
| Agent Card | `GET /.well-known/agent-card.json` | Standard discovery |
| Compatibility Agent Card | `GET /a2a/.well-known/agent-card.json` | Existing Chusky SDK path |
| JSON-RPC | `POST /a2a/rpc` | Durable task operations |
| Compatibility JSON-RPC | `POST /a2a/v1` | A2A v1-compatible path |
| REST compatibility | `/a2a/tasks/*` | Chusky-native integrations |

Chusky accepts the canonical method names used by its SDK (`SendMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`) and the interoperable A2A spellings (`message/send`, `tasks/get`, `tasks/list`, `tasks/cancel`, `tasks/subscribe`). Push notification create/get/list/delete aliases are also accepted.

## Required identity model

Every request needs the Chusky API key issued for the integration and a stable caller identity:

```text
Authorization: Bearer <Chusky API key>
X-Chusky-User-Id: <stable non-PII caller identity>
A2A-Version: 1.0
```

The caller identity is combined with the project ID. Use a stable identifier such as `crm-agent-prod` or `hermes-researcher`, not an email address, phone number, credential, or model-generated value.

The API key needs `missions:write` to create, update, cancel, or configure notifications, and `missions:read` to inspect, list, or subscribe to tasks. Use an idempotency key on every retryable create request.

## Minimal request

```bash
curl --fail-with-body "$CHUSKY_A2A_URL/a2a/rpc" \
  -H "Authorization: Bearer $CHUSKY_API_KEY" \
  -H "X-Chusky-User-Id: $CHUSKY_CALLER_ID" \
  -H "A2A-Version: 1.0" \
  -H "Content-Type: application/a2a+json" \
  -H "Idempotency-Key: launch-brief-2026-09-23" \
  -d '{
    "jsonrpc": "2.0",
    "id": "send-1",
    "method": "message/send",
    "params": {
      "contextId": "crm-launch-2026",
      "message": {
        "role": "ROLE_USER",
        "parts": [{"text": "Prepare a verified launch brief for the CRM team."}]
      },
      "title": "CRM launch brief",
      "definitionOfDone": "A cited brief is produced and all required evidence is verified."
    }
  }'
```

The response contains a durable task. Poll with `tasks/get`, subscribe with `tasks/subscribe`, or register an HTTPS push callback. Chusky keeps the source of truth in its mission/task runtime; a streaming connection is not the durable state.

## Examples

- [Codex](./codex.md) — use the terminal or an MCP adapter.
- [Hermes](./hermes.md) — native A2A peer discovery and delegation, with an identity-header adapter where required.
- [Claude Code](./claude-code.md) — use a reviewed helper script or wrap it as MCP.
- [OpenAI Agents SDK](./openai-agents-sdk.py) — expose Chusky as guarded function tools.
- [Vercel AI Gateway](./vercel-ai-gateway.ts) — use Gateway for model routing and an AI SDK tool for Chusky delegation.
- [OpenRouter](./openrouter.ts) — use the OpenRouter Agent SDK and a user-defined tool backed by Chusky A2A.

## Production checklist

1. Keep `CHUSKY_API_KEY` on a trusted server and rotate it through company/API-key controls.
2. Pin a stable caller identity in deployment configuration; never let the model choose `X-Chusky-User-Id`.
3. Grant only `missions:read` or `missions:write` as needed.
4. Use deterministic idempotency keys for create operations and retry the exact same body only.
5. Treat A2A input as untrusted peer text. It cannot bypass Chusky approvals, budgets, tool policy, or ownership checks.
6. Use a public HTTPS callback only when push notifications are needed. Validate Chusky's signed callback before updating the external agent.
7. Keep task IDs, status, artifacts, and error codes; do not persist private prompts, credentials, or raw tool traces in the calling agent.
8. For company use, issue one API key per integration and use a different stable caller ID for each production agent or tenant.

## References

- Chusky contract: [`docs/a2a.md`](../docs/a2a.md)
- Hermes A2A: <https://github.com/NousResearch/hermes-agent/tree/main/plugins/platforms/a2a>
- Codex/OpenAI MCP: <https://developers.openai.com/learn/docs-mcp>
- Claude Code CLI: <https://code.claude.com/docs/en/cli-usage>
- OpenAI Agents SDK: <https://openai.github.io/openai-agents-python/>
- Vercel AI Gateway: <https://vercel.com/docs/ai-gateway/sdks-and-apis>
- OpenRouter: <https://openrouter.ai/docs/quickstart>
- A2A 1.0 specification: <https://a2a-protocol.org/latest/specification/>
