import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { initStore, getRecallMeeting, listRecallMeetings, updateRecallMeeting, updateMeetingRepresentativeProfile } from "../src/store.js";
import { applyRecallStatusWebhook, joinRecallMeeting, leaveRecallMeeting, recallChatConfigurationReady, recallConfigurationReady, resolveRecallChatWebhook, sendRecallMeetingChat } from "../src/meetings/service.js";
import { verifyRecallMediaTicket } from "../src/meetings/recall.js";

const originalConfig = {
  enabled: config.recallMeetingsEnabled,
  apiKey: config.recallApiKey,
  region: config.recallRegion,
  name: config.recallBotName,
  page: config.recallMediaPageUrl,
  webhook: config.recallWebhookSecret,
  realtimeSecret: config.recallRealtimeSecret,
  bridge: config.recallMediaBridgeSecret,
  webhookUrl: config.webhookUrl,
  qstashToken: config.qstashToken,
};
const originalFetch = globalThis.fetch;
const botId = "bot_12345";
const ownerId = 793214;

before(async () => {
  config.recallMeetingsEnabled = true;
  config.recallApiKey = "test-recall-key";
  config.recallRegion = "us-west-2";
  config.recallBotName = "Chusky Meeting Assistant";
  config.recallMediaPageUrl = "https://voice.example/recall/media";
  config.recallWebhookSecret = `whsec_${Buffer.from("test webhook secret").toString("base64")}`;
  config.recallRealtimeSecret = `whsec_${Buffer.from("test workspace secret for Recall").toString("base64")}`;
  config.recallMediaBridgeSecret = "meeting-bridge-test-secret-with-32-plus-bytes";
  config.webhookUrl = "https://chusky.example";
  config.qstashToken = "test-qstash-token";
  await initStore({ memoryOnly: true });
});

after(() => {
  config.recallMeetingsEnabled = originalConfig.enabled;
  config.recallApiKey = originalConfig.apiKey;
  config.recallRegion = originalConfig.region;
  config.recallBotName = originalConfig.name;
  config.recallMediaPageUrl = originalConfig.page;
  config.recallWebhookSecret = originalConfig.webhook;
  config.recallRealtimeSecret = originalConfig.realtimeSecret;
  config.recallMediaBridgeSecret = originalConfig.bridge;
  config.webhookUrl = originalConfig.webhookUrl;
  config.qstashToken = originalConfig.qstashToken;
  globalThis.fetch = originalFetch;
});

test("creates an owner-scoped immediate meeting with no URL leakage or retained media", async () => {
  assert.equal(recallConfigurationReady(), true);
  const validSecret = config.recallMediaBridgeSecret;
  config.recallMediaBridgeSecret = "too-short";
  assert.equal(recallConfigurationReady(), false);
  config.recallMediaBridgeSecret = validSecret;
  let created = 0;
  let outgoing: Record<string, unknown> | undefined;
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    created++;
    outgoing = JSON.parse(String(init?.body)) as Record<string, unknown>;
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    assert.equal(String(input), "https://us-west-2.recall.ai/api/v1/bot/");
    return new Response(JSON.stringify({ id: botId }), { status: 201 });
  };

  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/abc-defg-hij", title: "Weekly planning", interactionMode: "copilot" });
  assert.equal(meeting.status, "joining");
  assert.equal(meeting.interactionMode, "copilot");
  assert.equal("meetingUrl" in meeting, false);
  assert.equal(authorization, "Token test-recall-key");
  const mediaUrl = String((((outgoing?.output_media as any).camera.config.url)));
  assert.match(mediaUrl, /#session=/);
  assert.equal(new URL(mediaUrl).search, "");
  const ticket = new URLSearchParams(new URL(mediaUrl).hash.slice(1)).get("session")!;
  assert.equal(verifyRecallMediaTicket(ticket, config.recallMediaBridgeSecret)?.interactionMode, "copilot");
  assert.equal((outgoing?.recording_config as any).retention, null);
  assert.equal((outgoing?.recording_config as any).video_mixed_mp4, null);
  assert.equal((outgoing?.recording_config as any).transcript, null);

  const repeated = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/abc-defg-hij" });
  assert.equal((repeated as any).alreadyActive, true);
  assert.equal(created, 1);
  const stored = await getRecallMeeting(ownerId, meeting.id);
  assert.equal(stored?.meetingUrlHash.length, 64);
  assert.equal("meetingUrl" in (stored ?? {}), false);
  assert.equal((await getRecallMeeting(ownerId + 1, meeting.id)), undefined);
});

test("concurrent requests for one live meeting create only one Recall bot", async () => {
  let created = 0;
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  let finishCreate!: () => void;
  const hold = new Promise<void>((resolve) => { finishCreate = resolve; });
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      created++;
      announceStarted();
      await hold;
      return new Response(JSON.stringify({ id: botId }), { status: 201 });
    }
    return new Response(null, { status: 204 });
  };

  const firstRequest = joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/race-test-room" });
  await started;
  const concurrent = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/race-test-room" });
  assert.equal((concurrent as any).alreadyActive, true);
  finishCreate();
  const first = await firstRequest;
  assert.equal(first.status, "joining");
  assert.equal(created, 1);
});

