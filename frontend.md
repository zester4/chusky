# Chusky Frontend

## Overview

The frontend is a Next.js application in `chusky-web/`. It contains the public
Chusky marketing site and a product dashboard prototype for managing the Chusky
agent.

The frontend was pushed separately from the parent agent repository:

- Remote: `https://github.com/zester4/chusky-web.git`
- Branch: `codex/chusky-web`
- Commit: `dcf35df` (`Build Chusky product frontend`)

The parent `tg-agent` repository changes were not included in that push.

## Frontend integration contract

This document is the frontend agent's capability contract. Treat the backend
behavior below as implemented product behavior, not mock data. Every screen
must consume the authenticated Chusky API and must show loading, empty,
offline, error, retry, and success states. Never invent connected accounts,
messages, approvals, tasks, files, or channel status in the browser.

The browser must use the Better Auth session cookie and the first-party `/v1`
API. Never expose `CHUSKY_API_KEY`, `CHUSKY_PROJECT_KEY`, provider tokens,
Twilio credentials, Deepgram credentials, Composio secrets, Redis URLs, or R2
object keys to client-side code.

All data is account-scoped. Private conversations, memories, scratchpad notes,
approvals, files, and tasks must never appear in a shared channel or another
account's workspace. A group conversation has its own history and permissions.

## Implemented platform capabilities

### Authentication and workspace identity

- Better Auth supports sign-up, sign-in, sign-out, email verification,
  password recovery, password reset, protected dashboard sessions, and CSRF /
  trusted-origin checks.
- A web account can create a one-time Telegram link code from Settings and link
  itself to the Telegram workspace that owns Chusky. Codes are hashed,
  expiring, one-time, and cannot rebind an identity.
- The dashboard must clearly distinguish an unlinked web workspace from a
  linked Chusky workspace and never silently merge them.

### Chat, runs, and specialist agents

- The chat API supports persisted threads, streamed runs, assistant text,
  native-tool activity, Composio-tool activity, approvals, failures,
  cancellation, idempotency, usage, and resumable task state.
- The UI must show the specialist name when work is delegated, together with a
  short truncated objective and current state (`queued`, `running`, `blocked`,
  `awaiting approval`, `completed`, or `failed`).
- Mixed objectives are split into dependency-ordered specialist stages. Workers
  operate inside typed tool allowlists and can request an additional tool from
  Chusky; they cannot grant themselves access or guess a Composio slug.
- Durable delegation can pause and resume from the same checkpoint after a
  scoped tool decision. The UI must render the pause reason and resume state,
  not create a second duplicate run.
- Show bounded tool rounds, elapsed time, cost, cancellation, and retry state
  without exposing hidden prompts, secrets, or raw provider payloads.

### Channels and delivery

| Channel | Implemented behavior | Frontend requirements |
|---|---|---|
| Telegram | Primary inbound channel, commands, media, approvals, reminders, group context, and delivery | Show linked status, bot health, command help, and delivery state. |
| CLI | Authenticated device pairing, shared account session, streaming runs, files, artifacts, tasks, approvals, and revocation | Show devices, last-seen time, revoke action, and pairing instructions. |
| Slack | Signed Events API, DMs, mentions, threads, OAuth installation, and approval interactions | Provide connect, workspace identity, channel status, and disconnect/recovery states. |
| WhatsApp | Signed Cloud API webhook, text/media hydration, debounce, receipts, and opt-in proactive delivery | Provide connection status, phone/workspace identity, and proactive-delivery toggle. |
| Sendblue iMessage | Signed direct and group messages, media hydration, typing, reactions, durable receipts, channel linking, and separate group history | Provide private link and group-link status; show group scope and access mode. |
| Twilio SMS/MMS | Signed inbound SMS/MMS, outbound messages, media hydration, delivery callbacks, and Messaging Service/number configuration | Provide sender status, inbound readiness, delivery state, and safe media errors. |
| XChat | Encrypted DMs/groups, verified webhook, bot identity checks, `chat.received` and `chat.conversation.join` subscriptions, mentions, media, typing, reactions, and durable delivery | Provide webhook/setup readiness, bot identity, subscription state, encryption state, and trust/link instructions. |
| Twilio voice | Approval-gated outbound calls, allowlisted inbound calls, signed callbacks, live transcription/voice bridge, and safe call history | Provide destination validation, purpose, pending approval, call status, masked history, and failure state. |
| Sendblue FaceTime | Optional outbound-only transport through the private bridge | Label it optional and outbound-only; never imply inbound FaceTime answering. |

