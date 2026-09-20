import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  attachMeetingToRoom,
  createMeetingRoom,
  deleteMeetingRoom,
  getMeetingRoom,
  initStore,
  listMeetingRooms,
  listWorkspaceMeetingPointers,
  updateMeetingRoom,
  type MeetingRoomRecord,
} from "../src/store.js";
import { meetingRepresentativeToolAllowlist } from "../src/meetings/representative.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

function room(overrides: Partial<MeetingRoomRecord> = {}): MeetingRoomRecord {
  const now = Date.now();
  return {
    id: `room_test_${Math.random().toString(36).slice(2)}`,
    organizationId: "better-auth-org-123",
    name: "Marketing weekly",
    createdByWebAuthUserId: "web-user-1",
    policy: {
      defaultMode: "addressed",
      visibility: "team",
      allowScreenUnderstanding: false,
      requireApprovalForExternalActions: true,
      allowedComposioTools: ["GOOGLECALENDAR_FIND_EVENT"],
      allowedNativeTools: ["CHUCK_MEETING_CONTEXT_LOOKUP"],
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("meeting rooms persist organization/team policy and shared pointers without owner leakage", async () => {
  const created = await createMeetingRoom(room({ teamId: "marketing-team" }));
  assert.equal((await getMeetingRoom(created.id))?.organizationId, "better-auth-org-123");
  assert.equal((await listMeetingRooms("better-auth-org-123"))[0]?.policy.visibility, "team");

  await attachMeetingToRoom(created.id, "mtg_shared_1", 810501);
  const pointers = await listWorkspaceMeetingPointers("better-auth-org-123");
  assert.deepEqual(pointers[0], {
    meetingId: "mtg_shared_1",
    ownerUserId: 810501,
    roomId: created.id,
    organizationId: "better-auth-org-123",
    teamId: "marketing-team",
    visibility: "team",
  });
  assert.equal(JSON.stringify(pointers).includes("meetingUrl"), false);
});

test("meeting room updates merge policy and deletion removes only the room", async () => {
  const created = await createMeetingRoom(room({ organizationId: "org-finance" }));
  const updated = await updateMeetingRoom(created.id, { name: "Finance review", policy: { ...created.policy, visibility: "organization", requireApprovalForExternalActions: true } });
  assert.equal(updated?.name, "Finance review");
  assert.equal(updated?.policy.visibility, "organization");
  assert.equal(await deleteMeetingRoom(created.id), true);
  assert.equal(await getMeetingRoom(created.id), undefined);
});

test("room policy intersects representative tools while preserving leave control", async () => {
  const profile = {
    enabled: true,
    allowedNativeTools: ["CHUCK_MEETING_CONTEXT_LOOKUP", "CHUCK_MEETING_CONTACT_CAPTURE"],
    allowedComposioTools: ["GMAIL_SEND_EMAIL", "GOOGLECALENDAR_FIND_EVENT"],
  } as Parameters<typeof meetingRepresentativeToolAllowlist>[0];
  const tools = meetingRepresentativeToolAllowlist(profile, undefined, {
    allowedNativeTools: ["CHUCK_MEETING_CONTEXT_LOOKUP"],
    allowedComposioTools: ["GOOGLECALENDAR_FIND_EVENT"],
  });
  assert.deepEqual(tools, ["CHUCK_MEETING_LEAVE", "CHUCK_MEETING_CONTEXT_LOOKUP", "GOOGLECALENDAR_FIND_EVENT"]);
});
