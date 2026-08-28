# Chusky Operations and Deployment

## Required production configuration

Set secrets through the hosting provider, never in Git:

- `TELEGRAM_BOT_TOKEN`
- `OPENROUTER_API_KEY`
- `COMPOSIO_API_KEY`
- `REDIS_URL`
- `WEBHOOK_URL` and a random `WEBHOOK_SECRET`
- `COMPOSIO_WEBHOOK_SECRET` for trigger verification

Set these when using durable workflows:

- `QSTASH_TOKEN`
- `VIDEO_WORKFLOW_URL`
- `REMINDER_WORKFLOW_URL`
- `JOB_WORKFLOW_URL`

Keep `.env.example` synchronized with `src/config.ts`. Treat blank workflow URLs as a deliberate disabled state and return a clear configuration error from the native tool.

## Startup checks

Before production traffic:

1. Run `npm ci` and confirm the lockfile is current.
2. Run `npm test`, `npm run typecheck`, and `npm run build`.
3. Start with production environment variables and verify `/health`.
4. Confirm Redis connection in logs; never accept in-memory fallback for production scheduling or memory.
5. Confirm Telegram webhook points to `/webhook` and Composio points to `/composio/triggers`.
6. Send a text, a voice note, and an image test message.
7. Create a short-delay reminder, cancel one, and verify a recurring job can be deleted.
8. Trigger a safe approval-gated action in a non-production account.

## Log policy

Safe to log: user ID, request ID, model ID, modality, tool slug, approval ID, workflow ID, latency, status, and error class.

Never log: API keys, Redis URLs, authorization URLs with credentials, raw media, base64, full documents, email bodies, private tool payloads, or approval secrets.

## Incident response

### Duplicate external action

Immediately stop retries for the affected tool, identify the idempotency key/provider request ID, inspect approval and lock logs, and disable the native capability if necessary. Do not blindly replay.

### Redis outage

Do not silently promote production to memory mode. Read-only health may remain available, but reject scheduling, approvals, memory writes, and external mutations with a clear retry message.

### OpenRouter outage

Use bounded exponential retries only for transient statuses. Do not retry non-idempotent provider actions unless the provider confirms the action was not accepted.

### Workflow delivery failure

Inspect QStash delivery state, workflow run ID, record status, Telegram chat mapping, and provider retry count. Keep the durable record until the failure is understood.

## Release discipline

Use a focused commit. Include source, tests, `.env.example`, README changes, and lockfile changes together. Review `git diff --check`, verify ignored secrets with `git status --ignored`, then deploy and smoke-test the exact commit.
