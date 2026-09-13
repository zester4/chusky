import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { parseGoogleCalendarMeetingTrigger, openCalendarMeetingUrl, sealCalendarMeetingUrl } from "../src/meetings/calendar.js";
import { getCalendarMeetingPreparation, initStore, listCalendarMeetingPreparations, saveCalendarMeetingPreparation } from "../src/store.js";

const originalWebhookSecret = config.webhookSecret;

before(async () => {
  config.webhookSecret = "calendar-meeting-test-secret";
  await initStore({ memoryOnly: true });
});

after(() => { config.webhookSecret = originalWebhookSecret; });

test("recognises only supported conference events among Google Calendar lifecycle triggers", () => {
  const created = parseGoogleCalendarMeetingTrigger("GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER", {
    event: {
      id: "calendar-event-1",
      summary: "Acme discovery",
      start: { dateTime: "2026-10-01T14:00:00Z" },
      conferenceData: { entryPoints: [{ uri: "https://meet.google.com/abc-defg-hij" }] },
      attendees: [{ displayName: "Avery" }, { email: "client@example.com" }],
    },
  });
  assert.deepEqual(created, {
    lifecycle: "created",
    calendarEventId: "calendar-event-1",
    title: "Acme discovery",
    startAt: "2026-10-01T14:00:00Z",
    participants: ["Avery", "client@example.com"],
    meetingUrl: "https://meet.google.com/abc-defg-hij",
  });
  assert.equal(parseGoogleCalendarMeetingTrigger("GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER", { event: { summary: "Lunch" } }), undefined);
  assert.equal(parseGoogleCalendarMeetingTrigger("GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_UPDATED_TRIGGER", { event: { hangoutLink: "https://example.com/not-a-meeting" } }), undefined);
  assert.deepEqual(parseGoogleCalendarMeetingTrigger("GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER", { event: { id: "calendar-event-1", summary: "Acme discovery" } }), {
    lifecycle: "cancelled", calendarEventId: "calendar-event-1", title: "Acme discovery", participants: [],
  });
  assert.equal(parseGoogleCalendarMeetingTrigger("GOOGLECALENDAR_SOMETHING_ELSE", {}), undefined);
});

test("seals meeting URLs and keeps list views free of the link", async () => {
  const url = "https://meet.google.com/abc-defg-hij";
  const sealed = sealCalendarMeetingUrl(url);
  assert.notEqual(sealed, url);
  assert.equal(openCalendarMeetingUrl(sealed), url);
  const owner = 880001;
  await saveCalendarMeetingPreparation(owner, {
    id: "cmp_calendar_test_1", userId: owner, sourceTriggerEventId: "trigger-event-1", calendarEventId: "calendar-event-1",
    lifecycle: "created", status: "prepared", title: "Acme discovery", participants: ["Avery"], sealedMeetingUrl: sealed,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  const stored = await getCalendarMeetingPreparation(owner, "cmp_calendar_test_1");
  assert.equal(stored?.sealedMeetingUrl, sealed);
  assert.equal((await getCalendarMeetingPreparation(owner + 1, "cmp_calendar_test_1")), undefined);
  const listed = await listCalendarMeetingPreparations(owner);
  assert.equal("sealedMeetingUrl" in listed[0]!, false);
  assert.equal(JSON.stringify(listed).includes(url), false);
});
