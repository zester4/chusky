# Chusky CLI and Transport Parity

## Purpose

The CLI is a thin authenticated client of the deployed Chusky service. It is not a second agent, provider client, or local Composio session. Telegram and CLI identify the same numeric user and therefore read and write the same Redis-backed session.

## Pairing contract

1. The user runs `/cli link` in Telegram.
2. The service stores a short-lived, one-time pairing record owned by that Telegram user.
3. The terminal posts the code to `/cli/pair` with a device name.
4. The service consumes the code atomically and returns a bearer token once.
5. The CLI stores the token in the platform config directory; the server stores only its hash.
6. `/cli devices` lists active devices and `/cli revoke <name>` revokes a device.

Treat the token like a password. Never print it in logs, shell output, tests, or error messages. Reject unknown and revoked hashes before loading session data.

## API behavior

Authenticated routes currently include:

- `GET /cli/session` for bounded session context and active records.
- `GET /cli/models` for paginated model discovery.
- `POST /cli/model` for per-user model selection.
- `POST /cli/chat` for a complete response.
- `POST /cli/chat/stream` for newline-delimited `start`, `delta`, `done`, `approval_required`, or `error` events.
- `POST /cli/approve` for one-time approval decisions.
- `POST /cli/clear` with `history` or `session` scope.
- `GET /cli/apps` for paginated Composio app connection states.
- `POST /cli/connect` for an authenticated, short-lived app authorization URL.
- `GET /cli/tools?query=...` for bounded Composio tool discovery.
- `GET /cli/triggers` and `POST /cli/triggers` for owned trigger lifecycle operations.
- `GET /cli/channels`, `POST /cli/channels/link`, and `POST /cli/channels/notify` for linked-channel management.
- `POST /cli/voice` for the user's durable voice-reply preference.
- `GET /cli/usage` for the user's bounded usage summary.
- `GET /cli/dashboard` for the configured dashboard URL.
- Voice-enabled chat responses include a bounded base64 audio payload; the CLI writes it as an artifact rather than attempting platform-specific playback.

All mutating or agent routes must use the distributed user lock, rate limits, spend checks, and the same `runAgent()` path used by Telegram. Persist a completed turn only after the agent finishes successfully; do not append partial stream fragments as assistant history.

## Terminal UX rules

- Use raw mode only while a prompt, picker, or pager owns the terminal; always restore raw mode in `finally`.
- Preserve multiline paste using bracketed paste mode where supported.
- Keep Up/Down prompt history process-local unless an explicit secure history feature is added.
- `/model` must paginate server results; Up/Down and Tab navigate, Space/Enter select, and `n`/`p` change pages.
- Render final Markdown for the terminal after collection so code blocks, links, lists, and tables remain coherent.
- Use a pager for long output and support `q`, Space/Down, and `b`/Up.
- Never claim Telegram feature parity when the CLI cannot upload media or receive asynchronous Telegram-only workflow notifications.
- The CLI now exposes the same app, tool, trigger, channel, voice, usage, export, and dashboard controls as Telegram. `/attach` uploads supported media/documents, while generated images and files are written to the local CLI artifacts directory; Telegram-only delivery remains provider-specific.

## Compatibility rules

Model changes update only the selected model. They must preserve raw history, summaries, memories, scratchpad, reminders, jobs, approvals, Telegram mapping, and the Composio session ID. `/clear history` removes conversation history only; `/clear session` additionally invalidates the Composio session.

When adding a CLI feature, add API, client, UX, and integration tests. Test server unavailable, unauthorized, revoked, malformed, oversized, rate-limited, approval-required, and lock-contention paths.