Channel pages must use verified identities and show whether a conversation is
private or shared. They must never use a provider display name as ownership.
Proactive delivery must have an explicit per-channel opt-in and a durable
delivery status.

### Connected applications and Composio

- The Apps area must represent multiple connected accounts for one toolkit,
  such as several Gmail accounts, rather than assuming one account per app.
- Show toolkit, account label, provider identity, connection health, scopes,
  last verified time, and disconnect/reconnect actions. Never display OAuth
  access or refresh tokens.
- Chusky can search the web and fetch URL content through the configured
  research tools. The supervisor can search for and inspect Composio tools,
  then execute verified connected actions.
- `COMPOSIO_SEARCH_TOOLS` is supervisor-only. Specialist workers receive only
  their scoped tools and must request missing capabilities from Chusky.
- Tool execution must show the provider/tool name, bounded arguments summary,
  progress, result/failure, and approval state. Do not expose raw tool payloads
  by default.

### Memory, history, and working state

These are separate UI resources and must not be collapsed into one “memory”
feed:

- Raw recent conversation history and bounded summaries.
- Structured, explicitly saved memories with category, key, value, confidence,
  scope, and expiry where applicable.
- Private scratchpad notes for temporary working material.
- Reminders, recurring jobs, durable tasks, approvals, locks, and audit events.

`/clear history` removes conversation history only. `/clear session` also resets
the Composio session. Neither should delete structured memories, scratchpad
notes, reminders, jobs, artifacts, or Daytona workspace mappings unless the
user explicitly uses the relevant delete action. Group history and private
history remain isolated.

### Automations and durable work

- One-time reminders and recurring jobs use durable workflow delivery and can
  be listed, cancelled, and inspected.
- A recurring job records its owner and originating channel. When a specialist
  schedules its own job, that specialist is invoked for the job; Chusky is not
  substituted as the worker. Chusky-owned jobs continue to invoke Chusky.
- Durable tasks support checkpoints, retries, blockers, pause/resume, and
  specialist ownership. The UI must render the task timeline and latest
  checkpoint without duplicating execution.
- Reminders should default to the channel where they were requested, including
  iMessage, WhatsApp, Telegram, XChat, or SMS when that channel is linked.

### Artifacts and media

The agent can create, register, list, download, delete, and package user-owned
artifacts. The dashboard must provide an Artifacts library with type, name,
status, created time, source workspace path, download, preview, and delete
actions.

Supported deliverables include websites, reports, PDF, DOCX, PPTX, XLSX,
images, videos, projects, and ZIP packages. Binary artifacts are generated in
Daytona, structurally validated, rendered, and only then registered and
delivered. A failed validation must never appear as a successful download.

The shared brand object supports company name, tagline, logo, header/footer,
letterhead, style presets (`executive`, `modern`, `bold`, `minimal`, `brand`),
font themes, and color palettes across PDF, DOCX, PPTX, and XLSX. The UI should
offer reusable brand profiles and design variants, including:

- PDF: top-right logo, letterhead, page numbers, tables, images, and charts.
- DOCX: real header/footer, top-right logo, headings, tables, images, and
  page breaks.
- PPTX: branded masters, cover/section layouts, logo on slides, charts, tables,
  images, readable overlays, notes, and slide numbers.
