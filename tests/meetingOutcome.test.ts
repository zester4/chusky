import test from "node:test";
import assert from "node:assert/strict";
import {
  deliverMeetingOutcomeOnce,
  buildMeetingFollowThroughPrompt,
  buildMeetingOutcomePrompt,
  splitMeetingOutcomeTranscript,
  buildScheduledMeetingFollowUpPrompt,
  executeScheduledMeetingFollowUp,
  formatMeetingOutcomeScratchpad,
  parseMeetingOutcome,
  processMeetingOutcome,
  selectMeetingNotionCreateTool,
} from "../src/meetings/outcome.js";
import type { MeetingContactRecord, RecallMeetingRecord } from "../src/store.js";
import { defaultMeetingRepresentativeProfile } from "../src/meetings/representative.js";

const meeting: RecallMeetingRecord = {
  id: "mtg_outcome_123",
  userId: 42,
  platform: "google_meet",
  interactionMode: "representative",
  status: "ended",
  meetingUrlHash: "a".repeat(64),
  title: "Acme onboarding",
  history: [
    { role: "user", content: "We want to start with the pilot in October.", createdAt: 1 },
    { role: "assistant", content: "I can coordinate onboarding for the pilot.", createdAt: 2 },
  ],
  createdAt: 1,
  updatedAt: 2,
};

const outcomeJson = JSON.stringify({
  title: "Acme pilot onboarding",
  summary: "Acme plans to start a pilot in October.",
  decisions: ["Target pilot start is October."],
  actionItems: [{ task: "Coordinate pilot onboarding", owner: "Chusky" }],
  openQuestions: ["Confirm the October start date."],
});

test("meeting outcome notification is durably claimed before delivery and never retried after an ambiguous send", async () => {
  let claimed = false;
  let completed = false;
  let sends = 0;
  const order: string[] = [];
  const deps = {
    key: `recall-outcome-notification:${meeting.userId}:${meeting.id}`,
    claim: async () => {
      order.push("claim");
      if (completed) return "completed" as const;
      if (claimed) return "busy" as const;
      claimed = true;
      return "acquired" as const;
    },
    complete: async () => {
      order.push("mark-attempted");
      if (!claimed) return false;
      claimed = false;
      completed = true;
      return true;
    },
    send: async () => {
      order.push("send");
      sends++;
      throw new Error("Telegram accepted the message but the connection was lost before acknowledgement");
    },
  };

  await assert.rejects(() => deliverMeetingOutcomeOnce(deps), /connection was lost/);
  assert.deepEqual(order, ["claim", "mark-attempted", "send"]);
  assert.equal(await deliverMeetingOutcomeOnce(deps), "duplicate");
  assert.equal(sends, 1);
});

test("meeting outcome prompt uses only bounded meeting turns and treats them as untrusted", () => {
  const prompt = buildMeetingOutcomePrompt(meeting);
  assert.match(prompt, /We want to start with the pilot in October/);
  assert.match(prompt, /untrusted participant data/i);
  assert.doesNotMatch(prompt, /meetingUrlHash|https?:\/\//i);
  assert.ok(prompt.length < 20_000);
});

test("meeting outcome prefers the complete bounded in-call transcript and includes only confidently resolved speaker names", () => {
  const prompt = buildMeetingOutcomePrompt({
    ...meeting,
    outcomeTranscript: [
      { role: "participant", content: "For this package, budget approval is still pending.", speakerName: "Avery" },
      { role: "chusky", content: "What date should I put against that?" },
      { role: "participant", content: "Please send the revised proposal by Friday." },
    ],
  });
  assert.match(prompt, /budget approval is still pending/i);
  assert.match(prompt, /unverified display label: Avery/);
  assert.match(prompt, /revised proposal by Friday/i);
  assert.doesNotMatch(prompt, /pilot in October/);
  assert.match(prompt, /untrusted participant data/i);
});

test("full Recall transcript is partitioned without dropping utterances or trusting participant names", () => {
  const segments = Array.from({ length: 12 }, (_, index) => ({
    id: index.toString(16).padStart(64, "0"), startMs: index * 1_000, endMs: index * 1_000 + 500,
    text: `Unique meeting statement number ${index}.`, speakerName: index % 2 ? "Avery" : undefined,
  }));
  const chunks = splitMeetingOutcomeTranscript(segments, 80);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flatMap((chunk) => chunk.segmentIds), segments.map((segment) => segment.id));
  assert.equal(chunks.some((chunk) => /unverified display label: Avery/.test(chunk.text)), true);
  assert.match(chunks[0]?.text ?? "", /Unique meeting statement number 0/);
});

