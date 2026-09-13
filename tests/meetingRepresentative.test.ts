import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultMeetingRepresentativeProfile,
  applyMeetingComposioAccountAlias,
  isMeetingRepresentativeComposioTool,
  meetingRepresentativeGreeting,
  meetingConversationToolAllowlist,
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
  assert.match(instructions, /no SPEAK\/SILENT label/);
  assert.doesNotMatch(instructions, /company-mail|sales-crm/);
  assert.match(instructions, /routing is enforced privately/);
});

test("default meeting conversation can create owner follow-ups without reading private account data", () => {
  assert.deepEqual(meetingConversationToolAllowlist(), ["CHUCK_MEETING_LEAVE", "CHUCK_SET_REMINDER", "CHUCK_TASK_CREATE"]);
  assert.equal(meetingConversationToolAllowlist().includes("CHUCK_MEMORY_GET"), false);
  assert.equal(meetingConversationToolAllowlist().includes("CHUCK_TASK_LIST"), false);
});

test("spoken greeting is natural while the meeting notice remains the disclosure surface", () => {
  const profile = normalizeMeetingRepresentativeProfile({
    enabled: true,
    role: "sales",
    representativeName: "Chusky",
    organizationName: "Acme",
    objective: "Qualify leads and arrange next steps",
  });
  const greeting = meetingRepresentativeGreeting("representative", profile);
  assert.equal(greeting, "Hi everyone, I’m Chusky. I’m here with Acme to help move the conversation forward. Let’s get into it.");
  assert.doesNotMatch(greeting, /\bAI\b/i);
  assert.doesNotMatch(greeting, /say ‘Chusky’/i);
  assert.equal(meetingRepresentativeGreeting("copilot"), "Hi everyone, I’m Chusky. I’ll follow along and join in when I can help.");
  assert.equal(meetingRepresentativeGreeting("addressed"), "Hi everyone, I’m Chusky. Say my name if you’d like me to jump in.");
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

test("meeting scheduling is an explicit representative capability and context lookup requires a mission", () => {
  const profile = normalizeMeetingRepresentativeProfile({ enabled: true, objective: "Progress approved client meetings", allowMeetingScheduling: true });
  assert.equal(profile.allowMeetingScheduling, true);
  assert.equal(meetingRepresentativeToolAllowlist(profile).includes("CHUCK_MEETING_CONTEXT_LOOKUP"), false);
  const mission = { clientName: "Acme", objective: "Close", brief: "Client: Acme", sourceMemoryIds: [], preparedAt: 1 };
  const tools = meetingRepresentativeToolAllowlist(profile, mission);
  assert.equal(tools.includes("CHUCK_MEETING_CONTEXT_LOOKUP"), true);
  assert.equal(tools.includes("CHUCK_MEETING_JOIN"), true);
});

test("representative instructions include the complete bounded client brief and prohibit fabrication", () => {
  const profile = normalizeMeetingRepresentativeProfile({
    enabled: true,
    role: "sales",
    objective: "Progress the approved client conversation",
  });
  const mission = {
    clientName: "Acme",
    objective: "Close the onboarding package",
    brief: "Client: Acme\nObjective: Close the onboarding package\nRelevant owner-approved relationship facts:\n- Acme asked for a September start.",
    sourceMemoryIds: ["mem_acme"],
    preparedAt: 1,
  };
  const instructions = meetingRepresentativeInstructions(profile, "mtg_example", true, mission);
  assert.match(instructions, /Acme asked for a September start/);
  assert.match(instructions, /Ground client-specific claims/i);
  assert.match(instructions, /Never invent a name, number, date, product capability/i);
  assert.match(instructions, /no SPEAK\/SILENT label/);
});
