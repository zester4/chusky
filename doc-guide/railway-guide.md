# Chusky on Railway

This guide deploys Chusky as a long-running Railway service with a public HTTPS
endpoint, Telegram webhooks, and durable Redis-backed state.

```text
Telegram ───────────────┐
CLI / browser ──────────┼──> Railway HTTPS domain ──> Chusky
Composio triggers ──────┘                              │
                                                       ├── OpenRouter
                                                       ├── Composio
                                                       └── Redis
```

Railway provides HTTPS and routes traffic to the `PORT` environment variable.
This repository already includes [`railway.toml`](railway.toml), which tells
Railway to build the checked-in [`Dockerfile`](Dockerfile) and use
`/health/live` as the deployment health check.

## Before you deploy

You need:

- A Railway account and this repository pushed to GitHub.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- An [OpenRouter API key](https://openrouter.ai/keys).
- A [Composio API key](https://app.composio.dev).
- Durable Redis. Railway's Redis template is suitable for a simple deployment;
  an external Redis provider also works.

Do not commit `.env`, API keys, Telegram tokens, Redis URLs, or generated
secrets. Add them only as Railway service variables.

## 1. Create the Railway project

1. Open Railway and choose **New Project**.
2. Choose **Deploy from GitHub repo**.
3. Select the Chusky repository and create the service.
4. Choose **Add Variables** if Railway offers it, so you can configure the
   service before its first successful deployment.

Railway should detect the repository's `railway.toml` and Dockerfile. The
container builds TypeScript and starts Chusky with:

```text
node dist/index.js
```

The Docker image also installs `ffmpeg`. This is required for Sendblue iMessage
voice notes: Apple sends these as Opus-in-CAF, and Chusky converts them to
Ogg/Opus before sending them to the transcription provider. Do not try to run
`apt-get` in a Railway shell or add an environment variable for it; pushing
this Dockerfile change causes Railway to build the dependency into the service.

There is no need to run `npm run setup` inside Railway; that command is an
interactive local setup helper. Configure the variables in the next section.

## 2. Add Redis first

In the same Railway project:

1. Choose **+ New** and add a **Redis** database.
2. Open the Chusky service's **Variables** tab.
3. Add `REDIS_URL` as a reference to the Redis service:

```text
${{Redis.REDIS_URL}}
```

If the Redis service has a different name, replace `Redis` with its exact
service name. Confirm that the final variable name on the Chusky service is
exactly `REDIS_URL`.

Redis is required for production. It stores sessions, memories, approvals,
reminders, jobs, leases, rate limits, and webhook deduplication. Without it,
Chusky intentionally refuses to use in-memory persistence in production.

## 3. Add the required variables

In the Chusky service's **Variables** tab, add these values:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The token from BotFather |
| `OPENROUTER_API_KEY` | Your OpenRouter key |
| `COMPOSIO_API_KEY` | Your Composio key |
| `REDIS_URL` | The Redis reference from step 2 |
| `WEBHOOK_SECRET` | A new, long random string |
| `WEBHOOK_URL` | Set to the Railway HTTPS origin after step 4 |

Recommended production values:

```text
NODE_ENV=production
DEFAULT_MODEL=minimax/minimax-m3:free
CHUSKY_TIMEZONE=Europe/London
LOG_LEVEL=info
```

Do not set a fixed `PORT` unless Railway specifically asks you to. Chusky
already reads Railway's injected `PORT`; its local/default port is `8080`.

For this repository, `WEBHOOK_URL` must be set before the first successful
Railway deployment. In webhook mode Chusky starts its HTTP listener and
`/health` route. With `WEBHOOK_URL` blank, it starts local polling mode instead
and does not provide the Railway health endpoint.

## 4. Create the public domain

1. Open the Chusky service **Settings**.
2. Find **Networking → Public Networking**.
3. Click **Generate Domain**.
4. Copy the generated `https://...up.railway.app` URL.

Railway provides the HTTPS certificate automatically. A custom domain is
optional; it is not required for Telegram.

## 5. Set the URL and deploy

Return to the Chusky service's **Variables** tab and set:

```text
WEBHOOK_URL=https://your-service.up.railway.app
```

Use the origin only:

- Include `https://`.
- Do not add `/webhook`.
- Do not add a trailing slash.

Review and deploy the staged Railway changes. On startup Chusky registers
Telegram's webhook at:

```text
https://your-service.up.railway.app/webhook
```

If Railway started an automatic deployment before the variables were ready and
it failed, simply redeploy after `REDIS_URL` and `WEBHOOK_URL` are configured.
Only one running deployment should own a bot token. Stop any local polling
process before enabling webhook mode, or Telegram may alternate between the
local process and Railway.

## 6. Verify the deployment

Open the Railway service's **Deployments** and **Logs** views. A healthy startup
should show that Chusky is listening, Redis is available, and the Telegram
webhook was registered. Logs must not contain tokens or raw webhook payloads.

From PowerShell, test the liveness endpoint:

```powershell
curl.exe -i https://your-service.up.railway.app/health/live
```

Then test the deeper health check:

```powershell
curl.exe -i https://your-service.up.railway.app/health
```

`/health/live` is dependency-free. `/health` checks Telegram and persistence;
it should return HTTP `200` with `"ok": true` when the production service is
operational. Railway uses `/health/live` during deployment, as configured in
`railway.toml`.

If the deployment fails its health check, inspect the logs first. The usual
causes are a missing `REDIS_URL`, an invalid provider key, or the service not
listening on Railway's `PORT`.

## 7. Pair the terminal CLI

After `/health` is operational:

1. In Telegram, send `/cli link` to Chusky.
2. On your local computer, from the repository root, run the one-time pairing
   command using the code Telegram gives you:

```powershell
npm run cli -- auth link --server https://your-service.up.railway.app --code 123456 --name my-laptop
npm run cli
```

The code expires after 10 minutes. The terminal stores a revocable device
token locally; conversations, memories, approvals, reminders, jobs, and the
Composio session remain on Railway in Redis.

## 8. Enable Composio triggers (optional)

First set these Railway variables:

```text
COMPOSIO_WEBHOOK_SECRET=<new random secret>
```

Then register the same URL in the Composio dashboard under **Triggers → Webhook
URL**:

```text
https://your-service.up.railway.app/composio/triggers
```

Keep the secret private. Chusky verifies the incoming signature before
accepting trigger events.

## 9. Enable reminders and durable workflows (optional)

Scheduled jobs and durable workflows require an Upstash QStash token and
webhook mode:

```text
QSTASH_TOKEN=<your QStash token>
QSTASH_URL=https://qstash-us-east-1.upstash.io
```

The workflow URLs may remain blank when using Chusky's default routes; Chusky
derives them from `WEBHOOK_URL`. Set `VIDEO_WORKFLOW_URL`,
`REMINDER_WORKFLOW_URL`, `JOB_WORKFLOW_URL`, or `TRIGGER_WORKFLOW_URL` only when
you have separately configured those public workflow endpoints.

## 10. Optional dashboard and authentication

The Telegram/CLI agent does not require the web dashboard. Leave
`BETTER_AUTH_ENABLED=false` unless you are also deploying the dashboard and
have configured production authentication.

If you enable it, configure all of the following as Railway variables:

```text
BETTER_AUTH_ENABLED=true
BETTER_AUTH_SECRET=<new random secret>
BETTER_AUTH_URL=https://your-dashboard-or-backend-origin
BETTER_AUTH_TRUSTED_ORIGINS=https://your-dashboard-origin
BETTER_AUTH_DATABASE_URL=<production PostgreSQL URL>
RESEND_API_KEY=<email provider key>
AUTH_EMAIL_FROM=<verified sender address>
```

Production Better Auth uses PostgreSQL; do not use the local SQLite path on
Railway.

## Updates and operations

With GitHub autodeploy enabled, push a tested change to the tracked branch and
Railway will create a new deployment. For a manual deployment, use Railway's
**Deploy** action from the service dashboard.

Before pushing a release locally:

```powershell
npm ci
npm test
npm run typecheck
npm run build
```

After every deployment:

1. Check the deployment logs.
2. Check `/health`.
3. Send a small test message to the bot.
4. Confirm that the Railway service still has the expected domain and
   `WEBHOOK_URL`.

Do not run a second Chusky polling process with the same bot token. Do not put
important application data on the Railway container filesystem; container
files are not the durable store. Keep Redis backups and provider credentials
managed separately from the application image.

## Troubleshooting

### `REDIS_URL is required in webhook/production mode`

The Redis reference is missing or points to the wrong service name. Recheck the
Chusky service's variable name and deploy the staged variable change.

### `/health` returns `503`

Check the deployment logs and verify `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`,
`COMPOSIO_API_KEY`, and `REDIS_URL`. `/health/live` can still return `200` while
the deeper Telegram or Redis check is failing.

### Telegram messages do not arrive

Verify that `WEBHOOK_URL` is the HTTPS origin with no trailing slash, the
deployment is healthy, and no local process is polling the same bot. The
expected endpoint is `/webhook`; do not configure Telegram to use `/health`.

### Composio triggers do not arrive

Verify `COMPOSIO_WEBHOOK_SECRET`, the exact
`https://your-service.../composio/triggers` URL, and that the trigger belongs to
the same Chusky user/session. A trigger route without its verification secret
is intentionally rejected.

### Railway keeps restarting the service

Open the deployment logs. A missing required environment variable, invalid
provider credential, unavailable Redis service, or a health check failure will
prevent the deployment from becoming active. Fix the first startup error and
redeploy rather than repeatedly restarting it.

## Official Railway references

- [Deploy from a GitHub repository](https://docs.railway.com/guides/deploying-a-project)
- [Using Railway variables](https://docs.railway.com/variables)
- [Railway Redis](https://docs.railway.com/databases/redis)
- [Public networking and domains](https://docs.railway.com/networking/public-networking)
- [Deployment health checks](https://docs.railway.com/deployments/healthchecks)
- [Railway config as code](https://docs.railway.com/reference/config-as-code)
