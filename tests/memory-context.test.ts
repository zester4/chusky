import test from "node:test";
import assert from "node:assert/strict";
import { initStore, searchMemories, upsertMemoryAndContext } from "../src/store.js";
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
