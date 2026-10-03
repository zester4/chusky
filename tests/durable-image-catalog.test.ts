import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { deleteDurableImageAsset, durableImageObjectId, isAuthorizedDurableImage, registerDurableImageAsset, type DurableImageCatalogDependencies } from "../src/durableImageCatalog.js";
import type { DurableObjectMetadata } from "../src/neonDurableState.js";

const bytes = Buffer.from("synthetic-image-bytes");
const input = { userId: 42, assetId: "img_123_test", r2Key: "images/42/img_123_test.png", contentType: "image/png", size: bytes.byteLength };

function dependencies(overrides: Partial<DurableImageCatalogDependencies> = {}) {
  const calls: string[] = [];
  const metadata: DurableObjectMetadata = {
    ownerUserId: input.userId,
    objectId: durableImageObjectId(input.assetId),
    kind: "image",
    objectKey: input.r2Key,
    status: "available",
    contentType: input.contentType,
    sizeBytes: input.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    metadata: { assetId: input.assetId },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const deps: DurableImageCatalogDependencies = {
    inspect: async () => ({ size: bytes.byteLength, contentType: input.contentType }),
    readBounded: async (_key, maxBytes) => { assert.equal(maxBytes, bytes.byteLength); return bytes; },
    create: async (record) => { calls.push(`create:${record.status}`); return metadata; },
    get: async () => metadata,
    markDeleting: async () => { calls.push("mark-deleting"); return true; },
    markDeleted: async () => { calls.push("mark-deleted"); return true; },
    deleteObject: async () => { calls.push("delete-object"); },
    ...overrides,
  };
  return { deps, calls, metadata };
}

test("image registration verifies R2 bytes and creates owner-scoped Neon metadata with a checksum", async () => {
  const { deps, calls, metadata } = dependencies();
  const created = await registerDurableImageAsset(input, deps, 1_000);
  assert.equal(created.objectId, durableImageObjectId(input.assetId));
  assert.equal(created.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(calls, ["create:available"]);
  assert.equal(isAuthorizedDurableImage(metadata, input), true);
});

test("image registration rejects mismatched object metadata and oversized reads before catalog writes", async () => {
  const mismatch = dependencies({ inspect: async () => ({ size: bytes.byteLength + 1, contentType: input.contentType }) });
  await assert.rejects(() => registerDurableImageAsset(input, mismatch.deps, 1_000), /does not match/);
  assert.deepEqual(mismatch.calls, []);

  const oversized = dependencies();
  await assert.rejects(() => registerDurableImageAsset(input, oversized.deps, bytes.byteLength - 1), /size limit/);
  assert.deepEqual(oversized.calls, []);
});

test("catalog authorization fails closed for foreign, deleting, mismatched, or expired image records", () => {
  const { metadata } = dependencies();
  assert.equal(isAuthorizedDurableImage({ ...metadata, ownerUserId: 43 }, input), false);
  assert.equal(isAuthorizedDurableImage({ ...metadata, status: "deleting" }, input), false);
  assert.equal(isAuthorizedDurableImage({ ...metadata, objectKey: "images/43/private.png" }, input), false);
  assert.equal(isAuthorizedDurableImage({ ...metadata, retentionExpiresAt: 1 }, input, 2), false);
});

test("image deletion tombstones before removing R2 bytes and confirms the tombstone", async () => {
  const { deps, calls } = dependencies();
  await deleteDurableImageAsset(input, deps);
  assert.deepEqual(calls, ["mark-deleting", "delete-object", "mark-deleted"]);
});

test("image deletion stops before R2 when tombstoning fails and preserves retryable failures", async () => {
  const { deps, calls } = dependencies({ markDeleting: async () => { calls.push("mark-deleting"); return false; } });
  await assert.rejects(() => deleteDurableImageAsset(input, deps), /could not be tombstoned/);
  assert.deepEqual(calls, ["mark-deleting"]);

  const failedFinalizeCalls: string[] = [];
  const failedFinalize = dependencies({ markDeleted: async () => { failedFinalizeCalls.push("mark-deleted"); return false; } });
  await assert.rejects(() => deleteDurableImageAsset(input, failedFinalize.deps), /awaiting catalog confirmation/);
  assert.deepEqual(failedFinalize.calls, ["mark-deleting", "delete-object"]);
  assert.deepEqual(failedFinalizeCalls, ["mark-deleted"]);
});

test("legacy image deletion remains owner-scoped when no catalog row exists", async () => {
  const { deps, calls } = dependencies({ get: async () => undefined });
  await deleteDurableImageAsset(input, deps);
  assert.deepEqual(calls, ["delete-object"]);
});
