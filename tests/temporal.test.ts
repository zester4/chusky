import test from "node:test";
import assert from "node:assert/strict";
import { buildTemporalContext } from "../src/temporal.js";
import { appendMessages, getSession, initStore } from "../src/store.js";

test("temporal context gives the model exact trusted current and elapsed time", () => {
  const context = buildTemporalContext([
    { role: "user", content: "I am busy", createdAt: Date.parse("2026-09-02T13:50:00.000Z") },
  ], {
    now: Date.parse("2026-09-02T15:16:00.000Z"),
    messageReceivedAt: Date.parse("2026-09-02T15:16:00.000Z"),
    timezone: "Europe/London",
  });
  assert.match(context, /Current UTC time: 2026-09-02T15:16:00\.000Z/);
  assert.match(context, /Current local time \(Europe\/London\): Wednesday, 2 September 2026 at 16:16:00 BST/);
  assert.match(context, /Elapsed since previous user message: 1 hour 26 minutes/);
});

test("new history messages receive timestamps without inventing legacy timestamps", async () => {
  await initStore({ memoryOnly: true });
  const userId = 920001;
  await appendMessages(userId, [{ role: "user", content: "timestamp me" }]);
  const session = await getSession(userId);
  assert.equal(typeof session.history[0]?.createdAt, "number");
});
