import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { setAgentDependenciesForTests } from "../src/agent.js";
import { requestDelegationCancellation, executeDelegation } from "../src/subagents/executor.js";
import { getTask, initStore, listHandoffRecords } from "../src/store.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("cancels an in-flight Composio call and preserves redacted audit metadata", async () => {
  const userId = 992001;
  let started!: () => void;
  const callStarted = new Promise<void>((resolve) => { started = resolve; });
  let receivedSignal: AbortSignal | undefined;

  const session = {
    sessionId: "cancel-session",
    tools: async () => [{ function: { name: "GITHUB_GET_REPOSITORY", parameters: { type: "object", properties: {} } } }],
    execute: async (_slug: string, _args: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      receivedSignal = options?.signal;
      started();
      return new Promise((resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
        setTimeout(() => resolve({ repository: "late-result" }), 2_000);
      });
    },
  };
  setAgentDependenciesForTests({ composio: { create: async () => session, sessions: { use: async () => session } } });

  const runPromise = executeDelegation(userId, {
    worker: "lucas",
    objective: "Inspect the repository and report its current status",
    allowedComposioTools: ["GITHUB_GET_REPOSITORY"],
    context: { toolCall: { name: "GITHUB_GET_REPOSITORY", args: { owner: "private-owner", repo: "private-repo" } } },
  });

  await callStarted;
  const records = await listHandoffRecords(userId);
  assert.equal(records.length, 1);
  const cancellation = await requestDelegationCancellation(userId, records[0]!.id, "Stop this worker now.");
  assert.equal(cancellation?.status, "cancel_requested");
  assert.ok(receivedSignal);
  assert.equal(receivedSignal!.aborted, true);

  const result = await runPromise;
  assert.equal(result.status, "interrupted");
  assert.equal(result.toolCallsLog[0]?.redactedValues, true);
  assert.deepEqual(result.toolCallsLog[0]?.argumentKeys, ["owner", "repo"]);
  assert.equal("args" in (result.toolCallsLog[0] ?? {}), false);
  assert.equal((await getTask(userId, result.taskId!))?.status, "cancelled");
});
