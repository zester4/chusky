import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  addHistorySummary, appendMessages, acquireUserLock, addReminder, claimTriggerEvent, clearHistory, clearSession,
  createApproval, createCliDevice, createCliPairing, getApproval, getDaytonaWorkspace, getSession, initStore,
  listReminders, releaseUserLock, saveDaytonaWorkspace, saveSession, setApprovalStatus, setComposioSessionId, setModel,
  upsertMemory, updateMemory, searchMemories, forgetMemory, writeScratchpad, readScratchpad, clearScratchpad,
  claimTelegramUpdate,
  claimDelivery, completeDelivery, claimDeliveryLease, completeDeliveryLease, releaseDeliveryLease,
  type DaytonaWorkspaceRecord, type TriggerEventRecord,
  createTriggerEvent, getTriggerEvent, updateTriggerEvent,
  createWebTelegramLinkCode, getTelegramUserIdForWebAuth, redeemWebTelegramLinkCode,
  createVideoJob, getVideoJob, listVideoJobs, updateVideoJob,
  addRecallMeeting, appendRecallMeetingMessages, getRecallMeeting, listRecallMeetings, updateRecallMeeting, claimRecallCopilotEvaluation,
  getMeetingRepresentativeProfile, updateMeetingRepresentativeProfile,
  claimRecallMeetingCreation, releaseRecallMeetingCreation,
  createRecallChatEvent, getRecallChatEvent, updateRecallChatEvent,
  getAgentRun, saveAgentRun, type AgentRunRecord,
} from "../src/store.js";
import { nativeTool } from "../src/nativeTools.js";

before(async () => { await initStore({ memoryOnly: true }); });

function agentRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  const now = Date.now();
  return {
    id: `run-store-${Math.random().toString(36).slice(2)}`,
    userId: 810000,
    kind: "supervisor",
    objective: "test durable run compaction",
    status: "running",
    version: 0,
    events: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("supervisor run records keep audit state without duplicating model context", async () => {
  const rawImage = "data:image/png;base64," + "a".repeat(12_000);
  const input = agentRun({
    state: {
      messages: [
        { role: "system", content: "system instruction" },
        { role: "user", content: [{ type: "image_url", image_url: { url: rawImage } }] },
      ],
      output: "completed safely",
      toolResults: { image: `created ${rawImage}` },
    },
  });
  const saved = await saveAgentRun(input);
  const restored = await getAgentRun(input.userId, input.id);
  assert.equal(saved.state?.messages, undefined);
  assert.equal(restored?.state?.messages, undefined);
  assert.equal(restored?.state?.output, "completed safely");
  assert.match(restored?.state?.toolResults?.image ?? "", /omitted from durable checkpoint/);
  assert.doesNotMatch(JSON.stringify(restored), /data:image\/png;base64/i);
});

test("worker checkpoints retain resumable text but replace raw media", async () => {
  const rawImage = "data:image/png;base64," + "b".repeat(12_000);
  const input = agentRun({
    kind: "worker",
    state: {
      messages: [
        { role: "system", content: "worker contract" },
        { role: "user", content: "build the report" },
        { role: "user", content: [{ type: "image_url", image_url: { url: rawImage } }] },
      ],
    },
  });
  const saved = await saveAgentRun(input);
  const messages = saved.state?.messages ?? [];
  assert.match(JSON.stringify(messages), /worker contract/);
  assert.match(JSON.stringify(messages), /omitted from durable checkpoint/);
  assert.doesNotMatch(JSON.stringify(messages), /data:image\/png;base64/i);
  const finalContent = (messages.at(-1) as { content?: Array<{ type?: string }> }).content;
  assert.equal(finalContent?.[0]?.type, "text");
});

test("video jobs persist owner-scoped lifecycle and progress", async () => {
  const job = await createVideoJob({ userId: 810099, prompt: "A red kite", destination: "telegram" });
  assert.equal(job.status, "queued");
  await updateVideoJob(810099, job.id, { workflowRunId: "wf-1", status: "running", pollCount: 3 });
  const running = await getVideoJob(810099, job.id);
  assert.equal(running?.status, "running");
  assert.equal(running?.pollCount, 3);
  assert.equal(await getVideoJob(810100, job.id), undefined);
  await updateVideoJob(810099, job.id, { status: "completed", completedAt: Date.now() });
  assert.equal((await listVideoJobs(810099))[0]?.status, "completed");
});

test("video status native tool is read-only and owner-scoped", async () => {
  const job = await createVideoJob({ userId: 810101, prompt: "A blue train", destination: "telegram" });
  await updateVideoJob(810101, job.id, { status: "running", pollCount: 2 });
  const result = await nativeTool(810101, "CHUCK_VIDEO_STATUS", { id: job.id }) as Array<{ id: string; status: string; pollCount: number }>;
  assert.deepEqual(result, [{ ...job, status: "running", pollCount: 2, updatedAt: result[0]!.updatedAt }]);
  assert.deepEqual(await nativeTool(810102, "CHUCK_VIDEO_STATUS", { id: job.id }), []);
});

test("meeting records and their conversation history remain owner-scoped and bounded", async () => {
  const userId = 810110;
  const meeting = await addRecallMeeting(userId, {
    id: "mtg_store_test",
    userId,
    platform: "google_meet",
    status: "joining",
    meetingUrlHash: "a".repeat(64),
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await updateRecallMeeting(userId, meeting.id, { status: "in_call", providerBotId: "bot-test" });
  const messages = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 ? "assistant" as const : "user" as const,
    content: `turn-${index}`,
  }));
  await appendRecallMeetingMessages(userId, meeting.id, messages);
  await updateRecallMeeting(userId, meeting.id, {
    outcome: { title: "Onboarding", summary: "Pilot starts next month.", decisions: ["Start the pilot next month."], actionItems: [{ task: "Prepare onboarding", owner: "Chusky" }], openQuestions: [] },
    outcomeFollowThrough: { notionSaved: true, notionTool: "NOTION_CREATE_PAGE", notionUrl: "https://www.notion.so/acme/onboarding" },
    outcomeStatus: "completed",
  });

  const restored = await getRecallMeeting(userId, meeting.id);
  assert.equal(restored?.status, "in_call");
  assert.equal(restored?.providerBotId, "bot-test");
  assert.equal(restored?.history.length, 20);
  assert.equal(restored?.history[0]?.content, "turn-10");
  assert.equal(restored?.outcome?.title, "Onboarding");
  assert.equal(restored?.outcomeFollowThrough?.notionUrl, "https://www.notion.so/acme/onboarding");
  assert.equal((await getRecallMeeting(userId + 1, meeting.id))?.outcome, undefined);
  await assert.rejects(() => updateRecallMeeting(userId, meeting.id, { outcome: { title: "x".repeat(181), summary: "too long", decisions: [], actionItems: [], openQuestions: [] } }), /storage bounds/);
  assert.equal(await getRecallMeeting(userId + 1, meeting.id), undefined);
  assert.equal((await listRecallMeetings(userId))[0]?.id, meeting.id);
});

test("Recall chat events are deduplicated, owner-scoped, and discard message text when completed", async () => {
  const record = {
    eventId: `rch_${"a".repeat(64)}`,
    userId: 810114,
    meetingId: "mtg_chat_store",
    providerBotId: "bot-chat-store",
    command: { kind: "message" as const, text: "What did we decide?" },
    reply: "We decided to ship Friday.",
    replyCost: 0.02,
    status: "queued" as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const created = await createRecallChatEvent(record);
  const duplicate = await createRecallChatEvent({ ...record, command: { kind: "leave" } });
  assert.deepEqual(duplicate.command, record.command, "duplicate provider events must not replace the first accepted payload");
  assert.equal((await getRecallChatEvent(record.eventId))?.userId, record.userId);
  assert.equal(await getRecallChatEvent(record.eventId, record.userId + 1), undefined);
  await updateRecallChatEvent(created.eventId, { status: "completed", command: undefined, reply: undefined, replyCost: undefined });
  const completed = await getRecallChatEvent(record.eventId);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.command, undefined, "processed chat text is erased while the short-lived dedup record remains");
  assert.equal(completed?.reply, undefined);
});

