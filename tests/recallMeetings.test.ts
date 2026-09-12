import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  buildRecallCreateBotRequest,
  createRecallBotWithRetry,
  createRecallMediaTicket,
  isValidRecallBotId,
  mapRecallBotStatus,
  parseRecallChatWebhook,
  recallChatCommand,
  recallApiRequest,
  RecallApiError,
  validateRecallJoinAt,
  validateMeetingUrl,
  verifyRecallMediaTicket,
  verifyRecallWebhookSignature,
} from "../src/meetings/recall.js";

test("accepts supported HTTPS meeting links and identifies their provider", () => {
  assert.equal(validateMeetingUrl("https://meet.google.com/abc-defg-hij").platform, "google_meet");
  assert.equal(validateMeetingUrl("https://us02web.zoom.us/j/123456789?pwd=private").platform, "zoom");
  assert.equal(validateMeetingUrl("https://teams.microsoft.com/l/meetup-join/abc").platform, "microsoft_teams");
  assert.equal(validateMeetingUrl("https://acme.webex.com/meet/alex").platform, "webex");
});

test("rejects arbitrary, malformed, credential-bearing, or non-HTTPS meeting URLs", () => {
  for (const value of [
    "http://meet.google.com/abc-defg-hij",
    "https://evil.example/meet.google.com/abc",
    "https://user:password@zoom.us/j/12345678",
    "javascript:alert(1)",
    "https://teams.microsoft.com.evil.example/meet",
    "https://webex.com.evil.example/meet/alex",
    "https://acme.webex.com/random/path",
    "https://meet.goto.com/abc123",
    "https://global.gotomeeting.com/join/12345",
    "https://goto.example/meeting/123",
  ]) assert.throws(() => validateMeetingUrl(value));
});

test("Recall bot request enables live output media and explicitly opts out of retained media", () => {
  const request = buildRecallCreateBotRequest({
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    botName: "Chusky Meeting Assistant",
    mediaPageUrl: "https://voice.example/recall/media#session=signed-ticket",
    meetingId: "mtg_123",
    userId: 42,
    joinAt: undefined,
  });
  assert.equal(request.meeting_url, "https://meet.google.com/abc-defg-hij");
  assert.equal(request.metadata.chusky_meeting_id, "mtg_123");
  assert.equal(request.metadata.chusky_user_id, "42");
  assert.deepEqual(request.output_media, {
    camera: { kind: "webpage", config: { url: "https://voice.example/recall/media#session=signed-ticket" } },
  });
  assert.equal(request.recording_config?.retention, null);
  assert.deepEqual(request.recording_config?.include_bot_in_recording, { audio: true });
  assert.equal(request.recording_config?.video_mixed_mp4, null);
  assert.equal(request.recording_config?.audio_mixed_raw, null);
  assert.equal(request.recording_config?.transcript, null);
});

test("Recall bot subscribes to chat without enabling retained participant artifacts and discloses the assistant", () => {
  const request = buildRecallCreateBotRequest({
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    botName: "Chusky Meeting Assistant",
    mediaPageUrl: "https://voice.example/recall/media",
    meetingId: "mtg_123",
    userId: 42,
    realtimeWebhookUrl: "https://chusky.example/recall/realtime-webhook",
  });

  assert.equal(request.recording_config.retention, null);
  assert.deepEqual(request.recording_config.participant_events, {});
  assert.deepEqual(request.recording_config.realtime_endpoints, [{
    type: "webhook",
    url: "https://chusky.example/recall/realtime-webhook",
    events: ["participant_events.chat_message"],
  }]);
  assert.equal(request.chat?.on_bot_join.send_to, "everyone");
  assert.match(request.chat?.on_bot_join.message ?? "", /disclosed AI meeting representative/i);
  assert.match(request.chat?.on_bot_join.message ?? "", /address chusky by name/i);
});

test("Recall chat parser recognizes natural Chusky addresses and labels ambient chat for owner-authorized representatives", () => {
  assert.deepEqual(recallChatCommand("@Chusky what is the current decision?"), {
    kind: "message", text: "what is the current decision?",
  });
  assert.deepEqual(recallChatCommand("/chusky: status"), { kind: "status" });
  assert.deepEqual(recallChatCommand("Chusky, please leave"), { kind: "leave" });
  assert.deepEqual(recallChatCommand("/chusky help"), { kind: "help" });
  assert.deepEqual(recallChatCommand("Hey Chusky, can you explain the pricing?"), { kind: "message", text: "can you explain the pricing?" });
  assert.deepEqual(recallChatCommand("we should ask Chusky later"), { kind: "ambient", text: "we should ask Chusky later" });
  assert.deepEqual(recallChatCommand("The launch is blocked on pricing approval."), { kind: "ambient", text: "The launch is blocked on pricing approval." });
  assert.equal(recallChatCommand(""), undefined);
  assert.equal(recallChatCommand(`/chusky ${"x".repeat(1200)}`), undefined);
});

