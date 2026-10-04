import { createHash } from "node:crypto";
import type { DurableObjectMetadata } from "./neonDurableState.js";

export interface StoredRecallTranscriptSegment {
  id: string;
  startMs: number;
  sealed: string;
}

const MAX_SEGMENTS = 8_000;
const MAX_TOTAL_BYTES = 200_000;
const MAX_SEGMENT_BYTES = 8_192;
const ENCRYPTION_VERSION = "aes256gcm-v1";
const CONTENT_TYPE = "application/json";

export interface RecallTranscriptArchiveDependencies {
  getObjectMetadata(userId: number, objectId: string): Promise<DurableObjectMetadata | undefined>;
  listRecallTranscriptObjects(userId: number, meetingHash: string, includeUnavailable: boolean): Promise<DurableObjectMetadata[]>;
  createObjectMetadata(record: DurableObjectMetadata): Promise<DurableObjectMetadata>;
  markObjectAvailableAtKey(userId: number, objectId: string, objectKey: string, sizeBytes: number, sha256: string, encryptionVersion: string): Promise<boolean>;
  updateRecallTranscriptObjectExpiry(userId: number, meetingHash: string, expiresAt: number): Promise<void>;
  markRecallTranscriptArchiveTruncated(userId: number, meetingHash: string): Promise<void>;
  markObjectDeleting(userId: number, objectId: string): Promise<boolean>;
  markObjectDeleted(userId: number, objectId: string): Promise<boolean>;
  putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  readObjectBounded(key: string, maxBytes: number): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}

export function recallTranscriptMeetingHash(userId: number, meetingId: string): string {
  return createHash("sha256").update(`${userId}\0${meetingId}`, "utf8").digest("hex");
}

function transcriptObjectIdentity(userId: number, meetingId: string, segmentId: string) {
  const meetingHash = recallTranscriptMeetingHash(userId, meetingId);
  return {
    meetingHash,
    objectId: `obj_tr_${meetingHash.slice(0, 32)}_${segmentId}`,
    objectKey: `archives/transcript_segment/${userId}/${meetingHash}/${segmentId}.json`,
  };
}

function validStoredSegment(value: unknown): value is StoredRecallTranscriptSegment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const segment = value as Record<string, unknown>;
  return typeof segment.id === "string" && /^[a-f0-9]{64}$/.test(segment.id)
    && Number.isSafeInteger(segment.startMs) && Number(segment.startMs) >= 0 && Number(segment.startMs) <= 7_200_000
    && typeof segment.sealed === "string" && segment.sealed.length > 0 && segment.sealed.length <= 8_192;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyMetadata(row: DurableObjectMetadata, input: {
  userId: number; objectId: string; objectKey: string; meetingHash: string; segmentId: string;
}): void {
  if (row.ownerUserId !== input.userId || row.objectId !== input.objectId || row.kind !== "transcript_segment"
    || row.objectKey !== input.objectKey || row.contentType !== CONTENT_TYPE || row.encryptionVersion !== ENCRYPTION_VERSION
    || row.metadata?.meetingHash !== input.meetingHash || row.metadata?.segmentId !== input.segmentId) {
    throw new Error("Recall transcript archive metadata does not match its owner-scoped object identity.");
  }
}

