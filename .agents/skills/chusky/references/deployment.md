# Chusky Deployment and Runtime Modes

## Polling mode

Leave `WEBHOOK_URL` blank. `src/index.ts` deletes any Telegram webhook and starts grammY polling. This works on an Oracle Cloud VM with only outbound HTTPS access to Telegram; the VM does not need a public URL for Telegram messages.

Polling is suitable for a single Telegram-only process. It does not expose the Hono HTTP routes, so the deployed service cannot provide CLI pairing/chat, Composio trigger ingestion, or authenticated workflow endpoints in this mode.

## Webhook mode

Set `WEBHOOK_URL` to the public origin without a trailing slash, for example `https://chusky.example.com`. Chusky listens on `PORT` and registers Telegram at:

```text
https://chusky.example.com/webhook
```

The public origin must terminate valid HTTPS and forward requests to the Chusky process. Do not use a bare `http://IP-address` value for Telegram webhook mode. A domain with a reverse proxy such as Caddy or Nginx is the normal VM setup:

```text
Telegram / CLI / Composio / QStash
          -> HTTPS reverse proxy :443
          -> Chusky :8080
```

Open only the required Oracle ingress ports (`80` and `443` for certificate issuance and HTTPS). Keep the application port private when possible. Set `WEBHOOK_SECRET` for Telegram and `COMPOSIO_WEBHOOK_SECRET` for Composio.

## Persistence and workflows

`REDIS_URL` is required for production continuity. Without it, the process falls back to in-memory state and restart loses sessions, history, memories, approvals, reminders, jobs, pairing records, and rate-limit state.

Durable reminders, recurring jobs, and video workflows additionally need the relevant QStash token and public workflow URLs. A workflow URL must be reachable over HTTPS and point to the matching `/workflows/*` route. Workflow handlers must re-read the durable record before delivery because cancellation can race with an already queued request.

## VM process lifecycle

Run a built artifact with `npm.cmd run build` then `npm.cmd start`. Use a supervisor such as systemd, PM2, or Docker to restart after crashes, but do not run two polling replicas for the same bot token. In webhook mode, multiple replicas are possible only when Redis locking, idempotency, and proxy health checks are configured correctly.

## Release checklist

1. Install from the lockfile.
2. Set secrets outside Git.
3. Confirm Redis is reachable and no production process uses the memory fallback.
4. Verify `/health`, Telegram webhook status, and the Composio webhook URL.
5. Test text, voice, image, CLI continuation, approval, reminder cancellation, and restart persistence.
6. Inspect logs for model, request, tool, workflow, and error class—not secrets or payloads.
