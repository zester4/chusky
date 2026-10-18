import test from "node:test";
import assert from "node:assert/strict";
import { resolveExplicitCapabilityScope, toolBelongsToCapabilityScope } from "../src/decisions/capabilityScope.js";

test("explicit Treg-only wording becomes a hard provider scope", () => {
  const scope = resolveExplicitCapabilityScope("Use Treg only for data (not Composio, not browser, not web search tools).");
  assert.deepEqual(scope, { surface: "treg", reason: "explicit_only" });
  assert.equal(toolBelongsToCapabilityScope("CHUCK_TREG_ENRICH_COMPANY", scope!), true);
  assert.equal(toolBelongsToCapabilityScope("COMPOSIO_MULTI_EXECUTE_TOOL", scope!), false);
  assert.equal(toolBelongsToCapabilityScope("GMAIL_FETCH_EMAILS", scope!), false);
  assert.equal(toolBelongsToCapabilityScope("CHUCK_BROWSER", scope!), false);
});

test("ordinary provider mentions do not unexpectedly fence a turn", () => {
  assert.equal(resolveExplicitCapabilityScope("Research Stripe with Treg and compare the result."), undefined);
  assert.deepEqual(resolveExplicitCapabilityScope("Use Monid only for this lookup."), { surface: "monid", reason: "explicit_only" });
});
