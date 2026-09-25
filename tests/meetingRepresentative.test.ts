import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultMeetingRepresentativeProfile,
  applyMeetingComposioAccountAlias,
  isMeetingRepresentativeComposioTool,
  isMeetingCalendarAvailabilityTool,
  isMeetingCalendarToolkit,
  isMeetingCalendarWriteTool,
  selectMeetingToolsForToolkit,
  selectMeetingCalendarTools,
  meetingRepresentativeGreeting,
  meetingConversationToolAllowlist,
  meetingRepresentativeInstructions,
  meetingRepresentativeCopilotInstructions,
  meetingRepresentativeToolAllowlist,
  needsPrivateMeetingBriefBeforeJoin,
  normalizeMeetingRepresentativeProfile,
} from "../src/meetings/representative.js";

test("meeting representative profile is disabled by default and requires a mandate before activation", () => {
  const profile = defaultMeetingRepresentativeProfile();
  assert.equal(profile.enabled, false);
  assert.equal(profile.autoJoinCalendar, false);
  assert.throws(() => normalizeMeetingRepresentativeProfile({ enabled: true }, profile), /objective of at least 8 characters/);
  const enabled = normalizeMeetingRepresentativeProfile({ enabled: true, role: "sales", objective: "Qualify and progress suitable leads" }, profile);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.role, "sales");
});

test("calendar capability discovery admits only schema-backed routine calendar reads and booking writes", () => {
  const schema = { type: "object", properties: {} };
  const tools = [
    { function: { name: "GOOGLECALENDAR_LIST_EVENTS", parameters: schema } },
    { function: { name: "GOOGLECALENDAR_CHECK_AVAILABILITY", parameters: schema } },
    { function: { name: "GOOGLECALENDAR_UPDATE_EVENT", parameters: schema } },
    { function: { name: "GOOGLECALENDAR_CREATE_EVENT", parameters: schema } },
    { function: { name: "GOOGLECALENDAR_DELETE_EVENT", parameters: schema } },
    { function: { name: "GMAIL_SEND_EMAIL", parameters: schema } },
    { function: { name: "GOOGLECALENDAR_UPDATE_EVENT" } },
  ];
  const selected = selectMeetingCalendarTools("googlecalendar", tools);
  assert.deepEqual(selected.map((tool: any) => tool.function.name), [
    "GOOGLECALENDAR_LIST_EVENTS",
    "GOOGLECALENDAR_CHECK_AVAILABILITY",
    "GOOGLECALENDAR_UPDATE_EVENT",
    "GOOGLECALENDAR_CREATE_EVENT",
  ]);
  assert.equal(isMeetingCalendarToolkit("outlook_calendar"), true);
  assert.equal(isMeetingCalendarAvailabilityTool("OUTLOOK_CALENDAR_LIST_EVENTS"), true);
  assert.equal(isMeetingCalendarWriteTool("GOOGLECALENDAR_UPDATE_EVENT"), true);
  assert.equal(isMeetingCalendarWriteTool("GOOGLECALENDAR_DELETE_EVENT"), false);
});