test("an active duplicate meeting URL is idempotent but a finished meeting can be rejoined", async () => {
  const userId = 810111;
  const first = await addRecallMeeting(userId, {
    id: "mtg_dedup_1", userId, platform: "zoom", status: "joining",
    meetingUrlHash: "b".repeat(64), history: [], createdAt: Date.now(), updatedAt: Date.now(),
  });
  const duplicate = await addRecallMeeting(userId, {
    id: "mtg_dedup_2", userId, platform: "zoom", status: "joining",
    meetingUrlHash: "b".repeat(64), history: [], createdAt: Date.now(), updatedAt: Date.now(),
  });
  assert.equal(duplicate.id, first.id);
  await updateRecallMeeting(userId, first.id, { status: "ended" });
  const afterEnd = await addRecallMeeting(userId, {
    id: "mtg_dedup_3", userId, platform: "zoom", status: "joining",
    meetingUrlHash: "b".repeat(64), history: [], createdAt: Date.now(), updatedAt: Date.now(),
  });
  assert.equal(afterEnd.id, "mtg_dedup_3");
});

test("scheduled meeting dedupe keys distinguish recurring instances on the same URL", async () => {
  const userId = 810122;
  const common = {
    userId, platform: "google_meet" as const, status: "scheduled" as const,
    meetingUrlHash: "e".repeat(64), history: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  const first = await addRecallMeeting(userId, { ...common, id: "mtg_recurring_1", meetingInstanceHash: "1".repeat(64) });
  const nextOccurrence = await addRecallMeeting(userId, { ...common, id: "mtg_recurring_2", meetingInstanceHash: "2".repeat(64) });
  assert.equal(first.id, "mtg_recurring_1");
  assert.equal(nextOccurrence.id, "mtg_recurring_2");
});

test("meeting history retention never evicts an active bot needed for webhook cleanup", async () => {
  const userId = 810112;
  const active = await addRecallMeeting(userId, {
    id: "mtg_keep_active", userId, platform: "google_meet", status: "in_call",
    meetingUrlHash: "c".repeat(64), history: [], createdAt: Date.now(), updatedAt: Date.now(),
  });
  for (let index = 0; index < 24; index++) {
    await addRecallMeeting(userId, {
      id: `mtg_finished_${index}`, userId, platform: "zoom", status: "ended",
      meetingUrlHash: String(index).padStart(64, "0"), history: [], createdAt: Date.now() + index, updatedAt: Date.now() + index,
    });
  }
  const retained = await listRecallMeetings(userId, 20);
  assert.equal(retained.length, 20);
  assert.equal(retained.some((meeting) => meeting.id === active.id), true);
});

test("copilot evaluation budget is owner-scoped, rate-limited, and durable for a meeting", async () => {
  const userId = 810113;
  assert.equal(await claimRecallCopilotEvaluation(userId, "mtg_budget", 8, 2, 100_000), "allowed");
  assert.equal(await claimRecallCopilotEvaluation(userId, "mtg_budget", 8, 2, 105_000), "interval");
  assert.equal(await claimRecallCopilotEvaluation(userId, "mtg_budget", 8, 2, 108_000), "allowed");
  assert.equal(await claimRecallCopilotEvaluation(userId, "mtg_budget", 8, 2, 116_000), "limit");
  assert.equal(await claimRecallCopilotEvaluation(userId + 1, "mtg_budget", 8, 2, 116_000), "allowed");
  assert.equal(await claimRecallCopilotEvaluation(userId, "mtg_other", 8, 2, 116_000), "allowed");
  await assert.rejects(() => claimRecallCopilotEvaluation(userId, "not-a-meeting", 8, 2, 116_000), /identity/);
});

test("normalizes old sessions while preserving new durable defaults", async () => {
  const userId = 810001;
  const session = await getSession(userId);
  session.history = [{ role: "user", content: "hello" }];
  delete (session as any).memories;
  delete (session as any).approvals;
  await import("../src/store.js").then(({ saveSession }) => saveSession(userId, session));
  const restored = await getSession(userId);
  assert.deepEqual(restored.memories, []);
  assert.deepEqual(restored.approvals, []);
  assert.equal(restored.meetingRepresentativeProfile?.enabled, false);
  assert.equal(restored.history[0].content, "hello");
});

test("meeting representative profile persists per owner and enforces owner-scoped values", async () => {
  const ownerId = 810019;
  const otherId = ownerId + 1;
  const profile = await updateMeetingRepresentativeProfile(ownerId, {
    enabled: true,
    role: "client_onboarding",
    objective: "Onboard the new client and agree the next steps",
    organizationName: "Chusky",
    allowedComposioTools: ["GMAIL_SEND_EMAIL"],
  });
  assert.equal(profile.enabled, true);
  assert.equal((await getMeetingRepresentativeProfile(ownerId)).organizationName, "Chusky");
  assert.equal((await getMeetingRepresentativeProfile(otherId)).enabled, false);
  await assert.rejects(() => updateMeetingRepresentativeProfile(ownerId, { allowedComposioTools: ["COMPOSIO_EXECUTE_TOOL"] }), /not permitted/);
});

test("history trimming creates bounded summaries", async () => {
  const userId = 810002;
  const messages = Array.from({ length: 44 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, content: `message-${i}` }));
  await appendMessages(userId, messages);
  const session = await getSession(userId);
  assert.equal(session.history.length, 40);
  assert.equal(session.summaries.length, 1);
  assert.match(session.summaries[0], /message-0/);
});

