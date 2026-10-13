import test from "node:test";
import assert from "node:assert/strict";
import { normalizeVoiceCallControls, normalizeVoiceCallProfile, voiceCallDialBlockReason } from "../src/calls/voiceProfile.js";
import { DEFAULT_VOICE_EVALUATION_SCENARIOS, scoreVoiceTrace } from "../src/calls/voiceEvaluation.js";
import { voiceToolIsWithinCapabilityFence } from "../src/agent.js";

test("voice controls normalize compliance boundaries without changing legacy profiles", () => {
  const legacy = normalizeVoiceCallProfile({ identity: "Chusky" });
  assert.equal(legacy.controls, undefined);
  const controls = normalizeVoiceCallControls({ greetingMode: "static", allowVoicemail: false, recording: "announce", retentionDays: 7, timezone: "Europe/London", start: "22:00", end: "07:00", days: [1, 2, 3] });
  assert.deepEqual(controls?.quietHours, { timezone: "Europe/London", start: "22:00", end: "07:00", days: [1, 2, 3] });
  assert.equal(controls?.allowVoicemail, false);
});

test("quiet-hour controls block outbound dialing only inside the configured window", () => {
  const profile = normalizeVoiceCallProfile({ controls: { timezone: "UTC", start: "00:00", end: "23:59" } });
  assert.match(voiceCallDialBlockReason(profile, new Date("2026-10-13T12:00:00.000Z")) ?? "", /quiet hours/i);
});

test("voice evaluation scorecard checks role, disclosure, latency, tools, interruption, and resolution", () => {
  const scenario = DEFAULT_VOICE_EVALUATION_SCENARIOS[0];
  const result = scoreVoiceTrace({ direction: "outbound", representedPartyCorrect: true, purposeStated: true, aiDisclosureGiven: true, firstResponseMs: 650, expectedToolSlugs: ["GOOGLECALENDAR_FIND_FREE_SLOTS"], toolReceipts: [{ slug: "GOOGLECALENDAR_FIND_FREE_SLOTS", succeeded: true }], interruptionsHandled: true, resolved: true }, scenario);
  assert.equal(result.passed, true);
  assert.ok(result.score >= 95);
  assert.equal(result.dimensions.toolAccuracy, 100);
});

test("voice capability fence rejects unrelated connected-app actions", () => {
  assert.equal(voiceToolIsWithinCapabilityFence("GOOGLECALENDAR_FIND_FREE_SLOTS", ["GOOGLECALENDAR_FIND_FREE_SLOTS"]), true);
  assert.equal(voiceToolIsWithinCapabilityFence("STRIPE_CREATE_REFUND", ["GOOGLECALENDAR_FIND_FREE_SLOTS"]), false);
  assert.equal(voiceToolIsWithinCapabilityFence("CHUCK_LIST_PHONE_CALLS", []), true);
});
