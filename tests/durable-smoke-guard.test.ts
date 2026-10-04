import assert from "node:assert/strict";
import test from "node:test";
import { reserveDurableSmokeScope, type DurableSmokeScopeOperations } from "../src/durableSmokeGuard.js";

function operations(overrides: Partial<DurableSmokeScopeOperations> = {}) {
  const calls = { acquired: 0, released: 0 };
  const value: DurableSmokeScopeOperations = {
    async hasNeonRows() { return false; },
    async hasRedisSessionKeys() { return false; },
    async acquireReservation() { calls.acquired += 1; return true; },
    async releaseReservation() { calls.released += 1; },
    ...overrides,
  };
  return { calls, value };
}

const syntheticOwnerId = 8_000_000_000_000_001;

test("durable smoke guard refuses any pre-existing Neon or Redis scope without reserving or deleting it", async () => {
  for (const conflict of [
    { hasNeonRows: async () => true },
    { hasRedisSessionKeys: async () => true },
  ]) {
    const fixture = operations(conflict);
    await assert.rejects(
      () => reserveDurableSmokeScope(syntheticOwnerId, "smoke-token", fixture.value),
      /scope is not empty/,
    );
    assert.equal(fixture.calls.acquired, 0);
    assert.equal(fixture.calls.released, 0);
  }
});

test("durable smoke guard rejects owner IDs outside the reserved synthetic range", async () => {
  const fixture = operations();
  await assert.rejects(
    () => reserveDurableSmokeScope(831_236, "smoke-token", fixture.value),
    /high-range synthetic owner ID/,
  );
  assert.equal(fixture.calls.acquired, 0);
});

test("durable smoke guard refuses a concurrent reservation and releases an owned one once", async () => {
  const busy = operations({ async acquireReservation() { return false; } });
  await assert.rejects(
    () => reserveDurableSmokeScope(syntheticOwnerId, "smoke-token", busy.value),
    /already reserved/,
  );
  assert.equal(busy.calls.released, 0);

  const fixture = operations();
  const release = await reserveDurableSmokeScope(syntheticOwnerId, "smoke-token", fixture.value);
  await release();
  await release();
  assert.equal(fixture.calls.acquired, 1);
  assert.equal(fixture.calls.released, 1);
});