test("clear history differs from clear session and preserves Daytona mapping", async () => {
  const userId = 810003;
  await setComposioSessionId(userId, "composio-1");
  const workspace: DaytonaWorkspaceRecord = { sandboxId: "sandbox-1", name: "chusky-810003", createdAt: Date.now(), updatedAt: Date.now() };
  await saveDaytonaWorkspace(userId, workspace);
  await appendMessages(userId, [{ role: "user", content: "keep?" }]);
  await clearHistory(userId);
  let session = await getSession(userId);
  assert.equal(session.history.length, 0);
  assert.equal(session.composioSessionId, "composio-1");
  assert.equal((await getDaytonaWorkspace(userId))?.sandboxId, "sandbox-1");
  await setModel(userId, "test/model");
  await clearSession(userId);
  session = await getSession(userId);
  assert.equal(session.composioSessionId, undefined);
  assert.equal((await getDaytonaWorkspace(userId))?.sandboxId, "sandbox-1");
});

test("memory and scratchpad remain private and searchable", async () => {
  const userId = 810004;
  const otherUser = 810005;
  await upsertMemory(userId, { category: "profile", key: "timezone", value: "Europe/London", confidence: 1 });
  await upsertMemory(otherUser, { category: "profile", key: "timezone", value: "America/New_York", confidence: 1 });
  assert.equal((await searchMemories(userId, "London"))[0].value, "Europe/London");
  assert.equal((await searchMemories(userId, "New York")).length, 0);
  await writeScratchpad(userId, "deploy", "use staging");
  assert.equal((await readScratchpad(userId, "staging")).deploy.content, "use staging");
  await clearScratchpad(userId, "deploy");
  assert.deepEqual(await readScratchpad(userId), {});
  assert.equal(await forgetMemory(userId, "timezone"), true);
});

