import assert from "node:assert/strict";
import test from "node:test";
import { runSyntheticR2Canary, type SyntheticR2CanaryDependencies } from "../src/r2Canary.js";
import type { DurableObjectMetadata } from "../src/neonDurableState.js";

function fakeDependencies(overrides: Partial<SyntheticR2CanaryDependencies> = {}) {
  const calls: string[] = [];
  let current: DurableObjectMetadata | undefined;
  let payload: Buffer | undefined;
  const dependencies: SyntheticR2CanaryDependencies = {
    createMetadata: async (record) => { calls.push("metadata-pending"); current = record; return record; },
    putObject: async (key, body, contentType) => { calls.push(`put:${key}:${contentType}`); payload = Buffer.from(body); },
    inspectObject: async () => ({ size: payload?.byteLength ?? 0, contentType: "application/octet-stream" }),
    readObjectBounded: async () => Buffer.from(payload ?? []),
    markAvailable: async (_owner, _id, _expected, finalKey, _size, sha256) => {
      calls.push("metadata-available");
      if (!current) return false;
      current = { ...current, status: "available", objectKey: finalKey, sha256 };
      return true;
    },
    getMetadata: async (owner, id) => current?.ownerUserId === owner && current.objectId === id ? current : undefined,
    markDeleting: async () => { calls.push("metadata-deleting"); if (!current) return false; current = { ...current, status: "deleting" }; return true; },
    deleteObject: async (key) => { calls.push(`delete:${key}`); payload = undefined; },
    markDeleted: async () => { calls.push("metadata-deleted"); if (!current) return false; current = { ...current, status: "deleted" }; return true; },
    ...overrides,
  };
  return { calls, dependencies };
}

test("synthetic R2 canary verifies bytes and owner scope then tombstones before cleanup", async () => {
  const { calls, dependencies } = fakeDependencies();
  const result = await runSyntheticR2Canary(dependencies, 1_800_000_000_000);
  assert.deepEqual(result, {
    uploaded: true,
    readBackVerified: true,
    ownerIsolationVerified: true,
    expiryMetadataVerified: true,
    cleanupConfirmed: true,
  });
  assert.deepEqual(calls.map((call) => call.split(":")[0]), [
    "metadata-pending", "put", "put", "metadata-available", "metadata-deleting", "delete", "delete", "metadata-deleted",
  ]);
});

test("synthetic R2 canary cleans up after a checksum/read-back failure", async () => {
  const { calls, dependencies } = fakeDependencies({ readObjectBounded: async () => Buffer.from("mismatch") });
  await assert.rejects(() => runSyntheticR2Canary(dependencies, 1_800_000_000_000), /checksum verification failed/);
  assert.deepEqual(calls.map((call) => call.split(":")[0]), [
    "metadata-pending", "put", "put", "metadata-deleting", "delete", "delete", "metadata-deleted",
  ]);
});

test("synthetic R2 canary refuses cleanup if its generated identity resolves to another object", async () => {
  const { calls, dependencies } = fakeDependencies({
    createMetadata: async () => { calls.push("metadata-conflict"); throw new Error("identity conflict"); },
    getMetadata: async (ownerUserId, objectId) => ({
      ownerUserId,
      objectId,
      kind: "file",
      objectKey: `sdk/${ownerUserId}/not-the-canary`,
      status: "available",
      contentType: "application/octet-stream",
      sizeBytes: 8,
      sha256: "a".repeat(64),
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    }),
  });
  await assert.rejects(() => runSyntheticR2Canary(dependencies, 1_800_000_000_000), /refused metadata outside its generated object scope/);
  assert.equal(calls.some((call) => call.startsWith("delete:")), false);
  assert.equal(calls.includes("metadata-deleting"), false);
});

test("synthetic R2 canary tombstones and deletes after an owner read-back outage", async () => {
  const { calls, dependencies } = fakeDependencies();
  const getMetadata = dependencies.getMetadata;
  let reads = 0;
  dependencies.getMetadata = async (ownerUserId, objectId) => {
    reads += 1;
    if (reads === 1) throw new Error("simulated Neon read-back outage");
    return getMetadata(ownerUserId, objectId);
  };
  await assert.rejects(() => runSyntheticR2Canary(dependencies, 1_800_000_000_000), /simulated Neon read-back outage/);
  assert.deepEqual(calls.map((call) => call.split(":")[0]), [
    "metadata-pending", "put", "put", "metadata-available", "metadata-deleting", "delete", "delete", "metadata-deleted",
  ]);
});
