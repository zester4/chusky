import assert from "node:assert/strict";
import test from "node:test";
import { withDistributedLease } from "../src/distributedLease.js";

test("distributed lease serializes work and releases only after each operation", async () => {
  let held = false;
  let active = 0;
  let maximumActive = 0;
  const operations = () => ({
    async acquire() { if (held) return false; held = true; return true; },
    async renew() { return held; },
    async release() { held = false; },
  });
  const run = (delay: number) => withDistributedLease(operations(), async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
  }, { acquisitionAttempts: 30, retryDelayMs: 2, renewalIntervalMs: 50, busyMessage: "busy", lostMessage: "lost" });

  await Promise.all([run(12), run(1)]);

  assert.equal(maximumActive, 1);
  assert.equal(held, false);
});

test("distributed lease fails closed after renewal loss and still releases", async () => {
  let released = false;
  let renewals = 0;
  await assert.rejects(() => withDistributedLease({
    async acquire() { return true; },
    async renew() { renewals += 1; return false; },
    async release() { released = true; },
  }, () => new Promise((resolve) => setTimeout(resolve, 15)), {
    renewalIntervalMs: 1,
    busyMessage: "busy",
    lostMessage: "lost",
  }), /lost/);
  assert.ok(renewals > 0);
  assert.equal(released, true);
});