test("Recall real-time chat payload parser rejects unrelated and malformed events", () => {
  const parsed = parseRecallChatWebhook({
    event: "participant_events.chat_message",
    data: {
      data: {
        participant: { id: 123, name: "Untrusted attendee", email: "attendee@example.com" },
        timestamp: { absolute: "2026-09-12T10:00:00Z", relative: 4.2 },
        data: { text: "/chusky summarize the decision", to: "everyone" },
      },
      bot: { id: "bot_12345", metadata: { chusky_meeting_id: "mtg_123", chusky_user_id: "42" } },
    },
  });
  assert.deepEqual(parsed, {
    providerBotId: "bot_12345",
    meetingId: "mtg_123",
    userId: 42,
    command: { kind: "message", text: "summarize the decision" },
  });
  const privateDm = parseRecallChatWebhook({
    event: "participant_events.chat_message",
    data: {
      data: { participant: { id: 123 }, data: { text: "@Chusky explain that", to: "bot_12345" } },
      bot: { id: "bot_12345", metadata: { chusky_meeting_id: "mtg_123", chusky_user_id: "42" } },
    },
  });
  assert.equal(privateDm?.replyToParticipantId, "123", "a Zoom direct message must be routed back privately to its sender");
  assert.equal(parseRecallChatWebhook({ event: "transcript.data", data: {} }), undefined);
  assert.equal(parseRecallChatWebhook({
    event: "participant_events.chat_message",
    data: { data: { data: { text: "hello everyone" } }, bot: { id: "bot_12345", metadata: {} } },
  }), undefined);
});

test("Recall API client uses documented token auth and does not leak provider error bodies", async () => {
  let requestUrl = "";
  let authorization = "";
  const result = await recallApiRequest("us-west-2", "secret-key", "/bot/", {
    method: "POST",
    body: { meeting_url: "https://meet.google.com/abc-defg-hij" },
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return new Response(JSON.stringify({ id: "bot-123", status: { code: "ready" } }), { status: 201 });
    },
  });
  assert.equal(requestUrl, "https://us-west-2.recall.ai/api/v1/bot/");
  assert.equal(authorization, "Token secret-key");
  assert.equal(result.id, "bot-123");

  assert.equal(isValidRecallBotId("bot-123"), true);
  assert.equal(isValidRecallBotId("../other-endpoint"), false);
  assert.equal(isValidRecallBotId("a".repeat(129)), false);

  await assert.rejects(() => recallApiRequest("us-west-2", "secret-key", "/bot/", {
    method: "POST",
    body: {},
    fetchImpl: async () => new Response("meeting https://meet.google.com/private-code leaked", { status: 400 }),
  }), /Recall API request failed \(400\)/);

  await assert.rejects(() => recallApiRequest("us-west-2", "secret-key", "/bot/12345678-1234-1234-1234-123456789abc/", {
    method: "POST", fetchImpl: async () => new Response(null, { status: 204 }),
  }), /Unsupported Recall API method/);
});

test("Recall Create Bot retries only 507 responses every 30 seconds and stops after ten attempts", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await createRecallBotWithRetry({
    create: async () => {
      attempts++;
      if (attempts < 3) throw new RecallApiError(507);
      return { id: "bot-after-retry" };
    },
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(result.id, "bot-after-retry");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [30_000, 30_000]);

  attempts = 0;
  waits.length = 0;
  await assert.rejects(() => createRecallBotWithRetry({
    create: async () => { attempts++; throw new RecallApiError(507); },
    wait: async (milliseconds) => { waits.push(milliseconds); },
  }), /507.*10 attempts/i);
  assert.equal(attempts, 10);
  assert.equal(waits.length, 9);
  assert.ok(waits.every((milliseconds) => milliseconds === 30_000));
});

