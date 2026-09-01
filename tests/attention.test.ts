import test from "node:test";
import assert from "node:assert/strict";
import {
  createAttentionRecord, getAttentionRecord, initStore, listAttentionRecords, updateAttentionRecord,
  type AttentionRecord,
} from "../src/store.js";
import { nativeTool } from "../src/nativeTools.js";
import { validateNativeToolArguments } from "../src/agentTools.js";

test("attention records are durable, bounded, owner-scoped, and separate from sessions", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910001;
  const otherUserId = 910002;
  const observation = await createAttentionRecord(userId, "observation", {
    source: "telegram", eventType: "message", summary: "User is preparing a launch", importance: 4, novelty: -2,
    dedupeKey: "launch:preparation",
  });
  assert.equal(observation.id.startsWith("obs_"), true);
  assert.equal((observation as any).importance, 1);
  assert.equal((observation as any).novelty, 0);
  assert.equal((await listAttentionRecords(userId, "observation")).length, 1);
  assert.equal((await listAttentionRecords(otherUserId, "observation")).length, 0);
  assert.equal(await getAttentionRecord(otherUserId, "observation", observation.id), undefined);

  const updated = await updateAttentionRecord(userId, "observation", observation.id, { userId: otherUserId, status: "processed" });
  assert.equal((updated as any).userId, userId);
  assert.equal((await getAttentionRecord(userId, "observation", observation.id) as any).status, "processed");
});

test("all phase-one entities use the same explicit substrate contract", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910003;
  const cases: Array<[any, Record<string, unknown>]> = [
    ["open_loop", { title: "Finish launch plan", relatedEntityIds: Array.from({ length: 30 }, (_, i) => `e-${i}`) }],
    ["attention_candidate", { candidateType: "prepare", reason: "The launch plan has a next action" }],
    ["standing_order", { name: "Watch launch risks", instruction: "Observe launch blockers", authority: "observe" }],
    ["delivery_preference", { provider: "telegram", conversationId: "chat-1", mode: "digest" }],
    ["relationship", { personKey: "alex", name: "Alex", importance: 0.8 }],
    ["project_state", { projectKey: "launch", name: "Launch", summary: "Preparing the launch" }],
  ];
  for (const [kind, input] of cases) {
    const record = await createAttentionRecord(userId, kind, input);
    assert.equal(record.userId, userId);
    assert.equal((await listAttentionRecords(userId, kind)).length, 1);
  }
  const loop = await listAttentionRecords(userId, "open_loop");
  assert.equal((loop[0] as any).relatedEntityIds.length, 20);
  const preference = await createAttentionRecord(userId, "delivery_preference", { provider: "telegram", conversationId: "chat-1", mode: "immediate" });
  assert.equal((await listAttentionRecords(userId, "delivery_preference")).length, 1);
  assert.equal((preference as any).mode, "digest");
});

test("native attention tool validates and routes explicit state operations", async () => {
  await initStore({ memoryOnly: true });
  const userId = 910004;
  validateNativeToolArguments("CHUCK_ATTENTION_STATE", { action: "create", kind: "project_state" });
  const created = await nativeTool(userId, "CHUCK_ATTENTION_STATE", {
    action: "create", kind: "project_state", projectKey: "agent", name: "Agent", summary: "Build safely",
  }) as AttentionRecord;
  const listed = await nativeTool(userId, "CHUCK_ATTENTION_STATE", { action: "list", kind: "project_state", query: "safely" }) as AttentionRecord[];
  assert.equal(listed[0]?.id, created.id);
  const changed = await nativeTool(userId, "CHUCK_ATTENTION_STATE", { action: "update", kind: "project_state", id: created.id, nextAction: "Add the attention engine" }) as any;
  assert.equal(changed.nextAction, "Add the attention engine");
  await assert.rejects(() => nativeTool(userId + 1, "CHUCK_ATTENTION_STATE", { action: "update", kind: "project_state", id: created.id, nextAction: "hijack" }));
});
