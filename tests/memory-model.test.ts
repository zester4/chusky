import test from "node:test";
import assert from "node:assert/strict";

type Fact = { key: string; value: string; category: string; updatedAt: number };
function search(facts: Fact[], query: string): Fact[] {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  return facts.map((fact) => ({ fact, score: tokens.filter((token) => `${fact.category} ${fact.key} ${fact.value}`.toLowerCase().includes(token)).length }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score).map((item) => item.fact);
}

test("ranks memory facts by matching terms", () => {
  const facts: Fact[] = [
    { key: "timezone", value: "Europe/London", category: "preference", updatedAt: 1 },
    { key: "editor", value: "VS Code", category: "preference", updatedAt: 1 },
  ];
  assert.equal(search(facts, "London timezone")[0].key, "timezone");
});

test("does not return unrelated memory", () => {
  assert.equal(search([{ key: "name", value: "Ada", category: "profile", updatedAt: 1 }], "calendar").length, 0);
});

test("supports multi-word matching", () => {
  const result = search([{ key: "deployment", value: "staging API", category: "instruction", updatedAt: 1 }], "staging deployment");
  assert.equal(result.length, 1);
});
