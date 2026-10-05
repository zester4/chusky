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

test("Recall calendar match remains a non-confirmed identity hint", () => {
  const result = resolveRecallMeetingSpeaker(
    [{ type: "speech_on", participantId: "p1", at: 1_000 }, { type: "speech_off", participantId: "p1", at: 2_000 }],
    [{ id: "p1", name: "Sarah Lee", email: "sarah@example.com", status: "present", updatedAt: 1_000, assurance: "calendar_matched" }],
    1_000,
    2_000,
  );
  assert.equal(result?.assurance, "calendar_matched");
  assert.equal(result?.email, "sarah@example.com");
});
