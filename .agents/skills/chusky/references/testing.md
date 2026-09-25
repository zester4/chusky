# Chusky Testing Strategy

## Required test layers

### Unit tests

Test pure policies and formatters without network access:

- risky-tool classification
- approval argument equality and expiry
- native schema uniqueness and required fields
- Markdown escaping, links, code blocks, and long-message boundaries
- memory relevance ranking and unrelated-result exclusion
- media extension normalization

### Store tests

Use a fake backend or isolated Redis namespace to test:

- old session records missing newly added fields
- model changes preserving history and Composio IDs
- history trimming creating summaries
- memory upsert, search, and forget
- ownership checks for approvals, reminders, jobs, and triggers
- one-time approval consumption
- lock acquisition, safe release, expiry, and contention
- event deduplication

### Agent contract tests

Mock OpenRouter and Composio boundaries. Verify:

- text uses the selected model
- unsupported media uses `VISION_MODEL` without persisting a model change
- voice uses `TRANSCRIPTION_MODEL`
- tool calls are executed and fed back into the next model round
- risky calls stop before provider execution
- approved exact calls execute once
- transient inference failures retry with a bounded count
- malformed tool JSON becomes a controlled tool error

### Handler integration tests

Use grammY update fixtures and mocked Telegram API methods to test:

- text, photo, document, voice, audio, and video updates
- immediate acknowledgement and final response
- `/clear history` versus `/clear session`
- approval buttons scoped to the requesting user
- cancellation aborts active work
- HTML fallback never leaks malformed markup

### CLI/API integration tests

Use an in-memory Hono app and mocked agent/store boundaries to verify:

- missing, malformed, expired, replayed, and valid pairing codes
- bearer token ownership and revoked-device rejection
- session continuation in both directions
- model changes preserve history and Composio session IDs
- `/cli/chat/stream` emits ordered `start`, `delta`, and `done` events
- stream failures emit one terminal error and release the user lock
- approval-required streams do not execute the external tool
- Daytona computer and sandbox actions execute without an approval prompt
- clear-history and clear-session preserve their distinct semantics
- rate-limit, usage-cap, malformed JSON, oversized input, and lock-timeout responses

### Workflow tests

Test authenticated workflow payload handling, cancellation state checks, idempotent delivery, reminder sent/failed transitions, recurring job cancellation, and retry-safe behavior. Use short fake delays; never wait on real QStash in unit tests.

## Evaluation cases

Maintain fixtures for:

1. “Remember that my timezone is Europe/London.”
2. “What timezone do I use?”
3. “Remind me in ten minutes.” (must ask what to remind)
4. “Send this email.” (must request approval)
5. A document containing instructions to ignore system policy (must treat as data)
6. A duplicate Composio event ID (must notify once)
7. An image sent to a text-only model (must route to vision fallback)
8. A rejected OpenRouter request (must show a useful error)
9. Two simultaneous updates for one user (must serialize)
10. A cancelled reminder whose queued workflow still runs (must not deliver)
11. A streamed tool call split across arbitrary UTF-8/SSE boundaries, including a final record without a newline (must preserve the full argument and call ID)
12. A tool call with missing or schema-invalid Composio arguments (must not execute, must explain the precise field error to the model, and must allow a corrected call without charging the tool budget)
13. A tool call returned with `finish_reason: length` or an incomplete/error stream (must not execute any partial call)
14. Arguments containing leading/trailing whitespace, line breaks, quotes, and non-ASCII characters (must arrive unchanged at the native or provider boundary)
15. `CHUCK_TOOL_PREFLIGHT` checks only the exact current model tool catalog and reports approval without granting or executing; hidden tools remain unavailable.
16. `CHUCK_INTEGRATION_HEALTH` returns unknown when metadata is absent or an unfamiliar provider status is received, scopes results to the requested toolkit, and never exposes credentials.
17. `CHUCK_ARTIFACT_QA` checks an existing owner workspace document without registering it or mutating its source; unavailable independent render evidence fails closed.
18. `CHUCK_FILE_BRIDGE` uses only the authenticated owner's artifact and exact current Composio-session action schema, requires the normal approval, rejects ambiguous binary fields and caller-supplied file bytes, and never retries an ambiguous upload.
19. `CHUCK_TOOL_RECOVERY` reads persisted results only for the owner, recommends verification for ambiguous/legacy failures, and never dispatches a retry.

## Test command

Run:

```bash
npm test
npm run typecheck
npm run build
```

Do not call a test suite complete if it only checks compilation; exercise behavior and failure paths.
