# Chuck AI Agent

Chuck is a production-ready Telegram AI agent with access to **1,000+ tools** via Composio managed auth, powered by any OpenRouter model. He can connect apps, run shell commands, browse the web, handle real-time trigger events, and execute across every major SaaS platform — all from a Telegram chat.

---

## What Chuck can do

| Capability | How |
|---|---|
| **1,000+ app tools** | Composio managed OAuth (GitHub, Gmail, Slack, Notion, Linear, Stripe…) |
| **Connect apps inline** | `COMPOSIO_MANAGE_CONNECTIONS` surfaces OAuth links mid-conversation |
| **Run shell commands** | `COMPOSIO_REMOTE_BASH_TOOL` — sandboxed bash in a remote environment |
| **Persistent workspace** | `COMPOSIO_REMOTE_WORKBENCH` — stateful remote environment per session |
| **Tool discovery** | `COMPOSIO_SEARCH_TOOL` — finds the right tool by intent |
| **Real-time triggers** | Composio webhook → Chuck notifies you on Slack messages, GitHub commits, emails, etc. |
| **Any LLM** | Switch model per-user at runtime via `/model` |
| **Redis persistence** | Sessions survive restarts; falls back to memory |
| **Rate limiting** | Per-user throttling |
| **Export** | `/export` downloads full conversation as `.txt` |
| **Inline mode** | `@chuck query` in any chat |

---

## Quickstart (local dev)

```bash
git clone <repo> && cd tg-agent
npm install
cp .env.example .env
# Fill in: TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY, COMPOSIO_API_KEY
# Leave WEBHOOK_URL blank — uses polling

npm run dev
```

---

## Deploy

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

Chuck can receive real-time events from connected apps (new Slack message, GitHub commit, incoming email, etc.).

1. Deploy Chuck and note your public URL
2. In the [Composio dashboard](https://app.composio.dev) → **Triggers** → set webhook URL to:
   `https://your-domain.com/composio/triggers`
3. Chuck will receive events at `/composio/triggers` and can notify you via Telegram

To create a trigger programmatically, tell Chuck:
> *"Create a trigger for new GitHub commits on my repo my-org/my-repo"*

Chuck will use `COMPOSIO_MANAGE_CONNECTIONS` to connect GitHub if needed, then set up the trigger.

---

## Commands

| Command | Description |
|---|---|
| `/start` | Welcome + current config |
| `/connect [app]` | Connect an app (e.g. `/connect github`) |
| `/apps` | See connected apps + available apps |
| `/model` | Switch AI model (per-session, no restart) |
| `/clear` | Wipe history + reset Composio session |
| `/clear history` | Wipe conversation history while keeping the Composio session |
| `/clear session` | Wipe history and reset the Composio session |
| `/triggers` | List your Composio triggers |
| `/trigger create|enable|disable|delete` | Manage a Composio trigger |
| `/image <description>` | Generate an image with OpenRouter |

Chuck also accepts these requests naturally, without slash commands:

```text
Generate an image of a moonlit mountain lake.
Make a short video of a red panda surfing.
Enable a trigger whenever I receive a new GitHub issue.
```

Natural-language image and trigger requests are exposed to the model as Chuck tools. Video requests are submitted to the Upstash Workflow endpoint and delivered to Telegram when generation completes.
| `/export` | Download conversation as `.txt` |
| `/usage` | Messages sent + model |
| `/info` | Full session details |
| `/help` | Help |

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
| `SYSTEM_PROMPT` | — | Chuck's default | Agent personality |
| `ENABLE_MANAGE_CONNECTIONS` | — | `true` | OAuth link tool |
| `COMPOSIO_CALLBACK_URL` | — | — | Post-connect redirect URL |
| `ENABLE_SANDBOX` | — | `true` | Bash + workbench tools |
| `SANDBOX_SIZE` | — | `standard` | `standard`/`medium`/`large`/`xlarge` |
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
├── agent.ts      Chuck's brain — Composio session + OpenRouter agentic loop
├── handlers.ts   grammY commands, live status bar, /connect, /apps, inline mode
└── markdown.ts   LLM markdown → Telegram HTML
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