/** Store one already encrypted segment, using a stable owner-scoped key and a recoverable catalog intent. */
export async function archiveRecallTranscriptSegment(
  userId: number,
  meetingId: string,
  segment: StoredRecallTranscriptSegment,
  retentionExpiresAt: number | undefined,
  dependencies: RecallTranscriptArchiveDependencies,
): Promise<DurableObjectMetadata> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId)
    || !validStoredSegment(segment) || retentionExpiresAt !== undefined && (!Number.isSafeInteger(retentionExpiresAt) || retentionExpiresAt <= Date.now())) {
    throw new Error("Recall transcript archive request is invalid or expired.");
  }
  const identity = transcriptObjectIdentity(userId, meetingId, segment.id);
  const bytes = Buffer.from(JSON.stringify(segment), "utf8");
  if (bytes.byteLength > MAX_SEGMENT_BYTES) throw new Error("Encrypted Recall transcript segment exceeds its archive bound.");
  const checksum = sha256(bytes);
  const existing = await dependencies.getObjectMetadata(userId, identity.objectId);
  if (existing) {
    verifyMetadata(existing, { userId, ...identity, segmentId: segment.id });
    if (retentionExpiresAt !== undefined && existing.retentionExpiresAt !== retentionExpiresAt) {
      await dependencies.updateRecallTranscriptObjectExpiry(userId, identity.meetingHash, retentionExpiresAt);
    }
    if (existing.status === "available") {
      if (existing.sizeBytes !== bytes.byteLength || existing.sha256 !== checksum) throw new Error("Recall transcript archive retry does not match its stored object.");
      const readback = await dependencies.readObjectBounded(existing.objectKey, MAX_SEGMENT_BYTES);
      if (readback.byteLength !== bytes.byteLength || sha256(readback) !== checksum) throw new Error("Recall transcript archive checksum mismatch.");
      return existing;
    }
    if (existing.status !== "pending") throw new Error("Recall transcript archive is not in a retryable state.");
    if (existing.sizeBytes !== 0) throw new Error("Recall transcript pending archive intent conflicts with this retry.");
  } else {
    await dependencies.createObjectMetadata({
      ownerUserId: userId,
      objectId: identity.objectId,
      kind: "transcript_segment",
      objectKey: identity.objectKey,
      status: "pending",
      contentType: CONTENT_TYPE,
      sizeBytes: 0,
      encryptionVersion: ENCRYPTION_VERSION,
      ...(retentionExpiresAt !== undefined ? { retentionExpiresAt } : {}),
      metadata: { meetingHash: identity.meetingHash, segmentId: segment.id, startMs: segment.startMs },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  await dependencies.putObject(identity.objectKey, bytes, CONTENT_TYPE);
  const readback = await dependencies.readObjectBounded(identity.objectKey, MAX_SEGMENT_BYTES);
  if (readback.byteLength !== bytes.byteLength || sha256(readback) !== checksum) throw new Error("Recall transcript archive checksum mismatch.");
  const promoted = await dependencies.markObjectAvailableAtKey(userId, identity.objectId, identity.objectKey, bytes.byteLength, checksum, ENCRYPTION_VERSION);
  if (!promoted) throw new Error("Recall transcript archive could not be finalized in its durable catalog.");
  const final = await dependencies.getObjectMetadata(userId, identity.objectId);
  if (!final) throw new Error("Recall transcript archive disappeared after finalization.");
  verifyMetadata(final, { userId, ...identity, segmentId: segment.id });
  if (final.status !== "available" || final.sizeBytes !== bytes.byteLength || final.sha256 !== checksum) throw new Error("Recall transcript archive catalog verification failed.");
  return final;
}

/** Load every available encrypted segment for one meeting without allowing a partial or unbounded archive read. */
export async function listArchivedRecallTranscriptSegments(
  userId: number,
  meetingId: string,
  dependencies: RecallTranscriptArchiveDependencies,
  cachedSegments: readonly StoredRecallTranscriptSegment[] = [],
): Promise<{ segments: StoredRecallTranscriptSegment[]; truncated: boolean }> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId)) return { segments: [], truncated: false };
  const meetingHash = recallTranscriptMeetingHash(userId, meetingId);
  const rows = await dependencies.listRecallTranscriptObjects(userId, meetingHash, true);
  if (rows.length > MAX_SEGMENTS || rows.reduce((total, row) => total + row.sizeBytes, 0) > MAX_TOTAL_BYTES) {
    throw new Error("Recall transcript archive exceeds its read bounds.");
  }
  const segments: StoredRecallTranscriptSegment[] = [];
  const cachedById = new Map(cachedSegments.map((segment) => [segment.id, segment]));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      if (!row) continue;
      const segmentId = row.metadata?.segmentId;
      if (typeof segmentId !== "string") throw new Error("Recall transcript archive segment identity is invalid.");
      const identity = transcriptObjectIdentity(userId, meetingId, segmentId);
      verifyMetadata(row, { userId, ...identity, segmentId });
      if (row.status !== "available" || !row.sha256 || row.sizeBytes < 1 || row.sizeBytes > MAX_SEGMENT_BYTES) throw new Error("Recall transcript archive is incomplete and cannot be read safely.");
      const cached = cachedById.get(segmentId);
      if (cached) {
        const cachedBytes = Buffer.from(JSON.stringify(cached), "utf8");
        if (cached.startMs !== row.metadata?.startMs || cachedBytes.byteLength !== row.sizeBytes || sha256(cachedBytes) !== row.sha256) {
          throw new Error("Recall transcript cache and archive metadata disagree for the same immutable segment.");
        }
        segments.push(cached);
        continue;
      }
      const bytes = await dependencies.readObjectBounded(row.objectKey, MAX_SEGMENT_BYTES);
      if (bytes.byteLength !== row.sizeBytes || sha256(bytes) !== row.sha256) throw new Error("Recall transcript archive checksum mismatch.");
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
      catch { throw new Error("Recall transcript archive object is malformed."); }
      if (!validStoredSegment(parsed) || parsed.id !== segmentId || parsed.startMs !== row.metadata?.startMs) throw new Error("Recall transcript archive content does not match its catalog entry.");
      segments.push(parsed);
    }
  });
  await Promise.all(workers);
  segments.sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
  return { segments, truncated: rows.some((row) => row.metadata?.truncated === true) };
}

