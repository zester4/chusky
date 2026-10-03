import { createHash, randomUUID } from "node:crypto";
import type { DurableObjectMetadata } from "./neonDurableState.js";
import { R2ObjectTooLargeError } from "./lib/storage/r2.js";

export interface SdkFilePromotionInput {
  ownerUserId: number;
  objectId: string;
  uploadKey: string;
  contentType: string;
  expectedSize: number;
  maxBytes: number;
  safeName: string;
}

export interface SdkFilePromotionDependencies {
  inspect(key: string): Promise<{ size: number; contentType?: string }>;
  readBounded(key: string, maxBytes: number): Promise<Buffer>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  finalize(userId: number, objectId: string, uploadKey: string, finalKey: string, size: number, sha256: string): Promise<boolean>;
  get(userId: number, objectId: string): Promise<DurableObjectMetadata | undefined>;
}

export type SdkFilePromotionResult =
  | { status: "available"; objectKey: string; sha256: string }
  | { status: "not_uploaded" }
  | { status: "verification_failed" }
  | { status: "conflict" };

/** Verify staged bytes and promote them to a unique final key before cataloging them as downloadable. */
export async function promoteSdkFileUpload(input: SdkFilePromotionInput, dependencies: SdkFilePromotionDependencies): Promise<SdkFilePromotionResult> {
  let staged: { size: number; contentType?: string };
  try { staged = await dependencies.inspect(input.uploadKey); }
  catch { return { status: "not_uploaded" }; }
  if (staged.size !== input.expectedSize || staged.contentType !== input.contentType) return { status: "verification_failed" };

  let bytes: Buffer;
  try { bytes = await dependencies.readBounded(input.uploadKey, input.maxBytes); }
  catch (error) {
    if (error instanceof R2ObjectTooLargeError) return { status: "verification_failed" };
    throw error;
  }
  if (bytes.byteLength !== input.expectedSize) return { status: "verification_failed" };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const finalKey = `sdk/${input.ownerUserId}/objects/${input.objectId}-${randomUUID()}-${input.safeName}`;
  let finalizeStarted = false;
  try {
    await dependencies.put(finalKey, bytes, input.contentType);
    const finalObject = await dependencies.inspect(finalKey);
    if (finalObject.size !== bytes.byteLength || finalObject.contentType !== input.contentType) {
      await dependencies.remove(finalKey).catch(() => undefined);
      return { status: "verification_failed" };
    }
    finalizeStarted = true;
    const finalized = await dependencies.finalize(input.ownerUserId, input.objectId, input.uploadKey, finalKey, bytes.byteLength, sha256);
    if (!finalized) {
      await dependencies.remove(finalKey).catch(() => undefined);
      return { status: "conflict" };
    }
    const winner = finalized ? await dependencies.get(input.ownerUserId, input.objectId) : undefined;
    if (!winner || winner.status !== "available" || winner.sizeBytes !== bytes.byteLength || winner.sha256 !== sha256) {
      // Finalization may have committed before the read-back failed. Keep the
      // candidate; deleting it here could leave an available catalog row whose
      // bytes have vanished. The orphan sweeper can reconcile this safely.
      return { status: "conflict" };
    }
    await dependencies.remove(input.uploadKey).catch(() => undefined);
    if (winner.objectKey !== finalKey) await dependencies.remove(finalKey).catch(() => undefined);
    return { status: "available", objectKey: winner.objectKey, sha256 };
  } catch (error) {
    if (!finalizeStarted) await dependencies.remove(finalKey).catch(() => undefined);
    throw error;
  }
}
