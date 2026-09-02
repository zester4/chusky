import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getApproval, initStore } from "../src/store.js";
import { requestPhoneCallApproval } from "../src/calls/phoneApproval.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("direct phone-call requests persist exact validated arguments for one approval", async () => {
  const approval = await requestPhoneCallApproval(71, { phoneNumber: "+15550001", purpose: "Confirm tomorrow's appointment" });
  assert.equal(approval.toolSlug, "CHUCK_START_PHONE_CALL");
  assert.deepEqual(approval.args, { phoneNumber: "+15550001", purpose: "Confirm tomorrow's appointment" });
  assert.equal(approval.status, "pending");
  assert.deepEqual(await getApproval(71, approval.id), approval);
});

test("direct phone-call requests reject invalid destinations and missing purpose", async () => {
  await assert.rejects(() => requestPhoneCallApproval(72, { phoneNumber: "550472834", purpose: "Test" }), /E\.164/);
  await assert.rejects(() => requestPhoneCallApproval(72, { phoneNumber: "+15550001", purpose: "" }), /purpose/);
});
