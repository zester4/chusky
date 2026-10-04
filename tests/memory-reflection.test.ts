import test from "node:test";
import assert from "node:assert/strict";
import { extractMemoryCandidates } from "../src/memory/reflection.js";

test("reflection auto-accepts only explicit non-sensitive owner statements", () => {
  const [item] = extractMemoryCandidates("Remember that I prefer concise updates.");
  assert.equal(item?.explicit, true);
  assert.equal(item?.sensitivity, "normal");
  assert.equal(item?.confidence, 0.99);
});

test("uncertain observations become review candidates, never facts", () => {
  const [item] = extractMemoryCandidates("I think the client probably prefers weekly reports.");
  assert.equal(item?.explicit, false);
  assert.equal(item?.reason, "inference");
  assert.ok((item?.confidence ?? 1) < 0.9);
  assert.ok(item?.reviewAt);
});

test("sensitive values are marked sensitive and reviewable", () => {
  const [item] = extractMemoryCandidates("Remember that my home address is 12 Example Street.");
  assert.equal(item?.sensitivity, "sensitive");
  assert.ok(item?.reviewAt);
});

test("ordinary conversation is not silently converted into memory", () => {
  assert.deepEqual(extractMemoryCandidates("Can you summarize the meeting?"), []);
});