test("the same recurring meeting URL can have distinct scheduled instances", async () => {
  let created = 0;
  globalThis.fetch = async () => {
    created++;
    return new Response(JSON.stringify({ id: `bot_${created}` }), { status: 201 });
  };
  const meetingUrl = "https://zoom.us/j/76543210987";
  const first = await joinRecallMeeting(ownerId, { meetingUrl, joinAt: new Date(Date.now() + 20 * 60_000).toISOString() });
  const second = await joinRecallMeeting(ownerId, { meetingUrl, joinAt: new Date(Date.now() + 40 * 60_000).toISOString() });
  assert.equal(first.status, "scheduled");
  assert.equal(second.status, "scheduled");
  assert.notEqual(first.id, second.id);
  assert.equal(created, 2);
});

test("scheduled cancellation deletes before dispatch; live leave uses leave_call", async () => {
  const methods: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/bot/") && init?.method === "POST") return new Response(JSON.stringify({ id: botId }), { status: 201 });
    methods.push(`${init?.method}`);
    return new Response(null, { status: 204 });
  };
  const scheduled = await joinRecallMeeting(ownerId, {
    meetingUrl: "https://zoom.us/j/23456789012",
    joinAt: new Date(Date.now() + 12 * 60_000).toISOString(),
  });
  assert.equal(scheduled.status, "scheduled");
  await updateRecallMeeting(ownerId, scheduled.id, { joinAt: new Date(Date.now() + 2 * 60_000).toISOString() });
  await leaveRecallMeeting(ownerId, scheduled.id);
  assert.deepEqual(methods, ["DELETE"]);

  const live = await joinRecallMeeting(ownerId, { meetingUrl: "https://teams.microsoft.com/l/meetup-join/example" });
  await updateRecallMeeting(ownerId, live.id, { status: "in_call" });
  await leaveRecallMeeting(ownerId, live.id);
  assert.equal(methods[1], "POST");
});

test("a scheduled bot already dispatched is removed through leave-call", async () => {
  const methods: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/bot/") && init?.method === "POST") return new Response(JSON.stringify({ id: botId }), { status: 201 });
    methods.push(`${init?.method}:${url.endsWith("/leave_call/") ? "leave" : "delete"}`);
    if (init?.method === "DELETE") return new Response(JSON.stringify({ code: "cannot_delete_bot" }), { status: 405 });
    return new Response(null, { status: 204 });
  };

  const scheduled = await joinRecallMeeting(ownerId, {
    meetingUrl: "https://zoom.us/j/45678901234",
    joinAt: new Date(Date.now() + 12 * 60_000).toISOString(),
  });
  await leaveRecallMeeting(ownerId, scheduled.id);
  assert.deepEqual(methods, ["DELETE:delete", "POST:leave"]);
  assert.equal((await getRecallMeeting(ownerId, scheduled.id))?.status, "ended");
});

test("a stale live meeting is reconciled when Recall says the bot already finished", async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/bot/") && init?.method === "POST") return new Response(JSON.stringify({ id: botId }), { status: 201 });
    if (url.endsWith("/leave_call/")) return new Response(JSON.stringify({ code: "cannot_command_completed_bot" }), { status: 400 });
    return new Response(JSON.stringify({ status: { code: "done" } }), { status: 200 });
  };
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/stale-status-room" });
  await updateRecallMeeting(ownerId, meeting.id, { status: "in_call" });

  const result = await leaveRecallMeeting(ownerId, meeting.id);
  assert.equal("alreadyFinished" in result && result.alreadyFinished, true);
  assert.equal((await getRecallMeeting(ownerId, meeting.id))?.status, "ended");
});

test("a rejected leave keeps a live bot active and exposes only Recall's safe error code", async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/bot/") && init?.method === "POST") return new Response(JSON.stringify({ id: botId }), { status: 201 });
    if (url.endsWith("/leave_call/")) return new Response(JSON.stringify({ code: "cannot_command_unstarted_bot", detail: "private provider response" }), { status: 400 });
    return new Response(JSON.stringify({ status: { code: "in_call_recording" } }), { status: 200 });
  };
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/leave-retry-room" });
  await updateRecallMeeting(ownerId, meeting.id, { status: "in_call" });

  await assert.rejects(() => leaveRecallMeeting(ownerId, meeting.id), (error: unknown) => {
    assert.match(String(error), /Recall API request failed \(400: cannot_command_unstarted_bot\)/);
    assert.doesNotMatch(String(error), /private provider response/);
    return true;
  });
  assert.equal((await getRecallMeeting(ownerId, meeting.id))?.status, "in_call");
});

