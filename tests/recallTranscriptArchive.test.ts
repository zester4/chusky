import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { DurableObjectMetadata } from "../src/neonDurableState.js";
import {
  archiveRecallTranscriptSegment,
  deleteRecallTranscriptArchive,
  listArchivedRecallTranscriptSegments,
  recallTranscriptMeetingHash,
  updateRecallTranscriptArchiveExpiry,
  type RecallTranscriptArchiveDependencies,
  type StoredRecallTranscriptSegment,
} from "../src/recallTranscriptArchive.js";

function archiveHarness() {
  const rows = new Map<string, DurableObjectMetadata>();
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  let failReadback = false;
  const dependencies: RecallTranscriptArchiveDependencies = {
    getObjectMetadata: async (owner, id) => rows.get(`${owner}:${id}`),
    listRecallTranscriptObjects: async (owner, meetingHash, includeUnavailable) => [...rows.values()]
      .filter((row) => row.ownerUserId === owner && row.kind === "transcript_segment"
        && row.metadata?.meetingHash === meetingHash && (includeUnavailable ? row.status !== "deleted" : row.status === "available")),
    createObjectMetadata: async (row) => {
      const key = `${row.ownerUserId}:${row.objectId}`;
      const prior = rows.get(key);
      if (prior) {
        assert.deepEqual({ ...prior, updatedAt: row.updatedAt }, row);
        return prior;
      }
      rows.set(key, structuredClone(row));
      calls.push("catalog:create");
      return row;
    },
    markObjectAvailableAtKey: async (owner, id, objectKey, sizeBytes, sha256, version) => {
      const row = rows.get(`${owner}:${id}`);
      if (!row || row.objectKey !== objectKey || row.status !== "pending") return false;
      rows.set(`${owner}:${id}`, { ...row, status: "available", sizeBytes, sha256, encryptionVersion: version });
      calls.push("catalog:available");
      return true;
    },
    updateRecallTranscriptObjectExpiry: async (owner, meetingHash, expiresAt) => {
      for (const [key, row] of rows) if (row.ownerUserId === owner && row.metadata?.meetingHash === meetingHash && row.status !== "deleted") {
        rows.set(key, { ...row, retentionExpiresAt: expiresAt });
      }
      calls.push("catalog:expiry");
    },
    markRecallTranscriptArchiveTruncated: async (owner, meetingHash) => {
      for (const [key, row] of rows) if (row.ownerUserId === owner && row.metadata?.meetingHash === meetingHash) {
        rows.set(key, { ...row, metadata: { ...row.metadata, truncated: true } });
      }
      calls.push("catalog:truncated");
    },
    markObjectDeleting: async (owner, id) => {
      const key = `${owner}:${id}`;
      const row = rows.get(key);
      if (!row) return false;
      rows.set(key, { ...row, status: "deleting" });
      calls.push("catalog:deleting");
      return true;
    },
    markObjectDeleted: async (owner, id) => {
      const key = `${owner}:${id}`;
      const row = rows.get(key);
      if (!row || row.status !== "deleting") return false;
      rows.set(key, { ...row, status: "deleted" });
      calls.push("catalog:deleted");
      return true;
    },
    putObject: async (key, bytes, contentType) => {
      assert.equal(contentType, "application/json");
      objects.set(key, Buffer.from(bytes));
      calls.push("r2:put");
    },
    readObjectBounded: async (key, maxBytes) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("missing object");
      if (failReadback) { failReadback = false; throw new Error("simulated R2 readback failure"); }
      assert.ok(bytes.byteLength <= maxBytes);
      calls.push("r2:get");
      return Buffer.from(bytes);
    },
    deleteObject: async (key) => { objects.delete(key); calls.push("r2:delete"); },
  };
  return { dependencies, rows, objects, calls, failNextReadback: () => { failReadback = true; } };
}

const stored: StoredRecallTranscriptSegment = {
  id: "a".repeat(64), startMs: 1200,
  sealed: `v1.${Buffer.alloc(12, 1).toString("base64url")}.${Buffer.alloc(16, 2).toString("base64url")}.${Buffer.from("ciphertext-only").toString("base64url")}`,
};

