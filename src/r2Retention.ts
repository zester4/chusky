import type { DurableObjectMetadata } from "./neonDurableState.js";

export interface R2RetentionDependencies {
  listExpired(nowMs: number, limit: number): Promise<DurableObjectMetadata[]>;
  markDeleting(ownerUserId: number, objectId: string, nowMs: number): Promise<boolean>;
  deleteObject(key: string): Promise<void>;
  markDeleted(ownerUserId: number, objectId: string): Promise<boolean>;
}

export interface R2RetentionResult {
  scanned: number;
  eligible: number;
  deleted: number;
  failed: number;
}

/**
 * Delete only owner-scoped objects whose Neon retention deadline has passed.
 * The Neon tombstone is committed before touching R2, making interrupted
 * deletes retryable without ever treating a list/prefix as authority.
 */
export async function sweepExpiredR2Objects(
  dependencies: R2RetentionDependencies,
  options: { nowMs?: number; limit?: number; apply?: boolean } = {},
): Promise<R2RetentionResult> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("R2 retention sweep bounds are invalid.");
  }
  const records = await dependencies.listExpired(nowMs, limit);
  const result: R2RetentionResult = { scanned: records.length, eligible: 0, deleted: 0, failed: 0 };
  for (const record of records) {
    if (!Number.isSafeInteger(record.ownerUserId) || record.ownerUserId <= 0
      || !/^obj_[A-Za-z0-9_-]{1,120}$/.test(record.objectId)
      || !record.objectKey || record.objectKey.length > 512 || record.objectKey.startsWith("/")
      || record.objectKey.split("/").some((part) => !part || part === "." || part === "..")
      || !/^[A-Za-z0-9_./-]+$/.test(record.objectKey)
      || !new RegExp(`(?:^|/)${record.ownerUserId}(?:/|$)`).test(record.objectKey)
      || !Number.isSafeInteger(record.retentionExpiresAt) || record.retentionExpiresAt! > nowMs
      || !["pending", "available", "deleting", "failed"].includes(record.status)) {
      result.failed += 1;
      continue;
    }
    result.eligible += 1;
    if (!options.apply) continue;
    try {
      if (!(await dependencies.markDeleting(record.ownerUserId, record.objectId, nowMs))) {
        result.failed += 1;
        continue;
      }
      await dependencies.deleteObject(record.objectKey);
      if (!(await dependencies.markDeleted(record.ownerUserId, record.objectId))) {
        result.failed += 1;
        continue;
      }
      result.deleted += 1;
    } catch {
      // Do not leak object keys, owner IDs, or provider error payloads from a
      // scheduled cleanup. A later bounded pass can retry the tombstoned row.
      result.failed += 1;
    }
  }
  return result;
}
