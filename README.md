# Chusky AI Agent

Chusky is a production-ready Telegram AI agent with access to **1,000+ tools** via Composio managed auth, powered by any OpenRouter model. Chusky can connect apps, run shell commands, browse the web, handle real-time trigger events, and execute across every major SaaS platform — from Telegram or a linked terminal.

---

## What Chusky can do

| Capability | How |
|---|---|
| **1,000+ app tools** | Composio managed OAuth (GitHub, Gmail, Slack, Notion, Linear, Stripe…) |
| **Connect apps inline** | `COMPOSIO_MANAGE_CONNECTIONS` surfaces OAuth links mid-conversation |
| **Run shell commands** | `COMPOSIO_REMOTE_BASH_TOOL` — sandboxed bash in a remote environment |
| **Persistent workspace** | `COMPOSIO_REMOTE_WORKBENCH` — stateful remote environment per session |
| **Tool discovery** | `COMPOSIO_SEARCH_TOOL` — finds the right tool by intent |
| **Real-time triggers** | Composio webhook → Chusky notifies you on Slack messages, GitHub commits, emails, etc. |
| **Any LLM** | Switch model per-user at runtime via `/model` |
| **Redis persistence** | Sessions survive restarts; falls back to memory |
| **Native scheduling** | Natural-language one-time reminders and recurring CRON jobs via Upstash |
| **Private scratchpad** | Chusky can save and retrieve per-user working notes across turns |
| **Daytona computer** | Optional isolated per-user workspace for code, files, and commands |
| **Rate limiting** | Per-user throttling |
| **Export** | `/export` downloads full conversation as `.txt` |
| **Inline mode** | `@chusky query` in any chat |
| **Linked CLI** | Continue the same Redis-backed session from a terminal |

---

## Quickstart (local dev)

```bash
git clone <repo> && cd tg-agent
npm install
cp .env.example .env
chusky setup
# Or: npm run setup
# For reminders/jobs and durable scheduled tasks, also set QSTASH_TOKEN and the two public workflow URLs.
# Leave WEBHOOK_URL blank — uses polling

npm run telegram

# From a linked terminal, after deploying Chusky:
npm run cli
```

`chusky setup` is safe to rerun: it preserves existing `.env` values, hides secret input, generates missing webhook secrets, and lets you skip optional Redis, QStash, and Daytona integrations. `chusky doctor` reports configured or missing settings and checks the deployed `/health` endpoint when webhook mode is enabled. The development aliases are `npm run setup` and `npm run doctor`.

Use `chusky chat` for terminal chat and `chusky telegram` to run the Telegram service. `chusky start` is an alias for the service. `npm run dev` remains available for TypeScript watch-mode development.

### Terminal CLI

The CLI is a secure client of the running Chusky service. It does not create a second conversation or a second Composio session. CLI API routes are enabled in production webhook mode; configure a public `WEBHOOK_URL` and Redis before pairing. Local polling mode remains Telegram-only unless the service is deployed.

1. Deploy Chusky with `WEBHOOK_URL` and `REDIS_URL` configured.
2. In Telegram, run `/cli link`.
3. In the terminal, run:

```bash
npm run cli -- auth link --server https://your-chusky-host --code 123456 --name joe-laptop
npm run cli
```

The pairing code is one-time and expires after 10 minutes. The terminal stores a revocable device token locally; conversation history, memories, approvals, reminders, jobs, and the Composio session remain server-side. Use `/cli devices` and `/cli revoke <terminal name>` in Telegram to manage access. When installed, the optional `keytar` dependency stores the token in Windows Credential Manager, macOS Keychain, or Linux Secret Service. If native storage is unavailable, set `CHUSKY_CLI_SECRET` to enable AES-256-GCM encrypted fallback storage; otherwise Chusky retains the legacy file behavior and reports it in diagnostics.

