# Chusky AI Agent

Chusky is a production-oriented personal AI agent with access to **1,000+ tools** via Composio managed auth, powered by any OpenRouter model. Chusky can connect apps, run shell commands, browse the web, handle real-time trigger events, and execute across major SaaS platforms from Telegram, linked channels, or a terminal.

The service has two layers:

- The agent layer owns model inference, Composio sessions, native tools, approvals, memory, tasks, and durable workflows.
- The transport layer owns Telegram, CLI, Slack, WhatsApp, and Sendblue delivery. Provider-specific payloads never enter the agent layer directly.

Production deployments should use Redis and QStash. In-memory persistence is intended for local development and tests only; it does not survive restarts and must not be used for production reminders, approvals, memories, or channel deduplication.

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
| **Redis persistence** | Sessions, memories, approvals, tasks, and channel events survive restarts; memory mode is development-only |
| **Native scheduling** | Natural-language one-time reminders and recurring CRON jobs via Upstash |
| **Voice replies** | `/voice on` adds an OpenRouter TTS audio reply while retaining the readable text response |
| **Private scratchpad** | Chusky can save and retrieve per-user working notes across turns |
| **Daytona computer** | Optional isolated per-user workspace for code, files, and commands |
| **Rate limiting** | Per-user throttling |
| **Export** | `/export` downloads full conversation as `.txt` |
| **Inline mode** | `@chusky query` in any chat |
| **Linked CLI** | Continue the same Redis-backed session from a terminal |
| **Shared channel gateway** | One account identity and durable conversation/outbox boundary for Telegram, CLI, Slack, WhatsApp, and Sendblue |
| **Verified Slack adapter** | Signed Events API/interactions, DMs, mentions, threads, OAuth installation, and Block Kit approvals |
| **Verified WhatsApp adapter** | Signed Cloud API webhooks, text/media normalization, and durable outbound receipts |
| **Verified Sendblue adapter** | iMessage webhooks, durable workflows, direct/group replies, media, typing indicators, and iMessage-safe formatting |
| **Provider boundaries** | SMS and voice contracts are available for provider injection; live provider routes are not enabled yet |

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

CLI commands include `/history`, `/tasks`, `/task <id>`, `/task retry <id>`, `/task cancel <id>`, `/model` (interactive picker) or `/model <openrouter-model>`, `/apps [page]`, `/connect <app>`, `/tools search <query>`, `/triggers`, `/trigger create|enable|disable|delete`, `/channel list|link|notify`, `/voice on|off|status`, `/call <E.164 number> <purpose>`, `/usage`, `/export`, `/dashboard`, `/approve <id>`, `/deny <id>`, `/clear history`, `/clear session`, and `/exit`. `/call` creates a one-time approval and cannot place the call until that approval is explicitly granted. Chat response deltas are displayed as they arrive; `Ctrl+C` cancels only the active request and returns to the prompt. The prompt is a raw editor: Up/Down navigates input history, Left/Right moves the cursor, Tab completes slash commands, Ctrl+J inserts a newline, and bracketed paste preserves every pasted newline until Enter sends the complete message. Long history, memory, scratchpad, reminder, job, task, app, tool, and trigger lists use a keyboard pager (`Space`/Down, `b`/Up, `q`); normal chat responses scroll naturally. Markdown responses are rendered for terminal output while the same assistant response is persisted for Telegram. Generated images, voice replies, and artifact files are saved to the local Chusky artifacts directory.

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
```

Use these commands to manage it:

```bash
pm2 reload ecosystem.config.cjs --only chusky --update-env  # safe production reload
pm2 logs chusky --lines 100      # inspect Chusky logs; Ctrl+C exits the viewer
pm2 save                         # persist the current PM2 state across reboot
```

Chusky uses a readiness-gated PM2 cluster worker. During a normal `reload`, PM2 starts
the replacement, waits for Chusky to verify Redis, Telegram, its HTTP listener, and the
Telegram webhook, then lets the old process drain active updates. Do not use `pm2 restart`
or `pm2 stop` for normal releases: both create avoidable Telegram downtime.

#### One-time PM2 migration

After pulling a release that contains `ecosystem.config.cjs`, migrate the existing fork-mode
process once. This briefly restarts only Chusky; run it after a successful build.

```bash
cd ~/chusky
pm2 delete chusky
pm2 start ecosystem.config.cjs --only chusky --update-env
pm2 save
```

#### Every future Oracle release

Use the checked-in deploy script. It refuses to deploy over tracked local changes, installs
from the lockfile, builds before touching PM2, performs the safe reload, and verifies local
liveness:

```bash
cd ~/chusky
bash scripts/deploy-oracle.sh
```

The Oracle-safe build heap defaults to `512 MB` and uses configured swap during compilation.
Override it only when necessary with `CHUSKY_BUILD_HEAP_MB=640 bash scripts/deploy-oracle.sh`.

Verify that it is listening on the configured Chusky port and that Nginx can reach it:

```bash
pm2 status
sudo ss -ltnp | grep :3003
curl -i https://chusky.selithub.shop/health
```

Do not run `npm start` while `pm2 status` shows Chusky as online: both processes try to
use port 3003 and the second one fails with `EADDRINUSE`. If a foreground process was
started before PM2, stop only that foreground process with `Ctrl+C` before the one-time
PM2 migration.

Do not use `pm2 stop all`, `pm2 delete all`, `pkill node`, or `sudo systemctl stop nginx`;
those commands can stop the other applications or the reverse proxy. `pm2 delete chusky`
removes Chusky from PM2 entirely and is only appropriate when intentionally uninstalling
its PM2 registration, not for a normal temporary stop.

### Railway
See [`railway-guide.md`](railway-guide.md) for the complete Railway deployment,
Redis, webhook, CLI pairing, and troubleshooting instructions.

### Local dashboard

From the repository root, run `npm run dashboard` to start the existing
`chusky-web` Next.js app. Visit `http://localhost:3000/app/operations` after
signing in; `/app/delivery` is the focused delivery view.

