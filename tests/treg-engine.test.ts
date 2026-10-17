import test from "node:test";
import assert from "node:assert/strict";
import { buildTregPlan } from "../src/treg/engine.js";
import { validateNativeToolArguments } from "../src/agentTools.js";
import { isReadOnlyToolSlug, toolApprovalPolicy } from "../src/policy.js";
import { isSharedChannelToolDenied } from "../src/sharedChannelPolicy.js";

test("Treg engine selects a focused reusable playbook without choosing providers", () => {
  const cases = [
    ["Prepare a company brief and enrich this account by domain", "account_research"],
    ["Find decision makers by role at these target companies", "people_search"],
    ["Enrich these qualified leads with verified work contact details", "lead_enrichment"],
    ["Build a qualified lead list for our B2B SaaS offer", "lead_generation"],
    ["Research buying-intent signals for the target accounts", "buying_signals"],
    ["Find recent job postings and hiring signals for these companies", "hiring_signals"],
    ["Compare technology adoption and the companies' tech stacks", "technology_research"],
    ["Build a market map of competitors and peer companies", "market_map"],
    ["Bulk enrich these 200 qualified companies asynchronously", "bulk_enrichment"],
    ["Research SEO keywords, backlinks, and AI search visibility", "seo_research"],
    ["Find recent public social mentions and creator engagement", "social_intelligence"],
    ["Research competitor ads and ad library creatives", "ads_intelligence"],
    ["Pause the campaign and reduce the ad budget", "ads_operations"],
    ["Find a structured dataset for a specific external-data question", "general_research"],
  ] as const;

  for (const [task, expected] of cases) {
    const plan = buildTregPlan({ task });
    assert.equal(plan.playbook, expected, task);
    assert.equal(plan.mode, "plan_only");
    assert.equal(plan.providerCallsAllowedByThisTool, false);
    assert.equal(plan.catalogIsDynamic, true);
    assert.equal(plan.endpointIdsAreHardcoded, false);
    assert.ok(Array.isArray(plan.tools) && plan.tools.length > 0);
    assert.ok(Array.isArray(plan.workflow) && plan.workflow.length >= 3);
    assert.ok(Array.isArray(plan.validation) && plan.validation.length >= 2);
    assert.ok(Array.isArray(plan.guardrails) && plan.guardrails.length >= 2);
  }
});

test("Treg plans preserve the requested aggregate cap and describe runtime precedence", () => {
  const bounded = buildTregPlan({ task: "Research recent hiring signals", playbook: "hiring_signals", budgetUsd: 2.5 });
  const unbounded = buildTregPlan({ task: "Research recent hiring signals", playbook: "hiring_signals" });
  assert.deepEqual(bounded.budget, {
    userBudgetProvided: true,
    budgetUsd: 2.5,
    instruction: "Treat this as the aggregate cap for the workflow; the stricter owner, mission, and per-call runtime limits always apply.",
  });
  assert.equal((unbounded.budget as { userBudgetProvided: boolean }).userBudgetProvided, false);
  assert.match((unbounded.budget as { instruction: string }).instruction, /existing owner and mission limits/);
});

test("Treg plan exposes every reusable playbook in the native schema", () => {
  for (const playbook of [
    "auto", "account_research", "people_search", "lead_enrichment", "lead_generation", "buying_signals",
    "hiring_signals", "technology_research", "market_map", "bulk_enrichment", "seo_research",
    "social_intelligence", "ads_intelligence", "ads_operations", "general_research",
  ]) {
    assert.doesNotThrow(() => validateNativeToolArguments("CHUCK_TREG_PLAN", { task: "Research target companies", playbook }));
  }
  assert.throws(() => validateNativeToolArguments("CHUCK_TREG_PLAN", { task: "Research target companies", playbook: "provider_endpoint" }), /unsupported value/i);
});

test("native Treg planner dispatch is local and does not need Treg credentials", async () => {
  const { nativeTool } = await import("../src/nativeTools.js");
  const plan = await nativeTool(88102, "CHUCK_TREG_PLAN", { task: "Find people and buying-intent signals for target accounts" }) as Record<string, unknown>;
  assert.equal(plan.playbook, "buying_signals");
  assert.equal(plan.providerCallsAllowedByThisTool, false);
});

test("Treg plan is private, read-only, schema-bounded, and denied in shared conversations", () => {
  assert.doesNotThrow(() => validateNativeToolArguments("CHUCK_TREG_PLAN", { task: "Map competitors", budgetUsd: 1 }));
  assert.equal(toolApprovalPolicy("CHUCK_TREG_PLAN"), "private");
  assert.equal(isReadOnlyToolSlug("CHUCK_TREG_PLAN"), true);
  assert.equal(isSharedChannelToolDenied("CHUCK_TREG_PLAN"), true);
});

test("signal playbook treats buying clues as evidence, not confirmed intent", () => {
  const plan = buildTregPlan({ task: "Research buyer intent signals for SaaS accounts" });
  const validation = (plan.validation as string[]).join(" ");
  const guardrails = (plan.guardrails as string[]).join(" ");
  assert.match(validation, /not proof of purchase intent/);
  assert.match(guardrails, /Do not contact a prospect/);
});

test("Treg ad operations explicitly require exact owner approval and read-back", () => {
  const plan = buildTregPlan({ task: "Pause the campaign and lower the ad spend", playbook: "ads_operations" });
  assert.match((plan.guardrails as string[]).join(" "), /exact owner approval/i);
  assert.match((plan.workflow as string[]).join(" "), /read the campaign back/i);
});
