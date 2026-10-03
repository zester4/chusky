import { createHash } from "node:crypto";
import type { DurableObjectMetadata } from "./neonDurableState.js";

export interface DurableImageAssetInput {
  userId: number;
  assetId: string;
  r2Key: string;
  contentType: string;
  size: number;
}

export interface DurableImageCatalogDependencies {
  inspect: (key: string) => Promise<{ size: number; contentType?: string }>;
  readBounded: (key: string, maxBytes: number) => Promise<Uint8Array>;
  create: (record: DurableObjectMetadata) => Promise<DurableObjectMetadata>;
  get: (userId: number, objectId: string) => Promise<DurableObjectMetadata | undefined>;
  markDeleting: (userId: number, objectId: string) => Promise<boolean>;
  markDeleted: (userId: number, objectId: string) => Promise<boolean>;
  deleteObject: (key: string) => Promise<void>;
}

export function durableImageObjectId(assetId: string): string {
  return `obj_image_${createHash("sha256").update(assetId).digest("hex").slice(0, 40)}`;
}

export async function registerDurableImageAsset(
  input: DurableImageAssetInput,
  dependencies: DurableImageCatalogDependencies,
  maxBytes: number,
): Promise<DurableObjectMetadata> {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || !/^[A-Za-z0-9_-]{1,180}$/.test(input.assetId)
    || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > maxBytes) {
    throw new Error("Durable image metadata is invalid or exceeds the configured size limit.");
  }
  const remote = await dependencies.inspect(input.r2Key);
  if (remote.size !== input.size || (remote.contentType && remote.contentType !== input.contentType)) {
    throw new Error("R2 image metadata does not match the uploaded object.");
  }
  const bytes = await dependencies.readBounded(input.r2Key, input.size);
  if (bytes.byteLength !== input.size) throw new Error("R2 image size changed during verification.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const now = Date.now();
  const record = await dependencies.create({
    ownerUserId: input.userId,
    objectId: durableImageObjectId(input.assetId),
    kind: "image",
    objectKey: input.r2Key,
    status: "available",
    contentType: input.contentType,
    sizeBytes: input.size,
    sha256,
    metadata: { assetId: input.assetId },
    createdAt: now,
    updatedAt: now,
  });
  if (!isAuthorizedDurableImage(record, input)) throw new Error("Durable image catalog did not confirm the verified owner object.");
  return record;
}

export function isAuthorizedDurableImage(record: DurableObjectMetadata | undefined, input: DurableImageAssetInput, now = Date.now()): record is DurableObjectMetadata {
  return Boolean(record
    && record.ownerUserId === input.userId
    && record.objectId === durableImageObjectId(input.assetId)
    && record.kind === "image"
    && record.status === "available"
    && record.objectKey === input.r2Key
    && record.contentType === input.contentType
    && record.sizeBytes === input.size
    && /^[a-f0-9]{64}$/.test(record.sha256 ?? "")
    && record.metadata?.assetId === input.assetId
    && (!record.retentionExpiresAt || record.retentionExpiresAt > now));
}

/** Tombstone the canonical record before deleting bytes; repeat calls safely finish interrupted deletes. */
export async function deleteDurableImageAsset(input: DurableImageAssetInput, dependencies: DurableImageCatalogDependencies): Promise<void> {
  const objectId = durableImageObjectId(input.assetId);
  const record = await dependencies.get(input.userId, objectId);
  if (!record) {
    // Compatibility for owner-scoped legacy assets created before the catalog cutover.
    await dependencies.deleteObject(input.r2Key);
    return;
  }
  if (record.ownerUserId !== input.userId || record.kind !== "image" || record.objectKey !== input.r2Key || record.metadata?.assetId !== input.assetId) {
    throw new Error("Durable image catalog ownership or identity does not match the requested asset.");
  }
  if (record.status !== "deleted") {
    if (!(await dependencies.markDeleting(input.userId, objectId))) throw new Error("Durable image could not be tombstoned before deletion.");
    await dependencies.deleteObject(record.objectKey);
    if (!(await dependencies.markDeleted(input.userId, objectId))) throw new Error("Durable image deletion is awaiting catalog confirmation.");
  }
}