To use the same workspace on web and Telegram, sign in to the dashboard, open
**Settings**, create a Telegram link code, then send the copied `/link web_…`
command from the Telegram account that already uses Chusky. The high-entropy
code expires in 10 minutes, is one-time, and cannot rebind either account.

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
| `/channel link slack|whatsapp|sendblue` | Create a one-time verified external-channel link |
| `/channel list` | List channels linked to your Chusky account |
| `/channel notify slack|whatsapp|sendblue on|off` | Enable or disable proactive notifications for a linked channel |
| `/link web_<one-time-code>` | Link the authenticated dashboard workspace to this verified Telegram account |
| `/dashboard` | Open the authenticated Chusky web dashboard |

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

### Event-driven Composio triggers

Composio trigger events are verified, ownership-checked, deduplicated, stored as a bounded safe
summary, and handed to the durable `/workflows/trigger-event` endpoint. The webhook returns `202`
before the agent runs. Set `TRIGGER_WORKFLOW_URL` explicitly when the public workflow URL differs
from `${WEBHOOK_URL}/workflows/trigger-event`; otherwise Chusky derives it from `WEBHOOK_URL`.
Trigger workflow runs use `trigger-<event-id>` as their stable QStash workflow ID, so provider
retries do not start a second agent run. If a triggered action needs approval, the workflow waits
for the approval callback and resumes with the same event context. Only a bounded, redacted summary
is persisted and shown to the model; raw provider payloads are not stored by default.

### Daytona persistence

When `DAYTONA_API_KEY` is configured, Chusky keeps a per-user Daytona workspace and stores its
provider ID in the durable Redis store under the existing `chuck:*` persistence contract. On a
later request, Chusky reconnects to that workspace, refreshes its state, recovers it when Daytona
reports a recoverable error, and starts it again after an idle pause or stop. The workspace's
filesystem is retained by Daytona across those lifecycle states; a provider-side deletion or
wall-clock TTL is permanent and causes Chusky to require a new workspace.

Daytona also provides three coding surfaces. `CHUCK_DAYTONA_BROWSER` controls a browser in the
Daytona desktop through the official Computer Use API (navigation, accessibility snapshots,
screenshots, clicks, typing, key presses, and scrolling). It is desktop/browser control rather
than a DOM selector API, so Chusky verifies results after interactions. The selected snapshot must
include a browser, and internet access remains subject to Daytona network policy. `CHUCK_DAYTONA_PTY`
creates durable interactive terminal sessions for shells, dev servers, and test watchers; session
IDs are retained in the Redis-backed workspace record and can be reused with `write`, `read`,
`resize`, `status`, and `kill`. `CHUCK_DAYTONA_GIT` uses Daytona's official Git API for clone,
status, branches, checkout, pull, add, commit, and push. Local operations stay private; push is
approval-gated. Pull requests, CI checks, reviews, and deployments use verified GitHub/Composio
tools after local checks pass. Changing `DAYTONA_SNAPSHOT` does not change an existing workspace.