test("memory categories, scopes, expiry, and bounded retrieval are enforced", async () => {
  const userId = 810050;
  await upsertMemory(userId, { category: "business", key: "carrier", value: "Acme Logistics", confidence: 0.9, source: "user", projectId: "freight", personKey: "ops" });
  await upsertMemory(userId, { category: "negative", key: "do-not-email", value: "the carrier before approval", confidence: 1, source: "user", projectId: "freight", expiresAt: Date.now() - 1 });
  await upsertMemory(userId, { category: "personal", key: "language", value: "English", confidence: 1, source: "user" });
  assert.equal((await searchMemories(userId, "carrier", { category: "business", projectId: "freight", personKey: "ops" })).length, 1);
  assert.equal((await searchMemories(userId, "before approval", { category: "negative" })).length, 0);
  assert.equal((await searchMemories(userId, undefined, { limit: 1 })).length, 1);
  const updated = await updateMemory(userId, { key: "carrier", category: "business" }, { value: "New Logistics", confidence: 1 });
  assert.equal(updated?.value, "New Logistics");
  assert.equal((await searchMemories(userId, "New Logistics"))[0].value, "New Logistics");
});

test("reminder ownership and active listing are enforced", async () => {
  const userId = 810006;
  const reminder = { id: "rem-test-1", userId, text: "check", runAt: Date.now() + 60_000, status: "scheduled" as const, createdAt: Date.now() };
  await addReminder(userId, reminder);
  assert.equal((await listReminders(userId)).length, 1);
  assert.equal(await (await import("../src/store.js")).getReminder(810007, reminder.id).then((v) => v === undefined), true);
});

test("scheduling records survive ordinary session writes", async () => {
  const userId = 810007;
  await addReminder(userId, { id: "rem-durable", userId, text: "long-term", runAt: Date.now() + 31 * 24 * 60 * 60 * 1000, status: "scheduled", createdAt: Date.now() });
  const session = await getSession(userId);
  session.reminders = [];
  session.jobs = [];
  await saveSession(userId, session);
  assert.equal((await listReminders(userId)).some((item) => item.id === "rem-durable"), true);
});

test("approvals require exact ownership, expiry, and one-time state transitions", async () => {
  const userId = 810008;
  const approval = await createApproval({ userId, toolSlug: "CHUCK_DAYTONA_EXECUTE", args: { command: "pwd", purpose: "inspect" }, request: "inspect", history: [], model: "test/model" });
  assert.equal((await getApproval(810009, approval.id)), undefined);
  assert.equal(await setApprovalStatus(userId, approval.id, "approved"), true);
  assert.equal(await setApprovalStatus(userId, approval.id, "approved"), false);
  assert.equal(await setApprovalStatus(userId, approval.id, "denied"), false);
  assert.equal(await setApprovalStatus(userId, approval.id, "consumed"), true);
  assert.equal(await setApprovalStatus(userId, approval.id, "denied"), false);
});

test("locks are exclusive and safely releasable", async () => {
  const userId = 810010;
  assert.equal(await acquireUserLock(userId, "token-a", 5), true);
  assert.equal(await acquireUserLock(userId, "token-b", 5), false);
  await releaseUserLock(userId, "token-b");
  assert.equal(await acquireUserLock(userId, "token-b", 5), false);
  await releaseUserLock(userId, "token-a");
  assert.equal(await acquireUserLock(userId, "token-b", 5), true);
});

test("trigger events are idempotent", async () => {
  const eventId = `event-${Date.now()}-${Math.random()}`;
  assert.equal(await claimTriggerEvent(eventId), true);
  assert.equal(await claimTriggerEvent(eventId), false);
});

test("trigger event records are durable and stateful", async () => {
  const record: TriggerEventRecord = { eventId: "evt-record-1", userId: 810099, triggerId: "trig-1", triggerSlug: "GITHUB_COMMIT_EVENT", summary: "Trigger: GITHUB_COMMIT_EVENT", status: "queued", createdAt: Date.now(), updatedAt: Date.now() };
  assert.deepEqual(await createTriggerEvent(record), record);
  assert.deepEqual(await createTriggerEvent({ ...record, status: "failed" }), record);
  assert.equal((await updateTriggerEvent(record.eventId, { status: "running", workflowRunId: "wfr_evt-record-1" }))?.status, "running");
  assert.equal((await getTriggerEvent(record.eventId))?.workflowRunId, "wfr_evt-record-1");
});

test("Telegram update claims deduplicate retries", async () => {
  assert.equal(await claimTelegramUpdate(991001), true);
  assert.equal(await claimTelegramUpdate(991001), false);
  assert.equal(await claimTelegramUpdate(991002), true);
});