CLI commands include `/history`, `/tasks`, `/task <id>`, `/task retry <id>`, `/task cancel <id>`, `/model` (interactive picker) or `/model <openrouter-model>`, `/approve <id>`, `/deny <id>`, `/clear history`, `/clear session`, and `/exit`. Chat response deltas are displayed as they arrive; `Ctrl+C` cancels only the active request and returns to the prompt. The prompt is a raw editor: Up/Down navigates input history, Left/Right moves the cursor, Tab completes slash commands, Ctrl+J inserts a newline, and bracketed paste preserves every pasted newline until Enter sends the complete message. Long history, memory, scratchpad, reminder, job, and task lists use a keyboard pager (`Space`/Down, `b`/Up, `q`); normal chat responses scroll naturally. Markdown responses are rendered for terminal output while the same assistant response is persisted for Telegram.

Email, publishing, deletion, payment, and direct externally visible actions require the approval picker before execution. Chusky's private Daytona computer and sandbox are agent-controlled and do not prompt for approval. `COMPOSIO_MULTI_EXECUTE_TOOL` itself is treated as an orchestration wrapper and does not prompt. The authenticated service exposes bounded collection APIs at `/cli/collection/history`,
`/cli/collection/memories`, `/cli/collection/scratchpad`, `/cli/collection/reminders`, and
`/cli/collection/jobs`. Each accepts `page`, `pageSize` (capped server-side), and an optional
`query`, and returns `total`/`totalPages`; `/cli/session?page=&pageSize=` provides the same
pagination metadata for session history while returning only bounded summaries and counts.

---

## Deploy

### Stop, start, and restart Chusky on Oracle

When Chusky is running under PM2, control only the `chusky` process. This leaves the
other applications (`hubtel-gateway`, `selit-pay`, and `verifo`) and Nginx running.

```bash
cd ~/chusky
pm2 status
pm2 stop chusky
```

Use these commands to manage it:

```bash
pm2 start chusky                 # resume a stopped Chusky process
pm2 restart chusky --update-env  # restart after changing .env
pm2 logs chusky --lines 100      # inspect Chusky logs; Ctrl+C exits the viewer
pm2 save                         # persist the current PM2 state across reboot
```

To update Chusky safely while keeping the other services untouched:

```bash
cd ~/chusky
pm2 stop chusky
git pull --ff-only origin main
npm install --no-audit --no-fund
NODE_OPTIONS="--max-old-space-size=512" npm run build
pm2 start chusky
pm2 save
```

Verify that it is listening on the configured Chusky port and that Nginx can reach it:

```bash
pm2 status
sudo ss -ltnp | grep :3003
curl -i https://chusky.selithub.shop/health
```

If Chusky was started directly in the terminal with `npm start`, press `Ctrl+C` to stop
that foreground process. Do not run `npm start` while `pm2 status` shows Chusky as online:
both processes try to use port 3003 and the second one fails with `EADDRINUSE`.

Do not use `pm2 stop all`, `pm2 delete all`, `pkill node`, or `sudo systemctl stop nginx`;
those commands can stop the other applications or the reverse proxy. `pm2 delete chusky`
removes Chusky from PM2 entirely and is only appropriate when intentionally uninstalling
its PM2 registration, not for a normal temporary stop.

### Railway
1. Push to GitHub → Railway → New Project → Deploy from repo
2. Set env vars in Railway dashboard
3. Copy Railway URL → set `WEBHOOK_URL` → redeploy

### Fly.io
```bash
fly launch --name chuck-agent --no-deploy
fly secrets set \
  TELEGRAM_BOT_TOKEN=... \
  OPENROUTER_API_KEY=... \
  COMPOSIO_API_KEY=... \
  WEBHOOK_URL=https://chuck-agent.fly.dev \
  WEBHOOK_SECRET=your-random-secret
fly deploy
```

### Google Cloud Run
```bash
docker build -t gcr.io/PROJECT/chuck .
docker push gcr.io/PROJECT/chuck
gcloud run deploy chuck \
  --image gcr.io/PROJECT/chuck \
  --platform managed --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "TELEGRAM_BOT_TOKEN=...,OPENROUTER_API_KEY=...,COMPOSIO_API_KEY=...,WEBHOOK_URL=https://..."
```

