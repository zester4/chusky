import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { initStore, getRecallMeeting, getSession, listRecallMeetings, recordRecallMeetingRuntime, saveSession, updateRecallMeeting, updateMeetingRepresentativeProfile } from "../src/store.js";
import { applyRecallParticipantWebhook, applyRecallStatusWebhook, applyRecallTranscriptArtifactWebhook, getRecallMediaAuthorization, getRecallMediaAuthorizationState, joinRecallMeeting, leaveRecallMeeting, recallChatConfigurationIssue, recallChatConfigurationReady, recallConfigurationReady, resolveRecallChatWebhook, sendRecallMeetingChat } from "../src/meetings/service.js";
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

test("reports a safe, actionable Recall chat configuration diagnosis", () => {
  const originalSecret = config.recallRealtimeSecret;
  const originalQstash = config.qstashToken;
  config.recallRealtimeSecret = "";
  assert.equal(recallChatConfigurationIssue(), "missing_workspace_secret");
  config.recallRealtimeSecret = "not-a-recall-secret";
  assert.equal(recallChatConfigurationIssue(), "invalid_workspace_secret");
  config.recallRealtimeSecret = originalSecret;
  config.qstashToken = "";
  assert.equal(recallChatConfigurationIssue(), "qstash_not_configured");
  config.qstashToken = originalQstash;
  assert.equal(recallChatConfigurationIssue(), "durable_store_required");
});

test("meeting runtime diagnostics persist bounded latency state and timeline events", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "bot_runtime_123" }), { status: 201 });
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/runtime-diagnostics-room" });
  const updated = await recordRecallMeetingRuntime(ownerId, meeting.id, {
    state: "degraded",
    eventType: "degraded",
    summary: "A natural recovery line was used while the model was slow.",
    turn: { completed: true, fallback: true, firstAudioMs: 1_200, finalResponseMs: 4_800 },
  });
  assert.equal(updated?.runtimeState, "degraded");
  assert.equal(updated?.turnMetrics?.turns, 1);
  assert.equal(updated?.turnMetrics?.fallbackTurns, 1);
  assert.equal(updated?.turnMetrics?.firstAudio.averageMs, 1_200);
  assert.equal(updated?.timeline?.at(-1)?.type, "degraded");
  assert.equal(updated?.timeline?.at(-1)?.summary, "A natural recovery line was used while the model was slow.");
  const fast = await recordRecallMeetingRuntime(ownerId, meeting.id, {
    eventType: "agent_first_token",
    summary: "The meeting agent started speaking.",
    turn: { completed: true, firstAudioMs: 300, finalResponseMs: 1_100 },
  });
  assert.equal(fast?.turnMetrics?.firstAudio.p50Ms, 300);
  assert.equal(fast?.turnMetrics?.finalResponse.p95Ms, 4_800);
  assert.equal(fast?.timeline?.at(-1)?.type, "agent_first_token");
});

test("meeting joins default to proactive copilot or the enabled representative profile", async () => {
  let botNumber = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: `bot_default_${++botNumber}` }), { status: 201 });
  await updateMeetingRepresentativeProfile(ownerId, { enabled: false });

  const copilot = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/proactive-default-room" });
  assert.equal(copilot.interactionMode, "copilot");

  await updateMeetingRepresentativeProfile(ownerId, {
    enabled: true,
    role: "sales",
    organizationName: "Acme",
    objective: "Qualify leads and agree next steps",
  });
  const representative = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/representative-default-room" });
  assert.equal(representative.interactionMode, "representative");
  await updateMeetingRepresentativeProfile(ownerId, { enabled: false });
});

test("empty optional client fields do not break an ordinary meeting join", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "bot_empty_client_fields" }), { status: 201 });
  await updateMeetingRepresentativeProfile(ownerId, { enabled: false });
  const meeting = await joinRecallMeeting(ownerId, {
    meetingUrl: "https://meet.google.com/empty-client-fields-room",
    clientName: "",
    objective: "",
    clientContext: "",
  });
  assert.equal(meeting.interactionMode, "copilot");
  assert.equal("mission" in meeting, false);
});

test("confirmed client context selects representative mode despite a stale copilot selection", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "bot_client_context" }), { status: 201 });
  await updateMeetingRepresentativeProfile(ownerId, {
    enabled: true,
    role: "sales",
    objective: "Qualify leads and agree next steps",
  });
  const meeting = await joinRecallMeeting(ownerId, {
    meetingUrl: "https://meet.google.com/client-context-mode-room",
    interactionMode: "copilot",
    clientName: "Acme",
    objective: "Close the onboarding package",
  });
  assert.equal(meeting.interactionMode, "representative");
  assert.equal(meeting.mission?.clientName, "Acme");
  await updateMeetingRepresentativeProfile(ownerId, { enabled: false });
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