test("delivery claims are exclusive and completion remains idempotent", async () => {
  const key = `reminder:claim-${Date.now()}`;
  assert.equal(await claimDelivery(key, 60_000), true);
  assert.equal(await claimDelivery(key, 60_000), false);
  await completeDelivery(key, 60);
  assert.equal(await claimDelivery(key, 60_000), false);
});

test("Recall meeting creation reservations are atomic, owner-scoped, and compare-token released", async () => {
  const instanceHash = "d".repeat(64);
  const claims = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    claimRecallMeetingCreation(810120, instanceHash, `reservation-holder-${index}`, 60_000)));
  assert.equal(claims.filter(Boolean).length, 1, "only one concurrent caller can reserve a meeting instance");
  assert.equal(await claimRecallMeetingCreation(810120, instanceHash, "second-owner-same-key-long", 60_000), false);
  assert.equal(await claimRecallMeetingCreation(810121, instanceHash, "other-owner-token-long", 60_000), true);
  assert.equal(await releaseRecallMeetingCreation(810120, instanceHash, "not-the-holder-token"), false);
  const holder = claims.findIndex(Boolean);
  assert.equal(await releaseRecallMeetingCreation(810120, instanceHash, `reservation-holder-${holder}`), true);
  assert.equal(await claimRecallMeetingCreation(810120, instanceHash, "retry-after-release-token", 60_000), true);
});

test("delivery webhook leases release only their holder and atomically complete dedupe", async () => {
  const key = `recall-status:${Date.now()}`;
  assert.equal(await claimDeliveryLease(key, "delivery-holder-1", 60_000), "acquired");
  assert.equal(await claimDeliveryLease(key, "delivery-holder-2", 60_000), "busy");
  assert.equal(await releaseDeliveryLease(key, "delivery-holder-2"), false);
  assert.equal(await releaseDeliveryLease(key, "delivery-holder-1"), true);
  assert.equal(await claimDeliveryLease(key, "delivery-holder-3", 60_000), "acquired");
  assert.equal(await completeDeliveryLease(key, "delivery-holder-3", 60), true);
  assert.equal(await claimDeliveryLease(key, "delivery-holder-4", 60_000), "completed");
  assert.equal(await releaseDeliveryLease(key, "delivery-holder-3"), false);
});

test("CLI pairing is one-time and device tokens authenticate by hash", async () => {
  const userId = 810011;
  const code = await createCliPairing(userId);
  const consumed = await import("../src/store.js").then(({ consumeCliPairing }) => consumeCliPairing(code));
  assert.equal(consumed?.userId, userId);
  assert.equal(await import("../src/store.js").then(({ consumeCliPairing }) => consumeCliPairing(code)), undefined);
  const created = await createCliDevice(userId, "test-terminal");
  const auth = await import("../src/store.js").then(({ authenticateCliToken }) => authenticateCliToken(created.token));
  assert.equal(auth?.userId, userId);
  assert.equal(await import("../src/store.js").then(({ authenticateCliToken }) => authenticateCliToken("not-a-token")), undefined);
});

test("web-to-Telegram links are high-entropy, one-time, and cannot be rebound", async () => {
  const webAccount = `web-user-${Date.now()}`;
  const { code } = await createWebTelegramLinkCode(webAccount);
  assert.match(code, /^web_[A-Za-z0-9_-]{20,}$/);
  assert.equal(await redeemWebTelegramLinkCode(code, 810012), "linked");
  assert.equal(await getTelegramUserIdForWebAuth(webAccount), 810012);
  assert.equal(await redeemWebTelegramLinkCode(code, 810012), "invalid");

  const second = await createWebTelegramLinkCode(webAccount);
  assert.equal(await redeemWebTelegramLinkCode(second.code, 810013), "conflict");
  const otherWeb = await createWebTelegramLinkCode(`other-${Date.now()}`);
  assert.equal(await redeemWebTelegramLinkCode(otherWeb.code, 810012), "conflict");
});
