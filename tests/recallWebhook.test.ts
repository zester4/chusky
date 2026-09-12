import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { processRecallStatusWebhook, receiveRecallChatWebhook } from "../src/meetings/webhook.js";
import type { RecallChatEventRecord } from "../src/store.js";

const secret = `whsec_${Buffer.from("test Recall realtime workspace key").toString("base64")}`;

function signed(body: string, id = "msg_recall_123") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new Headers({
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  });
}

function eventBody(text = "/chusky what was decided?") {
  return JSON.stringify({
    event: "participant_events.chat_message",
    data: {
      data: {
        participant: { id: 456, name: "Private attendee", email: "private@example.com" },
        data: { text, to: "everyone" },
      },
      bot: { id: "bot_123", metadata: { chusky_meeting_id: "mtg_123", chusky_user_id: "42" } },
    },
  });
}

function parsed() {
  return {
    userId: 42,
    meetingId: "mtg_123",
    providerBotId: "bot_123",
    command: { kind: "message" as const, text: "what was decided?" },
  };
}

function record(overrides: Partial<RecallChatEventRecord> = {}): RecallChatEventRecord {
  return {
    eventId: "rch_" + "a".repeat(64),
    userId: 42,
    meetingId: "mtg_123",
    providerBotId: "bot_123",
    command: parsed().command,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

test("Recall status webhook releases a failed reconciliation for provider retry, then dedupes completion", async () => {
  let activeToken: string | undefined;
  let completed = false;
  let reconcileCalls = 0;
  const common = {
    key: "recall-status-event-1",
    body: { event: "bot.in_call_not_recording" },
    claim: async (_key: string, token: string) => {
      if (completed) return "completed" as const;
      if (activeToken) return "busy" as const;
      activeToken = token;
      return "acquired" as const;
    },
    complete: async (_key: string, token: string) => {
      if (activeToken !== token) return false;
      activeToken = undefined;
      completed = true;
      return true;
    },
    release: async (_key: string, token: string) => {
      if (activeToken !== token) return false;
      activeToken = undefined;
      return true;
    },
  };
  assert.equal(await processRecallStatusWebhook({
    ...common,
    reconcile: async () => { reconcileCalls++; throw new Error("transient storage outage"); },
  }), "retry");
  assert.equal(activeToken, undefined, "failed reconciliation relinquishes the lease immediately");
  assert.equal(await processRecallStatusWebhook({
    ...common,
    reconcile: async () => { reconcileCalls++; },
  }), "processed");
  assert.equal(await processRecallStatusWebhook({ ...common, reconcile: async () => { reconcileCalls++; } }), "duplicate");
  assert.equal(reconcileCalls, 2);
});

test("a concurrent Recall status retry stays retryable while another worker holds the lease", async () => {
  let active = true;
  const outcome = await processRecallStatusWebhook({
    key: "event-locked",
    body: {},
    claim: async () => active ? "busy" : "acquired",
    reconcile: async () => assert.fail("busy events must not reconcile concurrently"),
    complete: async () => false,
    release: async () => { active = false; return true; },
  });
  assert.equal(outcome, "retry");
});

test("Recall realtime webhook validates exact signed bytes and queues only an opaque event ID", async () => {
  const rawBody = eventBody();
  let stored: RecallChatEventRecord | undefined;
  let enqueuedId = "";
  const result = await receiveRecallChatWebhook({
    secret,
    rawBody,
    headers: signed(rawBody),
    resolve: async () => parsed(),
    create: async (value) => (stored = value),
    update: async (eventId, patch) => {
      assert.equal(eventId, stored?.eventId);
      stored = { ...stored!, ...patch };
      return stored;
    },
    enqueue: async (eventId, queuedRecord) => {
      enqueuedId = eventId;
      assert.deepEqual(queuedRecord.command, { kind: "message", text: "what was decided?" });
      return "workflow_opaque";
    },
  });

  assert.deepEqual(result, { status: 202, queued: true });
  assert.match(enqueuedId, /^rch_[a-f0-9]{64}$/);
  assert.equal(stored?.workflowRunId, "workflow_opaque");
  assert.equal(JSON.stringify(stored).includes("private@example.com"), false);
  assert.equal(JSON.stringify(stored).includes("Private attendee"), false);
});

test("invalid signature is rejected before payload resolution or persistence", async () => {
  const rawBody = eventBody();
  let touched = false;
  const headers = signed(rawBody);
  headers.set("webhook-signature", "v1,invalid");
  const result = await receiveRecallChatWebhook({
    secret,
    rawBody,
    headers,
    resolve: async () => { touched = true; return parsed(); },
    create: async (value) => { touched = true; return value; },
    update: async () => undefined,
    enqueue: async () => { touched = true; return "unused"; },
  });
  assert.deepEqual(result, { status: 401 });
  assert.equal(touched, false);
});

test("signed malformed payload is rejected and ambient chat is acknowledged without storage", async () => {
  const malformed = "{";
  assert.deepEqual(await receiveRecallChatWebhook({
    secret,
    rawBody: malformed,
    headers: signed(malformed),
    resolve: async () => undefined,
    create: async (value) => value,
    update: async () => undefined,
    enqueue: async () => "unused",
  }), { status: 400 });

  const rawBody = eventBody("ordinary meeting chat, not addressed to Chusky");
  let persisted = false;
  assert.deepEqual(await receiveRecallChatWebhook({
    secret,
    rawBody,
    headers: signed(rawBody),
    resolve: async () => undefined,
    create: async (value) => { persisted = true; return value; },
    update: async () => undefined,
    enqueue: async () => "unused",
  }), { status: 204 });
  assert.equal(persisted, false);
});

test("Recall retries after transient queue failure and deduplicates already queued provider events", async () => {
  const rawBody = eventBody();
  const headers = signed(rawBody);
  let stored: RecallChatEventRecord | undefined;
  const common = {
    secret,
    rawBody,
    headers,
    resolve: async () => parsed(),
    create: async (value: RecallChatEventRecord) => (stored ??= value),
    update: async (eventId: string, patch: Partial<RecallChatEventRecord>) => {
      assert.equal(eventId, stored?.eventId);
      stored = { ...stored!, ...patch };
      return stored;
    },
  };
  const failed = await receiveRecallChatWebhook({ ...common, enqueue: async () => { throw new Error("private provider response"); } });
  assert.deepEqual(failed, { status: 503 });
  assert.equal(JSON.stringify(failed).includes("private provider response"), false);

  stored = { ...stored!, workflowRunId: "already-queued" };
  let enqueued = false;
  const duplicate = await receiveRecallChatWebhook({ ...common, enqueue: async () => { enqueued = true; return "new-run"; } });
  assert.deepEqual(duplicate, { status: 204 });
  assert.equal(enqueued, false);
});

test("Recall event-ID collisions across owners fail closed", async () => {
  const rawBody = eventBody();
  const result = await receiveRecallChatWebhook({
    secret,
    rawBody,
    headers: signed(rawBody),
    resolve: async () => parsed(),
    create: async () => record({ userId: 999 }),
    update: async () => undefined,
    enqueue: async () => "must-not-run",
  });
  assert.deepEqual(result, { status: 409 });
});