- XLSX: branded workbook headers, logo, tab colors, frozen headers, banded
  tables, fitted columns, formulas, and chart-ready data.

Images, documents, audio, and video uploaded through the dashboard must use
verified temporary R2 upload URLs. The browser sends file IDs to Chusky; it
does not send raw binary content through Redis or expose storage keys.

### Daytona workspaces, app building, and browser

Daytona is the only browser/computer backend currently in scope. Do not add
Browserbase, Firecrawl, or another browser provider to the product UI.

The workspace UI must support:

- Private sandbox lifecycle: create, inspect, status, pause, archive, and safe
  recovery of retained workspaces.
- Files: bounded text read/write, binary media writes, file listing, and safe
  workspace-relative paths.
- Execution: commands, durable PTY sessions, logs, errors, timeout state, and
  bounded output.
- Git: clone approved GitHub HTTPS repositories, status, branches, pull,
  branch, add, commit, and approval-gated push. Never put credentials in URLs.
- App projects: scaffold Vite React or Next.js, verify typecheck/lint/tests and
  production build, start a server, inspect logs, capture a visual preview,
  review evidence, stop, and hand off a release. Preview URLs must be signed,
  temporary, and shown with expiry.
- Browser/computer use: navigate HTTPS pages, inspect accessibility trees, find
  controls, focus/invoke/fill accessible controls, click/type/scroll/keyboard
  navigate, capture screenshots/regions, inspect windows/processes, and manage
  recordings. The UI must show when a browser action is running and retain
  only safe URL/state metadata.
- Visual QA: show captured preview screenshots and honest verification status;
  never claim an app or artifact was tested when the evidence is missing.

### Operations, security, and observability

The frontend must surface safe operational state from `/health` and the
authenticated operations endpoints: Redis persistence, QStash configuration,
provider readiness, enabled channels, workflow/provider/delivery/Redis failure
counters, latest incident, and XChat encryption/setup status. Do not show
secrets or raw logs containing user content.

Risky external actions (sending, deleting, publishing, financial, permission,
deployment, GitHub push, and phone calls) remain approval-gated according to
the backend policy. Read-only actions and private Daytona inspection tools may
run automatically. The browser must render the exact approval target and
decision state and must not alter arguments before approval.

## Required frontend surfaces

The dashboard should keep the current routes and add or complete these live
surfaces:

- **Overview:** health, recent activity, tasks, delivery failures, usage, and
  quick actions.
- **Chat:** streamed responses, specialist handoffs, tool progress, approvals,
  cancellation, attachments, generated files, preview links, and retry.
- **Conversations:** private/group scope, channel/provider, history, clear-history
  action, and safe conversation metadata.
- **Channels:** provider connection, link/unlink, private/group linking,
  proactive delivery, channel capabilities, and readiness diagnostics.
- **Apps:** multiple connected accounts per toolkit, scopes, health, and
  reconnect/disconnect.
- **Tasks / Reminders / Jobs:** ownership, timeline, checkpoint, recurrence,
  originating channel, specialist worker, pause/resume, cancel, and delivery.
- **Memory / Scratchpad:** separate search, create, edit, expire, and delete
  flows with scope labels.
- **Artifacts / Workspace:** artifact library, downloads, previews, Daytona
  files, app projects, logs, terminals, previews, browser screenshots, and Git
  state.
- **Approvals / Audit:** exact action, tool/provider, arguments summary,
  requester, expiry, decision, and immutable audit trail.
- **Calls:** safe phone destination form, purpose, approval, live status, and
  masked call history.
- **Developer API / Devices / Settings:** scoped credentials, webhooks, usage,
  device pairing/revocation, profile, linked Telegram workspace, and provider
  configuration status.

Each surface must have accessible keyboard navigation, responsive mobile
behavior, clear empty states, and browser tests for success, failure,
unauthorized, duplicate-submit, and retry behavior.

