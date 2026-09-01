import test from "node:test";
import assert from "node:assert/strict";
import { humanToolStatus, isRiskyToolSlug, toolApprovalPolicy } from "../src/policy.js";

test("recognizes destructive and externally visible tools", () => {
  for (const slug of ["GMAIL_SEND_EMAIL", "GITHUB_DELETE_REPOSITORY", "STRIPE_CREATE_PAYMENT", "SLACK_POST_MESSAGE", "AWS_UPDATE_PERMISSION"]) {
    assert.equal(isRiskyToolSlug(slug), true, slug);
  }
});

test("does not gate read-only tools", () => {
  for (const slug of ["GITHUB_GET_REPOSITORY", "GMAIL_LIST_MESSAGES", "NOTION_SEARCH_PAGES", "COMPOSIO_SEARCH_TOOL"]) {
    assert.equal(isRiskyToolSlug(slug), false, slug);
  }
});

test("uses explicit native policies and inspects Composio multi-tool calls", () => {
  assert.equal(toolApprovalPolicy("CHUCK_CREATE_TRIGGER"), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_START_FACETIME_CALL"), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_LIST_FACETIME_CALLS"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_NEW_NATIVE_TOOL"), "approval_required");
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_GIT", { action: "push" }), true);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_GIT", { action: "commit" }), false);
  assert.equal(isRiskyToolSlug("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_LIST_MESSAGES", arguments: {} }] }), false);
  assert.equal(isRiskyToolSlug("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }] }), true);
  assert.equal(isRiskyToolSlug("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ unexpected: true }] }), true);
});

test("renders human tool progress", () => {
  assert.match(humanToolStatus("COMPOSIO_SEARCH_TOOL"), /I’m looking/);
  assert.match(humanToolStatus("GITHUB_CREATE_ISSUE"), /I’m using Github to create issue/);
  assert.equal(humanToolStatus("CHUCK_GENERATE_IMAGE"), "🎨 I’m creating your image…");
  assert.equal(humanToolStatus("CHUCK_DAYTONA_WORKSPACE"), "🖥️ I’m opening my private computer workspace…");
  assert.equal(humanToolStatus("CHUCK_DAYTONA_COMPUTER"), "🖥️ I’m using my private computer…");
  assert.doesNotMatch(humanToolStatus("CHUCK_DAYTONA_EXECUTE"), /CHUCK|Daytona|sandbox|isolated/i);
  assert.doesNotMatch(humanToolStatus("CHUCK_NEW_INTERNAL_TOOL"), /CHUCK|NEW_INTERNAL_TOOL/i);
});

test("handles unknown and empty actions", () => {
  assert.match(humanToolStatus("TOOL"), /that task/);
});