/** Fetch an archived segment by its content-derived ID for webhook retries after the Redis cache expired. */
export async function getArchivedRecallTranscriptSegment(
  userId: number,
  meetingId: string,
  segmentId: string,
  dependencies: RecallTranscriptArchiveDependencies,
): Promise<StoredRecallTranscriptSegment | undefined> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId) || !/^[a-f0-9]{64}$/.test(segmentId)) return undefined;
  const identity = transcriptObjectIdentity(userId, meetingId, segmentId);
  const row = await dependencies.getObjectMetadata(userId, identity.objectId);
  if (!row) return undefined;
  verifyMetadata(row, { userId, ...identity, segmentId });
  if (row.status !== "available" || !row.sha256 || row.sizeBytes < 1 || row.sizeBytes > MAX_SEGMENT_BYTES) {
    throw new Error("Recall transcript archive is not available for a safe retry.");
  }
  const bytes = await dependencies.readObjectBounded(row.objectKey, MAX_SEGMENT_BYTES);
  if (bytes.byteLength !== row.sizeBytes || sha256(bytes) !== row.sha256) throw new Error("Recall transcript archive checksum mismatch.");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new Error("Recall transcript archive object is malformed."); }
  if (!validStoredSegment(parsed) || parsed.id !== segmentId || parsed.startMs !== row.metadata?.startMs) throw new Error("Recall transcript archive content does not match its catalog entry.");
  return parsed;
}

export async function updateRecallTranscriptArchiveExpiry(
  userId: number,
  meetingId: string,
  expiresAt: number,
  dependencies: RecallTranscriptArchiveDependencies,
): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId)
    || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error("Recall transcript archive expiry is invalid.");
  await dependencies.updateRecallTranscriptObjectExpiry(userId, recallTranscriptMeetingHash(userId, meetingId), expiresAt);
}

export async function deleteRecallTranscriptArchive(
  userId: number,
  meetingId: string,
  dependencies: RecallTranscriptArchiveDependencies,
): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId)) throw new Error("Recall transcript archive deletion scope is invalid.");
  const rows = await dependencies.listRecallTranscriptObjects(userId, recallTranscriptMeetingHash(userId, meetingId), true);
  if (rows.length > MAX_SEGMENTS) throw new Error("Recall transcript archive exceeds its deletion bound.");
  for (const row of rows) {
    if (row.ownerUserId !== userId || row.kind !== "transcript_segment" || row.metadata?.meetingHash !== recallTranscriptMeetingHash(userId, meetingId)) {
      throw new Error("Refusing to delete a transcript archive outside the requested owner and meeting.");
    }
    if (!await dependencies.markObjectDeleting(userId, row.objectId)) throw new Error("Recall transcript archive deletion could not be tombstoned.");
    await dependencies.deleteObject(row.objectKey);
    if (!await dependencies.markObjectDeleted(userId, row.objectId)) throw new Error("Recall transcript archive deletion was not confirmed in its catalog.");
  }
}
