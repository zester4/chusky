import assert from "node:assert/strict";
import test from "node:test";
import { parseRecallTranscriptWebhook } from "../src/meetings/recall.js";
import { config } from "../src/config.js";
import {
  addRecallMeeting,
  appendRecallTranscriptSegment,
  deleteRecallMeetingTranscript,
  initStore,
  readRecallTranscript,
  searchRecallMeetingTranscripts,
  type RecallMeetingRecord,
} from "../src/store.js";

const ownerId = 420042;
const meetingId = "mtg_transcript_123";
const botId = "cd6e8886-6ed4-45b1-94d4-43603833f1a1";
config.recallMediaBridgeSecret = "unit-test-only-transcript-encryption-secret-32-bytes-minimum";
config.recallTranscriptEncryptionKey = "unit-test-only-dedicated-transcript-encryption-key-32-bytes";

test("Recall live transcript events normalize word timing and preserve only a bounded participant label", () => {
  const event = parseRecallTranscriptWebhook({
    event: "transcript.data",
    data: {
      data: {
        words: [
          { text: "We", start_timestamp: { relative: 1.25 }, end_timestamp: { relative: 1.4 } },
          { text: "agreed", start_timestamp: { relative: 1.41 }, end_timestamp: { relative: 1.8 } },
          { text: "Friday.", start_timestamp: { relative: 1.81 }, end_timestamp: { relative: 2.2 } },
        ],
        participant: { id: 17, name: "Avery Chen", is_host: false },
      },
      bot: { id: botId, metadata: { chusky_meeting_id: meetingId, chusky_user_id: String(ownerId) } },
    },
  });

  assert.ok(event);
  assert.equal(event.providerBotId, botId);
  assert.equal(event.meetingId, meetingId);
  assert.equal(event.userId, ownerId);
  assert.match(event.segment.id, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...event.segment, id: undefined }, {
    startMs: 1250,
    endMs: 2200,
    text: "We agreed Friday.",
    speakerId: "17",
    speakerName: "Avery Chen",
    id: undefined,
  });
});

test("Recall transcript parser rejects foreign, malformed, empty, and overlarge transcript events", () => {
  assert.equal(parseRecallTranscriptWebhook({ event: "participant_events.chat_message", data: {} }), undefined);
  assert.equal(parseRecallTranscriptWebhook({
    event: "transcript.data",
    data: { data: { words: [{ text: "hello", start_timestamp: { relative: -1 } }], participant: {} }, bot: { id: botId, metadata: { chusky_meeting_id: meetingId, chusky_user_id: ownerId } } },
  }), undefined);
  assert.equal(parseRecallTranscriptWebhook({
    event: "transcript.data",
    data: { data: { words: [{ text: "x".repeat(2_001), start_timestamp: { relative: 1 } }], participant: {} }, bot: { id: botId, metadata: { chusky_meeting_id: meetingId, chusky_user_id: ownerId } } },
  }), undefined);
});

function meeting(overrides: Partial<RecallMeetingRecord> = {}): RecallMeetingRecord {
  const now = Date.now();
  return {
    id: meetingId,
    userId: ownerId,
    providerBotId: botId,
    platform: "google_meet",
    interactionMode: "representative",
    status: "ended",
    meetingUrlHash: "a".repeat(64),
    history: [],
    createdAt: now - 60_000,
    updatedAt: now,
    transcriptRetentionDays: 7,
    transcriptExpiresAt: now + 7 * 24 * 60 * 60_000,
    ...overrides,
  };
}

test("meeting transcript storage deduplicates retries, orders segments, enforces owner scope, and supports deletion", async () => {
  await initStore({ memoryOnly: true });
  await addRecallMeeting(ownerId, meeting());

  const second = { id: "b".repeat(64), startMs: 2_000, endMs: 2_500, text: "The pilot starts Friday.", speakerId: "17", speakerName: "Avery" };
  const first = { id: "a".repeat(64), startMs: 1_000, endMs: 1_500, text: "We agreed.", speakerId: "17", speakerName: "Avery" };
  assert.equal(await appendRecallTranscriptSegment(ownerId, meetingId, second), "stored");
  assert.equal(await appendRecallTranscriptSegment(ownerId, meetingId, first), "stored");
  assert.equal(await appendRecallTranscriptSegment(ownerId, meetingId, second), "duplicate");
  assert.equal(await appendRecallTranscriptSegment(ownerId + 1, meetingId, first), "expired");

  const record = await readRecallTranscript(ownerId, meetingId);
  assert.deepEqual(record?.segments.map((segment) => segment.text), ["We agreed.", "The pilot starts Friday."]);
  assert.equal(await deleteRecallMeetingTranscript(ownerId + 1, meetingId), false);
  assert.equal(await deleteRecallMeetingTranscript(ownerId, meetingId), true);
  assert.equal(await readRecallTranscript(ownerId, meetingId), undefined);
});

test("search returns bounded matching excerpts only from unexpired transcripts owned by the caller", async () => {
  await initStore({ memoryOnly: true });
  await addRecallMeeting(ownerId, meeting({ title: "Acme sales call" }));
  await appendRecallTranscriptSegment(ownerId, meetingId, {
    id: "c".repeat(64), startMs: 12_000, endMs: 15_000,
    text: "Avery agreed to send the revised proposal on Friday.", speakerName: "Avery Chen",
  });

  const found = await searchRecallMeetingTranscripts(ownerId, "revised proposal Friday");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.meetingId, meetingId);
  assert.match(found[0]?.excerpt ?? "", /revised proposal on Friday/i);
  assert.equal((await searchRecallMeetingTranscripts(ownerId + 1, "revised proposal")).length, 0);

  await addRecallMeeting(ownerId, meeting({ id: "mtg_expired_transcript", transcriptExpiresAt: Date.now() - 1 }));
  await appendRecallTranscriptSegment(ownerId, "mtg_expired_transcript", {
    id: "d".repeat(64), startMs: 1, endMs: 2, text: "revised proposal",
  });
  assert.equal((await searchRecallMeetingTranscripts(ownerId, "revised proposal")).length, 1);
});

test("dedicated transcript key rotation fails closed instead of exposing or corrupting plaintext", async () => {
  await initStore({ memoryOnly: true });
  const id = "mtg_dedicated_transcript_key";
  await addRecallMeeting(ownerId, meeting({ id, transcriptRetentionDays: undefined, transcriptExpiresAt: undefined }));
  assert.equal(await appendRecallTranscriptSegment(ownerId, id, {
    id: "e".repeat(64), startMs: 1_000, endMs: 1_500, text: "Confidential commitment.",
  }), "stored");
  const originalKey = config.recallTranscriptEncryptionKey;
  config.recallTranscriptEncryptionKey = "a-different-dedicated-key-that-is-also-long-enough-to-be-valid";
  try {
    assert.equal(await readRecallTranscript(ownerId, id), undefined);
  } finally {
    config.recallTranscriptEncryptionKey = originalKey;
  }
  assert.equal((await readRecallTranscript(ownerId, id))?.segments[0]?.text, "Confidential commitment.");
});
