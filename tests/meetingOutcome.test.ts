import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMeetingOutcomePrompt,
  formatMeetingOutcomeScratchpad,
  parseMeetingOutcome,
  processMeetingOutcome,
  selectMeetingNotionCreateTool,
} from "../src/meetings/outcome.js";
import type { RecallMeetingRecord } from "../src/store.js";
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

test("meeting outcome prompt uses only bounded meeting turns and treats them as untrusted", () => {
  const prompt = buildMeetingOutcomePrompt(meeting);
  assert.match(prompt, /We want to start with the pilot in October/);
  assert.match(prompt, /untrusted participant data/i);
  assert.doesNotMatch(prompt, /meetingUrlHash|https?:\/\//i);
  assert.ok(prompt.length < 20_000);
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
    allowedComposioTools: ["NOTION_CREATE_PAGE", "HUBSPOT_UPDATE_DEAL"],
    allowedNativeTools: ["CHUCK_TASK_CREATE"],
  };
  const calls: string[] = [];
  let claimed = false;
  let completed = false;
  const deps = {
    getMeeting: async (userId: number, id: string) => userId === meeting.userId && id === meeting.id ? meeting : undefined,
    getProfile: async () => profile,
    summarize: async () => outcomeJson,
    followThrough: async (input: { userId: number; meeting: RecallMeetingRecord; outcome: ReturnType<typeof parseMeetingOutcome>; notionTool?: string; allowedComposioTools: string[]; allowedNativeTools: string[] }) => {
      calls.push(`follow:${input.notionTool}:${input.allowedComposioTools.join(",")}:${input.allowedNativeTools.join(",")}`);
      return { notionSaved: true, notionUrl: "https://www.notion.so/acme/pilot-123" };
    },
    writeScratchpad: async (userId: number, key: string, content: string) => { calls.push(`scratchpad:${userId}:${key}`); assert.match(content, /notion\.so/); },
    saveOutcome: async (userId: number, id: string, value: ReturnType<typeof parseMeetingOutcome>, _followThrough: unknown, status: string) => { calls.push(`save:${userId}:${id}:${value.title}:${status}`); },
    notifyOwner: async (userId: number, text: string) => { calls.push(`notify:${userId}`); assert.match(text, /Acme pilot onboarding/); },
    claim: async (_key: string, _token: string) => { if (claimed) return "completed" as const; claimed = true; return "acquired" as const; },
    complete: async () => { completed = true; return true; },
    release: async () => { claimed = false; return true; },
  };

  assert.equal(await processMeetingOutcome({ userId: 42, meetingId: meeting.id }, deps), "completed");
  assert.equal(await processMeetingOutcome({ userId: 42, meetingId: meeting.id }, deps), "duplicate");
  assert.equal(completed, true);
  assert.deepEqual(calls, [
    `save:42:${meeting.id}:Acme pilot onboarding:pending`,
    "follow:NOTION_CREATE_PAGE:NOTION_CREATE_PAGE,HUBSPOT_UPDATE_DEAL:CHUCK_TASK_CREATE",
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
