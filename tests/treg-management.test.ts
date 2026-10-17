import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { requiresToolApproval, toolApprovalPolicy } from "../src/policy.js";
import { TregGateway } from "../src/treg/gateway.js";
import { TregSpendGuard } from "../src/treg/spend.js";
import { buildTregAdminRequest, sanitizeTregAdminResult } from "../src/treg/management.js";
import { nativeTool } from "../src/nativeTools.js";

test("Treg management builds only known routes and accepts org-scoped reads", () => {
  const request = buildTregAdminRequest("orgs.members", { orgId: "org_acme-1" });
  assert.equal(request.method, "GET");
  assert.equal(request.path, "/orgs/org_acme-1/members");
  assert.equal(request.orgId, "org_acme-1");
  assert.equal(request.isRead, true);
  assert.throws(() => buildTregAdminRequest("orgs.members", { orgId: "org_acme/other" }), /identifier/i);
  assert.throws(() => buildTregAdminRequest("orgs.members", { orgId: "org_acme", input: { user_id: "owner" } }), /not supported/i);
  assert.throws(() => buildTregAdminRequest("/orgs/org_acme/members", {}), /unsupported/i);
  assert.deepEqual(buildTregAdminRequest("catalog.endpoint", { id: "sendgrid.send_email" }), {
    method: "GET", path: "/catalog/endpoints/sendgrid.send_email", isRead: true,
  });
  assert.deepEqual(buildTregAdminRequest("catalog.search", { query: { q: "email", limit: 5 } }), {
    method: "GET", path: "/catalog/search", query: { q: "email", limit: 5 }, isRead: true,
  });
  assert.deepEqual(buildTregAdminRequest("account.connection_resource_set", {
    id: "connection-1", input: { resource_ref: "drive:file-1", resource_name: "Planning" },
  }), {
    method: "POST", path: "/connections/connection-1/resource",
    body: { resource_ref: "drive:file-1", resource_name: "Planning" }, isRead: false,
  });
  assert.throws(() => buildTregAdminRequest("account.connection_resource_set", {
    id: "connection-1", input: { resource_ref: "drive:file-1", token: "secret" },
  }), /not supported/i);
});

test("Treg management validates write fields, confirmation, and payment amounts", () => {
  const update = buildTregAdminRequest("orgs.member_role", {
    orgId: "org_acme", memberId: "user-1", input: { role: "viewer" },
  });
  assert.equal(update.method, "PATCH");
  assert.equal(update.body?.role, "viewer");
  assert.equal(update.isRead, false);
  assert.throws(() => buildTregAdminRequest("orgs.member_role", {
    orgId: "org_acme", memberId: "user-1", input: { role: "superadmin" },
  }), /role must be one of/i);
  assert.throws(() => buildTregAdminRequest("orgs.settings_update", {
    orgId: "org_acme", input: { api_token: "do-not-send" },
  }), /not supported/i);
  assert.throws(() => buildTregAdminRequest("account.billing_topup", { input: { amount_usd: 0 } }), /positive.*amount/i);
  assert.throws(() => buildTregAdminRequest("orgs.delete", { orgId: "org_acme" }), /confirm=true/i);
  assert.equal(buildTregAdminRequest("orgs.delete", { orgId: "org_acme", query: { confirm: true } }).method, "DELETE");
  assert.equal(buildTregAdminRequest("account.tool_create", { input: { name: "public-api", base_url: "https://api.example.com" } }).method, "POST");
  assert.throws(() => buildTregAdminRequest("account.tool_create", { input: { name: "local", base_url: "http://127.0.0.1" } }), /public HTTPS host/i);
  assert.throws(() => buildTregAdminRequest("account.tool_update", { id: "existing", input: { base_url: "https://attacker.example" } }), /not supported/i);
  assert.throws(() => buildTregAdminRequest("account.health_run", { query: { all_orgs: true } }), /Cross-organization/i);
  assert.equal(buildTregAdminRequest("account.skill_register", { input: { name: "research", recipe: "Use verified sources." } }).method, "POST");
  assert.equal(buildTregAdminRequest("account.hub_tool_publish", { input: { manifest: { name: "x" }, check: {}, readme: "Reviewed" } }).method, "POST");
});

test("Treg management blocks credential material and scrubs results", () => {
  assert.throws(() => buildTregAdminRequest("account.feedback_submit", {
    input: { category: "other", message: "Bearer abcdefghijklmnop" },
  }), /credential material/i);
  assert.deepEqual(sanitizeTregAdminResult({ id: "secret-row", api_key: "abc", result: "Bearer abcdefghijklmnop" }), {
    id: "secret-row", result: "Bearer [redacted]",
  });
});

test("Treg management requires approval for every write, including trigger runs", () => {
  assert.equal(toolApprovalPolicy("CHUCK_TREG_ADMIN", { action: "orgs.members" }), "private");
  assert.equal(requiresToolApproval("CHUCK_TREG_ADMIN", { action: "account.billing" }), false);
  assert.equal(toolApprovalPolicy("CHUCK_TREG_ADMIN", { action: "orgs.member_role" }), "approval_required");
  assert.equal(requiresToolApproval("CHUCK_TREG_ADMIN", { action: "orgs.member_role" }), true);
  assert.equal(requiresToolApproval("CHUCK_TREG_ADMIN", { action: "orgs.member_role" }, false, false, true), true);
});

test("Treg management dispatch rejects a write without an exact approved approval id", async () => {
  await assert.rejects(nativeTool(1, "CHUCK_TREG_ADMIN", {
    action: "orgs.create", input: { name: "new-org" },
  }), /requires approval/i);
});

test("Treg management checks organization membership before requesting org data and scrubs the response", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken, retries: config.tregMaxRetries };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  config.tregMaxRetries = 0;
  const paths: string[] = [];
  const fetchImpl = async (url: string) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === "/orgs") return new Response(JSON.stringify([{ id: "org_allowed" }]));
    if (path === "/orgs/org_allowed/members") return new Response(JSON.stringify({ members: [{ id: "member-1", role: "viewer", api_key: "secret" }] }));
    throw new Error(`Unexpected Treg request: ${path}`);
  };
  try {
    const spend = new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} });
    const gateway = new TregGateway({ spend, recordReceipt: async () => {}, fetchImpl });
    const result = await gateway.manage("orgs.members", { orgId: "org_allowed" });
    assert.deepEqual(paths, ["/orgs", "/orgs/org_allowed/members"]);
    assert.deepEqual(result, { action: "orgs.members", statusCode: 200, data: { members: [{ id: "member-1", role: "viewer" }] } });
    await assert.rejects(gateway.manage("orgs.members", { orgId: "org_other" }), /not available/i);
    assert.equal(paths.filter((path) => path === "/orgs/org_other/members").length, 0);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
    config.tregMaxRetries = previous.retries;
  }
});
