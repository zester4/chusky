import test from "node:test";
import assert from "node:assert/strict";
import { resolveRecallMeetingSpeaker } from "../src/meetings/participants.js";

test("display-name-only Recall speaker remains unverified", () => {
  const result = resolveRecallMeetingSpeaker(
    [{ type: "speech_on", participantId: "p1", at: 1_000 }, { type: "speech_off", participantId: "p1", at: 2_000 }],
    [{ id: "p1", name: "Sarah Lee", status: "present", updatedAt: 1_000, assurance: "unverified" }],
    1_000,
    2_000,
  );
  assert.equal(result?.assurance, "unverified");
});

test("calendar-verified participant carries only the verified email", () => {
  const result = resolveRecallMeetingSpeaker(
    [{ type: "speech_on", participantId: "p1", at: 1_000 }, { type: "speech_off", participantId: "p1", at: 2_000 }],
    [{ id: "p1", name: "Sarah Lee", email: "sarah@example.com", status: "present", updatedAt: 1_000, assurance: "calendar_verified" }],
    1_000,
    2_000,
  );
  assert.equal(result?.assurance, "calendar_verified");
  assert.equal(result?.email, "sarah@example.com");
});
