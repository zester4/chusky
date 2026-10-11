import test from "node:test";
import assert from "node:assert/strict";
import { withLatencyBudget } from "../src/voiceLatency.js";

test("voice latency budget returns a fast read result", async () => {
  assert.equal(await withLatencyBudget(Promise.resolve("context"), "", 50), "context");
});

test("voice latency budget returns fallback when an optional read is slow", async () => {
  const started = Date.now();
  const result = await withLatencyBudget(new Promise<string>((resolve) => setTimeout(() => resolve("late"), 40)), "", 5);
  assert.equal(result, "");
  assert.ok(Date.now() - started < 35);
});

test("voice latency budget converts an optional read failure to the fallback", async () => {
  assert.deepEqual(await withLatencyBudget(Promise.reject(new Error("unavailable")), [] as string[], 50), []);
});
