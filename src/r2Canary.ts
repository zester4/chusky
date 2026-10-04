import { createHash, randomInt, randomUUID } from "node:crypto";
import type { DurableObjectMetadata } from "./neonDurableState.js";

export interface SyntheticR2CanaryDependencies {
  createMetadata(record: DurableObjectMetadata): Promise<DurableObjectMetadata>;
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
  inspectObject(key: string): Promise<{ size: number; contentType?: string }>;
  readObjectBounded(key: string, maxBytes: number): Promise<Buffer>;
  markAvailable(ownerUserId: number, objectId: string, expectedKey: string, finalKey: string, sizeBytes: number, sha256: string): Promise<boolean>;
  getMetadata(ownerUserId: number, objectId: string): Promise<DurableObjectMetadata | undefined>;
  markDeleting(ownerUserId: number, objectId: string): Promise<boolean>;
  deleteObject(key: string): Promise<void>;
  markDeleted(ownerUserId: number, objectId: string): Promise<boolean>;
}

/** Exercise only a generated owner/object pair; cleanup tombstones before deleting bytes. */
export async function runSyntheticR2Canary(
  dependencies: SyntheticR2CanaryDependencies,
  nowMs = Date.now(),
): Promise<{ uploaded: true; readBackVerified: true; ownerIsolationVerified: true; expiryMetadataVerified: true; cleanupConfirmed: true }> {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("R2 canary clock is invalid.");
  const ownerUserId = 8_000_000_000_000_000 + randomInt(1, 1_000_000);
  const objectId = `obj_canary_${randomUUID()}`;
  const stagingKey = `canary/${ownerUserId}/${objectId}.staging`;
  const finalKey = `canary/${ownerUserId}/${objectId}.bin`;
  const contentType = "application/octet-stream";
  const body = Buffer.from(`chusky-synthetic-r2-canary:${randomUUID()}`, "utf8");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const retentionExpiresAt = nowMs + 120_000;
  let metadataMayExist = false;
  let metadataCreated = false;
  let stagingObjectMayExist = false;
  let finalObjectMayExist = false;

  try {
    metadataMayExist = true;
    await dependencies.createMetadata({
      ownerUserId,
      objectId,
      kind: "other",
      objectKey: stagingKey,
      status: "pending",
      contentType,
      sizeBytes: body.byteLength,
      retentionExpiresAt,
      metadata: { source: "synthetic-r2-live-canary" },
      createdAt: nowMs,
      updatedAt: nowMs,
    });
    metadataCreated = true;
    // A timed-out PUT may have written bytes, so set cleanup intent first.
    stagingObjectMayExist = true;
    await dependencies.putObject(stagingKey, body, contentType);
    finalObjectMayExist = true;
    await dependencies.putObject(finalKey, body, contentType);
    const inspected = await dependencies.inspectObject(finalKey);
    if (inspected.size !== body.byteLength || inspected.contentType !== contentType) {
      throw new Error("Synthetic R2 canary HEAD verification failed.");
    }
    const readBack = await dependencies.readObjectBounded(finalKey, body.byteLength);
    if (readBack.byteLength !== body.byteLength || createHash("sha256").update(readBack).digest("hex") !== sha256) {
      throw new Error("Synthetic R2 canary checksum verification failed.");
    }
    if (!await dependencies.markAvailable(ownerUserId, objectId, stagingKey, finalKey, body.byteLength, sha256)) {
      throw new Error("Synthetic R2 canary metadata could not be finalized.");
    }

    const ownerRecord = await dependencies.getMetadata(ownerUserId, objectId);
    if (!ownerRecord) throw Object.assign(new Error("Synthetic R2 canary owner metadata was not found."), { code: "r2_canary_owner_metadata_missing" });
    if (ownerRecord.status !== "available" || ownerRecord.sha256 !== sha256 || ownerRecord.retentionExpiresAt !== retentionExpiresAt) {
      throw Object.assign(new Error("Synthetic R2 canary metadata read-back did not match the write."), { code: "r2_canary_metadata_mismatch" });
    }
    const otherOwnerRecord = await dependencies.getMetadata(ownerUserId + 1, objectId);
    if (otherOwnerRecord !== undefined) throw Object.assign(new Error("Synthetic R2 canary metadata was visible to another owner."), { code: "r2_canary_owner_scope_violation" });
  } finally {
    if (metadataMayExist) {
      let shouldCleanup = metadataCreated;
      if (!metadataCreated) {
        const record = await dependencies.getMetadata(ownerUserId, objectId);
        if (record && (record.ownerUserId !== ownerUserId || record.objectId !== objectId || record.kind !== "other"
          || record.objectKey !== stagingKey || record.metadata?.source !== "synthetic-r2-live-canary")) {
          throw new Error("Synthetic R2 canary cleanup refused metadata outside its generated object scope.");
        }
        shouldCleanup = Boolean(record);
      }
      if (shouldCleanup) {
        if (!await dependencies.markDeleting(ownerUserId, objectId)) {
          throw new Error("Synthetic R2 canary cleanup could not persist its deletion tombstone.");
        }
        if (stagingObjectMayExist) await dependencies.deleteObject(stagingKey);
        if (finalObjectMayExist) await dependencies.deleteObject(finalKey);
        if (!await dependencies.markDeleted(ownerUserId, objectId)) {
          throw new Error("Synthetic R2 canary cleanup could not confirm deletion.");
        }
        const deletedRecord = await dependencies.getMetadata(ownerUserId, objectId);
        if (deletedRecord?.status !== "deleted") throw new Error("Synthetic R2 canary cleanup read-back failed.");
      }
    }
  }

  return { uploaded: true, readBackVerified: true, ownerIsolationVerified: true, expiryMetadataVerified: true, cleanupConfirmed: true };
}
