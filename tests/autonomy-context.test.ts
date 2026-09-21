import test from "node:test";
import assert from "node:assert/strict";
import { buildAutonomyContextBundle, contextBundleToPrompt } from "../src/autonomy/context.js";
import { createAttentionRecord, createTask, initStore, upsertMemory } from "../src/store.js";

test("autonomy context bundle is owner-scoped, linked, and bounded", async () => {
  await initStore({ memoryOnly: true });
  const userId = 940001;
  const otherUserId = 940002;
  const task = await createTask(userId, { id: "task_context", title: "Launch QA", objective: "Verify the launch checklist", nextAction: "Ask QA for the final report" });
  await createAttentionRecord(userId, "open_loop", { title: "Launch checklist", objective: "Verify the launch checklist", nextAction: "Ask QA for the final report", status: "open" });
  await upsertMemory(userId, { category: "project", key: "launch-owner", value: "Marketing owns the launch checklist", confidence: 1, projectId: "launch" });
  await upsertMemory(otherUserId, { category: "project", key: "launch-owner", value: "This must never cross the owner boundary", confidence: 1, projectId: "launch" });

  const bundle = await buildAutonomyContextBundle(userId, { objective: "Verify the launch checklist", links: { taskId: task.id, projectId: "launch" } });
  assert.equal(bundle.task?.id, task.id);
  assert.equal(bundle.openLoops.length, 1);
  assert.equal(bundle.memories.some((memory) => memory.value.includes("never cross")), false);
  assert.equal(bundle.memories.some((memory) => memory.value.includes("Marketing owns")), true);
  assert.ok(contextBundleToPrompt(bundle).length < 12_000);
});
