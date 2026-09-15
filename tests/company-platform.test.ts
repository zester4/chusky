import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION,
  createCompanyAgentProfile,
  effectiveCompanyRunPolicy,
} from "../src/companyPlatform.js";

test("company policy intersects grants, accumulates denials and approvals, and selects the tightest limits", () => {
  const agent = createCompanyAgentProfile({
    template: "sales-development",
    policy: { tools: { allow: ["COMPOSIO_SEARCH_WEB", "COMPOSIO_EXECUTE_TOOL"], deny: ["COMPOSIO_MULTI_EXECUTE_TOOL"], requireApproval: ["CHUCK_SEND_EMAIL"] }, budget: { duration: "30m", maxToolCalls: 40, maxCost: 5 } },
  }, "agt_sales");
  assert.ok(agent);
  const result = effectiveCompanyRunPolicy(
    { tools: { allow: ["COMPOSIO_SEARCH_WEB", "COMPOSIO_EXECUTE_TOOL", "CHUCK_SEARCH_SKILLS"], deny: ["CHUCK_SEND_EMAIL"] }, budget: { duration: "1h", maxToolCalls: 30, maxCost: 4 } },
    agent,
    { tools: { allow: ["COMPOSIO_SEARCH_WEB", "COMPOSIO_EXECUTE_TOOL"], requireApproval: ["CHUCK_SEND_EMAIL"] }, budget: { duration: "3h", maxToolCalls: 10, maxCost: 2 } },
  );
  assert.deepEqual(result.tools?.allow, ["COMPOSIO_SEARCH_WEB", "COMPOSIO_EXECUTE_TOOL"]);
  assert.deepEqual(result.tools?.deny, ["CHUCK_SEND_EMAIL", "COMPOSIO_MULTI_EXECUTE_TOOL"]);
  assert.deepEqual(result.tools?.requireApproval, [...COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION, "CHUCK_SEND_EMAIL"]);
  assert.deepEqual(result.budget, { duration: "30m", maxToolCalls: 10, maxCost: 2 });
});

test("company run requests cannot widen a project or agent tool grant", () => {
  const agent = createCompanyAgentProfile({ template: "competitive-intelligence" }, "agt_competitor");
  assert.ok(agent);
  const result = effectiveCompanyRunPolicy(
    { tools: { allow: ["COMPOSIO_SEARCH_WEB"] } },
    agent,
    { tools: { allow: ["COMPOSIO_SEARCH_WEB", "COMPOSIO_EXECUTE_TOOL"] } },
  );
  assert.deepEqual(result.tools?.allow, ["COMPOSIO_SEARCH_WEB"]);
  assert.deepEqual(result.tools?.requireApproval, [...COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION]);
});

test("company agent creation rejects unsupported templates and tools outside template grants", () => {
  assert.equal(createCompanyAgentProfile({ template: "unknown-agent" }, "agt_bad"), undefined);
  assert.equal(createCompanyAgentProfile({ template: "competitive-intelligence", policy: { tools: { allow: ["COMPOSIO_EXECUTE_TOOL"] } } }, "agt_bad"), undefined);
  const defaulted = createCompanyAgentProfile({ template: "lead-research" }, "agt_lead", 1234);
  assert.ok(defaulted);
  assert.equal(defaulted.createdAt, 1234);
  assert.equal(defaulted.budget.maxToolCalls, 40);
  assert.ok(defaulted.tools.requireApproval.includes("COMPOSIO_EXECUTE_TOOL"));
});