test("Recall Create Bot does not retry permanent API errors and cancellation interrupts the retry delay", async () => {
  let attempts = 0;
  await assert.rejects(() => createRecallBotWithRetry({
    create: async () => { attempts++; throw new RecallApiError(400); },
    wait: async () => assert.fail("permanent errors must not wait/retry"),
  }), /Recall API request failed \(400\)/);
  assert.equal(attempts, 1);

  const controller = new AbortController();
  await assert.rejects(() => createRecallBotWithRetry({
    create: async () => { throw new RecallApiError(507); },
    signal: controller.signal,
    wait: async () => { controller.abort(new Error("cancelled by owner")); },
  }), /cancelled by owner/);
});

test("Recall chat send endpoint is scoped to a bot and enforces meeting-platform message limits", async () => {
  let sent: Record<string, unknown> | undefined;
  let url = "";
  await recallApiRequest("us-west-2", "secret-key", "/bot/bot-123/send_chat_message/", {
    method: "POST",
    body: { to: "everyone", message: "Chusky joined." },
    fetchImpl: async (input, init) => {
      url = String(input);
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(url, "https://us-west-2.recall.ai/api/v1/bot/bot-123/send_chat_message/");
  assert.deepEqual(sent, { to: "everyone", message: "Chusky joined." });
  await assert.rejects(() => recallApiRequest("us-west-2", "secret-key", "/bot/bot-123/send_chat_message/", {
    method: "POST", body: {}, fetchImpl: async () => new Response(null, { status: 204 }),
  }), /1-4096 characters/);
  await assert.rejects(() => recallApiRequest("us-west-2", "secret-key", "/bot/bot-123/not_allowed/", {
    method: "POST", fetchImpl: async () => new Response(null, { status: 204 }),
  }), /Unsupported Recall API path/);
});

test("scheduled meeting times respect Recall's guaranteed scheduling window and cap", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(validateRecallJoinAt(undefined, now), undefined);
  assert.equal(validateRecallJoinAt(new Date(now + 11 * 60_000).toISOString(), now), new Date(now + 11 * 60_000).toISOString());
  assert.throws(() => validateRecallJoinAt(new Date(now + 9 * 60_000).toISOString(), now), /at least 10 minutes/);
  assert.throws(() => validateRecallJoinAt(new Date(now + 31 * 24 * 60 * 60_000).toISOString(), now), /30 days/);
});

test("Recall lifecycle statuses map to stable Chusky meeting states", () => {
  assert.equal(mapRecallBotStatus("in_waiting_room"), "waiting_room");
  assert.equal(mapRecallBotStatus("in_call_not_recording"), "in_call");
  assert.equal(mapRecallBotStatus("fatal"), "failed");
  assert.equal(mapRecallBotStatus("recording_permission_denied"), "in_call");
  assert.equal(mapRecallBotStatus("ready"), undefined);
});

test("Recall webhook signature validates the exact body, freshness, and versioned signatures", () => {
  const secret = `whsec_${Buffer.from("test signing key").toString("base64")}`;
  const body = JSON.stringify({ event: "bot.done" });
  const id = "msg_123";
  const timestamp = String(1_800_000_000);
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  const headers = { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v0,ignored v1,${sig}` };
  assert.equal(verifyRecallWebhookSignature({ secret, body, headers, nowSeconds: 1_800_000_005 }), true);
  assert.equal(verifyRecallWebhookSignature({ secret, body: `${body} `, headers, nowSeconds: 1_800_000_005 }), false);
  assert.equal(verifyRecallWebhookSignature({ secret, body, headers, nowSeconds: 1_800_001_000 }), false);
});

test("Recall media tickets are signed, scoped to a meeting, and expire", () => {
  const token = createRecallMediaTicket({ meetingId: "mtg_123", userId: 42, expiresAt: 1_800_000_100 }, "bridge-secret");
  assert.deepEqual(verifyRecallMediaTicket(token, "bridge-secret", 1_800_000_000), {
    meetingId: "mtg_123", userId: 42, expiresAt: 1_800_000_100,
  });
  assert.equal(verifyRecallMediaTicket(token, "wrong-secret", 1_800_000_000), undefined);
  assert.equal(verifyRecallMediaTicket(token, "bridge-secret", 1_800_000_101), undefined);

  const copilot = createRecallMediaTicket({ meetingId: "mtg_456", userId: 42, expiresAt: 1_800_000_100, interactionMode: "copilot" }, "bridge-secret");
  assert.deepEqual(verifyRecallMediaTicket(copilot, "bridge-secret", 1_800_000_000), {
    meetingId: "mtg_456", userId: 42, expiresAt: 1_800_000_100, interactionMode: "copilot",
  });
});