## What was completed

### Public website

The existing public pages remain available:

- `/` — landing page
- `/features` — feature overview
- `/how-it-works` — product flow
- `/developers` — developer information
- `/pricing` — pricing page
- `/start-creating` — call to action / signup entry
- `/sign-in` — sign-in entry page

### Product dashboard

The new authenticated-product-style shell and pages were added under `/app`.
The current implementation uses local demo data and client-side interactions so
the complete interface can be explored before the backend is connected.

- `/app` — dashboard overview, activity, quick actions, and system status
- `/app/chat` — chat workspace for interacting with Chusky
- `/app/conversations` — conversation list and conversation state
- `/app/approvals` — pending risky-action approvals with approve/deny controls
- `/app/apps` — connected applications and integrations
- `/app/tasks` — task list and task status
- `/app/reminders` — one-time reminders
- `/app/jobs` — recurring jobs and schedules
- `/app/memory` — saved memories and preferences
- `/app/scratchpad` — private temporary notes
- `/app/triggers` — external app triggers
- `/app/workspace` — workspace information and usage
- `/app/devices` — connected CLI/device sessions
- `/app/settings` — account and product settings

The app shell includes responsive navigation, a mobile menu, page headings,
status badges, cards, buttons, and a consistent Chusky visual system.

## Files added or changed

### New product routes

- `chusky-web/app/app/layout.tsx` — product-area layout and app shell wrapper
- `chusky-web/app/app/page.tsx` — dashboard route
- `chusky-web/app/app/[section]/page.tsx` — dynamic product-section route

### New product components

- `chusky-web/components/app/app-shell.tsx` — responsive sidebar, header,
  navigation, shared layout primitives, and status UI
- `chusky-web/components/app/app-pages.tsx` — dashboard and product-section
  page implementations, demo data, and local interactions

### Frontend configuration

- `chusky-web/package.json` — uses webpack explicitly for reliable local builds
- `chusky-web/pnpm-lock.yaml` — includes the Windows Lightning CSS native package

The public-site files and shared styling remain in the existing `chusky-web/app/`
and `chusky-web/components/` structure.

## How to run it locally

From PowerShell:

```powershell
cd C:\Users\mseyy\Downloads\tg-agent\chusky-web
pnpm install
pnpm dev -- -p 3010
```

