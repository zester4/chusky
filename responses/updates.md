# Chusky early-response handoff

Updated: 2026-10-15

This document is the handoff for the next agent working on both the Chusky backend and the `chusky-web` frontend. It records what was changed, what production actually proved, what the user observed, and how to continue without confusing an early progress message with the main agent answer.

## Executive summary

Chusky now has a request-scoped opening response for interactive work. The opening is a short intent message sent while the real agent prepares context, skills, routing, memory, and tools. It is not the final answer and it must never claim that a tool ran or that private data was already inspected.

The Telegram path visibly delivers these early messages. The web chat did not visibly show the opening in the latest user test, even though Railway recorded the backend enqueueing it. Therefore there are two separate issues:

1. The fallback copy was too generic and could appear for conversational messages such as “well done.” This is fixed in the current local change.
2. The web path still needs a transport/frontend investigation. The backend request spends about 2.8 seconds in admission before the stream starts, and a server-side enqueue does not prove that the browser received and rendered the first NDJSON chunks.

The fallback correction is included in the commit pushed with this handoff. It does not yet add conversation memory to the opening path; keeping the fast path bounded and safe is intentional.

## What has been implemented

### Context summarization

- Added the production ScaleDown context summarization integration using `scaledown/summarize`.
- The purpose is to reduce oversized agent context before the main model call instead of allowing compaction to become an uncontrolled latency spike.
- This is separate from the early opening. The opening must remain small and must not wait for summarization.

### Durable run reliability

- Repaired durable SDK run projections and partial session reconciliation.
- Serialized concurrent opening/progress snapshot writes to avoid races.
- The early opening is sent before its durable snapshot write. The write is queued asynchronously, while terminal closeout still waits for pending writes and persists the final state.

### Early opening architecture

Relevant backend files:

- `src/turnOpening.ts`: opening lifecycle, timeout, cancellation, safe-output validation, fallback selection, and `needsTurnOpening`.
- `src/turnOpeningModel.ts`: bounded OpenRouter request for the opening model.
- `src/agent.ts`: request-scoped opening is started concurrently with normal preparation; the main model waits for the opening gate before doing actual work.
- `src/sdkApi.ts`: web/SDK NDJSON stream, opening events, asynchronous persistence, and latency telemetry.
- `src/config.ts`: `TURN_OPENING_*` configuration defaults.
- `docs/fast-responses.md`: public behavior and event contract.

The current flow is:

1. The request is authenticated and passes policy, quota, rate, spend, thread, input, lock, and durable run-admission checks.
2. The web route creates a `ReadableStream` and sends `run.started`.
3. The opening model starts with only the current user text, bounded to 3,000 characters. It receives no history, memory, tools, credentials, connected-app data, or tool results.
4. The opening has a 600 ms generation deadline. A separate 1,500 ms delivery bound protects the request from a stuck client.
5. On success, the opening is validated and sent as `run.status`, followed by `run.progress` with an evidence item whose ID is `turn-opening`.
6. On timeout, provider failure, unsafe output, or malformed output, a local truthful fallback is sent once.
7. The normal agent continues with the full preparation and main model flow. It is instructed not to repeat the opening as its final answer.
8. Final run persistence and webhook notification happen during terminal closeout.

The opening is deliberately not appended to canonical conversation history and is not treated as evidence of completed work.

## Why the generic fallback appeared

The exact message:

> I’ll review your request and the relevant context, then work through the next steps.

was the local fallback from `openingFallback()`. It was not the main agent answer and it was not proof that context had already been loaded.

The fallback appeared for “well done” because the original `needsTurnOpening()` filter skipped greetings and a few confirmations, but did not classify “well done,” “great job,” “perfect,” and similar acknowledgements as conversational. The fallback also used one generic sentence for unrelated requests such as “What do you suggest I do tomorrow?”

## Fallback correction now in the code

`src/turnOpening.ts` now:

- Skips the opening model entirely for common acknowledgements: greetings, thanks, “well done,” “good/great job,” “great,” “perfect,” “awesome,” “got it,” “understood,” “sounds good,” and similar short confirmations.
- Still triggers for a real request embedded after an acknowledgement, for example: “Thanks, can you summarize my last email?”
- Uses one neutral, truthful fallback when the fast model misses its deadline: `Just a moment — I’m working through that.` The fallback intentionally does not pretend to know whether the request is about email, planning, research, or another category.
- Does not load memory merely to produce a fallback. That keeps the fallback fast and avoids implying that unavailable context has already been read.

If the next agent adds limited context, it should remain a separate, explicitly bounded feature: at most the last one or two relevant turns, with sensitive data and tool results excluded from the opening prompt. Do not pass the full conversation or full memory store to the fast model.

## Telegram versus web behavior

The user reports that Telegram feels faster and visibly shows early progress, while the web chat does not visibly show the opening. This is consistent with the current architecture:

- Telegram starts its opening after authorization, rate, and spend checks, before session loading and lock acquisition.
- The web/SDK stream currently starts after durable run admission. This preserves the existing durable-run contract but adds request-critical work before the browser receives any bytes.
- Telegram uses its existing account-scoped outbox/channel delivery path.
- Web uses an NDJSON `ReadableStream`; the server may call `controller.enqueue()` while a proxy, browser fetch reader, or UI state update still delays visible rendering.

