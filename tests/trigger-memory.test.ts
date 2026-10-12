import assert from "node:assert/strict";
import test from "node:test";
import { getSession, initStore, searchMemories } from "../src/store.js";
import { saveTriggerOutcomeMemory } from "../src/triggerMemory.js";

test("trigger outcome memory is concise, replay-safe, searchable, and owner-scoped", async () => {
  await initStore({ memoryOnly: true });
  const ownerId = 831091;
  const otherOwnerId = 831092;
  const eventId = "verified-gmail-event-1";

  await saveTriggerOutcomeMemory({
    userId: ownerId,
    eventId,
    triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
    result: "Action taken: Replied to Treffley with a short introduction and verified the sent message at https://mail.example/thread. <chusky_actions>[]</chusky_actions>",
  });
  await saveTriggerOutcomeMemory({
    userId: ownerId,
    eventId,
    triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
    result: "Action taken: Replied to Treffley with a short introduction and verified the sent message.",
  });

  const session = await getSession(ownerId);
  const entries = session.memories.filter((memory) => memory.source === "verified_trigger_outcome");
  assert.equal(entries.length, 1);
  assert.match(entries[0]?.value ?? "", /Action taken: Replied to Treffley/);
  assert.doesNotMatch(entries[0]?.value ?? "", /https?:\/\//i);
  assert.ok((entries[0]?.value.length ?? 0) <= 700);
  assert.ok((entries[0]?.expiresAt ?? 0) > Date.now());

  const recalled = await searchMemories(ownerId, "Treffley introduction", { category: "episodic" });
  assert.equal(recalled.length, 1);
  assert.equal((await searchMemories(otherOwnerId, "Treffley introduction", { category: "episodic" })).length, 0);
});