Open [http://localhost:3010/app](http://localhost:3010/app).

If port 3000 is free, `pnpm dev` can be used and the dashboard will be at
`http://localhost:3000/app`.

## Verification completed

- Production build completed successfully with `pnpm run build`.
- Verified HTTP 200 responses for `/app`, `/app/chat`, `/app/approvals`, and
  `/app/settings`.
- Verified the frontend diff with `git diff --check`.
- The smooth-scroll warning from Next.js is informational and does not prevent
  the application from running.

## What is left

### Backend and authentication integration

- Add real authentication and protected dashboard access.
- Add a typed API client for the Chusky service.
- Connect the dashboard to the existing Redis-backed sessions, histories,
  memories, approvals, reminders, jobs, scratchpad, triggers, and device data.
- Connect the chat page to the shared Chusky agent/API flow and streaming or
  polling responses.
- Replace local approval actions with server-side approval records and the
  existing one-time, expiring approval rules.
- Add loading, empty, error, retry, optimistic-update, and unauthorized states
  for every data-driven page.

### Product functionality

- Implement create, edit, cancel, delete, and search actions for the relevant
  resources.
- Add real app connection and OAuth/linking flows for supported integrations.
- Add channel management for Telegram, Slack, WhatsApp, and future channel
  adapters while preserving Chusky account ownership and conversation scope.
- Add device pairing, token revocation, and last-seen status for CLI devices.
- Add account/profile management and persistent settings.

### Production readiness

- Define and document the frontend/backend API contract.
- Configure environment variables without committing secrets.
- Add frontend unit/component tests and end-to-end tests for authentication,
  chat, approvals, and CRUD flows.
- Run the complete repository checks, including `npm test`, typecheck, and the
  backend build, after API integration.
- Deploy the frontend and configure its production domain, HTTPS, CORS, and
  backend URL.
- Add observability, rate-limit handling, accessibility review, and responsive
  browser testing.

## Authentication integration

Better Auth is now wired between the Hono backend and the Next.js frontend.

Backend files:

- `src/auth.ts` — Better Auth configuration, SQLite database, Redis secondary
  storage, session policy, password policy, CSRF/origin protections, and startup
  migrations
- `src/authRoutes.ts` — `/api/auth/*` Hono route, CORS, and `/api/auth/ok`
- `src/auth-email.ts` — Resend verification and password-reset email delivery
- `src/config.ts` — auth enablement, trusted origins, and database settings
- `src/index.ts` — auth route registration in webhook and local polling modes

Frontend files:

- `chusky-web/lib/auth-client.ts` — Better Auth browser client
- `chusky-web/components/app/authenticated-app.tsx` — session gate for `/app`
- `chusky-web/components/app/app-shell.tsx` — sign-out action
- `chusky-web/components/landing/auth-pages.tsx` — real sign-in, sign-up,
  recovery, reset, and verification client calls
- `chusky-web/.env.example` — `NEXT_PUBLIC_AUTH_URL`

### Local configuration

Set these variables in the backend `.env`:

```env
BETTER_AUTH_ENABLED=true
BETTER_AUTH_SECRET=<a unique value with at least 32 characters>
BETTER_AUTH_URL=http://localhost:8080
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3010
BETTER_AUTH_DATABASE=./data/better-auth.sqlite
BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION=true
```

Set this in `chusky-web/.env.local`:

```env
NEXT_PUBLIC_AUTH_URL=http://localhost:8080
```

Start the backend and frontend separately, then visit `/sign-up`. In local
development, email delivery is accepted but logged as unconfigured unless
`RESEND_API_KEY` and `AUTH_EMAIL_FROM` are set. Production requires both values;
the server refuses to silently skip auth email delivery in production.

The root Better Auth API is intentionally opt-in. If
`BETTER_AUTH_ENABLED=false`, the existing Telegram polling behavior remains
unchanged and auth routes return no authenticated service behavior.

## Backend-connected pages

The first-party dashboard now uses the authenticated Chusky `/v1` API without
exposing `CHUSKY_API_KEY` in the browser:

- `chusky-web/lib/chusky-api.ts` — typed, credentialed client for threads,
  streamed runs, tasks, and usage; it handles NDJSON streaming, idempotency
  keys, API errors, and session cookies.
- `chusky-web/components/app/chat-page.tsx` — creates/loads a thread and sends
  prompts to `/v1/threads/:id/runs/stream`, rendering tool activity, approval
  requests, failures, cancellation, and streamed assistant text.
- `chusky-web/components/app/backend-pages.tsx` — live overview metrics,
  recent conversations, conversation listing, and task listing with loading,
  empty, offline, and retry states.
- `chusky-web/components/app/app-pages.tsx` — routes Overview, Chat,
  Conversations, and Tasks to the backend-connected page components.
- `src/sdkApi.ts` — accepts the Better Auth session for first-party web
  requests, maps the auth user to an isolated `web` project namespace, and
  continues to support project-key SDK clients.
- `src/index.ts` — mounts `/v1` when Better Auth is enabled in both local
  polling and hosted webhook modes.

The remaining dashboard sections (approvals, connected apps, reminders, jobs,
memory, scratchpad, triggers, workspace, devices, and settings) still need
dedicated frontend adapters for their corresponding private or future API
resources. The public `/v1` approval, files, webhook, and audit endpoints are
available in the backend contract but are not yet surfaced by the browser
client.
