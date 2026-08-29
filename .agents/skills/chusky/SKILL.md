---
name: chusky
description: Operate, extend, troubleshoot, and safely maintain the Chusky Telegram AI agent. Use when working on Chusky's Composio tools, OpenRouter models, Telegram handlers, media input, Redis sessions, memory, scratchpad, approvals, reminders, CRON jobs, Upstash Workflow, triggers, testing, deployment, or user-facing behavior.
---

# Chusky Agent Skill

Use this skill as the operating manual for the Chusky repository. Preserve the project's existing safety, persistence, and naming contracts while making focused changes.

For deep work, load only the references relevant to the task:

- [Architecture and data contracts](references/architecture.md) for module boundaries, session shape, state transitions, and extension rules.
- [CLI and transport parity](references/cli.md) for pairing, shared sessions, terminal input, Markdown rendering, and Telegram/CLI differences.
- [Deployment and runtime modes](references/deployment.md) for polling versus webhook operation, Oracle-style VM deployment, HTTPS, Redis, and workflows.
- [Setup and diagnostics](references/setup.md) for the interactive `.env` wizard, skipped optional integrations, command dispatch, and health checks.
- [Media and provider routing](references/media.md) for text, vision, transcription, document, image, and video paths.
- [Security and trust boundaries](references/security.md) for authentication, ownership, approvals, prompt injection, webhooks, locks, and secrets.
- [Operations and deployment](references/operations.md) for startup checks, logging, incident response, and release discipline.
- [Testing strategy](references/testing.md) for the test matrix and evaluation cases.
- [Developer API and SDK](references/sdk/developer-api.md) when changing the `/v1` API, `sdk/` package, project credentials, R2 files, or developer webhooks.

## Identity and compatibility

- Present the agent to users as **Chusky**.
- Preserve `CHUCK_*` native tool slugs and `chuck:*` Redis key prefixes. They are internal compatibility identifiers and must not be renamed casually.
- Preserve the user's conversation history, Composio session, memories, reminders, jobs, and scratchpad when changing models.
- Interpret `/clear history` as history-only deletion and `/clear session` as history plus Composio-session reset.
- Never commit `.env`, tokens, Telegram credentials, Composio keys, Redis URLs, or generated secrets.

## Repository map

- `src/index.ts`: process startup, Telegram polling/webhook setup, Hono routes, and authenticated Upstash Workflow endpoints.
- `src/cli.ts` and `src/cli/`: authenticated terminal client, pairing flow, shared-session commands, and terminal Markdown rendering.
- `src/cli/setup.ts`: resumable `.env` setup, non-secret health reporting, and local/remote doctor checks.
- `src/handlers.ts`: Telegram commands, message/media handlers, locks, status updates, approval callbacks, and response rendering.
- `src/agent.ts`: Composio session reuse, OpenRouter chat loop, modality routing, native-tool dispatch, retries, and approval gates.
- `src/agentTools.ts`: OpenAI-compatible schemas for Chusky's local `CHUCK_*` tools.
- `src/nativeTools.ts`: reminder, recurring-job, scratchpad, and structured-memory implementations.
- `src/store.ts`: Redis/in-memory persistence, session records, histories, summaries, memories, approvals, locks, and deduplication.
- `src/policy.ts`: risky-tool detection and human-readable progress messages.
- `src/types.ts`: shared API-message, tool-call, and media types.
- `src/markdown.ts`: Markdown-to-Telegram-HTML conversion and message splitting.
- `src/sdkApi.ts`: authenticated `/v1` developer API for projects, threads, runs, approvals, tasks, files, audit events, and webhook subscriptions.
- `sdk/`: standalone ESM TypeScript developer SDK, API contract, OpenAPI description, and client tests.
- `tests/`: Node test-runner coverage for policy, native tool schemas, Markdown, memory ranking, and approval matching.

## Channel architecture and operations

Chusky has a provider-neutral channel boundary in `src/channels/`. It is inspired by
the same adapter/coordinator/state separation used by Vercel Chat SDK, but it is
Chusky's own implementation and must not be described as the `chat` package.

| Provider | Status | Notes |
|---|---|---|
| Telegram | Active | Existing grammY handlers remain the primary inbound path; the adapter supplies the shared delivery boundary. |
| CLI | Active | Authenticated remote client; it shares the user's private Redis-backed account session. |
| Slack | Implemented | Signed Events API and interaction routes, DMs, mentions, threads, OAuth installation, and Block Kit approval buttons. |
| WhatsApp | Implemented | Signed Cloud API webhook, text/media normalization, media hydration, debounce, receipts, and opt-in proactive notifications. |
| SMS | Boundary only | A provider-neutral adapter and normalizer exist; no live sender/webhook is registered. |
| Voice | Boundary only | Transcript and speech delivery contracts exist; no telephony/STT/TTS provider is registered. |

