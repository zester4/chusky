import test from "node:test";
import assert from "node:assert/strict";
import { nativeTool, setPhoneCallLauncherForTests } from "../src/nativeTools.js";

test("rewording an outbound objective does not redial within the same run; a new owner retry can", async () => {
  const inputs: Record<string, unknown>[] = [];
  setPhoneCallLauncherForTests(async (_userId, input) => { inputs.push(input); return { id: "twc_test", status: "bridging" }; });
  try {
    const args = { phoneNumber: "+15550101234", purpose: "Ask about tomorrow at eight", callProfile: "personal" };
    await nativeTool(42, "CHUCK_START_PHONE_CALL", args, { currentRunId: "attempt_1" });
    await nativeTool(42, "CHUCK_START_PHONE_CALL", { ...args, purpose: "Confirm the appointment and book if accepted", callProfile: "business" }, { currentRunId: "attempt_1" });
    await nativeTool(42, "CHUCK_START_PHONE_CALL", args, { currentRunId: "owner_retry_2" });
    assert.equal(inputs[0].requestKey, inputs[1].requestKey);
    assert.notEqual(inputs[0].requestKey, inputs[2].requestKey);
  } finally { setPhoneCallLauncherForTests(undefined); }
});