### Artifact Studio

`CHUCK_ARTIFACT` gives Chusky a durable, user-owned deliverable registry backed by Daytona and
Redis metadata. Chusky can create Markdown reports and HTML websites directly, register verified
files generated in Daytona (DOCX, PDF, PPTX, XLSX, images, and videos), list or retrieve prior
artifacts, delete registry entries, and package verified workspace files into ZIP archives.
Registered artifacts are downloaded from Daytona only after metadata validation and delivered to
Telegram as documents. Large binary contents are never written into conversation history. Binary
formats must be generated and checked in Daytona before registration; an artifact record is not
created from a text claim alone.

Chusky also accepts these requests naturally, without slash commands:

```text
Generate an image of a moonlit mountain lake.
Make a short video of a red panda surfing.
Enable a trigger whenever I receive a new GitHub issue.
```

Natural-language image and trigger requests are exposed to the model as Chusky tools. Video requests are submitted to the Upstash Workflow endpoint and delivered to Telegram when generation completes.

### Slack and WhatsApp channels

The channel gateway keeps the internal account identity (`account_<telegram-user-id>`) separate from provider IDs. A Slack, WhatsApp, or Sendblue user is never trusted by display name alone: link it from the owning Telegram account with `/channel link <provider>`. Slack OAuth links the installer’s verified Slack user; WhatsApp and Sendblue use the one-time code with `/link <code>`. Unlinked messages receive instructions only and never enter an account’s history, memory, tasks, or approvals.

Enable the adapters only after their public HTTPS webhook endpoints are reachable. Slack uses `/slack/events`, `/slack/interactions`, `/slack/install`, and `/slack/oauth/callback`; WhatsApp Cloud API uses `GET/POST /whatsapp/webhook`. Requests are signature-checked against the raw body, stale Slack requests are rejected, duplicate provider events are claimed in Redis, and Slack events are acknowledged before agent work begins. Provider replies are written to the durable outbox with a stable idempotency key and a reclaimable delivery lease. WhatsApp also supports explicit approved-template delivery through the outbound contract: set `template.name`, `template.languageCode`, and optional Meta `components`; the adapter sends `type: "template"`. Normal replies remain text messages with WhatsApp formatting, and templates are never selected implicitly.

Slack setup requires an app Signing Secret, `chat:write`, Event Subscriptions for direct messages and app mentions, Interactivity enabled at `/slack/interactions`, and OAuth Redirect URL matching `SLACK_REDIRECT_URI`. WhatsApp setup requires a Cloud API access token, phone number ID, verify token, and app secret. Keep all tokens in the deployment secret store; never commit `.env`.

### Sendblue iMessage channel

Sendblue connects Chusky to an iMessage-capable Sendblue line. It uses a verified inbound webhook and a durable Upstash Workflow so the provider request can be acknowledged quickly while agent work continues safely after retries or process restarts.

Required deployment variables:

```text
SENDBLUE_ENABLED=true
SENDBLUE_API_KEY=<Sendblue API key ID>
SENDBLUE_API_SECRET=<Sendblue API secret>
SENDBLUE_NUMBER=<your Sendblue iMessage number in E.164 format>
SENDBLUE_WEBHOOK_SECRET=<random webhook secret>
SENDBLUE_FACETIME_ENABLED=false
SENDBLUE_FACETIME_NUMBER=<Sendblue-purchased FaceTime-enabled line>
FACETIME_MEDIA_BRIDGE_URL=<HTTPS URL of your server-side Agora media bridge>
FACETIME_MEDIA_BRIDGE_SECRET=<shared bridge bearer secret>
WEBHOOK_URL=https://your-domain.example
REDIS_URL=<durable Redis URL>
QSTASH_TOKEN=<Upstash QStash token>
```

Configure the Sendblue `receive` webhook as `https://your-domain.example/sendblue/webhook`. From the owning Telegram account, run `/channel link sendblue`, then send the generated six-digit code from iMessage using `/link <code>`. Confirm with `/channel list` and send a normal message.

#### Link an iMessage group

First link the owner's private Sendblue identity. Then create a group authorization code from Telegram:

```text
/channel link sendblue-group
```

Send the generated six-digit code inside the iMessage group from that same linked Sendblue number:

```text
/link-group <code>
```

The group receives a confirmation and uses its own shared conversation history. By default, everyone in the group can use Chusky; private Telegram, web, direct-iMessage history, and account-only memory remain unavailable to the group. The linked owner can manage access from inside the group:

