import test from "node:test";
import assert from "node:assert/strict";
import { parseRecallParticipantWebhook } from "../src/meetings/recall.js";
import { buildMeetingInput } from "../src/meetings/context.js";

function participantEvent(event: string, participant: Record<string, unknown>) {
  return {
    event,
    data: {
      data: { participant },
      bot: { id: "bot_123", metadata: { chusky_meeting_id: "mtg_123", chusky_user_id: "42" } },
    },
  };
}

test("participant lifecycle events retain only a bounded display roster", () => {
  assert.deepEqual(parseRecallParticipantWebhook(participantEvent("participant_events.join", {
    id: 456, name: "  Avery   Smith ", is_host: true, email: "private@example.com",
  })), {
    providerBotId: "bot_123", meetingId: "mtg_123", userId: 42,
    participant: { id: "456", name: "Avery Smith", isHost: true, status: "present" },
  });
  assert.deepEqual(parseRecallParticipantWebhook(participantEvent("participant_events.leave", { id: "456", name: "Avery Smith" }))?.participant, {
    id: "456", name: "Avery Smith", status: "left",
  });
  assert.equal(parseRecallParticipantWebhook(participantEvent("participant_events.join", { id: 456, email: "private@example.com" })), undefined);
  assert.equal(parseRecallParticipantWebhook(participantEvent("participant_events.chat_message", { id: 456, name: "Avery Smith" })), undefined);
});

test("live roster is context rather than verified identity", () => {
  const input = buildMeetingInput([], "Can you help?", [{ name: "Avery Smith", isHost: true }]);
  assert.match(input, /Live roster/);
  assert.match(input, /not verified identity/);
  assert.match(input, /Avery Smith/);
  assert.doesNotMatch(input, /private@example\.com/);
});
