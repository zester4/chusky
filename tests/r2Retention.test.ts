import assert from "node:assert/strict";
import test from "node:test";
import { sweepExpiredR2Objects } from "../src/r2Retention.js";
import type { DurableObjectMetadata } from "../src/neonDurableState.js";

const now = 1_800_000_000_000;
const record: DurableObjectMetadata = {
  ownerUserId: 42,
  objectId: "obj_expired_file",
  kind: "file",
  objectKey: "sdk/42/expired.bin",
  status: "available",
  contentType: "application/octet-stream",
  sizeBytes: 10,
  sha256: "a".repeat(64),
  retentionExpiresAt: now - 1,
  createdAt: now - 10_000,
  updatedAt: now - 10_000,
};

function deps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    dependencies: {
      listExpired: async (nowMs: number, limit: number) => {
        calls.push(`list:${nowMs}:${limit}`);
        return [record];
      },
      markDeleting: async (ownerUserId: number, objectId: string, nowMs: number) => {
        calls.push(`tombstone:${ownerUserId}:${objectId}:${nowMs}`);
        return true;
      },
      deleteObject: async (key: string) => { calls.push(`delete:${key}`); },
      markDeleted: async (ownerUserId: number, objectId: string) => {
        calls.push(`deleted:${ownerUserId}:${objectId}`);
        return true;
      },
      ...overrides,
    },
  };
}

test("R2 retention defaults to an inert dry run and reports only bounded counts", async () => {
  const { dependencies, calls } = deps();
  const result = await sweepExpiredR2Objects(dependencies, { nowMs: now, limit: 25 });
  assert.deepEqual(result, { scanned: 1, eligible: 1, deleted: 0, failed: 0 });
  assert.deepEqual(calls, [`list:${now}:25`]);
});

test("R2 retention tombstones before deletion and confirms metadata afterward", async () => {
  const { dependencies, calls } = deps();
  const result = await sweepExpiredR2Objects(dependencies, { nowMs: now, apply: true });
  assert.deepEqual(result, { scanned: 1, eligible: 1, deleted: 1, failed: 0 });
  assert.deepEqual(calls, [
    `list:${now}:100`,
    `tombstone:${record.ownerUserId}:${record.objectId}:${now}`,
    `delete:${record.objectKey}`,
    `deleted:${record.ownerUserId}:${record.objectId}`,
  ]);
});

test("R2 retention rechecks the deadline atomically before touching bytes", async () => {
  const { dependencies, calls } = deps({ markDeleting: async () => { calls.push("not-due-anymore"); return false; } });
  const result = await sweepExpiredR2Objects(dependencies, { nowMs: now, apply: true });
  assert.deepEqual(result, { scanned: 1, eligible: 1, deleted: 0, failed: 1 });
  assert.equal(calls.some((call) => call.startsWith("delete:")), false);
});

test("R2 delete failure leaves a tombstoned object retryable and does not mark it deleted", async () => {
  const { dependencies, calls } = deps({ deleteObject: async () => { calls.push("delete-failed"); throw new Error("private provider response"); } });
  const result = await sweepExpiredR2Objects(dependencies, { nowMs: now, apply: true });
  assert.deepEqual(result, { scanned: 1, eligible: 1, deleted: 0, failed: 1 });
  assert.equal(calls.some((call) => call.startsWith("deleted:")), false);
  assert.deepEqual(calls.slice(-2), [`tombstone:${record.ownerUserId}:${record.objectId}:${now}`, "delete-failed"]);
});

test("R2 retention rejects unsafe or not-yet-expired catalog rows without touching storage", async () => {
  const { dependencies, calls } = deps({ listExpired: async () => [
    { ...record, objectKey: "sdk/43/foreign.bin" },
    { ...record, objectKey: "sdk/42/../private.bin" },
    { ...record, retentionExpiresAt: now + 1 },
  ] });
  const result = await sweepExpiredR2Objects(dependencies, { nowMs: now, apply: true });
  assert.deepEqual(result, { scanned: 3, eligible: 0, deleted: 0, failed: 3 });
  assert.equal(calls.some((call) => call.startsWith("delete:")), false);
});

test("R2 retention bounds query limits", async () => {
  const { dependencies } = deps();
  await assert.rejects(() => sweepExpiredR2Objects(dependencies, { limit: 501 }), /bounds are invalid/);
});