### Render
1. New Web Service → Docker → connect repo
2. Add env vars → deploy → copy URL → set `WEBHOOK_URL` → redeploy

---

## Setting up Composio triggers

Chusky can receive real-time events from connected apps (new Slack message, GitHub commit, incoming email, etc.).

1. Deploy Chusky and note your public URL
2. In the [Composio dashboard](https://app.composio.dev) → **Triggers** → set webhook URL to:
   `https://your-domain.com/composio/triggers`
3. Chusky will receive events at `/composio/triggers` and can notify you via Telegram

To create a trigger programmatically, tell Chusky:
> *"Create a trigger for new GitHub commits on my repo my-org/my-repo"*

Chusky will use `COMPOSIO_MANAGE_CONNECTIONS` to connect GitHub if needed, then set up the trigger.

---

## Commands

| Command | Description |
|---|---|
| `/start` | Welcome + current config |
| `/connect [app]` | Connect an app (e.g. `/connect github`) |
| `/apps` | See connected apps + available apps |
| `/model` | Switch AI model (per-session, no restart) |
| `/clear` | Show clear-session help |
| `/clear history` | Wipe conversation history while keeping the Composio session |
| `/clear session` | Wipe history and reset the Composio session |
| `/triggers` | List your Composio triggers |
| `/trigger create|enable|disable|delete` | Manage a Composio trigger |
| `/tasks` | List durable tasks and their current status |
| `/task <id>` | Inspect a task, checkpoint, next action, and audit events |
| `/task retry|cancel <id>` | Retry or cancel an owned task |
| `/attach "path" [instruction]` | Send an image, audio, video, PDF, text, or Markdown file to Chusky |
| `/devices` | List linked terminal devices |
| `/revoke <name>` | Revoke a linked terminal device |
| `/image <description>` | Generate an image with OpenRouter |
| `/export` | Download conversation as `.txt` |
| `/usage` | Messages sent + model |
| `/info` | Full session details |
| `/help` | Help |
| `/cli link` | Create a one-time terminal pairing code |
| `/cli devices` | List linked terminals |
| `/cli revoke <name>` | Revoke a linked terminal |

## Natural-language reminders, jobs, and scratchpad

Chusky's native tools are callable directly from ordinary messages:

- “Remind me in 20 minutes to check the deployment.”
- “Every weekday at 9, remind me to review the inbox.” (Chusky asks for or uses a CRON expression when needed.)
- “Save this as a scratchpad note called deploy: use the staging API.”
- “What did I save in my deploy notes?”

Configure `QSTASH_TOKEN`, `REMINDER_WORKFLOW_URL=https://your-domain/workflows/reminder`, and
`JOB_WORKFLOW_URL=https://your-domain/workflows/job`. One-time reminders are delayed durable
Workflow runs; recurring jobs are QStash schedules that invoke the authenticated Workflow endpoint.
Chusky checks ownership and cancellation state before delivering a notification.

### Daytona persistence

When `DAYTONA_API_KEY` is configured, Chusky keeps a per-user Daytona workspace and stores its
provider ID in the durable Redis store under the existing `chuck:*` persistence contract. On a
later request, Chusky reconnects to that workspace, refreshes its state, recovers it when Daytona
reports a recoverable error, and starts it again after an idle pause or stop. The workspace's
filesystem is retained by Daytona across those lifecycle states; a provider-side deletion or
wall-clock TTL is permanent and causes Chusky to require a new workspace.

Chusky also accepts these requests naturally, without slash commands:

```text
Generate an image of a moonlit mountain lake.
Make a short video of a red panda surfing.
Enable a trigger whenever I receive a new GitHub issue.
```

Natural-language image and trigger requests are exposed to the model as Chusky tools. Video requests are submitted to the Upstash Workflow endpoint and delivered to Telegram when generation completes.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | From @BotFather |
| `OPENROUTER_API_KEY` | ✅ | — | From openrouter.ai/keys |
| `COMPOSIO_API_KEY` | ✅ | — | From app.composio.dev |
| `WEBHOOK_URL` | prod | — | Public URL (blank = polling) |
| `WEBHOOK_SECRET` | — | — | Secures Telegram webhook |
| `DEFAULT_MODEL` | — | `~deepseek/deepseek-v4-flash-latest` | Any OpenRouter model ID |
| `TRANSCRIPTION_MODEL` | — | `openai/gpt-transcribe` | OpenRouter speech-to-text model |
| `QSTASH_TOKEN` | reminders/jobs | — | Upstash QStash token |
| `REMINDER_WORKFLOW_URL` | reminders | — | Public `.../workflows/reminder` URL |
| `JOB_WORKFLOW_URL` | recurring jobs | — | Public `.../workflows/job` URL |
| `SYSTEM_PROMPT` | — | Chusky's default | Agent personality |
| `ENABLE_MANAGE_CONNECTIONS` | — | `true` | OAuth link tool |
| `COMPOSIO_CALLBACK_URL` | — | — | Post-connect redirect URL |
| `ENABLE_SANDBOX` | — | `true` | Bash + workbench tools |
| `SANDBOX_SIZE` | — | `standard` | `standard`/`medium`/`large`/`xlarge` |
| `DAYTONA_API_KEY` | Daytona | — | Enables an isolated per-user Daytona workspace |
| `DAYTONA_API_URL` | — | `https://app.daytona.io/api` | Daytona API endpoint |
| `DAYTONA_TARGET` | — | provider default | Optional Daytona execution target |
| `DAYTONA_SNAPSHOT` | — | provider default | Optional reusable snapshot |
| `MAX_TOOL_ROUNDS` | — | `10` | Max agentic loop iterations |
| `RATE_LIMIT` | — | `10` | Messages per window |
| `RATE_WINDOW_SECONDS` | — | `60` | Rate window |
| `ALLOWED_USERS` | — | (all) | Telegram user IDs allowlist |
| `MAX_HISTORY` | — | `20` | Conversation turns to keep |
| `REDIS_URL` | — | (memory) | Redis for persistence |
| `SESSION_TTL` | — | `2592000` | Redis TTL (30 days) |
| `PORT` | — | `8080` | HTTP port |
| `LOG_LEVEL` | — | `info` | trace/debug/info/warn/error |

---

## Architecture

```
src/
├── index.ts      Entry point — webhook (prod) / polling (dev), Composio trigger endpoint
├── config.ts     All env vars, typed + validated at startup
├── logger.ts     pino — pretty in dev, JSON in prod
├── store.ts      Redis + memory — sessions, rate limits, Composio session IDs
├── agent.ts      Chusky's brain — Composio session + OpenRouter agentic loop
├── agentTools.ts Native tool schemas exposed to the model
├── types.ts      Shared API, media, and tool-call types
├── policy.ts     Risk detection and human progress messages
├── nativeTools.ts Native reminders, CRON, scratchpad, and Daytona dispatch
├── lib/daytona/  Daytona SDK client, workspace lifecycle, files, and process engine
├── handlers.ts   grammY commands, live status bar, /connect, /apps, inline mode
└── markdown.ts   LLM markdown → Telegram HTML
└── cli/           Authenticated terminal client, API client, and Markdown renderer
```

### Agentic loop

```
composio.create(userId) → session with 1000+ tools + meta tools
        │
session.tools() → OpenAI-compatible tool schemas
        │
POST openrouter.ai/chat/completions (model + messages + tools)
        │
   finish_reason?
   ┌────┴────────────┐
 stop           tool_calls
   │                 │
 return          for each call:
  text           session.execute(slug, args) → Composio routes it
                 (meta tools → Composio server,
                  app tools → Composio → provider API)
                      │
                 append result → loop (max MAX_TOOL_ROUNDS)
```

### Adding a custom tool

```typescript
// In src/agent.ts — after sessionObj is created:
const myTool = {
  type: "function",
  function: {
    name: "MY_CUSTOM_TOOL",
    description: "What this does",
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
  },
};

// Add to composioTools array before the agentic loop:
composioTools.push(myTool);

// Handle in the loop:
if (slug === "MY_CUSTOM_TOOL") {
  result = await myCustomExecute(args);
}
```
