import test from "node:test";
import assert from "node:assert/strict";
import { selectBlandBusinessFacts } from "../src/calls/blandBrain.js";
import type { MemoryFact } from "../src/store.js";

test("Bland consultation selects only relevant global normal-sensitivity company facts", () => {
  const memories: MemoryFact[] = [
    { id: "mem_price", category: "business", key: "Annual plan pricing", value: "The annual plan starts at $1,200.", confidence: 1, source: "owner", sensitivity: "normal", createdAt: 1, updatedAt: 1 },
    { id: "mem_margin", category: "business", key: "Internal pricing margin", value: "Never disclose our margin.", confidence: 1, source: "owner", sensitivity: "sensitive", createdAt: 1, updatedAt: 1 },
    { id: "mem_prospect", category: "business", key: "Prospect discount", value: "The prospect was offered a 15% discount.", confidence: 1, source: "owner", sensitivity: "normal", personKey: "prospect", createdAt: 1, updatedAt: 1 },
    { id: "mem_project", category: "business", key: "Project launch date", value: "Launch is planned for November.", confidence: 1, source: "owner", sensitivity: "normal", projectId: "private-project", createdAt: 1, updatedAt: 1 },
    { id: "mem_expired", category: "business", key: "Expired annual plan pricing", value: "The expired annual plan starts at $800.", confidence: 1, source: "owner", sensitivity: "normal", expiresAt: Date.now() - 1, createdAt: 1, updatedAt: 1 },
    { id: "mem_personal", category: "personal", key: "Private price", value: "Home address is private.", confidence: 1, source: "owner", sensitivity: "normal", createdAt: 1, updatedAt: 1 },
  ];

  const facts = selectBlandBusinessFacts(memories, "What does the annual plan cost?");
  assert.deepEqual(facts, ["Annual plan pricing: The annual plan starts at $1,200."]);
  assert.doesNotMatch(JSON.stringify(facts), /margin|15%|November|\$800/);
});
