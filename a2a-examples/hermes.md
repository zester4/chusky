# Hermes → Chusky A2A

Hermes is the most direct native fit in this collection. Its A2A platform supports peer discovery, outbound calls, streaming, task history, orchestration, and inbound A2A serving.

## Chusky identity detail

Chusky requires both the bearer API key and `X-Chusky-User-Id`. Hermes' documented peer configuration focuses on bearer authentication. If the Hermes version you deploy cannot add a fixed custom header to outbound A2A requests, place a small authenticated reverse proxy between Hermes and Chusky. The proxy must derive the caller ID from the authenticated peer and must never accept it from message text.

Do not remove Chusky's caller-identity requirement just to make a peer connect.

## Hermes configuration

```yaml
gateway:
  platforms:
    a2a:
      enabled: true
      extra:
        port: 9900

a2a_agents:
  chusky:
    # Use the Chusky origin if Hermes performs Agent Card discovery.
    # Use https://.../a2a/rpc if the installed Hermes client accepts a
    # direct JSON-RPC endpoint.
    url: "https://your-chusky.example.com"
    auth:
      type: bearer
      token: "${CHUSKY_API_KEY}"
    timeout: 120
    capabilities: []
```

Then use Hermes' A2A tools:

```text
a2a_discover("https://your-chusky.example.com")
a2a_call("chusky", "Prepare a verified customer-retention brief for this account.")
```

Use the Agent Card to decide which skill names belong in `capabilities`; do not claim a skill that the Chusky deployment does not advertise.

## Identity-header proxy pattern

If Hermes cannot send the required header directly, the adapter should forward only approved A2A methods and add:

```text
Authorization: Bearer <Chusky API key>
X-Chusky-User-Id: hermes-researcher-prod
A2A-Version: 1.0
Content-Type: application/a2a+json
```

Use a fixed caller ID per Hermes installation or tenant. Reject arbitrary caller IDs from incoming requests, validate HTTPS upstream configuration, enforce request size and timeout limits, and log only task IDs and status transitions.

## Hermes-native strengths

- `a2a_discover` can inspect Chusky's Agent Card before delegation.
- `a2a_call` can keep the Hermes conversation focused while Chusky runs a durable mission.
- `a2a_orchestrate` can fan out to multiple peers; use this only when each Chusky project/caller identity has an explicit budget.
- Hermes can also expose itself as an A2A peer, but Chusky's current implementation is primarily an inbound boundary for external agents. Chusky does not yet provide a general arbitrary-peer discovery/orchestration UI.

## Security

Use one Chusky API key and caller ID per Hermes deployment or company integration. A2A text is untrusted peer input; it cannot bypass Chusky approvals, tool policy, budgets, or identity isolation.