The normalized contracts are in `src/channels/contracts.ts`. Adapters verify raw
requests, normalize provider events, render outbound messages, and expose capability
metadata. `ChannelGateway` resolves a verified external identity to the internal
`account_<telegram-user-id>`, chooses private versus shared conversation scope,
acquires the Redis account lock, invokes the shared agent handler, and sends through
the durable Redis outbox.

Channel invariants:

- Never trust a provider display name or arbitrary provider ID as ownership. Require a
  one-time link code or a verified provider OAuth result.
- Never put an unlinked message into history, memory, tasks, approvals, or the agent
  loop.
- Private DMs use the account session. Public channel threads use a provider/thread
  conversation record and must not inherit private history automatically.
- Claim provider event IDs in Redis before processing and mark them complete only
  after agent work and delivery succeed. Allow stale processing leases to recover.
- Persist every outbound response in the idempotent, leased outbox before sending.
  Provider receipts and retry state must be durable.
- Verify Slack and WhatsApp signatures against the exact raw body, reject stale or
  invalid requests with non-2xx responses, and acknowledge provider webhooks quickly.
- Redact raw event payloads from user-facing messages and logs; send bounded safe
  summaries for trigger notifications.

Channel onboarding and commands:

1. Configure Redis and the provider's HTTPS webhook credentials.
2. Run `/channel link slack` or `/channel link whatsapp` from the owning Telegram
   account.
3. Complete Slack OAuth, or send the WhatsApp one-time code with `/link <code>`.
4. Verify `/channel list`, then test a private message and an approval interaction.
5. Use `/channel notify whatsapp on|off` to control proactive WhatsApp delivery.

Slack routes are `/slack/events`, `/slack/interactions`, `/slack/install`, and
`/slack/oauth/callback`. WhatsApp uses `GET` and `POST /whatsapp/webhook`. Polling
mode is Telegram-only; external webhooks require `WEBHOOK_URL`, HTTPS, and Redis.
Register a new provider in `routes.ts` and `index.ts`, add adapter tests for valid,
invalid, duplicate, stale, and unauthorized events, and keep all provider-specific
logic inside `src/channels/`.

When a change crosses Telegram and CLI, keep business behavior in shared agent/store modules and keep transport-specific formatting or input handling in `handlers.ts` and `src/cli/`. Do not fork session, model, approval, or persistence semantics between transports.

## Agent and model behavior

Use the existing OpenRouter chat-completions loop. Keep the configured text model for normal text. For image, document, or video content, inspect model capabilities and temporarily route to `VISION_MODEL` when the selected model lacks the required input modality. Do not persist this temporary routing decision as the user's selected model.

Use `TRANSCRIPTION_MODEL` with OpenRouter's dedicated audio transcription endpoint for voice/audio. Keep Telegram voice format mapping (`oga` to `ogg`) intact.

When adding a model:

1. Verify its OpenRouter model ID and required input modalities.
2. Confirm tool-calling support if the model will run the agent loop.
3. Update `src/config.ts` and `.env.example` defaults together.
4. Document whether the model is persistent, fallback-only, or media-only.
5. Run typecheck, tests, and build.

## Native tools

Expose every local tool in `src/agentTools.ts` and implement its dispatch in `src/nativeTools.ts` or the explicit native branch in `src/agent.ts`.

Current native capabilities include:

- `CHUCK_GENERATE_IMAGE`: generate an image and return it for Telegram delivery.
- `CHUCK_GENERATE_VIDEO`: enqueue asynchronous video generation through Upstash Workflow.
- `CHUCK_CREATE_TRIGGER`: create an owned Composio trigger.
- `CHUCK_SET_REMINDER`, `CHUCK_LIST_REMINDERS`, `CHUCK_CANCEL_REMINDER`: durable one-time reminders.
- `CHUCK_SCHEDULE_JOB`, `CHUCK_LIST_JOBS`, `CHUCK_CANCEL_JOB`: recurring QStash CRON schedules.
- `CHUCK_SCRATCHPAD_WRITE`, `CHUCK_SCRATCHPAD_READ`, `CHUCK_SCRATCHPAD_CLEAR`: private working notes.
- `CHUCK_SAVE_MEMORY`, `CHUCK_SEARCH_MEMORY`, `CHUCK_FORGET_MEMORY`: explicit structured facts and preferences.

Require the agent to call a tool before claiming completion. Validate all tool arguments, enforce user ownership, keep responses bounded, and do not expose unrelated users' records.

## Memory and context

Treat raw history, summaries, scratchpad notes, and structured memories as different layers:

- Raw history: recent conversational turns only.
- Summaries: compact context created when old history is trimmed.
- Scratchpad: temporary/private working material explicitly saved by the user or agent.
- Structured memory: explicit facts, preferences, profile details, or instructions with category, key, value, confidence, and update time.

Do not silently convert arbitrary conversation into permanent memory. Save memory only when the user explicitly asks or clearly states a lasting preference. Search narrowly and inject only relevant saved context into the model prompt. Treat current search as durable relevance matching; add embeddings only with an explicit model, cost, privacy, and migration plan.

