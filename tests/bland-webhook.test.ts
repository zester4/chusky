import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { addPhoneCall, getPhoneCall, getSession, initStore, updatePhoneCall } from "../src/store.js";
import { createBlandCallToken } from "../src/calls/blandSecurity.js";
import { processBlandConsult, processBlandWebhook } from "../src/calls/blandWebhooks.js";

const secret = "test-only-bland-webhook-secret-long-enough";
const makeCall = async (userId: number, providerCallId?: string) => {
  const call = {
    id: `blc_${randomUUID()}`, userId, provider: "bland" as const, direction: "outbound" as const,
    phoneNumber: "+15550001", purpose: "Qualify the inbound lead", status: "bridging" as const,
    providerCallId, createdAt: Date.now(), updatedAt: Date.now(),
  };
  await addPhoneCall(userId, call);
  if (providerCallId) await updatePhoneCall(userId, call.id, { providerCallId });
  return call;
};
const signed = (body: unknown) => {
  const rawBody = JSON.stringify(body);
  return { rawBody, signature: createHmac("sha256", secret).update(rawBody).digest("hex") };
};

test("Bland live status callbacks resolve from the opaque per-call URL without metadata", async () => {
  await initStore({ memoryOnly: true });
  const call = await makeCall(821);
  const callbackToken = createBlandCallToken({ userId: call.userId, callId: call.id }, secret);
  const body = { call_id: "provider-call-821", category: "call", message: "Call started", log_level: "info" };

  const result = await processBlandWebhook({ ...signed(body), callbackToken, secret });
  assert.equal(result.status, 200);
  assert.equal((await getPhoneCall(call.userId, call.id))?.status, "active");
  assert.equal((await getPhoneCall(call.userId, call.id))?.providerCallId, body.call_id);
  assert.equal((await processBlandWebhook({ ...signed(body), callbackToken, secret })).body.duplicate, true);
});

test("Bland post-call webhook persists distinct user and assistant turns once", async () => {
  await initStore({ memoryOnly: true });
  const call = await makeCall(822, "provider-call-822");
  const callbackToken = createBlandCallToken({ userId: call.userId, callId: call.id }, secret);
  const body = {
    call_id: "provider-call-822", completed: true, queue_status: "complete", call_length: 2.5,
    summary: "The lead asked for pricing and agreed to a demo.",
    transcripts: [
      { id: 1, user: "assistant", text: "Thanks for taking the call." },
      { id: 2, user: "user", text: "Can you send pricing?" },
      { id: 3, user: "agent-action", text: "Ended call" },
    ],
  };
  const request = { ...signed(body), callbackToken, secret };

  assert.equal((await processBlandWebhook(request)).status, 200);
  const saved = await getSession(call.userId);
  assert.deepEqual(saved.history.map(({ role, content }) => ({ role, content })), [
    { role: "assistant", content: `[Bland call ${call.id}] Thanks for taking the call.` },
    { role: "user", content: `[Bland call ${call.id}] Can you send pricing?` },
  ]);
  assert.equal((await getPhoneCall(call.userId, call.id))?.summary, body.summary);
  assert.equal((await processBlandWebhook(request)).body.duplicate, true);
  assert.equal((await getSession(call.userId)).history.length, 2);
});

test("Bland consult tool is authenticated to the call owner and cannot target another call", async () => {
  await initStore({ memoryOnly: true });
  const call = await makeCall(823, "provider-call-823");
  let asked: { userId: number; callId: string; purpose: string; question: string } | undefined;
  const answerQuestion = async (input: { userId: number; callId: string; purpose: string; question: string }) => {
    asked = input;
    return "Our annual plan starts at $1,200.";
  };
  const request = { authorization: `Bearer ${secret}`, rawBody: JSON.stringify({ call_id: "provider-call-823", question: "What does the annual plan cost?" }), secret, answerQuestion };

  const result = await processBlandConsult(request);
  assert.equal(result.status, 200);
  assert.equal(result.body.answer, "Our annual plan starts at $1,200.");
  assert.deepEqual(asked, { userId: 823, callId: call.id, purpose: call.purpose, question: "What does the annual plan cost?" });
  const mismatched = await processBlandConsult({ ...request, rawBody: JSON.stringify({ call_id: "some-other-call", question: "What does the annual plan cost?" }) });
  assert.equal(mismatched.status, 404);
});

test("Bland webhook rejects invalid signatures and expired or altered callback tokens", async () => {
  await initStore({ memoryOnly: true });
  const call = await makeCall(824);
  const token = createBlandCallToken({ userId: call.userId, callId: call.id }, secret);
  const badSignature = await processBlandWebhook({ ...signed({ call_id: "provider-call-824", category: "call", message: "Call started" }), signature: "00", callbackToken: token, secret });
  assert.equal(badSignature.status, 401);
  const altered = await processBlandWebhook({ ...signed({ call_id: "provider-call-824", category: "call", message: "Call started" }), callbackToken: `${token}x`, secret });
  assert.equal(altered.status, 401);
});

test("Bland custom-tool requests require the shared bearer secret and only resolve an indexed active call", async () => {
  await initStore({ memoryOnly: true });
  await makeCall(825, "provider-call-825");
  const invalid = await processBlandConsult({
    authorization: "Bearer wrong-secret", secret,
    rawBody: JSON.stringify({ call_id: "provider-call-825", question: "What is the next step?" }),
    answerQuestion: async () => "should not run",
  });
  assert.equal(invalid.status, 401);
  const missing = await processBlandConsult({
    authorization: `Bearer ${secret}`, secret,
    rawBody: JSON.stringify({ call_id: "unmapped-call-825", question: "What is the next step?" }),
    answerQuestion: async () => "should not run",
  });
  assert.equal(missing.status, 404);
  const limited = await processBlandConsult({
    authorization: `Bearer ${secret}`, secret,
    rawBody: JSON.stringify({ call_id: "provider-call-825", question: "What is the next step?" }),
    authorizeQuestion: async () => "usage_limit",
    answerQuestion: async () => "should not run",
  });
  assert.equal(limited.status, 200);
  assert.match(limited.body.answer ?? "", /owner follows up/);
});