```text
/group-access owner   # only the linked owner can use Chusky
/group-access all     # allow all group participants (default)
/unlink-group         # remove Chusky from this group
```

Only the linked owner can activate, change access for, or unlink the group. Group linking requires the Sendblue webhook, Redis, QStash, and HTTPS webhook-mode deployment described above.

The adapter verifies timestamped HMAC signatures when present and supports the legacy signing-secret header for compatibility. It claims provider event IDs before workflow enqueue, stores only bounded event data, hydrates permitted media, and sends replies through the durable outbox.

#### Outbound FaceTime voice calls

Chusky can start an **outbound** FaceTime call only when `SENDBLUE_FACETIME_ENABLED=true`, the sending line is purchased and FaceTime-enabled by Sendblue, and an HTTPS media bridge is configured. Sendblue's `POST /facetime/start-call` returns short-lived Agora credentials; Chusky passes them directly to the bridge, which must be a server-side Agora participant that streams remote audio to STT and sends TTS audio back. Chusky persists only call metadata and bridge session IDs—never Agora tokens or media. The `CHUCK_START_FACETIME_CALL` tool is approval-gated. Sendblue does not provide an inbound-call webhook, so automatic answering of incoming FaceTime calls is not supported.

The bridge implementation lives in [`voice-bridge/`](voice-bridge/README.md). It uses Agora's Python Server SDK to receive and publish 16 kHz PCM, Deepgram for live transcription and synthesis, and the private `/internal/facetime/turn` route to reuse the caller's Chusky memory. Configure `DEEPGRAM_API_KEY` and `CHUSKY_VOICE_TURN_URL=http://127.0.0.1:3003/internal/facetime/turn` in the bridge process, then proxy `voice.selithub.shop` to its loopback port `3004`. Voice turns allow only read-only tools; external actions remain in Telegram where approvals are visible.

#### Outbound Twilio phone calls

Twilio phone calls are a separate approval-gated transport; they do not replace
Sendblue FaceTime. Verify `TWILIO_CALLER_ID` in Twilio, then configure
`TWILIO_VOICE_ENABLED=true`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_WEBHOOK_BASE_URL=https://chusky.selithub.shop`, and
`TWILIO_MEDIA_STREAM_URL=wss://voice.selithub.shop/twilio/stream`. Chusky
validates signed TwiML and status callbacks; the bridge uses Twilio's
bidirectional Media Streams with Deepgram and stores only safe call metadata.
For inbound calls, purchase a Twilio voice number and configure its incoming
Voice URL as `https://chusky.selithub.shop/twilio/inbound` (POST). Set
`TWILIO_INBOUND_ENABLED=true`, `TWILIO_INBOUND_OWNER_USER_ID` to the owner’s
Telegram numeric ID, and `TWILIO_INBOUND_ALLOWED_CALLERS` to a comma-separated
E.164 allowlist. Unknown callers are rejected before they can access private
memory or the agent.

The voice bridge validates Twilio's WebSocket signature and a short-lived
server-issued stream ticket. It uses Deepgram Flux conversational STT turn
events plus streaming Flux TTS in Twilio-compatible 8 kHz μ-law. An
`EagerEndOfTurn` begins a cancellable read-only draft, `TurnResumed` cancels
it, and only `EndOfTurn` is committed to history. Caller speech interrupts TTS
and clears Twilio's buffered playback. Configure the same `TWILIO_AUTH_TOKEN`
and `TWILIO_MEDIA_STREAM_URL` inside
`voice-bridge/.env`; see [`voice-bridge/README.md`](voice-bridge/README.md)
for latency tuning and Nginx WebSocket settings.

Sendblue `content` is plain text, not rendered Markdown. Chusky converts common Markdown at the provider boundary: emphasis markers are removed, bullets become `•`, headings become uppercase, and links become `label: URL`. Typing indicators are sent through `POST /api/send-typing-indicator` before linked one-to-one agent work and stopped after delivery. Verified one-to-one inbound messages are marked read through `POST /api/mark-read`; this is best-effort and never blocks the reply. Generated images and supported audio/video artifacts are stored in R2 and sent using short-lived HTTPS URLs when R2 is configured. A linked user can reply to an iMessage and send `/react love`, `/react like`, `/react dislike`, `/react laugh`, `/react emphasize`, or `/react question` to send a tapback to the replied message. Reactions are private-chat only. Sendblue status callbacks are sent to `/sendblue/status` and update the durable outbox receipt. The Sendblue dashboard's “Typing Indicators” webhook section is only needed if Chusky later needs to receive user-typing events.

