import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DurableObjectMetadata } from "../src/neonDurableState.js";
import { R2ObjectTooLargeError } from "../src/lib/storage/r2.js";
import { promoteSdkFileUpload, type SdkFilePromotionDependencies } from "../src/sdkFilePromotion.js";

const input = { ownerUserId: 42, objectId: "obj_upload_1", uploadKey: "sdk/42/.staging/file_1", contentType: "text/plain", expectedSize: 4, maxBytes: 8, safeName: "note.txt" };
const payload = Buffer.from("data");

function fakeStorage(): { dependencies: SdkFilePromotionDependencies; objects: Map<string, { bytes: Buffer; contentType: string }>; getCatalog: () => DurableObjectMetadata | undefined } {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>([[input.uploadKey, { bytes: payload, contentType: input.contentType }]]);
  let catalog: DurableObjectMetadata = {
    ownerUserId: input.ownerUserId, objectId: input.objectId, kind: "file", objectKey: input.uploadKey,
    status: "pending", contentType: input.contentType, sizeBytes: input.expectedSize,
    metadata: { fileId: "file_1" }, createdAt: 1, updatedAt: 1,
  };
  const dependencies: SdkFilePromotionDependencies = {
    inspect: async (key) => {
      const object = objects.get(key);
      if (!object) throw new Error("not found");
      return { size: object.bytes.length, contentType: object.contentType };
    },
    readBounded: async (key, maxBytes) => {
      const object = objects.get(key);
      if (!object) throw new Error("not found");
      if (object.bytes.length > maxBytes) throw new R2ObjectTooLargeError();
      return Buffer.from(object.bytes);
    },
    put: async (key, bytes, contentType) => { objects.set(key, { bytes: Buffer.from(bytes), contentType }); },
    remove: async (key) => { objects.delete(key); },
    finalize: async (_userId, _objectId, expectedKey, finalKey, size, sha256) => {
      if (catalog.status === "pending" && catalog.objectKey === expectedKey && catalog.sizeBytes === size) {
        catalog = { ...catalog, objectKey: finalKey, status: "available", sha256 };
        return true;
      }
      return catalog.status === "available" && catalog.sizeBytes === size && catalog.sha256 === sha256;
    },
    get: async () => ({ ...catalog }),
  };
  return { dependencies, objects, getCatalog: () => ({ ...catalog }) };
}

test("SDK upload promotion keeps the signed staging key separate from the finalized object", async () => {
  const storage = fakeStorage();
  const result = await promoteSdkFileUpload(input, storage.dependencies);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.notEqual(result.objectKey, input.uploadKey);
  assert.match(result.objectKey, /^sdk\/42\/objects\//);
  assert.equal(storage.getCatalog()?.objectKey, result.objectKey);
  assert.equal(storage.getCatalog()?.sha256, createHash("sha256").update(payload).digest("hex"));
  assert.equal(storage.objects.has(input.uploadKey), false);
  assert.deepEqual(storage.objects.get(result.objectKey)?.bytes, payload);
});

test("concurrent identical completions converge on one final key and clean the loser", async () => {
  const storage = fakeStorage();
  const results = await Promise.all([
    promoteSdkFileUpload(input, storage.dependencies),
    promoteSdkFileUpload(input, storage.dependencies),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(storage.getCatalog()?.objectKey, results[0]?.status === "available" ? results[0].objectKey : "");
  assert.equal([...storage.objects.keys()].filter((key) => key.startsWith("sdk/42/objects/")).length, 1);
});

test("a failed read-back after catalog finalization preserves the possibly referenced final object", async () => {
  const storage = fakeStorage();
  storage.dependencies.get = async () => { throw new Error("temporary database read failure"); };
  await assert.rejects(() => promoteSdkFileUpload(input, storage.dependencies), /temporary database read failure/);
  assert.equal(storage.getCatalog()?.status, "available");
  assert.equal([...storage.objects.keys()].filter((key) => key.startsWith("sdk/42/objects/")).length, 1);
});

test("an oversized upload is a verification failure before final-object creation", async () => {
  const storage = fakeStorage();
  const bounded = { ...input, maxBytes: 3 };
  assert.deepEqual(await promoteSdkFileUpload(bounded, storage.dependencies), { status: "verification_failed" });
  assert.equal([...storage.objects.keys()].filter((key) => key.startsWith("sdk/42/objects/")).length, 0);
});
