import test from "node:test";
import assert from "node:assert/strict";
import { humanToolStatus, isRiskyToolSlug } from "../src/policy.js";

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

test("renders human tool progress", () => {
  assert.match(humanToolStatus("COMPOSIO_SEARCH_TOOL"), /I’m looking/);
  assert.match(humanToolStatus("GITHUB_CREATE_ISSUE"), /I’m using Github to create issue/);
  assert.equal(humanToolStatus("CHUCK_GENERATE_IMAGE"), "🎨 I’m creating your image…");
  assert.equal(humanToolStatus("CHUCK_DAYTONA_WORKSPACE"), "🖥️ I’m connecting to your computer…");
  assert.equal(humanToolStatus("CHUCK_DAYTONA_COMPUTER"), "🖥️ I’m using your computer…");
  assert.doesNotMatch(humanToolStatus("CHUCK_DAYTONA_EXECUTE"), /CHUCK|Daytona|sandbox|isolated/i);
  assert.doesNotMatch(humanToolStatus("CHUCK_NEW_INTERNAL_TOOL"), /CHUCK|NEW_INTERNAL_TOOL/i);
});

test("handles unknown and empty actions", () => {
  assert.match(humanToolStatus("TOOL"), /that task/);
});
