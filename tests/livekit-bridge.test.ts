import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { addPhoneCall, getPhoneCall, initStore } from "../src/store.js";
import { processLiveKitBuilderConsult } from "../src/calls/livekitBridge.js";

const secret = "test-only-livekit-builder-secret-long-enough";

async function makeCall(userId: number, status: "bridging" | "active" | "ended" = "active") {
  const call = {
    id: `lvc_${randomUUID()}`,
    userId,
    provider: "livekit" as const,
    direction: "outbound" as const,
    callProfile: "business" as const,
    callVerification: "verified" as const,
    phoneNumber: "+15550001",
    purpose: "Confirm the customer's repair appointment",
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await addPhoneCall(userId, call);
  return call;
}

function body(call: { id: string; userId: number }, question = "What time is the appointment?", turnId = "builder-turn-1") {
  return JSON.stringify({ version: 1, kind: "question", callId: call.id, userId: call.userId, turnId, question });
}

test("Builder bridge authenticates, derives policy from the durable call, and forwards one question", async () => {
  await initStore({ memoryOnly: true });
  const call = await makeCall(931);
  let received: Record<string, unknown> | undefined;
  const result = await processLiveKitBuilderConsult({
    rawBody: body(call),
    authorization: `Bearer ${secret}`,
    secret,
    answerQuestion: async (request) => {
      received = request;
      return { answer: "The appointment is at three PM." };
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, answer: "The appointment is at three PM." });
  assert.deepEqual(received, {
    version: 1,
    kind: "question",
    callId: call.id,
    userId: call.userId,
    direction: "outbound",
    purpose: call.purpose,
    callProfile: "business",
    verification: "verified",
    turnId: "builder-turn-1",
    question: "What time is the appointment?",
  });
});

test("Builder bridge rejects bad credentials, malformed metadata, and inactive calls", async () => {
  await initStore({ memoryOnly: true });
  const call = await makeCall(932);
  const answer = async () => ({ answer: "must not run" });

  assert.equal((await processLiveKitBuilderConsult({ rawBody: body(call), authorization: "Bearer wrong", secret, answerQuestion: answer })).status, 401);
  assert.equal((await processLiveKitBuilderConsult({ rawBody: JSON.stringify({ version: 1 }), authorization: `Bearer ${secret}`, secret, answerQuestion: answer })).status, 400);

  const ended = await makeCall(933, "ended");
  const result = await processLiveKitBuilderConsult({ rawBody: body(ended), authorization: `Bearer ${secret}`, secret, answerQuestion: answer });
  assert.equal(result.status, 404);
});

test("Builder bridge keeps the same safe quota and approval responses as the worker bridge", async () => {
  await initStore({ memoryOnly: true });
  const call = await makeCall(934);
  let invoked = false;
  const result = await processLiveKitBuilderConsult({
    rawBody: body(call),
    authorization: `Bearer ${secret}`,
    secret,
    authorizeQuestion: async () => "usage_limit",
    answerQuestion: async () => {
      invoked = true;
      return { answer: "should not run" };
    },
  });
  assert.equal(result.status, 200);
  assert.match(result.body.answer ?? "", /owner follows up/);
  assert.equal(invoked, false);
  assert.equal((await getPhoneCall(call.userId, call.id))?.provider, "livekit");
});