### Channel support and operating model

| Channel | Current status | Conversation behavior |
|---|---|---|
| Telegram | Active | Primary bot transport; private history is retained in the account session |
| CLI | Active | Authenticated client of the deployed service; shares the user's private account session |
| Slack | Implemented | DMs use private account history; channel threads are shared-scope conversations |
| WhatsApp | Implemented | Linked private chats use the account session; proactive notifications require explicit opt-in |
| Sendblue | Implemented | Linked private iMessages use the account session; groups use shared scope; replies use the durable outbox |
| SMS | Boundary only | Requires a provider sender, webhook route, signature scheme, and deployment wiring |
| Voice | Boundary only | Requires a telephony/STT/TTS provider and deployment wiring |

To connect Slack, WhatsApp, or Sendblue, first run `/channel link <provider>` in the owning Telegram account. Complete the provider OAuth or send the one-time code from the external channel. Unlinked messages are rejected before they reach Chusky’s history, memory, tasks, or approvals. Sendblue requires `SENDBLUE_ENABLED`, API credentials, an iMessage-capable line, a `receive` webhook at `/sendblue/webhook`, Redis, QStash, and an HTTPS `WEBHOOK_URL`. Use `/channel list` to inspect links and `/channel notify <provider> on` only when the user wants proactive delivery.

In webhook mode, provider routes must be publicly reachable over HTTPS. Slack uses `/slack/events` and `/slack/interactions`; WhatsApp Cloud API uses `GET` and `POST /whatsapp/webhook`. Both routes verify the raw request signature, reject invalid requests with a non-2xx status, acknowledge provider webhooks quickly, and dispatch work asynchronously. Duplicate events are claimed in Redis, and every outbound reply is persisted in the Redis outbox before provider delivery.

The channel gateway is intentionally provider-neutral. It resolves provider identity to `account_<telegram-user-id>`, applies private/shared conversation scope, obtains the distributed account lock, runs the shared agent handler, and recovers queued outbound messages after a process restart. Keep provider parsing, signature verification, and formatting inside `src/channels/`; do not add provider payload parsing to `agent.ts` or `handlers.ts`.

### Current product gaps

The core agent and Sendblue conversation loop are operational. Remaining product work is concentrated in production operations and channel breadth:

- Dashboard operations pages now expose provider readiness, channel status, runtime failure counters, and delivery health through the authenticated `/v1/ops/health` endpoint.
- The CLI doctor now prints the same provider checks and runtime failure summary; Redis is fail-closed in production and webhook mode.
- Add Sendblue App Cards for interactive actions where a plain URL is not sufficient.
- Add SMS and Voice provider implementations; their current contracts are intentionally provider-neutral boundaries.
- Expand end-to-end deployment tests for Redis outages, provider retries, duplicate webhooks, concurrent messages, and long-running tool calls.

