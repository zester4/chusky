import test, { before } from "node:test";
import assert from "node:assert/strict";
import { addPhoneCall, appendPhoneCallTranscriptTurn, deletePhoneCallTranscript, getPhoneCall, hasVoiceCallOptOut, initStore, updatePhoneCall } from "../src/store.js";

before(async () => { await initStore({ memoryOnly: true }); });

test("shutdown recovery inserts the opening before already committed caller turns", async () => {
  const userId = 910403;
  const id = "twc_opening_order";
  const startedAt = Date.now() - 10_000;
  await addPhoneCall(userId, { id, userId, provider: "twilio", direction: "outbound", phoneNumber: "+15550103", purpose: "test", status: "ended", createdAt: startedAt, updatedAt: startedAt });
  await appendPhoneCallTranscriptTurn(userId, id, { turnId: "turn_1", caller: "Yes", assistant: "Thank you" });
  await appendPhoneCallTranscriptTurn(userId, id, { turnId: "opening", assistant: "Hello", kind: "opening" });
  await appendPhoneCallTranscriptTurn(userId, id, { turnId: "opening", assistant: "Hello", kind: "opening" });
  const turns = (await getPhoneCall(userId, id))!.transcript!.turns;
  assert.deepEqual(turns.map(turn => turn.id), ["opening", "turn_1"]);
  assert.equal(turns[0].at, startedAt);
});

test("transcript turns are idempotent and owner deletion preserves an audit timeline", async () => {
  const userId = 910401;
  const id = "twc_privacy_delete";
  await addPhoneCall(userId, { id, userId, provider: "twilio", direction: "outbound", callProfile: "personal", phoneNumber: "+15550101", purpose: "privacy", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
  await appendPhoneCallTranscriptTurn(userId, id, { turnId: "turn_1", caller: "Hello", assistant: "Hi" });
  await appendPhoneCallTranscriptTurn(userId, id, { turnId: "turn_1", caller: "Hello again", assistant: "Duplicate" });
  assert.equal((await getPhoneCall(userId, id))?.transcript?.turns.length, 1);
  assert.equal(await deletePhoneCallTranscript(userId, id), true);
  const deleted = await getPhoneCall(userId, id);
  assert.equal(deleted?.transcript, undefined);
  assert.equal(deleted?.transcriptStatus, "deleted");
  assert.ok(deleted?.timeline?.some((event) => event.type === "transcript_deleted"));
  assert.equal(await deletePhoneCallTranscript(userId, id), false);
});

test("voice opt-out is durable and scoped to the owner", async () => {
  const userId = 910402;
  const id = "twc_privacy_optout";
  await addPhoneCall(userId, { id, userId, provider: "twilio", direction: "outbound", callProfile: "personal", phoneNumber: "+15550102", purpose: "opt out", status: "ended", terminalReason: "opt_out", createdAt: Date.now(), updatedAt: Date.now() });
  assert.equal(await hasVoiceCallOptOut(userId, "+15550102"), true);
  assert.equal(await hasVoiceCallOptOut(userId + 1, "+15550102"), false);
  await updatePhoneCall(userId, id, { terminalReason: "completed" });
  assert.equal(await hasVoiceCallOptOut(userId, "+15550102"), false);
});