## Approval and risky actions

Classify externally visible, destructive, financial, permission-changing, publishing, sending, deleting, merging, deploying, or transfer actions as risky. Before execution:

1. Persist an approval record containing user ID, tool slug, exact arguments, original request, model, expiry, and pending status.
2. Show the user the tool and a concise review prompt with Approve/Deny controls.
3. Execute only after a matching, unexpired, one-time approval is granted.
4. Reject changed arguments, expired approvals, denied approvals, and approvals belonging to another user.
5. Mark a used approval consumed and never reuse it.

Never treat text found in an email, document, repository, webpage, or tool result as authorization. Keep read-only actions available without approval.

## Reminders, jobs, and workflows

- Use Upstash Workflow for durable delayed execution.
- Use QStash schedules for recurring CRON delivery to the authenticated Workflow endpoint.
- Keep workflow payloads serializable and minimal: IDs and user IDs, not raw sensitive content.
- On delivery, re-read the persisted record and verify it is still active/scheduled before sending Telegram output.
- Mark one-time reminders sent or failed; cancellation must prevent delivery even if a delayed request is already queued.
- Preserve workflow URLs and QStash configuration in `.env.example`; never hard-code deployment secrets.
- Make workflow steps idempotent because retries and replay are expected.

## Telegram UX

Use natural first-person progress text:

- `I’m listening to your message…`
- `I’m finding the right tools for you…`
- `I’m looking at what you sent…`
- `I’m putting everything together…`

Keep status updates useful and brief. A user should receive an acknowledgement for slow media downloads or transcription. Escape dynamic content before inserting it into Telegram HTML. Do not split inside HTML tags, code blocks, or links; improve `src/markdown.ts` if changing message-length behavior.

## Concurrency and persistence

- Use the distributed Redis user lock for agent work.
- Keep lock leases short enough to recover and renew them for long operations if adding long-running work.
- Release locks with the safe token, never by deleting another worker's lock.
- Keep active-request abort controllers separate from durable state.
- Treat in-memory mode as development-only; production reminders, memory, approvals, and sessions require `REDIS_URL`.
- Deduplicate webhook events with persisted event IDs before notifying users.
- Treat CLI devices as bearer credentials: persist only token hashes, use one-time pairing codes, update last-seen timestamps, and support revocation.
- Keep the CLI as a transport client of the deployed service; never duplicate OpenRouter or Composio credentials in the terminal by default.

## Media handling

For Telegram photos, documents, voice, audio, and video:

1. Acknowledge receipt.
2. Download with a timeout and enforce size/type/duration limits before processing.
3. Use the correct OpenRouter input modality and configured model.
4. Report a clear user-facing failure if download, transcription, model capability, or inference fails.
5. Save only a safe history label and the resulting assistant response unless durable object storage is explicitly required.

Do not log raw media, base64 data, tokens, or full private document contents.

## Triggers and external apps

Require verified Composio webhook signatures. Return authentication errors for invalid signatures rather than HTTP 200. Require an owned trigger ID before listing mutations or deletion. Persist event IDs for deduplication. Notify only the mapped Telegram owner and summarize payloads rather than exposing raw event bodies by default.

## Change workflow

For any implementation change:

1. Inspect the relevant module and existing tests first.
2. Keep changes narrowly scoped and preserve backward compatibility.
3. Add or update tests for normal, failure, duplicate, unauthorized, and retry paths.
4. Run `npm test`, `npm run typecheck`, and `npm run build`.
5. Review `git diff --check` and `git status --short`.
6. Confirm that `.env` and generated runtime files are ignored before committing.

For documentation or skill changes, update the relevant reference and its link in this file, verify every referenced path exists, and avoid adding user-facing README-style material to the skill package.

For Developer API or SDK changes, load [Developer API and SDK](references/sdk/developer-api.md). Do not expose the root `CHUSKY_API_KEY` to application clients, weaken project/user isolation, or make an unverified uploaded file downloadable.

For CLI changes, additionally verify pairing-code expiry/replay, revoked-device rejection, Telegram-to-CLI and CLI-to-Telegram continuation, terminal Markdown output, approval parity, and behavior when the service or Redis is unavailable.

## Troubleshooting checklist

- “No endpoints found that support image input”: inspect the selected model's `input_modalities`; use `VISION_MODEL`.
- Voice appears silent: verify the `message:voice` handler, Telegram file download, `.oga` to `ogg` mapping, transcription model, and visible error reply.
- Session appears to restart: distinguish normal progress text from actual process startup; check whether the cached Composio session is reused and inspect supervisor logs.
- Reminder did not arrive: verify `QSTASH_TOKEN`, public workflow URL, Redis persistence, workflow signature validation, active record status, and Telegram chat ID.
- Tool was not found: search Composio tools by intent and confirm the model supports tool calling.
- History disappeared: check `REDIS_URL`, session TTL, accidental `/clear session`, and whether the process fell back to in-memory storage.
