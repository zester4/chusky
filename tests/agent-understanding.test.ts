import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type UnderstandingCase = {
  id: string;
  surface: "chat" | "voice";
  history: Array<{ role: string; content: string }>;
  current: string;
  expected: {
    objective: string;
    confirmed_facts: string[];
    unknowns: string[];
    action: string;
    must_not: string[];
  };
};

test("agent-understanding evaluation cases are complete, synthetic, and cover both surfaces", () => {
  const set = JSON.parse(readFileSync(new URL("../benchmarks/agent-understanding/cases.json", import.meta.url), "utf8")) as {
    version: number;
    dimensions: string[];
    cases: UnderstandingCase[];
  };
  assert.equal(set.version, 1);
  assert.deepEqual(set.dimensions, [
    "intent_fidelity",
    "context_use",
    "correction_handling",
    "clarification_quality",
    "repetition",
    "capability_choice",
    "verified_outcome",
    "safety",
  ]);
  assert.ok(set.cases.length >= 10);
  assert.equal(new Set(set.cases.map((scenario) => scenario.id)).size, set.cases.length);
  assert.ok(set.cases.some((scenario) => scenario.surface === "chat"));
  assert.ok(set.cases.some((scenario) => scenario.surface === "voice"));
  assert.ok(set.cases.some((scenario) => scenario.history.length >= 2), "include multi-turn state");
  assert.ok(set.cases.some((scenario) => scenario.expected.unknowns.length > 0), "include decision-critical uncertainty");
  assert.ok(set.cases.some((scenario) => scenario.history.some((turn) => turn.role === "tool")), "include reuse of verified tool results");
  for (const scenario of set.cases) {
    assert.ok(scenario.id.trim());
    assert.ok(scenario.current.trim());
    assert.ok(scenario.expected.objective.trim());
    assert.ok(scenario.expected.action.trim());
    assert.ok(scenario.expected.must_not.length > 0);
    assert.ok(scenario.history.every((turn) => turn.role.trim() && turn.content.trim()));
  }
});