test("signed provider status updates only the owning meeting and ignores stale lifecycle events", async () => {
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls++;
    return new Response(JSON.stringify({ id: botId }), { status: 201 });
  };
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/qwe-rtyu-iop" });
  await updateRecallMeeting(ownerId, meeting.id, { providerStatusAt: Date.now() - 5000 });
  const applied = await applyRecallStatusWebhook({
    eventId: "msg-status",
    body: { event: "bot.in_call_not_recording", data: {
      data: { code: "in_call_not_recording", updated_at: new Date().toISOString() },
      bot: { id: botId, metadata: { chusky_meeting_id: meeting.id, chusky_user_id: String(ownerId) } },
    } },
  });
  assert.equal(applied, "updated");
  assert.equal((await getRecallMeeting(ownerId, meeting.id))?.status, "in_call");
  const stale = await applyRecallStatusWebhook({
    eventId: "msg-stale",
    body: { event: "bot.joining_call", data: {
      data: { code: "joining_call", updated_at: new Date(Date.now() - 60_000).toISOString() },
      bot: { id: botId, metadata: { chusky_meeting_id: meeting.id, chusky_user_id: String(ownerId) } },
    } },
  });
  assert.equal(stale, "ignored");
  assert.equal(providerCalls, 1, "a complete signed Recall status payload needs no serial API lookup");
  assert.equal((await listRecallMeetings(ownerId)).some((item) => item.id === meeting.id), true);
});

test("an ended representative meeting schedules post-meeting follow-through and retries can re-enqueue it", async () => {
  await updateMeetingRepresentativeProfile(ownerId, { enabled: true, objective: "Represent the company and progress onboarding" });
  globalThis.fetch = async () => new Response(JSON.stringify({ id: botId }), { status: 201 });
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/outcome-test-room", interactionMode: "representative" });
  await updateRecallMeeting(ownerId, meeting.id, { status: "in_call" });
  const body = { event: "bot.done", data: {
    data: { code: "done", updated_at: new Date().toISOString() },
    bot: { id: botId, metadata: { chusky_meeting_id: meeting.id, chusky_user_id: String(ownerId) } },
  } };
  const queued: string[] = [];
  assert.equal(await applyRecallStatusWebhook({ eventId: "msg-outcome", body, onMeetingEnded: async (userId, meetingId) => { queued.push(`${userId}:${meetingId}`); } }), "updated");
  assert.equal((await getRecallMeeting(ownerId, meeting.id))?.status, "ended");
  assert.deepEqual(queued, [`${ownerId}:${meeting.id}`]);
  assert.equal(await applyRecallStatusWebhook({ eventId: "msg-outcome-retry", body, onMeetingEnded: async (userId, meetingId) => { queued.push(`${userId}:${meetingId}`); } }), "ignored");
  assert.deepEqual(queued, [`${ownerId}:${meeting.id}`, `${ownerId}:${meeting.id}`], "the durable workflow ID must deduplicate repeat enqueue requests");
  await updateMeetingRepresentativeProfile(ownerId, { enabled: false });
});

test("Recall chat messages require an owned active bot and use the supported chat-send API", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: botId }), { status: 201 });
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://zoom.us/j/98765432101" });
  await updateRecallMeeting(ownerId, meeting.id, { status: "in_call" });
  const event = {
    event: "participant_events.chat_message",
    data: {
      data: { participant: { id: 123 }, data: { text: "/chusky what is the agenda?", to: "everyone" } },
      bot: { id: botId, metadata: { chusky_meeting_id: meeting.id, chusky_user_id: String(ownerId) } },
    },
  };
  assert.equal((await resolveRecallChatWebhook(event))?.userId, ownerId);
  assert.equal(await resolveRecallChatWebhook({
    ...event,
    data: { ...event.data, bot: { id: "different-bot", metadata: { chusky_meeting_id: meeting.id, chusky_user_id: String(ownerId) } } },
  }), undefined);

  let outgoing: Record<string, unknown> | undefined;
  let requestUrl = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    outgoing = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(null, { status: 204 });
  };
  await sendRecallMeetingChat(ownerId, meeting.id, "I’m Chusky. What can I clarify?");
  assert.equal(requestUrl, `https://us-west-2.recall.ai/api/v1/bot/${botId}/send_chat_message/`);
  assert.deepEqual(outgoing, { to: "everyone", message: "I’m Chusky. What can I clarify?" });
  await assert.rejects(() => sendRecallMeetingChat(ownerId + 1, meeting.id, "not yours"), /not active or is not owned/);
});

test("Recall meeting chat configuration stays disabled without durable storage", () => {
  assert.equal(recallChatConfigurationReady(), false, "a local memory store must not advertise a durable webhook queue");
});

test("Webex accepts a leave command but ignores chat requests it cannot answer", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: botId }), { status: 201 });
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://acme.webex.com/meet/alex" });
  await updateRecallMeeting(ownerId, meeting.id, { status: "in_call" });
  const payload = (text: string) => ({
    event: "participant_events.chat_message",
    data: {
      data: { participant: { id: 123 }, data: { text, to: "everyone" } },
      bot: { id: botId, metadata: { chusky_meeting_id: meeting.id, chusky_user_id: String(ownerId) } },
    },
  });
  assert.equal(await resolveRecallChatWebhook(payload("/chusky what did we decide?")), undefined);
  assert.equal((await resolveRecallChatWebhook(payload("/chusky leave")))?.command.kind, "leave");
});