test("mission-driven discovery admits relevant HR and CRM record work but rejects destructive, meta, and schema-less actions", () => {
  const schema = { type: "object", properties: { candidate_id: { type: "string" } } };
  const tools = [
    { function: { name: "ASHBY_GET_CANDIDATE", description: "Read a candidate profile", parameters: schema } },
    { function: { name: "ASHBY_LIST_APPLICATIONS", description: "List applications", parameters: schema } },
    { function: { name: "ASHBY_UPDATE_CANDIDATE", description: "Update a candidate", parameters: schema } },
    { function: { name: "ASHBY_DELETE_CANDIDATE", description: "Delete a candidate", parameters: schema } },
    { function: { name: "HUBSPOT_SEARCH_CONTACTS", description: "Find customer contacts", parameters: schema } },
    { function: { name: "HUBSPOT_CREATE_NOTE", description: "Add an account note", parameters: schema } },
    { function: { name: "HUBSPOT_SEND_PAYMENT", description: "Charge a customer", parameters: schema } },
    { function: { name: "GMAIL_SEND_EMAIL", description: "Send an email", parameters: schema } },
    { function: { name: "COMPOSIO_EXECUTE_TOOL", description: "Generic executor", parameters: schema } },
    { function: { name: "ASHBY_GET_INTERVIEW", description: "Missing schema" } },
    { function: { name: "SALESFORCE_GET_CONTACT", description: "Wrong toolkit", parameters: schema } },
  ];
  const selected = selectMeetingToolsForToolkit("ashby", tools);
  assert.deepEqual(selected.map((tool: any) => tool.function.name), [
    "ASHBY_GET_CANDIDATE",
    "ASHBY_LIST_APPLICATIONS",
    "ASHBY_UPDATE_CANDIDATE",
  ]);
  assert.deepEqual(selectMeetingToolsForToolkit("hubspot", tools).map((tool: any) => tool.function.name), [
    "HUBSPOT_SEARCH_CONTACTS",
    "HUBSPOT_CREATE_NOTE",
  ]);
});

