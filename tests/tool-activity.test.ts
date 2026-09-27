import assert from "node:assert/strict";
import test from "node:test";
import { buildComposioBatchActions, collectComposioToolPresentations, correlateComposioBatchOutcomes, enrichComposioToolPresentationsFromToolkits, settleComposioBatchActions } from "../src/toolActivity.js";

test("extracts explicit, safe app metadata from nested Composio discovery output", () => {
  const metadata = collectComposioToolPresentations({ data: { tools: [{ tool_slug: "GMAIL_SEARCH_EMAILS", name: "Search emails", human_description: "Find matching messages", toolkit: { slug: "gmail", name: "Gmail", logo: "https://assets.example/gmail.svg" }, arguments: { query: "private search" } }] } });
  assert.deepEqual(metadata.get("GMAIL_SEARCH_EMAILS"), {
    toolSlug: "GMAIL_SEARCH_EMAILS",
    actionLabel: "Find matching messages",
    toolkitSlug: "gmail",
    toolkitName: "Gmail",
    toolkitLogo: "https://assets.example/gmail.svg",
  });
  assert.equal(metadata.has("CHUCK_SECRET_TOOL"), false);
  assert.equal(collectComposioToolPresentations({ tool_slug: "GMAIL_SEARCH_EMAILS", toolkit: { slug: "gmail", name: "Gmail", logo: "javascript:alert(1)" } }).get("GMAIL_SEARCH_EMAILS")?.toolkitLogo, undefined);
});

test("reads toolkit slugs from Composio search schemas and enriches them from toolkit metadata", () => {
  const metadata = collectComposioToolPresentations({ toolSchemas: {
    GMAIL_FETCH_EMAILS: { toolSlug: "GMAIL_FETCH_EMAILS", toolkit: "gmail", description: "Fetch emails from Gmail" },
    GOOGLECALENDAR_EVENTS_LIST: { toolSlug: "GOOGLECALENDAR_EVENTS_LIST", toolkit: "googlecalendar", description: "List calendar events" },
  } });

  assert.equal(metadata.get("GMAIL_FETCH_EMAILS")?.toolkitSlug, "gmail");
  assert.equal(metadata.get("GOOGLECALENDAR_EVENTS_LIST")?.toolkitSlug, "googlecalendar");
  enrichComposioToolPresentationsFromToolkits(metadata, [
    { slug: "gmail", name: "Gmail", meta: { logo: "https://assets.example/gmail.svg" } },
    { slug: "googlecalendar", name: "Google Calendar", meta: { logo: "https://assets.example/calendar.svg" } },
    { slug: "unrelated", name: "Unrelated", meta: { logo: "https://assets.example/other.svg" } },
  ]);

  assert.deepEqual(metadata.get("GMAIL_FETCH_EMAILS"), {
    toolSlug: "GMAIL_FETCH_EMAILS",
    actionLabel: "Fetch emails from Gmail",
    toolkitSlug: "gmail",
    toolkitName: "Gmail",
    toolkitLogo: "https://assets.example/gmail.svg",
  });
  assert.deepEqual(metadata.get("GOOGLECALENDAR_EVENTS_LIST"), {
    toolSlug: "GOOGLECALENDAR_EVENTS_LIST",
    actionLabel: "List calendar events",
    toolkitSlug: "googlecalendar",
    toolkitName: "Google Calendar",
    toolkitLogo: "https://assets.example/calendar.svg",
  });
});

test("creates bounded parallel action rows without copying their arguments", () => {
  const metadata = collectComposioToolPresentations({ tools: [{ tool_slug: "GMAIL_SEARCH_EMAILS", name: "Search messages", toolkit: { slug: "gmail", name: "Gmail", logo: "https://assets.example/gmail.svg" } }] });
  const actions = buildComposioBatchActions({ tools: [
    { tool_slug: "GMAIL_SEARCH_EMAILS", arguments: { query: "secret text" } },
    { tool_slug: "NOTION_SEARCH", arguments: { query: "private" } },
    { tool_slug: "CHUCK_FORGET_MEMORY", arguments: {} },
  ] }, "call-1", metadata);
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0], { id: "call-1:0", toolSlug: "GMAIL_SEARCH_EMAILS", status: "started", actionLabel: "Search messages", toolkitSlug: "gmail", toolkitName: "Gmail", toolkitLogo: "https://assets.example/gmail.svg" });
  assert.equal(actions[1]?.actionLabel, "Search");
  assert.equal(JSON.stringify(actions).includes("secret text"), false);
  assert.equal(buildComposioBatchActions({ tools: Array.from({ length: 70 }, () => ({ tool_slug: "GMAIL_SEARCH_EMAILS", arguments: {} })) }, "call-2", metadata).length, 50);
});

test("correlates outcomes only by an explicit unique action slug and explicit result status", () => {
  const outcomes = correlateComposioBatchOutcomes({ data: { results: [
    { tool_slug: "GMAIL_SEARCH_EMAILS", successful: true, data: { messages: ["private"] } },
    { tool_slug: "NOTION_SEARCH", error: "provider failure" },
    { tool_slug: "SLACK_SEARCH_MESSAGES", data: { matches: [] } },
  ] } });
  assert.equal(outcomes.get("GMAIL_SEARCH_EMAILS")?.status, "completed");
  assert.equal(outcomes.get("NOTION_SEARCH")?.status, "failed");
  assert.equal(outcomes.has("SLACK_SEARCH_MESSAGES"), false);
  const duplicate = correlateComposioBatchOutcomes({ results: [
    { tool_slug: "GMAIL_SEARCH_EMAILS", successful: true },
    { tool_slug: "GMAIL_SEARCH_EMAILS", successful: false },
  ] });
  assert.equal(duplicate.size, 0);
});

test("leaves individual batch outcomes unknown when the provider gives only a batch receipt", () => {
  const actions = buildComposioBatchActions({ tools: [{ tool_slug: "GMAIL_SEARCH_EMAILS", arguments: {} }] }, "call-3", new Map());
  assert.deepEqual(settleComposioBatchActions(actions, { successful: true })[0], {
    id: "call-3:0",
    toolSlug: "GMAIL_SEARCH_EMAILS",
    actionLabel: "Search Emails",
    status: "unknown",
    summary: "Batch response received; individual outcome was not identified",
  });
});
