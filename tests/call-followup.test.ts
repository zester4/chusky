import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { addPhoneCall, getTask, initStore, updateTask } from "../src/store.js";
import { schedulePhoneCallFollowUps } from "../src/calls/followUp.js";

test("phone outcome action items become idempotent durable tasks", async () => {
  await initStore({ memoryOnly: true });
  const call = {
    id: `twc_${randomUUID()}`,
    userId: 901,
    provider: "twilio" as const,
    direction: "outbound" as const,
    phoneNumber: "+15550001",
    purpose: "Confirm the demo",
    status: "ended" as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await addPhoneCall(call.userId, call);
  let enqueues = 0;
  const enqueue = async (userId: number, taskId: string) => {
    enqueues += 1;
    await updateTask(userId, taskId, { workflowRunId: `wfr_${taskId}` });
    return `wfr_${taskId}`;
  };
  const outcome = {
    title: "Demo follow-up",
    summary: "The contact requested the pricing page.",
    decisions: [],
    actionItems: [{ task: "Send the pricing page", owner: "Chusky" }],
    openQuestions: [],
  };

  const first = await schedulePhoneCallFollowUps(call, outcome, { enqueueTask: enqueue });
  const second = await schedulePhoneCallFollowUps(call, outcome, { enqueueTask: enqueue });
  assert.equal(first.taskIds.length, 1);
  assert.equal(first.scheduled, 1);
  assert.equal(second.taskIds[0], first.taskIds[0]);
  assert.equal(enqueues, 1);
  assert.match((await getTask(call.userId, first.taskIds[0]))?.objective ?? "", /pricing page/);
});
