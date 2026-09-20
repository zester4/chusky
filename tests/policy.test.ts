import test from "node:test";
import assert from "node:assert/strict";
import { humanProgressStatus, humanToolStatus, isRiskyToolSlug, toolApprovalPolicy } from "../src/policy.js";
import { clearComposioToolMetadata, registerComposioToolMetadata } from "../src/composioRisk.js";

test("recognizes materially risky tools", () => {
  for (const slug of ["GITHUB_DELETE_REPOSITORY", "STRIPE_CREATE_PAYMENT", "AWS_UPDATE_PERMISSION", "GITHUB_DEPLOY_PRODUCTION"]) {
    assert.equal(isRiskyToolSlug(slug), true, slug);
  }
});

test("allows routine autonomous communication and content actions", () => {
  for (const slug of ["GMAIL_SEND_EMAIL", "SLACK_POST_MESSAGE", "X_PUBLISH_POST", "NEWSLETTER_SEND_CAMPAIGN"]) {
    assert.equal(isRiskyToolSlug(slug), false, slug);
  }
});

test("does not gate read-only tools", () => {
  for (const slug of ["GITHUB_GET_REPOSITORY", "GMAIL_LIST_MESSAGES", "NOTION_SEARCH_PAGES", "COMPOSIO_SEARCH_TOOL"]) {
    assert.equal(isRiskyToolSlug(slug), false, slug);
  }
});

test("uses explicit native policies and gates only side-effecting Composio batches", () => {
  assert.equal(toolApprovalPolicy("CHUCK_CREATE_TRIGGER"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_START_PHONE_CALL"), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_LIST_PHONE_CALLS"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_CREATE_PRESENTATION"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_CREATE_PDF"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_CREATE_DOCUMENT"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_CREATE_SPREADSHEET"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_EMAIL_ARTIFACT"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_UPDATE_MEMORY"), "private");
  for (const name of ["CHUCK_MEETING_JOIN", "CHUCK_MEETING_LIST", "CHUCK_MEETING_STATUS", "CHUCK_MEETING_LEAVE"]) assert.equal(toolApprovalPolicy(name), "private", name);
  for (const name of ["CHUCK_MEETING_CONTEXT_LOOKUP", "CHUCK_MEETING_CONTACT_CAPTURE", "CHUCK_MEETING_CONTACTS_LIST", "CHUCK_MEETING_FOLLOWUP_SCHEDULE"]) {
    assert.equal(toolApprovalPolicy(name), "private", name);
  }
  assert.equal(toolApprovalPolicy("CHUCK_MEETING_CONTACT_DELETE"), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_NEW_NATIVE_TOOL"), "approval_required");
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_GIT", { action: "push" }), true);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_GIT", { action: "commit" }), false);
  for (const name of ["CHUCK_DAYTONA_DELETE_FILE", "CHUCK_DAYTONA_DELETE_WORKSPACE", "CHUCK_DAYTONA_MOVE_FILES"]) {
    assert.equal(toolApprovalPolicy(name), "approval_required", name);
  }
  assert.equal(isRiskyToolSlug("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_LIST_MESSAGES", arguments: {} }] }), false);
  assert.equal(isRiskyToolSlug("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }] }), false);
  assert.equal(isRiskyToolSlug("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GITHUB_DELETE_REPOSITORY", arguments: {} }] }), true);
  assert.equal(isRiskyToolSlug("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ unexpected: true }] }), true);
  assert.equal(isRiskyToolSlug("COMPOSIO_EXECUTE_TOOL", { tool_slug: "UNKNOWN_PROVIDER_UPDATE_RECORD" }), true);
  assert.equal(isRiskyToolSlug("COMPOSIO_EXECUTE_TOOL", { tool_slug: "GMAIL_LIST_MESSAGES" }), false);
});

test("provider metadata classifies dynamic Composio tools before heuristic fallback", () => {
  clearComposioToolMetadata();
  registerComposioToolMetadata({ name: "MYSTERY_READ", annotations: { readOnlyHint: true } });
  registerComposioToolMetadata({ name: "MYSTERY_ACTION", annotations: { destructiveHint: true } });
  assert.equal(toolApprovalPolicy("MYSTERY_READ"), "private");
  assert.equal(toolApprovalPolicy("MYSTERY_ACTION"), "approval_required");
  clearComposioToolMetadata();
});

test("renders human tool progress", () => {
  assert.match(humanToolStatus("COMPOSIO_SEARCH_TOOL"), /I’m finding/);
  assert.match(humanToolStatus("GITHUB_CREATE_ISSUE"), /I’m using Github to create issue/);
  assert.equal(humanToolStatus("CHUCK_GENERATE_IMAGE"), "🎨 I’m creating your image…");
  assert.equal(humanToolStatus("CHUCK_DAYTONA_WORKSPACE"), "🖥️ I’m opening my private computer workspace…");
  assert.equal(humanToolStatus("CHUCK_DAYTONA_COMPUTER"), "🖥️ I’m using my private computer…");
  assert.equal(humanToolStatus("CHUCK_CREATE_PRESENTATION"), "📊 I’m building and checking your presentation…");
  assert.equal(humanToolStatus("CHUCK_CREATE_PDF"), "📄 I’m building and checking your PDF…");
  assert.doesNotMatch(humanToolStatus("CHUCK_DAYTONA_EXECUTE"), /CHUCK|Daytona|sandbox|isolated/i);
  assert.doesNotMatch(humanToolStatus("CHUCK_NEW_INTERNAL_TOOL"), /CHUCK|NEW_INTERNAL_TOOL/i);
});

test("renders natural high-level progress phases", () => {
  assert.equal(humanProgressStatus("understanding"), "🧠 I’m understanding what you need…");
  assert.equal(humanProgressStatus("preparing"), "🧰 I’m lining up the best way to help…");
  assert.equal(humanProgressStatus("finalizing"), "✍️ I’m pulling everything together…");
  for (const phase of ["understanding", "preparing", "finalizing"] as const) {
    assert.doesNotMatch(humanProgressStatus(phase), /prompt|model loop|tool registry|internal/i);
  }
});

test("handles unknown and empty actions", () => {
  assert.match(humanToolStatus("TOOL"), /that task/);
});
