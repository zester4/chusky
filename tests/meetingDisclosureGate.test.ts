import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { meetingDisclosureCheck } from "../src/decisions/disclosureGate.js";

test("disabled and shadow meeting disclosure checks never replace ordinary replies", async () => {
  const prior = { enabled: config.meetingDisclosureGateEnabled, mode: config.meetingDisclosureGateMode };
  config.meetingDisclosureGateEnabled = false;
  config.meetingDisclosureGateMode = "shadow";
  try {
    const ordinaryReplies = [
      "I'll email you the notes after the meeting.",
      "Our CEO will join the next call.",
      "That's a private matter I'll take offline.",
      "Happy to walk through the pricing tiers on our site.",
      "Let me check with the owner and follow up.",
    ];
    for (const text of ordinaryReplies) {
      const result = await meetingDisclosureCheck({ text, usedRecordTool: false, verifiedParticipant: false });
      assert.equal(result.allowed, true, text);
    }
  } finally {
    config.meetingDisclosureGateEnabled = prior.enabled;
    config.meetingDisclosureGateMode = prior.mode;
  }
});

test("shadow mode allows replies even when its proposed decision would block", async () => {
  const prior = { enabled: config.meetingDisclosureGateEnabled, mode: config.meetingDisclosureGateMode };
  config.meetingDisclosureGateEnabled = true;
  config.meetingDisclosureGateMode = "shadow";
  const client = {
    available: () => true,
    evaluate: async () => ({ answers: { disclosure: { type: "choice", choice: "block", confidence: 1 } }, latencyMs: 1, costUsd: 0, model: "test" }),
  } as any;
  try {
    const result = await meetingDisclosureCheck({ text: "ordinary reply", usedRecordTool: false, verifiedParticipant: true, client });
    assert.equal(result.allowed, true);
    assert.equal(result.shadow, true);
  } finally {
    config.meetingDisclosureGateEnabled = prior.enabled;
    config.meetingDisclosureGateMode = prior.mode;
  }
});
