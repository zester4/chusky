import test from "node:test";
import assert from "node:assert/strict";
import { beginExternalAction, failExternalAction, finishExternalAction, reconcileExternalActionByRead } from "../src/autonomy/actions.js";
import { getExternalAction, initStore } from "../src/store.js";
import { createRecallBotWithRetry, recallApiRequest } from "../src/meetings/recall.js";

test("live meeting provider retries reuse one Recall idempotency key", async () => {
  const keys: string[] = [];
  let attempts = 0;
  const result = await createRecallBotWithRetry({
    create: () => recallApiRequest("us-west-2", "test-key", "/bot/", {
      method: "POST",
      body: { meeting_url: "https://meet.google.com/live-soak" },
      idempotencyKey: "meeting-live-harness-1",
      fetchImpl: async (_input, init) => {
        keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        attempts++;
        return attempts === 1
          ? new Response(null, { status: 503 })
          : new Response(JSON.stringify({ id: "bot-live-harness" }), { status: 201 });
      },
    }),
    wait: async () => undefined,
  });
  assert.equal(result.id, "bot-live-harness");
  assert.deepEqual(keys, ["meeting-live-harness-1", "meeting-live-harness-1"]);
});

test("live meeting Composio writes are occurrence-scoped and quarantine uncertain outcomes", async () => {
  await initStore({ memoryOnly: true });
  const input = {
    userId: 951001,
    provider: "composio" as const,
    tool: "GOOGLECALENDAR_CREATE_EVENT",
    args: { summary: "Live meeting follow-up", start: "2026-10-20T10:00:00Z" },
    runId: "meeting-runtime-retry",
    source: { kind: "meeting", id: "mtg_live_harness", occurrenceId: "flux-session-turn-1" },
  };

  let providerWrites = 0;
  const first = await beginExternalAction(input);
  assert.equal(first.state, "new");
  providerWrites++;
  await failExternalAction(input.userId, first.logicalActionId, "Composio timed out after dispatch");

  const retry = await beginExternalAction({ ...input, runId: "meeting-runtime-retry-2" });
  assert.equal(retry.state, "ambiguous");
  assert.equal(providerWrites, 1);

  const verified = await reconcileExternalActionByRead({
    userId: input.userId,
    logicalActionId: first.logicalActionId,
    evidenceRef: "composio-read:GOOGLECALENDAR_EVENTS_LIST:live-event-1",
    summary: "The event exists with the requested time and title.",
    verifiedAt: Date.now(),
  });
  assert.equal(verified?.receiptVerification, "provider_read");

  const replay = await beginExternalAction({ ...input, runId: "meeting-runtime-retry-3" });
  assert.equal(replay.state, "succeeded");
  assert.equal((await getExternalAction(input.userId, first.logicalActionId))?.status, "succeeded");
  assert.equal(providerWrites, 1);

  const nextTurn = await beginExternalAction({
    ...input,
    source: { ...input.source, occurrenceId: "flux-session-turn-2" },
  });
  assert.equal(nextTurn.state, "new");
  await finishExternalAction(input.userId, nextTurn.logicalActionId, "Provider confirmed the second occurrence.", "event-live-2");
  assert.notEqual(nextTurn.logicalActionId, first.logicalActionId);
});
