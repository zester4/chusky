# Codex → Chusky A2A

## Integration choice

Codex can reach Chusky through its terminal execution surface or through an MCP adapter. The direct A2A call below is the smallest reliable path: Codex asks a protected helper to create a durable Chusky task, then inspects the returned task or polls it later.

This is not described as a native Codex A2A feature. OpenAI documents MCP as the extension point for Codex integrations, while A2A is Chusky's HTTP interoperability boundary.

## Environment

```bash
export CHUSKY_A2A_URL="https://your-chusky.example.com"
export CHUSKY_API_KEY="chsk_replace_me"
export CHUSKY_CALLER_ID="codex-engineering-prod"
```

On PowerShell:

```powershell
$env:CHUSKY_A2A_URL = "https://your-chusky.example.com"
$env:CHUSKY_API_KEY = "chsk_replace_me"
$env:CHUSKY_CALLER_ID = "codex-engineering-prod"
```

## Start a durable task from the Codex terminal

```bash
curl --fail-with-body "$CHUSKY_A2A_URL/a2a/rpc" \
  -H "Authorization: Bearer $CHUSKY_API_KEY" \
  -H "X-Chusky-User-Id: $CHUSKY_CALLER_ID" \
  -H "A2A-Version: 1.0" \
  -H "Content-Type: application/a2a+json" \
  -H "Idempotency-Key: codex-release-audit-2026-09-23" \
  -d '{
    "jsonrpc": "2.0",
    "id": "codex-1",
    "method": "message/send",
    "params": {
      "contextId": "codex-release-audit",
      "message": {
        "role": "ROLE_USER",
        "parts": [{"text": "Audit the release candidate, inspect the generated artifacts, and return a verified release report."}]
      },
      "title": "Release candidate audit",
      "definitionOfDone": "The report contains evidence, failed checks, and a final verified status."
    }
  }'
```

Then poll the returned `result.task.id`:

```bash
curl --fail-with-body "$CHUSKY_A2A_URL/a2a/rpc" \
  -H "Authorization: Bearer $CHUSKY_API_KEY" \
  -H "X-Chusky-User-Id: $CHUSKY_CALLER_ID" \
  -H "A2A-Version: 1.0" \
  -H "Content-Type: application/a2a+json" \
  -d '{"jsonrpc":"2.0","id":"codex-2","method":"tasks/get","params":{"id":"mis_replace_with_task_id"}}'
```

## Making it a Codex-native tool

For repeated use, put a reviewed wrapper around the two calls above and expose that wrapper through MCP. Configure the server with Codex's MCP mechanism, then expose only typed operations such as `chusky_create_mission` and `chusky_get_mission`.

The MCP wrapper should keep the API key server-side, set the caller ID from trusted configuration, accept only bounded task fields, return task ID/status/artifacts, enforce an outcome allow-list, and require a fresh human approval for publishing, sending, deleting, deploying, or spending actions.

Do not put a Chusky API key in `AGENTS.md`. Put behavioral guidance there, not credentials.

## Good use cases

- Delegate browser-heavy research while Codex keeps editing a repository.
- Ask Chusky to produce a PDF or release report and return an artifact ID.
- Start a long-running meeting-preparation or competitive-intelligence mission.
- Have Chusky validate deployment evidence without giving Codex provider credentials.

Codex permissions and Chusky A2A policy are separate boundaries. A local Codex approval does not authorize Chusky to perform a risky external action.