test("explicitly retained encrypted segments archive idempotently and read back within bounds", async () => {
  const harness = archiveHarness();
  const expiresAt = Date.now() + 7 * 24 * 60 * 60_000;
  const first = await archiveRecallTranscriptSegment(71, "mtg_private_1", stored, expiresAt, harness.dependencies);
  const second = await archiveRecallTranscriptSegment(71, "mtg_private_1", stored, expiresAt, harness.dependencies);
  assert.equal(first.status, "available");
  assert.equal(second.objectId, first.objectId);
  assert.equal(harness.calls.filter((call) => call === "r2:put").length, 1);
  const read = await listArchivedRecallTranscriptSegments(71, "mtg_private_1", harness.dependencies);
  assert.deepEqual(read, { segments: [stored], truncated: false });
  const r2Reads = harness.calls.filter((call) => call === "r2:get").length;
  const cachedRead = await listArchivedRecallTranscriptSegments(71, "mtg_private_1", harness.dependencies, [stored]);
  assert.deepEqual(cachedRead, { segments: [stored], truncated: false });
  assert.equal(harness.calls.filter((call) => call === "r2:get").length, r2Reads);
  assert.equal(harness.objects.get(first.objectKey)?.includes(Buffer.from("ciphertext-only")), false);
  assert.equal(harness.rows.get(`71:${first.objectId}`)?.sha256, createHash("sha256").update(JSON.stringify(stored)).digest("hex"));
});

test("a readback failure leaves a retryable catalog intent and a retry completes it", async () => {
  const harness = archiveHarness();
  harness.failNextReadback();
  await assert.rejects(archiveRecallTranscriptSegment(72, "mtg_retry", stored, Date.now() + 60_000, harness.dependencies), /readback failure/);
  assert.equal([...harness.rows.values()][0]?.status, "pending");
  const completed = await archiveRecallTranscriptSegment(72, "mtg_retry", stored, Date.now() + 60_000, harness.dependencies);
  assert.equal(completed.status, "available");
  assert.deepEqual((await listArchivedRecallTranscriptSegments(72, "mtg_retry", harness.dependencies)).segments, [stored]);
});

test("archive reads and deletes are owner- and meeting-scoped with tombstones before R2 deletion", async () => {
  const harness = archiveHarness();
  await archiveRecallTranscriptSegment(73, "mtg_owner_a", stored, Date.now() + 60_000, harness.dependencies);
  assert.deepEqual(await listArchivedRecallTranscriptSegments(74, "mtg_owner_a", harness.dependencies), { segments: [], truncated: false });
  await deleteRecallTranscriptArchive(73, "mtg_owner_a", harness.dependencies);
  assert.equal(harness.calls.indexOf("catalog:deleting") < harness.calls.indexOf("r2:delete"), true);
  assert.equal(harness.calls.indexOf("r2:delete") < harness.calls.indexOf("catalog:deleted"), true);
  assert.deepEqual(await listArchivedRecallTranscriptSegments(73, "mtg_owner_a", harness.dependencies), { segments: [], truncated: false });
});

test("transcript retention expiry updates only the matching owner's meeting rows", async () => {
  const harness = archiveHarness();
  await archiveRecallTranscriptSegment(75, "mtg_expiry", stored, Date.now() + 60_000, harness.dependencies);
  const before = [...harness.rows.values()][0]!;
  const nextExpiry = Date.now() + 24 * 60 * 60_000;
  await updateRecallTranscriptArchiveExpiry(75, "mtg_expiry", nextExpiry, harness.dependencies);
  assert.equal([...harness.rows.values()][0]?.retentionExpiresAt, nextExpiry);
  assert.equal(recallTranscriptMeetingHash(75, "mtg_expiry"), before.metadata?.meetingHash);
});

test("archive preserves the bounded transcript truncation state without storing transcript text in Neon", async () => {
  const harness = archiveHarness();
  const archived = await archiveRecallTranscriptSegment(77, "mtg_truncated", stored, Date.now() + 60_000, harness.dependencies);
  await harness.dependencies.markRecallTranscriptArchiveTruncated(77, String(archived.metadata?.meetingHash));
  const listed = await listArchivedRecallTranscriptSegments(77, "mtg_truncated", harness.dependencies);
  assert.equal(listed.truncated, true);
  assert.deepEqual(archived.metadata && Object.keys(archived.metadata).sort(), ["meetingHash", "segmentId", "startMs"].sort());
});

test("corrupted R2 bytes fail closed instead of yielding partial transcript data", async () => {
  const harness = archiveHarness();
  const object = await archiveRecallTranscriptSegment(76, "mtg_corrupt", stored, Date.now() + 60_000, harness.dependencies);
  harness.objects.set(object.objectKey, Buffer.from("not the archived ciphertext"));
  await assert.rejects(listArchivedRecallTranscriptSegments(76, "mtg_corrupt", harness.dependencies), /checksum|size/i);
});
