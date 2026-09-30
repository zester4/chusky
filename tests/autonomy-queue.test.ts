import test from "node:test";
import assert from "node:assert/strict";
import { createAttentionRecord, initStore } from "../src/store.js";
import { getAutonomySnapshot } from "../src/autonomy/queue.js";

test("autonomy snapshot scopes watches by mode and exposes failed checks in the queue", async () => {
  await initStore({ memoryOnly: true });
  const userId = 991201;
  const now = Date.now();
  const addWatch = (name: string, values: Record<string, unknown>) => createAttentionRecord(userId, "autonomy_watch", {
    name,
    domain: "gmail",
    objective: `Check ${name}`,
    cadenceSeconds: 3600,
    freshnessMs: 60 * 60_000,
    authority: "observe",
    status: "active",
    maxItems: 10,
    ...values,
  });

  const current = await addWatch("Current", { mode: "business", lastCheckedAt: now - 60_000, nextCheckAt: now + 3_540_000 });
  const scheduled = await addWatch("Scheduled", { mode: "business", nextCheckAt: now + 3_600_000 });
  const stale = await addWatch("Stale", { mode: "business", lastCheckedAt: now - 2 * 60 * 60_000 });
  const failed = await addWatch("Failed", { mode: "business", lastCheckedAt: now, lastError: "Provider unavailable", consecutiveFailures: 2 });
  const legacyPersonal = await addWatch("Legacy personal", { nextCheckAt: now + 3_600_000 });

  const business = await getAutonomySnapshot(userId, "business");
  assert.deepEqual(new Set(business.watches.map((watch) => watch.id)), new Set([current.id, scheduled.id, stale.id, failed.id]));
  const businessQueueWatches = business.queue.filter((item) => item.kind === "watch");
  assert.deepEqual(new Set(businessQueueWatches.map((item) => item.id)), new Set([current.id, scheduled.id, stale.id, failed.id]));
  assert.equal(businessQueueWatches.find((item) => item.id === failed.id)?.status, "failed");
  assert.equal(business.watches.find((watch) => watch.id === failed.id)?.consecutiveFailures, 2);

  const personal = await getAutonomySnapshot(userId, "personal");
  assert.deepEqual(personal.watches.map((watch) => watch.id), [legacyPersonal.id]);
  assert.deepEqual(personal.queue.filter((item) => item.kind === "watch").map((item) => item.id), [legacyPersonal.id]);
});
