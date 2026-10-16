import test from "node:test";
import assert from "node:assert/strict";
import { boundMissionContext, contextSearchQuery } from "../src/agentContext.js";

test("mission owner-context retrieval uses the active step objective", () => {
  assert.equal(
    contextSearchQuery("Long worker prompt with policies and old mission context", "  Verify the saved checkpoint marker  "),
    "Verify the saved checkpoint marker",
  );
});

test("context retrieval trims and bounds a user prompt when no mission step is supplied", () => {
  assert.equal(contextSearchQuery("  general owner request  "), "general owner request");
  assert.equal(contextSearchQuery("x".repeat(2_500)).length, 2_000);
});

test("mission reference context has a bounded size and a visible truncation marker", () => {
  const bounded = boundMissionContext("source".repeat(100), 120);
  assert.ok(bounded.length <= 120);
  assert.ok(bounded.startsWith("source"));
  assert.match(bounded, /mission context shortened/);
  assert.equal(boundMissionContext("short", 120), "short");
});
