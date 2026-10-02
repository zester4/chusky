import test from "node:test";
import assert from "node:assert/strict";
import { MissionFakeClock } from "./helpers/missionKernelHarness.js";

test("mission clock runs async heartbeats in deadline order and preserves cancelled timers", async () => {
  const clock = new MissionFakeClock(1000);
  clock.installTimers();
  try {
    const observed: string[] = [];
    const heartbeat = setInterval(() => {
      void Promise.resolve().then(() => { observed.push(`heartbeat:${Date.now()}`); });
    }, 100);
    heartbeat.unref();
    const cancelled = setTimeout(() => { observed.push("must-not-fire"); }, 150);
    clearTimeout(cancelled);
    setTimeout(() => { clearInterval(heartbeat); observed.push(`deadline:${Date.now()}`); }, 250);
    await clock.advanceAsync(1000);
    assert.deepEqual(observed, ["heartbeat:1100", "heartbeat:1200", "deadline:1250"]);
    assert.equal(Date.now(), 2000);
    assert.equal(clock.pendingTimers, 0);
  } finally { clock.restore(); }
});

test("mission clock restore discards old worker timers before a fresh restart", async () => {
  const clock = new MissionFakeClock(1000);
  clock.installTimers();
  setInterval(() => { throw new Error("An abandoned worker cannot keep renewing its lease."); }, 100);
  clock.restore();
  clock.installTimers();
  try {
    await clock.advanceAsync(1000);
    assert.equal(clock.pendingTimers, 0);
  } finally { clock.restore(); }
});