test("post-meeting actions receive only captured contacts from this meeting and coach tailored follow-up", () => {
  const profile = { ...defaultMeetingRepresentativeProfile(), enabled: true, objective: "Arrange useful next steps" };
  const prompt = buildMeetingFollowThroughPrompt({
    meeting,
    outcome: parseMeetingOutcome(outcomeJson),
    profile,
    notionTool: "NOTION_CREATE_PAGE",
    contacts: [
      { id: "mct_1234567890abcdef1234567890abcdef", userId: meeting.userId, meetingId: meeting.id, participantName: "Avery Chen", email: "avery@example.com", contactPreference: "email", interest: "Vehicle test drive", nextStep: "Arrange a test drive next week", followUpAt: Date.now() + 60_000, followUpTaskId: "task_existing_followup", createdAt: 1, updatedAt: 2 },
      { id: "mct_abcdef1234567890abcdef1234567890", userId: meeting.userId, meetingId: "mtg_other", participantName: "Other Person", email: "other@example.com", contactPreference: "email", interest: "Unrelated", createdAt: 1, updatedAt: 2 },
    ],
  });
  assert.match(prompt, /avery@example\.com/);
  assert.match(prompt, /individualized email/i);
  assert.match(prompt, /NOTION_CREATE_PAGE/);
  assert.match(prompt, /No second owner approval/i);
  assert.match(prompt, /followUpTaskId means that follow-up is already scheduled/i);
  assert.doesNotMatch(prompt, /other@example\.com|Unrelated/);
});

