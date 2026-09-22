# Chusky A2A integration

Chusky exposes a standards-shaped A2A 1.0 boundary over the same project-key,
end-user, mission, budget, approval, and evidence runtime used by the SDK and
dashboard. It does not create a second tenant or identity system.

## Discovery

Fetch the public Agent Card:

```http
GET https://api.chusky.ai/a2a/.well-known/agent-card.json
```

The card advertises the JSON-RPC interface at `/a2a/rpc`, protocol version
`1.0`, supported outcome skills, bearer authentication, text input, task
streaming, and durable A2A push notifications.

## Authentication and identity

Use a project-scoped `chsk_` key as a bearer token. Every request must also
include a stable, non-PII caller identity:

```http
Authorization: Bearer chsk_...
X-Chusky-User-Id: crm-agent-prod
Content-Type: application/a2a+json
```

The identity is combined with the project ID to isolate missions, context,
artifacts, approvals, and results. Do not send a phone number, email address,
root operator key, or provider credential as the identity.

The project key needs `missions:read` for `GetTask`, `ListTasks`,
`SubscribeToTask`, `GetTaskPushNotificationConfig`, and
`ListTaskPushNotificationConfigs`. It needs `missions:write` for
`SendMessage`, `SendStreamingMessage`, `CancelTask`, creating push
configurations, and deleting them.

## JSON-RPC operations

The endpoint accepts JSON-RPC 2.0 at either `/a2a/rpc` or `/a2a/v1`.

### Start a task

```bash
curl -X POST https://api.chusky.ai/a2a/rpc \
  -H "Authorization: Bearer $CHUSKY_API_KEY" \
  -H "X-Chusky-User-Id: crm-agent-prod" \
  -H "Content-Type: application/a2a+json" \
  -H "Idempotency-Key: launch-brief-2026-09-22" \
  -d '{
    "jsonrpc": "2.0",
    "id": "send-1",
    "method": "SendMessage",
    "params": {
      "message": {
        "role": "ROLE_USER",
        "messageId": "msg-1",
        "parts": [{"text": "Prepare a verified launch brief for the CRM team."}]
      }
    }
  }'
```

The result contains a durable A2A Task. Chusky maps that task to an owner-
scoped mission and durable worker task; the external agent never receives
Chusky's private prompts, credentials, or internal tool traces.

### Read, list, and cancel

```json
{"jsonrpc":"2.0","id":2,"method":"GetTask","params":{"id":"mis_..."}}
{"jsonrpc":"2.0","id":3,"method":"ListTasks","params":{"pageSize":20}}
{"jsonrpc":"2.0","id":4,"method":"CancelTask","params":{"id":"mis_..."}}
```

`ListTasks` returns a cursor in `nextPageToken`; send it back as
`params.pageToken`. All results are owner-scoped.

### Push notifications

An agent may register a callback for a task. Chusky stores callback
credentials encrypted and enqueues signed `application/a2a+json` status
updates through the durable webhook outbox. The callback receives no Chusky
secrets.

```json
{
  "jsonrpc": "2.0",
  "id": "push-1",
  "method": "CreateTaskPushNotificationConfig",
  "params": {
    "taskId": "mis_...",
    "id": "callback-1",
    "url": "https://agent.example.com/chusky/a2a",
    "token": "callback-token",
    "authentication": { "schemes": ["Bearer"], "credentials": "callback-credential" }
  }
}
```

Use `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, and
`DeleteTaskPushNotificationConfig` to manage the callback. Returned
configurations follow the current flattened A2A v1 shape and intentionally omit
token and authentication credentials. Chusky also accepts the older
`tasks/pushNotificationConfig/*` method names and wrapper shape.

### Stream a task

Use `SendStreamingMessage` to receive an SSE stream containing the initial
task status and subsequent `statusUpdate` objects. Use `SubscribeToTask` when
the task already exists. The stream ends when the mission reaches completed,
failed, or canceled.

```json
{
  "jsonrpc": "2.0",
  "id": "stream-1",
  "method": "SendStreamingMessage",
  "params": {
    "message": {
      "role": "ROLE_USER",
      "parts": [{"text": "Research current fintech competitors and cite the evidence."}]
    }
  }
}
```

## Existing Chusky REST surface

The custom `/a2a/tasks` routes remain supported for existing integrations and
return the full Chusky mission projection. New external-agent integrations
should prefer the Agent Card and JSON-RPC binding so they can discover and use
the protocol without Chusky-specific route knowledge.

## Safety and durability

A2A creates work; it does not bypass Chusky policy. Destructive, financial,
permission-changing, and other high-impact actions remain governed by the
project and agent approval policy. Missions retain checkpoints, budgets,
dependency state, evidence, and proof. Reusing an idempotency key with a
different request is rejected rather than creating a second task.
