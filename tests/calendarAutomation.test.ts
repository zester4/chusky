import test from "node:test";
import assert from "node:assert/strict";
import { planCalendarAutoJoin } from "../src/meetings/calendarAutomation.js";

const base = {
  enabled: true,
  lifecycle: "created" as const,
  meetingUrlHash: "a".repeat(64),
  startAt: "2026-09-14T15:00:00.000Z",
  endAt: "2026-09-14T16:00:00.000Z",
  nowMs: Date.parse("2026-09-14T14:00:00.000Z"),
};

test("calendar auto-join schedules only when explicitly enabled and at the documented lead time", () => {
  assert.deepEqual(planCalendarAutoJoin({ ...base, enabled: false }), { action: "skip", reason: "disabled" });
  assert.deepEqual(planCalendarAutoJoin(base), { action: "schedule", joinAt: "2026-09-14T15:00:00.000Z" });
});

test("near-start events join immediately and expired or malformed events do not schedule", () => {
  assert.deepEqual(planCalendarAutoJoin({
    ...base,
    startAt: "2026-09-14T14:05:00.000Z",
  }), { action: "schedule" });
  assert.deepEqual(planCalendarAutoJoin({ ...base, startAt: "not-a-date" }), { action: "skip", reason: "invalid-time" });
  assert.deepEqual(planCalendarAutoJoin({ ...base, endAt: "2026-09-14T13:59:00.000Z" }), { action: "skip", reason: "expired" });
  assert.deepEqual(planCalendarAutoJoin({ ...base, startAt: "2026-10-20T14:00:00.000Z" }), { action: "skip", reason: "too-far" });
});

test("cancellation removes a previously auto-scheduled bot but never cancels a manual join", () => {
  const existing = { automatic: true, meetingUrlHash: base.meetingUrlHash, joinAt: base.startAt, status: "scheduled" as const };
  assert.deepEqual(planCalendarAutoJoin({ ...base, lifecycle: "cancelled", existing }), { action: "cancel" });
  assert.deepEqual(planCalendarAutoJoin({ ...base, lifecycle: "cancelled", existing: { ...existing, automatic: false } }), { action: "skip", reason: "not-automatic" });
  assert.deepEqual(planCalendarAutoJoin({ ...base, lifecycle: "cancelled", existing: { ...existing, status: "in_call" } }), { action: "keep" });
});

test("unchanged calendar retries are idempotent and reschedules replace only a future automatic bot", () => {
  const existing = { automatic: true, meetingUrlHash: base.meetingUrlHash, joinAt: base.startAt, status: "scheduled" as const };
  assert.deepEqual(planCalendarAutoJoin({ ...base, existing }), { action: "keep" });
  assert.deepEqual(planCalendarAutoJoin({ ...base, meetingUrlHash: "b".repeat(64), existing }), { action: "reschedule", joinAt: base.startAt });
  assert.deepEqual(planCalendarAutoJoin({ ...base, lifecycle: "updated", meetingUrlHash: "b".repeat(64), existing: { ...existing, status: "in_call" } }), { action: "keep" });
});
