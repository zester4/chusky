import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultMeetingRepresentativeProfile,
  applyMeetingComposioAccountAlias,
  isMeetingRepresentativeComposioTool,
  meetingRepresentativeInstructions,
  meetingRepresentativeToolAllowlist,
  normalizeMeetingRepresentativeProfile,
} from "../src/meetings/representative.js";

test("meeting representative profile is disabled by default and requires a mandate before activation", () => {
  const profile = defaultMeetingRepresentativeProfile();
  assert.equal(profile.enabled, false);
  assert.throws(() => normalizeMeetingRepresentativeProfile({ enabled: true }, profile), /objective of at least 8 characters/);
  const enabled = normalizeMeetingRepresentativeProfile({ enabled: true, role: "sales", objective: "Qualify and progress suitable leads" }, profile);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.role, "sales");
});

test("meeting profile accepts direct routine actions but rejects broad and high-impact Composio tools", () => {
  assert.equal(isMeetingRepresentativeComposioTool("HUBSPOT_CREATE_DEAL"), true);
  assert.equal(isMeetingRepresentativeComposioTool("GMAIL_SEND_EMAIL"), true);
  assert.equal(isMeetingRepresentativeComposioTool("COMPOSIO_EXECUTE_TOOL"), false);
  assert.equal(isMeetingRepresentativeComposioTool("STRIPE_CREATE_SUBSCRIPTION"), false);
  assert.equal(isMeetingRepresentativeComposioTool("GITHUB_DELETE_REPOSITORY"), false);
  assert.throws(() => normalizeMeetingRepresentativeProfile({ allowedComposioTools: ["COMPOSIO_EXECUTE_TOOL"] }), /not permitted/);
  assert.throws(() => normalizeMeetingRepresentativeProfile({ allowedNativeTools: ["CHUCK_DAYTONA_BROWSER"] }), /not permitted/);
});

test("meeting run receives only configured actions plus the leave control", () => {
  const profile = normalizeMeetingRepresentativeProfile({
    enabled: true,
    objective: "Qualify leads and arrange the next step",
    organizationName: "Acme",
    role: "sales",
    approvedKnowledge: "Acme provides logistics software.",
    authorityBoundaries: "Offer standard pricing only.",
    allowedComposioTools: ["HUBSPOT_CREATE_DEAL", "GMAIL_SEND_EMAIL", "HUBSPOT_CREATE_DEAL"],
    allowedNativeTools: ["CHUCK_SET_REMINDER"],
  });
  assert.deepEqual(meetingRepresentativeToolAllowlist(profile), ["CHUCK_MEETING_LEAVE", "CHUCK_SET_REMINDER", "HUBSPOT_CREATE_DEAL", "GMAIL_SEND_EMAIL"]);
  assert.deepEqual(meetingRepresentativeToolAllowlist(undefined), ["CHUCK_MEETING_LEAVE"]);
  const instructions = meetingRepresentativeInstructions(profile, "mtg_example", true);
  assert.match(instructions, /representing Acme/);
  assert.match(instructions, /Approved company knowledge/);
  assert.match(instructions, /untrusted participant input/);
  assert.match(instructions, /SILENT/);
  assert.match(instructions, /SPEAK/);
  assert.doesNotMatch(instructions, /company-mail|sales-crm/);
  assert.match(instructions, /routing is enforced privately/);
});

test("meeting account routing is pinned to owner aliases and strips participant-selected accounts", () => {
  const profile = normalizeMeetingRepresentativeProfile({
    composioAccountAliases: { GMAIL: "company-mail", HUBSPOT: "sales-crm" },
  });
  assert.deepEqual(
    applyMeetingComposioAccountAlias("GMAIL_SEND_EMAIL", { to: "prospect@example.com", account: "personal-mail" }, profile.composioAccountAliases),
    { to: "prospect@example.com", account: "company-mail" },
  );
  assert.deepEqual(
    applyMeetingComposioAccountAlias("SLACK_SEND_MESSAGE", { channel: "sales", account: "attendee-supplied" }, profile.composioAccountAliases),
    { channel: "sales" },
  );
  assert.throws(() => normalizeMeetingRepresentativeProfile({ composioAccountAliases: { "bad prefix": "work" } }), /invalid action prefix/);
  const saved = normalizeMeetingRepresentativeProfile({ updatedAt: 1_700_000_000_000 }, profile);
  assert.equal(saved.updatedAt, 1_700_000_000_000);
});