This difference must not be “fixed” by making the opening claim that work is complete. The correct web improvement is to measure and remove pre-stream delay and verify the first bytes in the browser.

## Railway evidence from the latest test

Production deployment:

- Project: `12e169c9-aaf4-4452-819b-8939c30a27ca`
- Environment: `00fb1e28-a9b7-4253-98fc-3afa2e2754ca`
- Service: `cafbea91-7582-4b4e-9ee9-c3f93aca4603`
- Deployment: `c8512bc4-612c-4b34-957a-8920557e320d`
- Deployment status: `SUCCESS`
- Backend commit before the fallback correction: `16bf988`

The latest web test proved:

- `POST /v1/threads/.../runs/stream` reached Railway and returned HTTP 200.
- Total HTTP stream duration was `36,364 ms`; this is the complete agent run, not the opening generation time.
- Run ID: `run_f650f402-62be-4438-8f20-6af5d29b1cb4`.
- `Agent first response latency` reported `outcome: fallback`, model `openai/gpt-4.1-nano`, and `elapsedMs: 603.1`.
- `Agent first response frame sent` reported `streamElapsedMs: 605.6` and `requestElapsedMs: 2823.0`.
- Railway showed no backend crash and no HTTP error for that request.

Interpretation: the backend did enqueue an opening fallback, but it took roughly 2.8 seconds from request entry to stream phase. Railway logs cannot prove that the browser rendered the chunk. The next investigation must capture the browser network response and frontend state updates.

## Frontend contract and investigation checklist

The frontend is the separate `chusky-web` submodule. Its opening display support exists at commit `8a94bcb` (`Keep early agent responses visible through chat activity`). The remote frontend `main` also contains a later unrelated rich-media commit `a8cf9cd`.

Relevant frontend files:

- `chusky-web/lib/chusky-api.ts`: reads newline-delimited JSON from `/v1/threads/:threadId/runs/stream`.
- `chusky-web/components/app/chat-page.tsx`: handles `run.started`, `run.progress`, `run.status`, `run.delta`, tool activity, and terminal events; it renders the opening separately through `openingText`.

The opening should be visible through either of these events:

```json
{"type":"run.status","runId":"...","text":"..."}
{"type":"run.progress","runId":"...","progress":{"phase":"planning","title":"Preparing your request","detail":"...","evidence":[{"id":"turn-opening","kind":"note","label":"Initial response","detail":"..."}]}}
```

Next agent checklist:

1. Reproduce from a browser with DevTools Network open and disable cache.
2. Confirm the POST response headers include `Content-Type: application/x-ndjson` and that the first `run.started`, `run.status`, and `run.progress` lines arrive before the final line.
3. Confirm the frontend fetch reader yields each line immediately rather than only after the 36-second stream closes.
4. Confirm `typed.type === "run.progress"` updates the last assistant message and that `openingText` is present in React state.
5. Confirm the rendered assistant component is not hiding `openingText` behind `pending`, `statusText`, `ActivityNarrative`, or a stale message index.
6. Compare a Telegram request and web request with the same input using `requestElapsedMs`, `streamElapsedMs`, browser first-byte time, and visible first-frame time.
7. Only then decide whether to move web response creation earlier. If doing so, preserve authentication, ownership, policy, idempotency, cancellation, durable run recovery, and lock semantics.

The likely backend optimization after this handoff is to introduce an early admission phase that can return the stream after the minimum safe checks, while completing durable admission immediately afterward. That is a larger protocol change and should not be replaced with an unsafe unauthenticated stream.

## Configuration

No additional credentials are required for the opening feature. Production currently uses:

| Variable | Value/default | Purpose |
| --- | --- | --- |
| `TURN_OPENING_ENABLED` | `true` by code default | Rollout/rollback switch |
| `TURN_OPENING_MODEL` | `openai/gpt-4.1-nano` | Separate low-latency opening model |
| `TURN_OPENING_DEADLINE_MS` | `600` | Generation deadline, capped at 2,500 ms |

The opening model call uses OpenRouter with provider latency sorting and fallbacks. A deadline miss must never block the actual agent run.

## Verification completed

- Focused opening/fallback tests: `10/10` passed.
- Typecheck: passed.
- Production build: passed.
- `git diff --check`: passed.
- Previous SDK API suite: `87/87` passed.
- Backend deployment `c8512bc4-612c-4b34-957a-8920557e320d`: `SUCCESS`.

## Commit and deployment handoff

- The fallback correction, tests, and this handoff document are being pushed to backend GitHub `main` in the commit associated with this update.
- Railway will need to build the new backend commit before the fallback correction is live.
- The frontend remains a separate repository/submodule deployment. Updating backend `main` does not automatically change the Vercel frontend unless the frontend repository is also deployed.
- After deployment, test these cases:
  - “Well done” — no planning opening; normal conversational response only.
  - “Thanks, can you summarize my last email?” — opening allowed and email-specific.
  - “What do you suggest I do tomorrow?” — neutral fallback if the opening model times out; the main agent still handles the actual request.
  - A genuine tool request — opening appears before tool activity and final answer, without claiming completed work.
