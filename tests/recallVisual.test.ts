import test from "node:test";
import assert from "node:assert/strict";
import {
  openRecallVisualFrame,
  sealRecallVisualFrame,
  validateRecallPngFrame,
} from "../src/meetings/visualFrames.js";
import { assertRecallVisualServiceHealth, receiveRecallVisualFrame, readRecallVisualContextFrame } from "../src/meetings/service.js";
import { config } from "../src/config.js";
import {
  addRecallMeeting,
  initStore,
  putRecallVisualFrame,
  readRecallVisualFrame,
  getRecallMeeting,
} from "../src/store.js";

const secret = "test-bridge-secret-with-more-than-32-bytes-0123456789";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WQAAAABJRU5ErkJggg==";

test("vision-enabled meeting preflight checks the voice service's optional configuration", async () => {
  await assert.rejects(() => assertRecallVisualServiceHealth("https://voice.example/recall/media", async () => new Response(JSON.stringify({ optionalFeatures: { sharedScreenUnderstanding: "disabled" } }), { status: 200 })), /Configure RECALL_REALTIME_SECRET and CHUSKY_RECALL_VISUAL_FRAME_URL/);
  await assert.rejects(() => assertRecallVisualServiceHealth("https://voice.example/recall/media", async () => { throw new Error("network down"); }), /Configure RECALL_REALTIME_SECRET and CHUSKY_RECALL_VISUAL_FRAME_URL/);
  await assertRecallVisualServiceHealth("https://voice.example/recall/media", async () => new Response(JSON.stringify({ optionalFeatures: { sharedScreenUnderstanding: "configured" } }), { status: 200 }));
});

test("Recall screen frame envelope is authenticated, scoped, and round-trips PNG bytes", () => {
  const sealed = sealRecallVisualFrame({ meetingId: "mtg_visual_1", userId: 42, base64: png, secret });
  assert.notEqual(sealed, png);
  assert.equal(openRecallVisualFrame({ meetingId: "mtg_visual_1", userId: 42, sealed, secret }), png);
  assert.throws(() => openRecallVisualFrame({ meetingId: "mtg_other", userId: 42, sealed, secret }));
  assert.throws(() => openRecallVisualFrame({ meetingId: "mtg_visual_1", userId: 43, sealed, secret }));
  assert.throws(() => openRecallVisualFrame({ meetingId: "mtg_visual_1", userId: 42, sealed, secret: "wrong-secret" }));
});

test("Recall screen frame validation accepts bounded PNGs and rejects malformed or oversized images", () => {
  assert.equal(validateRecallPngFrame(png).length > 24, true);
  assert.throws(() => validateRecallPngFrame("not-an-image"));
  assert.throws(() => validateRecallPngFrame(Buffer.from(png, "base64").toString("base64url")));
  const oversized = Buffer.from(png, "base64");
  oversized.writeUInt32BE(8_192, 16);
  assert.throws(() => validateRecallPngFrame(oversized.toString("base64")));
});

test("Recall screen frames use an encrypted short-TTL cache, never the meeting record", async () => {
  await initStore({ memoryOnly: true });
  const userId = 987_654;
  const meetingId = "mtg_visual_buffer";
  await addRecallMeeting(userId, {
    id: meetingId,
    userId,
    platform: "google_meet",
    status: "in_call",
    visualContextEnabled: true,
    meetingUrlHash: "a".repeat(64),
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const sealed = sealRecallVisualFrame({ meetingId, userId, base64: png, secret });
  assert.equal(await putRecallVisualFrame(userId, meetingId, sealed), true);
  assert.equal(await putRecallVisualFrame(userId, meetingId, sealed), false, "per-meeting writes are rate limited");
  const latest = await readRecallVisualFrame(userId, meetingId);
  assert.equal(openRecallVisualFrame({ meetingId, userId, sealed: latest!, secret }), png);
  assert.equal(await readRecallVisualFrame(userId, meetingId), latest, "static screen remains available inside its encrypted short TTL");
  const record = await getRecallMeeting(userId, meetingId);
  assert.equal(record?.visualContextEnabled, true);
  assert.equal(JSON.stringify(record).includes(png), false, "raw screenshots must never enter durable meeting history");
});

test("Recall visual ingestion enforces owned bot, active status, opt-in, and ephemeral multimodal context", async () => {
  await initStore({ memoryOnly: true });
  config.recallMeetingsEnabled = true;
  config.recallMediaBridgeSecret = secret;
  const userId = 987_655;
  const meetingId = "mtg_visual_ingest";
  await addRecallMeeting(userId, {
    id: meetingId,
    userId,
    platform: "zoom",
    status: "in_call",
    providerBotId: "recall_bot_visual",
    visualContextEnabled: true,
    meetingUrlHash: "b".repeat(64),
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(await receiveRecallVisualFrame({ userId, meetingId, providerBotId: "wrong_bot", base64: png }), "unavailable");
  assert.equal(await receiveRecallVisualFrame({ userId, meetingId, providerBotId: "recall_bot_visual", base64: png }), "accepted");
  assert.equal(await receiveRecallVisualFrame({ userId, meetingId, providerBotId: "recall_bot_visual", base64: png }), "rate_limited");
  assert.equal(await readRecallVisualContextFrame(userId, meetingId), png);
  assert.equal(await readRecallVisualContextFrame(userId, meetingId), png);
  const record = await getRecallMeeting(userId, meetingId);
  assert.equal(record?.history.length, 0);
  assert.equal(JSON.stringify(record).includes(png), false);
  config.recallMeetingsEnabled = false;
});

test("Recall visual frames retry during meeting startup instead of poisoning an unchanged first slide", async () => {
  await initStore({ memoryOnly: true });
  const userId = 987_656;
  const meetingId = "mtg_visual_starting";
  await addRecallMeeting(userId, {
    id: meetingId,
    userId,
    platform: "google_meet",
    status: "joining",
    providerBotId: "recall_bot_starting",
    visualContextEnabled: true,
    meetingUrlHash: "c".repeat(64),
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(await receiveRecallVisualFrame({ userId, meetingId, providerBotId: "recall_bot_starting", base64: png }), "not_ready");
  assert.equal(await readRecallVisualFrame(userId, meetingId), undefined);
});
