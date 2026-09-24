import test from "node:test";
import assert from "node:assert/strict";
import { forgetMemory, initStore, searchMemories, updateMemory, upsertMemoryAndContext } from "../src/store.js";
import { selectContext } from "../src/contextGraph.js";

test("a saved memory and its searchable context projection remain in sync", async () => {
  await initStore({ memoryOnly: true });
  const userId = 991204;
  const saved = await upsertMemoryAndContext(userId, {
    category: "preference",
    key: "report_style",
    value: "Use concise executive summaries",
    confidence: 1,
    source: "test",
    sensitivity: "normal",
  }, {
    scope: "user",
    kind: "preference",
    key: "report_style",
    value: "Use concise executive summaries",
    source: "test",
    sensitivity: "normal",
  });

  const memories = await searchMemories(userId, "report_style");
  const context = await selectContext(userId, { query: "report_style", purpose: "planning" });
  assert.equal(memories[0]?.id, saved.memory.id);
  assert.equal(context[0]?.id, saved.context.id);
  assert.equal(context[0]?.sourceRef, saved.memory.id);
  assert.equal(context[0]?.value, memories[0]?.value);
});

test("updating a memory atomically replaces its context projection even when its key and scope change", async () => {
  await initStore({ memoryOnly: true });
  const userId = 991205;
  const saved = await upsertMemoryAndContext(userId, {
    category: "preference", key: "old_key", value: "Old private value", confidence: 1, source: "test", sensitivity: "normal",
  }, { scope: "user", kind: "preference", key: "old_key", value: "Old private value", source: "test", sensitivity: "normal" });

  const updated = await updateMemory(userId, { id: saved.memory.id }, { key: "new_key", value: "Updated project value", projectId: "project-1" });
  assert.equal(updated?.id, saved.memory.id);
  assert.equal((await selectContext(userId, { query: "old_key" })).length, 0);
  const context = await selectContext(userId, { query: "new_key", scope: "project", scopeId: "project-1" });
  assert.equal(context.length, 1);
  assert.equal(context[0]?.id, saved.context.id);
  assert.equal(context[0]?.sourceRef, saved.memory.id);
  assert.equal(context[0]?.value, "Updated project value");
});

test("forgetting a memory removes its linked context projection in the same owner write", async () => {
  await initStore({ memoryOnly: true });
  const userId = 991206;
  const saved = await upsertMemoryAndContext(userId, {
    category: "fact", key: "temporary_fact", value: "This should disappear", confidence: 1, source: "test", sensitivity: "normal",
  }, { scope: "user", kind: "fact", key: "temporary_fact", value: "This should disappear", source: "test", sensitivity: "normal" });

  assert.equal(await forgetMemory(userId, saved.memory.id), true);
  assert.equal((await searchMemories(userId, "temporary_fact")).length, 0);
  assert.equal((await selectContext(userId, { query: "temporary_fact" })).length, 0);
});
