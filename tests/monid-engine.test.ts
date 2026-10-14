import test from "node:test";
import assert from "node:assert/strict";
import { buildMonidPlan } from "../src/monid/engine.js";
import { validateNativeToolArguments } from "../src/agentTools.js";
import { toolApprovalPolicy } from "../src/policy.js";
import { isSharedChannelToolDenied } from "../src/sharedChannelPolicy.js";

test("Monid planner selects purpose-built playbooks without choosing live endpoints", () => {
  const cases = [
    ["Audit SEO rankings and keyword opportunities for example.com", "seo"],
    ["Research competitor ads in the public Meta ad library", "ad_intelligence"],
    ["Find verified work emails for sales leaders at target companies", "lead_sourcing"],
    ["Find local business prospects for my web design services in Austin", "local_prospects"],
    ["Prepare a partnership brief for a company meeting", "company_brief"],
    ["Digest this week's YouTube videos about AI coding agents", "video_digest"],
    ["Find content opportunities from customer questions for my store", "content_opportunities"],
    ["Compare AI citation visibility for my brand and competitors", "ai_visibility"],
    ["Find TikTok videos outperforming creator baselines", "creator_analysis"],
    ["Compare customer reviews for three products", "product_reviews"],
    ["Extract public product information from these websites", "web_extraction"],
  ] as const;

  const plans = cases.map(([task, expectedPlaybook]) => {
    const plan = buildMonidPlan({ task });
    assert.equal(plan.playbook, expectedPlaybook, task);
    return plan;
  });
  for (const plan of plans) {
    assert.equal(plan.mode, "plan_only");
    assert.equal(plan.paidCallsAllowedByThisTool, false);
    assert.equal(plan.catalogIsDynamic, true);
    assert.equal(plan.endpointsAreHardcoded, false);
    assert.ok(Array.isArray(plan.workflow) && plan.workflow.length >= 3);
    assert.ok(Array.isArray(plan.validation) && plan.validation.length >= 2);
    assert.ok(Array.isArray(plan.guardrails) && plan.guardrails.length >= 2);
  }
});

test("Monid planner preserves an explicit aggregate budget and asks before paid work if absent", () => {
  const bounded = buildMonidPlan({ task: "Research organic search visibility", playbook: "seo", budgetUsd: 2 });
  const unbounded = buildMonidPlan({ task: "Research organic search visibility", playbook: "seo" });
  assert.deepEqual(bounded.budget, { userBudgetProvided: true, budgetUsd: 2, instruction: "Treat this as the aggregate cap across this research task; ask before exceeding it." });
  assert.deepEqual(unbounded.budget, { userBudgetProvided: false, instruction: "Ask for a spend ceiling before any paid call; existing runtime limits also apply." });
});

test("Monid planner schema exposes every reusable playbook", () => {
  for (const playbook of [
    "seo", "ad_intelligence", "lead_sourcing", "local_prospects", "company_brief",
    "video_digest", "content_opportunities", "ai_visibility", "creator_analysis",
    "product_reviews", "web_extraction", "general_research",
  ]) {
    assert.doesNotThrow(() => validateNativeToolArguments("CHUCK_MONID_PLAN", { task: "Research this topic", playbook }));
  }
});

test("native Monid planner dispatch is local and does not require the provider to be enabled", async () => {
  const { nativeTool } = await import("../src/nativeTools.js");
  const plan = await nativeTool(88101, "CHUCK_MONID_PLAN", { task: "Research competitor ads in the public ad library" }) as Record<string, unknown>;
  assert.equal(plan.playbook, "ad_intelligence");
  assert.equal(plan.paidCallsAllowedByThisTool, false);
});

test("Monid planner rejects invalid task, playbook, and budget values", () => {
  assert.throws(() => buildMonidPlan({ task: " " }), /2-2000 characters/);
  assert.throws(() => buildMonidPlan({ task: "valid", playbook: "provider_endpoint" }), /Unsupported Monid playbook/);
  assert.throws(() => buildMonidPlan({ task: "valid", budgetUsd: -1 }), /between 0 and 10000/);
  assert.throws(() => buildMonidPlan({ task: "x".repeat(2001) }), /2-2000 characters/);
});

test("Monid plan native tool is read-only, private, schema-bounded, and shared-channel denied", () => {
  assert.doesNotThrow(() => validateNativeToolArguments("CHUCK_MONID_PLAN", { task: "SEO research", playbook: "seo", budgetUsd: 1 }));
  assert.throws(() => validateNativeToolArguments("CHUCK_MONID_PLAN", { task: "SEO research", playbook: "not-real" }), /unsupported value/i);
  assert.equal(toolApprovalPolicy("CHUCK_MONID_PLAN"), "private");
  assert.equal(isSharedChannelToolDenied("CHUCK_MONID_PLAN"), true);
});