test("calendar auto-join requires an enabled owner-configured representative", () => {
  const defaults = defaultMeetingRepresentativeProfile();
  assert.throws(() => normalizeMeetingRepresentativeProfile({ autoJoinCalendar: true }, defaults), /enabled representative/);
  const profile = normalizeMeetingRepresentativeProfile({
    enabled: true,
    objective: "Represent me in approved customer meetings",
    autoJoinCalendar: true,
  }, defaults);
  assert.equal(profile.autoJoinCalendar, true);
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

test("meeting run receives only configured actions and cannot leave on participant instruction", () => {
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
  assert.deepEqual(meetingRepresentativeToolAllowlist(profile), ["CHUCK_MEETING_JOIN", "CHUCK_MEETING_CONTEXT_LOOKUP", "CHUCK_MEETING_CONTACT_CAPTURE", "CHUCK_MEETING_FOLLOWUP_SCHEDULE", "CHUCK_SET_REMINDER", "HUBSPOT_CREATE_DEAL", "GMAIL_SEND_EMAIL"]);
  assert.deepEqual(meetingRepresentativeToolAllowlist(undefined), []);
  const instructions = meetingRepresentativeInstructions(profile, "mtg_example", true);
  assert.match(instructions, /sales representative for Acme/i);
  assert.match(instructions, /Approved company knowledge/);
  assert.match(instructions, /untrusted participant input/);
  assert.match(instructions, /thoughtful participant/i);
  assert.match(instructions, /Do not wait to be addressed/i);
  assert.match(instructions, /ask a useful follow-up question/i);
  assert.match(instructions, /yield immediately when someone starts speaking over you/i);
  assert.match(instructions, /rather check than guess/i);
  assert.match(instructions, /move the conversation forward/i);
  assert.match(instructions, /SILENT/);
  assert.match(instructions, /no SPEAK\/SILENT label/);
  assert.doesNotMatch(instructions, /company-mail|sales-crm/);
  assert.match(instructions, /routing is enforced privately/);
  assert.match(instructions, /Do not use canned language/i);
  assert.match(instructions, /Treat the objective as the agenda/i);
  assert.match(instructions, /Do not decide that the meeting is over/i);
  const copilotInstructions = meetingRepresentativeCopilotInstructions("mtg_example");
  assert.match(copilotInstructions, /thoughtful participant/i);
  assert.match(copilotInstructions, /Do not wait to be addressed/i);
  assert.match(copilotInstructions, /Do not use canned language/i);
  const addressedInstructions = meetingRepresentativeCopilotInstructions("mtg_example", "addressed");
  assert.doesNotMatch(addressedInstructions, /Do not wait to be addressed/i);
  assert.match(addressedInstructions, /only speak when directly addressed/i);
});

test("default meeting conversation can create owner follow-ups without reading private account data or leaving", () => {
  assert.deepEqual(meetingConversationToolAllowlist(), ["CHUCK_SET_REMINDER", "CHUCK_TASK_CREATE"]);
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
  assert.equal(greeting, "Hi, I’m Chusky.");
  assert.doesNotMatch(greeting, /\bAI\b/i);
  assert.doesNotMatch(greeting, /move the conversation forward/i);
  assert.equal(meetingRepresentativeGreeting("copilot"), "Hi, I’m Chusky.");
  assert.equal(meetingRepresentativeGreeting("addressed"), "Hi, I’m Chusky.");
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

test("representative runs always get meeting context, contact capture, and follow-up scheduling without an extra meeting toggle", () => {
  const profile = normalizeMeetingRepresentativeProfile({ enabled: true, objective: "Progress approved client meetings", allowMeetingScheduling: false });
  assert.equal(profile.allowMeetingScheduling, false, "legacy field is retained for stored-profile compatibility");
  assert.equal(meetingRepresentativeToolAllowlist(profile).includes("CHUCK_MEETING_CONTEXT_LOOKUP"), true);
  assert.equal(meetingRepresentativeToolAllowlist(profile).includes("CHUCK_MEETING_CONTACT_CAPTURE"), true);
  assert.equal(meetingRepresentativeToolAllowlist(profile).includes("CHUCK_MEETING_JOIN"), true);
  assert.equal(meetingRepresentativeToolAllowlist(profile).includes("CHUCK_MEETING_CONTACTS_LIST"), false);
  const mission = { clientName: "Acme", objective: "Close", brief: "Client: Acme", sourceMemoryIds: [], preparedAt: 1 };
  const tools = meetingRepresentativeToolAllowlist(profile, mission);
  assert.equal(tools.includes("CHUCK_MEETING_CONTEXT_LOOKUP"), true);
  assert.equal(tools.includes("CHUCK_MEETING_JOIN"), true);
});

test("representative direct joins require private owner context, while copilot and known meetings proceed", () => {
  const profile = normalizeMeetingRepresentativeProfile({ enabled: true, objective: "Represent approved customer meetings" });
  assert.equal(needsPrivateMeetingBriefBeforeJoin(profile, {}), true);
  assert.equal(needsPrivateMeetingBriefBeforeJoin(profile, { interactionMode: "copilot" }), false);
  assert.equal(needsPrivateMeetingBriefBeforeJoin(profile, { title: "Acme onboarding kickoff" }), false);
  assert.equal(needsPrivateMeetingBriefBeforeJoin(profile, { hasSourceMeeting: true }), false);
  assert.equal(needsPrivateMeetingBriefBeforeJoin(defaultMeetingRepresentativeProfile(), {}), false);
});

test("delayed meeting email scheduling is exposed only with an exact enabled email action", () => {
  const withoutEmail = normalizeMeetingRepresentativeProfile({ enabled: true, objective: "Progress approved client meetings", allowedComposioTools: ["HUBSPOT_CREATE_DEAL"] });
  const withEmail = normalizeMeetingRepresentativeProfile({ enabled: true, objective: "Progress approved client meetings", allowedComposioTools: ["GMAIL_SEND_EMAIL"] });
  assert.equal(meetingRepresentativeToolAllowlist(withoutEmail).includes("CHUCK_MEETING_FOLLOWUP_SCHEDULE"), false);
  assert.equal(meetingRepresentativeToolAllowlist(withEmail).includes("CHUCK_MEETING_FOLLOWUP_SCHEDULE"), true);
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
  assert.match(instructions, /Do not use canned language/i);
  assert.match(instructions, /no SPEAK\/SILENT label/);
});

test("representative coaching teaches natural qualification, accurate booking, and useful follow-through", () => {
  const profile = normalizeMeetingRepresentativeProfile({ enabled: true, objective: "Build trust and agree the right next step" });
  const instructions = meetingRepresentativeInstructions(profile, "mtg_example", true);
  assert.match(instructions, /capture/i);
  assert.match(instructions, /preferred contact/i);
  assert.match(instructions, /calendar's availability/i);
  assert.match(instructions, /Good example/i);
  assert.match(instructions, /Bad example/i);
  assert.match(instructions, /CHUCK_MEETING_CONTEXT_LOOKUP/i);
  assert.match(instructions, /business facts/i);
});
