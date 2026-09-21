import test from "node:test";
import assert from "node:assert/strict";
import { buildAutonomyContextBundle, contextBundleToPrompt } from "../src/autonomy/context.js";
import { appendChannelConversationMessages, createAttentionRecord, createTask, initStore, upsertMemory } from "../src/store.js";

test("autonomy context bundle is owner-scoped, linked, and bounded", async () => {
  await initStore({ memoryOnly: true });
  const userId = 940001;
  const otherUserId = 940002;
  const task = await createTask(userId, { id: "task_context", title: "Launch QA", objective: "Verify the launch checklist", nextAction: "Ask QA for the final report" });
  await createAttentionRecord(userId, "open_loop", { title: "Launch checklist", objective: "Verify the launch checklist", nextAction: "Ask QA for the final report", status: "open" });
  await createAttentionRecord(userId, "open_loop", { title: "Unrelated finance review", objective: "Reconcile a separate finance report", nextAction: "Ask finance for the ledger", status: "open" });
  await upsertMemory(userId, { category: "project", key: "launch-owner", value: "Marketing owns the launch checklist", confidence: 1, projectId: "launch" });
  await upsertMemory(userId, { category: "project", key: "private-note", value: "Sensitive context must not enter an autonomous slice", confidence: 1, projectId: "launch", sensitivity: "sensitive" });
  await upsertMemory(otherUserId, { category: "project", key: "launch-owner", value: "This must never cross the owner boundary", confidence: 1, projectId: "launch" });

  const bundle = await buildAutonomyContextBundle(userId, { objective: "Verify the launch checklist", links: { taskId: task.id, projectId: "launch" } });
  assert.equal(bundle.task?.id, task.id);
  assert.equal(bundle.openLoops.length, 1);
  assert.equal(bundle.memories.some((memory) => memory.value.includes("never cross")), false);
  assert.equal(bundle.memories.some((memory) => memory.value.includes("Marketing owns")), true);
  assert.equal(bundle.memories.some((memory) => memory.value.includes("Sensitive context")), false);
  assert.equal(bundle.openLoops.some((loop) => loop.title.includes("Unrelated")), false);
  assert.ok(contextBundleToPrompt(bundle).length < 12_000);
});

test("autonomy context rejects a linked channel conversation owned by another user", async () => {
  await initStore({ memoryOnly: true });
  await appendChannelConversationMessages({
    id: "telegram:-:owner-boundary:-",
    accountId: "account_other",
    userId: 940004,
    provider: "telegram",
    scope: "private",
    messages: [{ role: "user", content: "private other-owner context", createdAt: Date.now() }],
  });
  const bundle = await buildAutonomyContextBundle(940003, { objective: "continue", links: { conversationId: "telegram:-:owner-boundary:-" }, includeHistory: true });
  assert.deepEqual(bundle.conversation, []);
});
