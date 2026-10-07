import test from "node:test";
import assert from "node:assert/strict";
import { normalizePulsePreferences } from "../src/proactive/preferences.js";

test("pulse preferences default to an hourly preparation plan with safe starter domains", () => {
  assert.deepEqual(normalizePulsePreferences({ enabled: false }), {
    enabled: false,
    cadence: "hourly",
    authority: "prepare",
    maxPerDay: 4,
    deliveryTargets: [{ provider: "telegram" }],
    monitoredDomains: ["gmail", "calendar"],
  });
});

test("pulse preferences bound channels, domains, limits, and quiet hours", () => {
  const result = normalizePulsePreferences({
    enabled: true,
    cadence: "every_30_minutes",
    authority: "execute_reversible",
    maxPerDay: 12,
    deliveryTargets: [{ provider: "telegram", conversationId: "chat-1" }, { provider: "telegram", conversationId: "chat-1" }],
    monitoredDomains: ["Gmail", "calendar"],
    quietHoursUtc: { startMinute: 1320, endMinute: 420 },
  });
  assert.equal(result.deliveryTargets.length, 1);
  assert.deepEqual(result.monitoredDomains, ["gmail", "calendar"]);
  assert.deepEqual(result.quietHoursUtc, { startMinute: 1320, endMinute: 420 });
});

test("pulse preferences reject malformed values instead of coercing them", () => {
  assert.throws(() => normalizePulsePreferences({ enabled: true, quietHoursUtc: { startMinute: 1.5, endMinute: 20 } }), /quietHoursUtc/);
  assert.throws(() => normalizePulsePreferences({ enabled: true, deliveryTargets: [{ provider: "telegram", conversationId: 42 as unknown as string }] }), /conversationId/);
  assert.throws(() => normalizePulsePreferences({ enabled: true, monitoredDomains: ["gmail", "not safe"] }), /monitoredDomains/);
});