test("current Recall fatal status envelope preserves only its safe sub-code", async () => {
  globalThis.fetch = async (_input, init) => init?.method === "POST"
    ? new Response(JSON.stringify({ id: botId }), { status: 201 })
    : new Response(JSON.stringify({ id: botId, metadata: { chusky_meeting_id: currentFailureMeeting.id, chusky_user_id: String(ownerId) } }), { status: 200 });
  const currentFailureMeeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/current-fatal-status" });

  assert.equal(await applyRecallStatusWebhook({
    eventId: "msg-current-fatal",
    body: { event: "bot.status_change", data: {
      bot_id: botId,
      status: {
        code: "fatal",
        created_at: new Date().toISOString(),
        sub_code: "zoom_sdk_credentials_missing",
        message: "private provider diagnostic must not be persisted",
      },
    } },
  }), "updated");

  const failed = await getRecallMeeting(ownerId, currentFailureMeeting.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "Recall could not join the meeting (zoom_sdk_credentials_missing)");
  assert.doesNotMatch(failed?.error ?? "", /private provider diagnostic/);
});

test("Recall media authorization starts once the owned bot is joining and rejects terminal states", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: botId }), { status: 201 });
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/media-auth-race" });

  assert.equal(await getRecallMediaAuthorizationState(ownerId, meeting.id), "authorized");
  // Recall's output-media callback must not depend on the ordinary chat
  // session blob; it can arrive after that key has expired or been recreated.
  const session = await getSession(ownerId);
  await saveSession(ownerId, { ...session, recallMeetings: [] });
  assert.equal(await getRecallMediaAuthorizationState(ownerId, meeting.id), "authorized");
  const missing = await getRecallMediaAuthorization(ownerId, "mtg_missing_media_session");
  assert.equal(missing.state, "denied");
  assert.match(missing.reason ?? "", /could not be found/i);
  await updateRecallMeeting(ownerId, meeting.id, { status: "creating" });
  assert.equal(await getRecallMediaAuthorizationState(ownerId, meeting.id), "pending");
  await updateRecallMeeting(ownerId, meeting.id, { status: "joining" });
  assert.equal(await getRecallMediaAuthorizationState(ownerId, meeting.id), "authorized");
  await updateRecallMeeting(ownerId, meeting.id, { status: "waiting_room" });
  assert.equal(await getRecallMediaAuthorizationState(ownerId, meeting.id), "authorized");
  await updateRecallMeeting(ownerId, meeting.id, { status: "in_call" });
  assert.equal(await getRecallMediaAuthorizationState(ownerId, meeting.id), "authorized");
  await updateRecallMeeting(ownerId, meeting.id, { status: "ended" });
  // An ambiguous provider response remains retryable for a short bounded
  // window; an explicit Recall terminal code is still denied.
  assert.equal(await getRecallMediaAuthorizationState(ownerId, meeting.id), "pending");
  assert.equal(await getRecallMediaAuthorizationState(ownerId + 1, meeting.id), "denied");
});

test("Recall media authorization repairs a stale terminal webhook before denying Output Media", async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/bot/") && init?.method === "POST") return new Response(JSON.stringify({ id: "bot_stale_media" }), { status: 201 });
    if (url.endsWith("/bot/bot_stale_media/") && init?.method === "GET") return new Response(JSON.stringify({ status: { code: "in_call_not_recording" } }), { status: 200 });
    return new Response(null, { status: 204 });
  };
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/stale-media-terminal" });
  await updateRecallMeeting(ownerId, meeting.id, { status: "ended", error: "Recall could not join the meeting" });
  assert.equal(await getRecallMediaAuthorizationState(ownerId, meeting.id), "authorized");
  assert.equal((await getRecallMeeting(ownerId, meeting.id))?.status, "in_call");
});

test("Recall media authorization uses provider status history during a webhook race", async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/bot/") && init?.method === "POST") return new Response(JSON.stringify({ id: "bot_history_media" }), { status: 201 });
    if (url.endsWith("/bot/bot_history_media/") && init?.method === "GET") {
      return new Response(JSON.stringify({ status: { code: "ready" }, status_changes: [
        { code: "joining_call" },
        { code: "in_call_recording" },
      ] }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  };
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/history-media-race" });
  await updateRecallMeeting(ownerId, meeting.id, { status: "failed", error: "stale webhook" });
  assert.equal(await getRecallMediaAuthorizationState(ownerId, meeting.id), "authorized");
  assert.equal((await getRecallMeeting(ownerId, meeting.id))?.status, "in_call");
});

test("Recall media authorization stays pending when provider reconciliation is temporarily unavailable", async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/bot/") && init?.method === "POST") return new Response(JSON.stringify({ id: "bot_pending_media" }), { status: 201 });
    if (url.endsWith("/bot/bot_pending_media/") && init?.method === "GET") return new Response("upstream timeout", { status: 503 });
    return new Response(null, { status: 204 });
  };
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/pending-media-race" });
  await updateRecallMeeting(ownerId, meeting.id, { status: "ended", error: "stale webhook" });
  assert.equal(await getRecallMediaAuthorizationState(ownerId, meeting.id), "pending");
});

