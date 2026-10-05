import test from "node:test";
import assert from "node:assert/strict";
import { classifyMemory } from "../src/memory/classifier.js";

test("memory classifier never sends locally sensitive text to Jev and fails closed", async () => {
  const calls: unknown[] = [];
  const client = { available: () => true, evaluate: async (...args: unknown[]) => { calls.push(args); throw new Error("must not be called"); } } as any;
  const result = await classifyMemory({ key: "health", value: "My medical diagnosis is private", sensitivity: "normal", client });
  assert.equal(calls.length, 0);
  assert.equal(result.meetingSafe, false);
  assert.equal(result.audience, "sensitive");
});

test("disabled memory classification remains owner-only for meeting exposure", async () => {
  const result = await classifyMemory({ key: "conversation.remembered", value: "Our refund window is 30 days", category: "fact", explicit: true });
  assert.equal(result.meetingSafe, false);
  assert.equal(result.audience, "owner_only");
});