test("scheduled follow-up prompt carries the agreed timing and only one contact/action", () => {
  const profile = {
    ...defaultMeetingRepresentativeProfile(),
    enabled: true,
    objective: "Coordinate the requested vehicle test drive",
    approvedKnowledge: "Test drives are available at the downtown showroom.",
  };
  const followUpAt = Date.now() + 24 * 60 * 60 * 1000;
  const contact: MeetingContactRecord = {
    id: "mct_1234567890abcdef1234567890abcdef",
    userId: meeting.userId,
    meetingId: meeting.id,
    participantName: "Avery Chen",
    email: "avery@example.com",
    contactPreference: "email",
    interest: "Electric SUV test drive",
    nextStep: "Send available test-drive times",
    followUpAt,
    createdAt: 1,
    updatedAt: 2,
  };
  const prompt = buildScheduledMeetingFollowUpPrompt({ meeting, contact, profile, emailTool: "GMAIL_SEND_EMAIL", outcome: parseMeetingOutcome(outcomeJson) });
  assert.match(prompt, /GMAIL_SEND_EMAIL/);
  assert.match(prompt, /avery@example\.com/);
  assert.match(prompt, /agreedFollowUpAt/);
  assert.match(prompt, /available test-drive times/);
  assert.match(prompt, /Do not read or infer from owner history, general memory/i);
  assert.doesNotMatch(prompt, /Private Road|other@example\.com|another customer's offer/i);
  assert.doesNotMatch(prompt, /other@example\.com|Unrelated/);
  assert.ok(prompt.length < 12_000);
});

test("scheduled meeting follow-up revalidates grants, scopes the single send, and suppresses duplicates", async () => {
  const profile = { ...defaultMeetingRepresentativeProfile(), enabled: true, objective: "Coordinate the requested vehicle test drive", allowedComposioTools: ["GMAIL_SEND_EMAIL"] };
  const contact: MeetingContactRecord = {
    id: "mct_1234567890abcdef1234567890abcdef", userId: meeting.userId, meetingId: meeting.id,
    participantName: "Avery Chen", email: "avery@example.com", contactPreference: "email",
    interest: "Electric SUV", nextStep: "Send test-drive times", createdAt: 1, updatedAt: 2,
  };
  let state: "scheduled" | "claimed" | "completed" | "ambiguous" = "scheduled";
  let sends = 0;
  const execute = (emailResult: { toolsUsed: string[]; toolsSucceeded: string[] }) => executeScheduledMeetingFollowUp({
    userId: meeting.userId,
    taskId: "task_meeting_followup",
    binding: { meetingId: meeting.id, contactId: contact.id, emailTool: "GMAIL_SEND_EMAIL", state },
  }, {
    getMeeting: async (userId, id) => userId === meeting.userId && id === meeting.id ? meeting : undefined,
    getProfile: async () => profile,
    getContact: async (userId, id, meetingId) => userId === contact.userId && id === contact.id && meetingId === contact.meetingId ? contact : undefined,
    canSend: async () => true,
    updateState: async (_userId, _taskId, next) => { state = next; return true; },
    send: async ({ emailTool, prompt }) => {
      sends++;
      assert.equal(emailTool, "GMAIL_SEND_EMAIL");
      assert.match(prompt, /avery@example\.com/);
      return emailResult;
    },
  });

  const sent = await execute({ toolsUsed: ["GMAIL_SEND_EMAIL"], toolsSucceeded: ["GMAIL_SEND_EMAIL"] });
  assert.equal(sent.status, "completed");
  assert.equal(state, "completed");
  assert.equal(sends, 1);
  const duplicate = await execute({ toolsUsed: ["GMAIL_SEND_EMAIL"], toolsSucceeded: ["GMAIL_SEND_EMAIL"] });
  assert.equal(duplicate.status, "blocked");
  assert.match(duplicate.message, /already completed/i);
  assert.equal(sends, 1);
});

test("ambiguous email execution is never automatically repeated and revoked grants block before claiming", async () => {
  const baseProfile = { ...defaultMeetingRepresentativeProfile(), enabled: true, objective: "Coordinate the requested vehicle test drive", allowedComposioTools: ["GMAIL_SEND_EMAIL"] };
  const contact: MeetingContactRecord = {
    id: "mct_1234567890abcdef1234567890abcdef", userId: meeting.userId, meetingId: meeting.id,
    participantName: "Avery Chen", email: "avery@example.com", contactPreference: "email", interest: "Electric SUV", createdAt: 1, updatedAt: 2,
  };
  let state: "scheduled" | "claimed" | "completed" | "ambiguous" = "scheduled";
  let sends = 0;
  const run = (profile = baseProfile) => executeScheduledMeetingFollowUp({
    userId: meeting.userId,
    taskId: "task_meeting_followup",
    binding: { meetingId: meeting.id, contactId: contact.id, emailTool: "GMAIL_SEND_EMAIL", state },
  }, {
    getMeeting: async () => meeting,
    getProfile: async () => profile,
    getContact: async () => contact,
    updateState: async (_userId, _taskId, next) => { state = next; return true; },
    send: async () => { sends++; return { toolsUsed: ["GMAIL_SEND_EMAIL"], toolsSucceeded: [] }; },
  });
  const ambiguous = await run();
  assert.equal(ambiguous.status, "blocked");
  assert.equal(state, "ambiguous");
  const retry = await run();
  assert.match(retry.message, /not automatically repeated/i);
  assert.equal(sends, 1);

  state = "scheduled";
  const revoked = await run({ ...baseProfile, allowedComposioTools: [] });
  assert.match(revoked.message, /exact email action is no longer enabled/i);
  assert.equal(state, "scheduled");
  assert.equal(sends, 1);
});

test("structured meeting outcome parser validates and bounds model output", () => {
  assert.deepEqual(parseMeetingOutcome(outcomeJson), {
    title: "Acme pilot onboarding",
    summary: "Acme plans to start a pilot in October.",
    decisions: ["Target pilot start is October."],
    actionItems: [{ task: "Coordinate pilot onboarding", owner: "Chusky" }],
    openQuestions: ["Confirm the October start date."],
  });
  assert.throws(() => parseMeetingOutcome("not json"), /valid structured outcome/i);
  assert.throws(() => parseMeetingOutcome(JSON.stringify({ title: "", summary: "x" })), /title/i);
});

test("meeting outcome creates a bounded post-meeting owner review package", () => {
  const outcome = parseMeetingOutcome(JSON.stringify({
    title: "Risk review",
    summary: "A material implementation risk remains unresolved.",
    decisions: [],
    actionItems: [],
    openQuestions: ["Who owns the mitigation?"],
    escalation: {
      required: true,
      severity: "high",
      reason: "The launch date depends on an unresolved security review.",
      nextSteps: [{ action: "Review the security exception and choose a mitigation owner", owner: "Engineering lead" }],
      openQuestions: ["Can the launch proceed without the exception?"],
      confidence: "high",
    },
  }));
  assert.equal(outcome.escalation?.required, true);
  assert.equal(outcome.escalation?.severity, "high");
  assert.throws(() => parseMeetingOutcome(JSON.stringify({ title: "x", summary: "y", decisions: [], actionItems: [], openQuestions: [], escalation: { required: true, severity: "urgent", nextSteps: [], openQuestions: [], confidence: "high" } })), /status fields/i);
});

test("Notion page creation is selected only from one exact owner-granted create-page action", () => {
  assert.equal(selectMeetingNotionCreateTool(["NOTION_CREATE_PAGE"]), "NOTION_CREATE_PAGE");
  assert.equal(selectMeetingNotionCreateTool(["NOTION_CREATE_PAGE", "NOTION_CREATE_DATABASE_PAGE"]), undefined);
  assert.equal(selectMeetingNotionCreateTool(["COMPOSIO_SEARCH_TOOL", "NOTION_SEARCH_PAGES"]), undefined);
  assert.equal(selectMeetingNotionCreateTool([]), undefined);
});

test("scratchpad note contains the outcome and verified Notion reference", () => {
  const content = formatMeetingOutcomeScratchpad(meeting, {
    title: "Acme pilot onboarding",
    summary: "Acme plans to start a pilot in October.",
    decisions: ["Target pilot start is October."],
    actionItems: [{ task: "Coordinate pilot onboarding", owner: "Chusky" }],
    openQuestions: [],
  }, { notionSaved: true, notionUrl: "https://www.notion.so/acme/pilot-123" });
  assert.match(content, /Target pilot start is October/);
  assert.match(content, /https:\/\/www\.notion\.so\/acme\/pilot-123/);
  assert.doesNotMatch(content, /meetingUrlHash/);
});

test("ended representative meeting saves to owner scratchpad, follows only granted tools, and notifies once", async () => {
  const profile = {
    ...defaultMeetingRepresentativeProfile(),
    enabled: true,
    objective: "Represent Acme and progress onboarding",
    allowedComposioTools: ["NOTION_CREATE_PAGE", "HUBSPOT_UPDATE_DEAL", "GMAIL_SEND_EMAIL"],
    allowedNativeTools: ["CHUCK_TASK_CREATE"],
  };
  const calls: string[] = [];
  const contacts: MeetingContactRecord[] = [{
    id: "mct_1234567890abcdef1234567890abcdef", userId: meeting.userId, meetingId: meeting.id,
    participantName: "Avery Chen", email: "avery@example.com", contactPreference: "email",
    interest: "Vehicle test drive", nextStep: "Arrange a test drive next week", createdAt: 1, updatedAt: 2,
  }];
  let claimed = false;
  let completed = false;
  let completionTtl: number | undefined;
  const deps = {
    getMeeting: async (userId: number, id: string) => userId === meeting.userId && id === meeting.id ? meeting : undefined,
    getProfile: async () => profile,
    getContacts: async () => contacts,
    summarize: async () => outcomeJson,
    followThrough: async (input: { userId: number; meeting: RecallMeetingRecord; outcome: ReturnType<typeof parseMeetingOutcome>; notionTool?: string; allowedComposioTools: string[]; allowedNativeTools: string[]; contacts: MeetingContactRecord[] }) => {
      calls.push(`follow:${input.notionTool}:${input.allowedComposioTools.join(",")}:${input.allowedNativeTools.join(",")}`);
      assert.deepEqual(input.contacts, contacts);
      return { notionSaved: true, notionUrl: "https://www.notion.so/acme/pilot-123" };
    },
    writeScratchpad: async (userId: number, key: string, content: string) => { calls.push(`scratchpad:${userId}:${key}`); assert.match(content, /notion\.so/); },
    saveOutcome: async (userId: number, id: string, value: ReturnType<typeof parseMeetingOutcome>, _followThrough: unknown, status: string) => { calls.push(`save:${userId}:${id}:${value.title}:${status}`); },
    notifyOwner: async (userId: number, text: string) => { calls.push(`notify:${userId}`); assert.match(text, /Acme pilot onboarding/); },
    claim: async (_key: string, _token: string) => { if (claimed) return "completed" as const; claimed = true; return "acquired" as const; },
    complete: async (_key: string, _token: string, ttlSeconds: number) => { completionTtl = ttlSeconds; completed = true; return true; },
    release: async () => { claimed = false; return true; },
  };

  assert.equal(await processMeetingOutcome({ userId: 42, meetingId: meeting.id }, deps), "completed");
  assert.equal(await processMeetingOutcome({ userId: 42, meetingId: meeting.id }, deps), "duplicate");
  assert.equal(completed, true);
  assert.equal(completionTtl, 90 * 24 * 60 * 60, "outcome dedupe TTL must remain within the store limit");
  assert.deepEqual(calls, [
    `save:42:${meeting.id}:Acme pilot onboarding:pending`,
    "follow:NOTION_CREATE_PAGE:NOTION_CREATE_PAGE,HUBSPOT_UPDATE_DEAL,GMAIL_SEND_EMAIL:CHUCK_TASK_CREATE",
    `save:42:${meeting.id}:Acme pilot onboarding:pending`,
    `scratchpad:42:meeting:${meeting.id}`,
    `save:42:${meeting.id}:Acme pilot onboarding:completed`,
    `save:42:${meeting.id}:Acme pilot onboarding:completed`,
    "notify:42",
    `save:42:${meeting.id}:Acme pilot onboarding:completed`,
  ]);
});

test("a retry resumes from persisted outcome and does not repeat completed external follow-through", async () => {
  let current = meeting;
  let active = false;
  let completed = false;
  let summaries = 0;
  let followThroughCalls = 0;
  let scratchpadCalls = 0;
  const profile = { ...defaultMeetingRepresentativeProfile(), enabled: true, objective: "Represent Acme and progress onboarding", allowedComposioTools: ["NOTION_CREATE_PAGE"] };
  const deps = {
    getMeeting: async () => current,
    getProfile: async () => profile,
    summarize: async () => { summaries++; return outcomeJson; },
    followThrough: async () => { followThroughCalls++; return { notionSaved: true, notionUrl: "https://www.notion.so/acme/pilot-123" }; },
    writeScratchpad: async () => { scratchpadCalls++; if (scratchpadCalls === 1) throw new Error("temporary scratchpad failure"); },
    saveOutcome: async (_userId: number, _id: string, outcome: ReturnType<typeof parseMeetingOutcome>, followThrough: { notionSaved?: boolean }, status: "pending" | "completed") => {
      current = { ...current, outcome, outcomeFollowThrough: followThrough, outcomeStatus: status };
    },
    notifyOwner: async () => undefined,
    claim: async () => { if (completed) return "completed" as const; if (active) return "busy" as const; active = true; return "acquired" as const; },
    complete: async () => { active = false; completed = true; return true; },
    release: async () => { active = false; return true; },
  };
  await assert.rejects(() => processMeetingOutcome({ userId: 42, meetingId: meeting.id }, deps), /scratchpad failure/);
  assert.equal(current.outcomeStatus, "pending");
  assert.equal(await processMeetingOutcome({ userId: 42, meetingId: meeting.id }, deps), "completed");
  assert.equal(summaries, 1);
  assert.equal(followThroughCalls, 1);
});

test("outcome workflow supplies the full transient transcript and deletes it only after durable outcome save", async () => {
  let current = meeting;
  const order: string[] = [];
  const transcript = { segments: [{ id: "a".repeat(64), startMs: 0, endMs: 1_000, text: "The customer approved the pilot." }], truncated: false };
  const deps = {
    getMeeting: async () => current,
    getProfile: async () => ({ ...defaultMeetingRepresentativeProfile(), enabled: true, objective: "Represent the owner professionally" }),
    getTranscript: async () => transcript,
    summarize: async (_meeting: RecallMeetingRecord, received?: typeof transcript) => {
      assert.equal(received, transcript);
      order.push("summarize");
      return outcomeJson;
    },
    deleteEphemeralTranscript: async () => { assert.ok(current.outcome); order.push("delete"); },
    writeScratchpad: async () => undefined,
    saveOutcome: async (_userId: number, _id: string, outcome: ReturnType<typeof parseMeetingOutcome>) => { current = { ...current, outcome }; order.push("save"); },
    notifyOwner: async () => undefined,
    claim: async () => "acquired" as const,
    complete: async () => true,
    release: async () => true,
  };
  assert.equal(await processMeetingOutcome({ userId: meeting.userId, meetingId: meeting.id }, deps), "completed");
  assert.deepEqual(order, ["summarize", "save", "delete", "save", "save", "save", "save"]);
});

test("a persisted owner-notification claim suppresses a retry after an ambiguous delivery", async () => {
  const current: RecallMeetingRecord = {
    ...meeting,
    outcome: parseMeetingOutcome(outcomeJson),
    outcomeFollowThrough: {},
    outcomeStatus: "completed",
    outcomeNotificationStatus: "claimed",
  };
  let notified = 0;
  const deps = {
    getMeeting: async () => current,
    getProfile: async () => ({ ...defaultMeetingRepresentativeProfile(), enabled: true, objective: "Progress the approved client meeting" }),
    summarize: async () => { throw new Error("summary must not repeat"); },
    writeScratchpad: async () => undefined,
    saveOutcome: async () => undefined,
    notifyOwner: async () => { notified++; },
    claim: async () => "acquired" as const,
    complete: async () => true,
    release: async () => true,
  };
  assert.equal(await processMeetingOutcome({ userId: meeting.userId, meetingId: meeting.id }, deps), "completed");
  assert.equal(notified, 0);
});

test("the notification claim is persisted before the owner delivery", async () => {
  let current: RecallMeetingRecord = { ...meeting };
  const statuses: string[] = [];
  const deps = {
    getMeeting: async () => current,
    getProfile: async () => ({ ...defaultMeetingRepresentativeProfile(), enabled: true, objective: "Progress the approved client meeting" }),
    summarize: async () => outcomeJson,
    writeScratchpad: async () => undefined,
    saveOutcome: async (_userId: number, _id: string, outcome: ReturnType<typeof parseMeetingOutcome>, followThrough: {}, status: "pending" | "completed", notificationStatus?: "pending" | "claimed" | "delivered") => {
      current = { ...current, outcome, outcomeFollowThrough: followThrough, outcomeStatus: status, ...(notificationStatus ? { outcomeNotificationStatus: notificationStatus } : {}) };
      if (notificationStatus) statuses.push(notificationStatus);
    },
    notifyOwner: async () => { assert.equal(current.outcomeNotificationStatus, "claimed"); },
    claim: async () => "acquired" as const,
    complete: async () => true,
    release: async () => true,
  };
  assert.equal(await processMeetingOutcome({ userId: meeting.userId, meetingId: meeting.id }, deps), "completed");
  assert.deepEqual(statuses, ["claimed", "delivered"]);
});

test("outcome workflow skips non-ended or addressed-only meetings", async () => {
  let sideEffects = 0;
  const deps = {
    getMeeting: async () => ({ ...meeting, interactionMode: "addressed" as const }),
    getProfile: async () => ({ ...defaultMeetingRepresentativeProfile(), enabled: true }),
    summarize: async () => { sideEffects++; return outcomeJson; },
    followThrough: async () => { sideEffects++; return {}; },
    writeScratchpad: async () => { sideEffects++; },
    saveOutcome: async () => { sideEffects++; },
    notifyOwner: async () => { sideEffects++; },
    claim: async () => { sideEffects++; return "acquired" as const; },
    complete: async () => true,
    release: async () => true,
  };
  assert.equal(await processMeetingOutcome({ userId: 42, meetingId: meeting.id }, deps), "skipped");
  assert.equal(sideEffects, 0);
});

test("default conversational meetings produce a private recap without exercising representative tools", async () => {
  let summarized = 0;
  let followThrough = 0;
  let scratchpad = "";
  let notification = "";
  const result = await processMeetingOutcome({ userId: 42, meetingId: meeting.id }, {
    getMeeting: async () => ({ ...meeting, interactionMode: "copilot" as const }),
    getProfile: async () => defaultMeetingRepresentativeProfile(),
    summarize: async () => { summarized++; return outcomeJson; },
    followThrough: async () => { followThrough++; return {}; },
    writeScratchpad: async (_userId, _key, content) => { scratchpad = content; },
    saveOutcome: async () => {},
    notifyOwner: async (_userId, text) => { notification = text; },
    claim: async () => "acquired",
    complete: async () => true,
    release: async () => true,
  });
  assert.equal(result, "completed");
  assert.equal(summarized, 1);
  assert.equal(followThrough, 0, "conversation-only mode has no connected-app action authority");
  assert.match(scratchpad, /## Decisions/);
  assert.match(notification, /Meeting outcome:/);
});