test("Recall media authorization surfaces a safe Google Meet admission reason", async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/bot/") && init?.method === "POST") return new Response(JSON.stringify({ id: "bot_google_blocked" }), { status: 201 });
    if (url.endsWith("/bot/bot_google_blocked/") && init?.method === "GET") {
      return new Response(JSON.stringify({ status: { code: "fatal", sub_code: "google_meet_bot_blocked" } }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  };
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/admission-settings" });
  await updateRecallMeeting(ownerId, meeting.id, { status: "failed", error: "Recall could not join the meeting (google_meet_bot_blocked)" });
  const authorization = await getRecallMediaAuthorization(ownerId, meeting.id);
  assert.equal(authorization.state, "denied");
  assert.match(authorization.reason ?? "", /Google Meet did not admit Chusky/);
  assert.match(authorization.reason ?? "", /signed-in Meet bot/);
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

test("an ended default conversational meeting queues its private outcome recap", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: botId }), { status: 201 });
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/default-conversation-outcome" });
  assert.equal(meeting.interactionMode, "copilot");
  await updateRecallMeeting(ownerId, meeting.id, { status: "in_call" });
  const body = { event: "bot.done", data: {
    data: { code: "done", updated_at: new Date().toISOString() },
    bot: { id: botId, metadata: { chusky_meeting_id: meeting.id, chusky_user_id: String(ownerId) } },
  } };
  const queued: string[] = [];
  assert.equal(await applyRecallStatusWebhook({
    eventId: "msg-copilot-outcome",
    body,
    onMeetingEnded: async (userId, meetingId) => { queued.push(`${userId}:${meetingId}`); },
  }), "updated");
  assert.deepEqual(queued, [`${ownerId}:${meeting.id}`]);
});

test("speaker transitions are owner and bot scoped, idempotent, and cleared when a meeting ends", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: botId }), { status: 201 });
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/speaker-attribution-test" });
  await updateRecallMeeting(ownerId, meeting.id, { status: "in_call" });
  const at = new Date(Date.now() - 1_000).toISOString();
  const event = {
    event: "participant_events.speech_on",
    data: {
      data: { participant: { id: 456, name: "Avery Smith", email: "private@example.com" }, timestamp: { absolute: at, relative: 10 } },
      bot: { id: botId, metadata: { chusky_meeting_id: meeting.id, chusky_user_id: String(ownerId) } },
    },
  };
  assert.equal(await applyRecallParticipantWebhook(event), "updated");
  assert.equal(await applyRecallParticipantWebhook(event), "updated");
  assert.deepEqual((await getRecallMeeting(ownerId, meeting.id))?.speakerEvents, [
    { type: "speech_on", participantId: "456", at: Date.parse(at) },
  ]);
  assert.equal(await applyRecallParticipantWebhook({
    ...event,
    data: { ...event.data, bot: { id: "other-bot", metadata: { chusky_meeting_id: meeting.id, chusky_user_id: String(ownerId) } } },
  }), "ignored");
  await updateRecallMeeting(ownerId, meeting.id, { status: "ended" });
  assert.deepEqual((await getRecallMeeting(ownerId, meeting.id))?.speakerEvents, []);
});

test("transcript artifact lifecycle is owner/bot scoped and a late processing event cannot regress ready", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: botId }), { status: 201 });
  const meeting = await joinRecallMeeting(ownerId, { meetingUrl: "https://meet.google.com/transcript-status-test" });
  const artifact = (event: string, providerBotId = botId) => ({
    event,
    data: {
      bot: { id: providerBotId, metadata: { chusky_meeting_id: meeting.id, chusky_user_id: String(ownerId) } },
      data: { sub_code: "transcript_provider_error", message: "Do not retain raw provider error" },
    },
  });
  assert.equal(await applyRecallTranscriptArtifactWebhook(artifact("transcript.processing")), "updated");
  assert.equal((await getRecallMeeting(ownerId, meeting.id))?.transcriptStatus, "processing");
  assert.equal(await applyRecallTranscriptArtifactWebhook(artifact("transcript.done")), "updated");
  assert.equal((await getRecallMeeting(ownerId, meeting.id))?.transcriptStatus, "ready");
  assert.equal(await applyRecallTranscriptArtifactWebhook(artifact("transcript.processing")), "ignored");
  assert.equal((await getRecallMeeting(ownerId, meeting.id))?.transcriptStatus, "ready");
  assert.equal(await applyRecallTranscriptArtifactWebhook(artifact("transcript.failed", "other_bot")), "ignored");
  const stored = await getRecallMeeting(ownerId, meeting.id);
  assert.equal(stored?.transcriptErrorCode, undefined);
  assert.equal(JSON.stringify(stored).includes("Do not retain raw provider error"), false);
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
