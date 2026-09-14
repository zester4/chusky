import test, { before } from "node:test";
import assert from "node:assert/strict";
import { chuckTools, validateNativeToolArguments } from "../src/agentTools.js";
import { nativeTool } from "../src/nativeTools.js";
import { addRecallMeeting, getMeetingRepresentativeProfile, initStore, updateMeetingRepresentativeProfile } from "../src/store.js";

const ownerId = 812340;
const meetingId = "mtg_contact_test";

before(async () => {
  await initStore({ memoryOnly: true });
  await updateMeetingRepresentativeProfile(ownerId, { enabled: true, objective: "Understand interest and agree a practical next step" });
  await addRecallMeeting(ownerId, {
    id: meetingId,
    userId: ownerId,
    platform: "google_meet",
    interactionMode: "representative",
    status: "in_call",
    meetingUrlHash: "a".repeat(64),
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
});

test("meeting contact tools expose the meeting capture and private owner review contracts", () => {
  const tools = new Map(chuckTools.map((tool) => [tool.function.name, tool.function.parameters]));
  for (const name of ["CHUCK_MEETING_CONTACT_CAPTURE", "CHUCK_MEETING_CONTACTS_LIST", "CHUCK_MEETING_CONTACT_DELETE", "CHUCK_MEETING_FOLLOWUP_SCHEDULE"]) assert.ok(tools.has(name), name);
  validateNativeToolArguments("CHUCK_MEETING_CONTACT_CAPTURE", {
    participantName: "Avery Chen", email: "avery@example.com", interest: "Interested in a vehicle test drive", nextStep: "Book a test drive next week",
  });
  assert.throws(() => validateNativeToolArguments("CHUCK_MEETING_CONTACT_CAPTURE", { participantName: "Avery Chen" }), /requires argument/);
});

test("representative meeting captures participant-shared contact details privately and idempotently", async () => {
  const followUpAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const input = {
    participantName: "Avery Chen",
    email: "avery@example.com",
    contactPreference: "email",
    interest: "Interested in a vehicle test drive",
    nextStep: "Book a test drive next week",
    followUpAt,
  };
  const first = await nativeTool(ownerId, "CHUCK_MEETING_CONTACT_CAPTURE", input, { meetingId }) as { id: string; participantName: string };
  const repeated = await nativeTool(ownerId, "CHUCK_MEETING_CONTACT_CAPTURE", input, { meetingId }) as { id: string };
  assert.equal(repeated.id, first.id);
  assert.equal(first.participantName, "Avery Chen");
  const contacts = await nativeTool(ownerId, "CHUCK_MEETING_CONTACTS_LIST", {}) as Array<{ id: string; email?: string; interest: string; followUpAt?: number }>;
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]?.id, first.id);
  assert.equal(contacts[0]?.email, "avery@example.com");
  assert.match(contacts[0]?.interest ?? "", /test drive/);
  assert.equal(contacts[0]?.followUpAt, Date.parse(followUpAt));
  assert.deepEqual(await nativeTool(ownerId + 1, "CHUCK_MEETING_CONTACTS_LIST", {}), []);
});

test("meeting capture requires an active owned representative meeting; private contact list rejects shared channels", async () => {
  await assert.rejects(() => nativeTool(ownerId, "CHUCK_MEETING_CONTACT_CAPTURE", {
    participantName: "Taylor", phone: "+14155550123", interest: "Asked for more information",
  }), /active representative meeting/);
  await assert.rejects(() => nativeTool(ownerId, "CHUCK_MEETING_CONTACT_CAPTURE", {
    participantName: "Taylor", phone: "+14155550123", interest: "Asked for more information",
  }, { meetingId: "mtg_missing" }), /not found or is not an active representative meeting/);
  await assert.rejects(() => nativeTool(ownerId, "CHUCK_MEETING_CONTACT_CAPTURE", {
    participantName: "Taylor", interest: "Asked for more information",
  }, { meetingId }), /email or phone number/);
  await assert.rejects(() => nativeTool(ownerId, "CHUCK_MEETING_CONTACTS_LIST", {}, { sharedConversation: true }), /private owner conversation/);
  const profile = await getMeetingRepresentativeProfile(ownerId);
  assert.equal(profile.enabled, true);
});

test("owner can delete a captured contact from their private Chusky conversation", async () => {
  const contact = await nativeTool(ownerId, "CHUCK_MEETING_CONTACT_CAPTURE", {
    participantName: "Jordan Lee", phone: "+14155550125", contactPreference: "phone", interest: "Interested in the onboarding program",
  }, { meetingId }) as { id: string };
  const deleted = await nativeTool(ownerId, "CHUCK_MEETING_CONTACT_DELETE", { id: contact.id });
  assert.deepEqual(deleted, { deleted: true, id: contact.id });
  const contacts = await nativeTool(ownerId, "CHUCK_MEETING_CONTACTS_LIST", {}) as Array<{ id: string }>;
  assert.equal(contacts.some((item) => item.id === contact.id), false);
  await assert.rejects(() => nativeTool(ownerId, "CHUCK_MEETING_CONTACT_DELETE", { id: contact.id }, { sharedConversation: true }), /private owner conversation/);
});
