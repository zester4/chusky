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
});

test("handles unknown and empty actions", () => {
  assert.match(humanToolStatus("TOOL"), /that task/);
});