Treat this list as a roadmap, not as a claim that these capabilities are already complete.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | From @BotFather |
| `OPENROUTER_API_KEY` | ✅ | — | From openrouter.ai/keys |
| `COMPOSIO_API_KEY` | ✅ | — | From app.composio.dev |
| `WEBHOOK_URL` | prod | — | Public URL (blank = polling) |
| `DASHBOARD_URL` | dashboard | — | Public Next.js dashboard URL; `/dashboard` opens its `/app` route |
| `WEBHOOK_SECRET` | — | — | Secures Telegram webhook |
| `DEFAULT_MODEL` | — | `minimax/minimax-m3:free` | Any OpenRouter model ID |
| `TRANSCRIPTION_MODEL` | — | `openai/gpt-transcribe` | OpenRouter speech-to-text model |
| `TTS_MODEL` | voice replies | `deepgram/flux-tts:free` | OpenRouter text-to-speech model |
| `TTS_VOICE` | — | `flux-kit-en` | Voice ID accepted by the selected TTS model |
| `QSTASH_TOKEN` | reminders/jobs/triggers | — | Upstash QStash token |
| `QSTASH_URL` | QStash client | `https://qstash-us-east-1.upstash.io` | Regional Upstash QStash API URL |
| `REMINDER_WORKFLOW_URL` | reminders | — | Public `.../workflows/reminder` URL |
| `JOB_WORKFLOW_URL` | recurring jobs | — | Public `.../workflows/job` URL |
| `TRIGGER_WORKFLOW_URL` | Composio triggers | — | Public `.../workflows/trigger-event` URL; defaults from `WEBHOOK_URL` |
| `SYSTEM_PROMPT` | — | Chusky's default | Agent personality |
| `ENABLE_MANAGE_CONNECTIONS` | — | `true` | OAuth link tool |
| `COMPOSIO_CALLBACK_URL` | — | — | Post-connect redirect URL |
| `ENABLE_SANDBOX` | — | `true` | Bash + workbench tools |
| `SANDBOX_SIZE` | — | `standard` | `standard`/`medium`/`large`/`xlarge` |
| `DAYTONA_API_KEY` | Daytona | — | Enables an isolated per-user Daytona workspace |
| `DAYTONA_API_URL` | — | `https://app.daytona.io/api` | Daytona API endpoint |
| `DAYTONA_TARGET` | — | provider default | Optional Daytona execution target |
| `DAYTONA_SNAPSHOT` | — | provider default | Optional reusable snapshot |
| `DAYTONA_NETWORK_BLOCK_ALL` | — | `true` | Blocks outbound sandbox network by default; set false only deliberately |
| `DAYTONA_DOMAIN_ALLOW_LIST` | — | — | Comma-separated domains for a restricted browser/network allowlist on new workspaces |
| `DAYTONA_AUTO_PAUSE_INTERVAL` | — | `0` | Pause interval in minutes; use only with a pausable Daytona target such as `linux-vm` |
| `MAX_TOOL_ROUNDS` | — | `10` | Max agentic loop iterations |
| `RATE_LIMIT` | — | `10` | Messages per window |
| `RATE_WINDOW_SECONDS` | — | `60` | Rate window |
| `ALLOWED_USERS` | — | (all) | Telegram user IDs allowlist |
| `MAX_HISTORY` | — | `20` | Conversation turns to keep |
| `REDIS_URL` | — | (memory) | Redis for persistence |
| `SESSION_TTL` | — | `2592000` | Redis TTL (30 days) |
| `BETTER_AUTH_DATABASE_URL` | Neon | — | Production Better Auth PostgreSQL connection string; required when `NODE_ENV=production` and auth is enabled |
| `BETTER_AUTH_MIGRATION_DATABASE_URL` | Neon | — | Direct PostgreSQL connection used only by `npm run auth:migrate` for Better Auth schema migrations |
| `BETTER_AUTH_DATABASE` | — | `./data/better-auth.sqlite` | Local-development Better Auth SQLite fallback only |
| `PORT` | — | `8080` | HTTP port |
| `LOG_LEVEL` | — | `info` | trace/debug/info/warn/error |
| `SLACK_ENABLED` | — | `false` | Enable the verified Slack adapter |
| `SLACK_SIGNING_SECRET` | Slack | — | Slack app Signing Secret |
| `SLACK_BOT_TOKEN` | — | — | Optional single-workspace token; OAuth installations are preferred |
| `SLACK_CLIENT_ID` | Slack OAuth | — | Slack app client ID |
| `SLACK_CLIENT_SECRET` | Slack OAuth | — | Slack app client secret |
| `SLACK_REDIRECT_URI` | Slack OAuth | — | Public `/slack/oauth/callback` URL |
| `WHATSAPP_ENABLED` | — | `false` | Enable WhatsApp Cloud API adapter |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp | — | Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp | — | Sending phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | WhatsApp | — | Webhook verification token |
| `WHATSAPP_APP_SECRET` | WhatsApp | — | Meta app secret for `X-Hub-Signature-256` |
| `WHATSAPP_GRAPH_VERSION` | — | `v23.0` | Graph API version |
| `SENDBLUE_ENABLED` | — | `false` | Enable the Sendblue iMessage adapter |
| `SENDBLUE_API_KEY` | Sendblue | — | Sendblue API key ID |
| `SENDBLUE_API_SECRET` | Sendblue | — | Sendblue API secret |
| `SENDBLUE_NUMBER` | Sendblue | — | Sending iMessage-capable number in E.164 format |
| `SENDBLUE_WEBHOOK_SECRET` | Sendblue | — | Secret used to verify Sendblue receive webhooks |
| `SENDBLUE_WORKFLOW_URL` | — | derived | Optional public `/workflows/sendblue-event` URL override |
| `CHUSKY_PROJECT_KEY` | — | — | Optional private Oracle root/bootstrap key for the self-hosted Developer API; enables `/v1` and provisions scoped project keys |

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
├── channels/     Provider-neutral gateway, identity, scopes, outbox, formatters, and adapters
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
