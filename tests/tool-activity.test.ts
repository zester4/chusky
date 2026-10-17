import assert from "node:assert/strict";
import test from "node:test";
import { buildComposioBatchActions, collectComposioToolPresentations, composioActivityActionLabel, correlateComposioBatchOutcomes, enrichComposioToolPresentationsFromToolkits, nativeActivityActionLabel, fallbackActivityActionLabel, settleComposioBatchActions, successfulComposioBatchActions } from "../src/toolActivity.js";

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
    { tool_slug: "GMAIL_SEARCH_EMAILS", arguments: { query: "Acme" } },
    { tool_slug: "NOTION_SEARCH", arguments: { query: "api-key-secret" } },
    { tool_slug: "CHUCK_FORGET_MEMORY", arguments: {} },
  ] }, "call-1", metadata);
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0], { id: "call-1:0", toolSlug: "GMAIL_SEARCH_EMAILS", status: "started", actionLabel: "Searching for Acme", toolkitSlug: "gmail", toolkitName: "Gmail", toolkitLogo: "https://assets.example/gmail.svg" });
  assert.equal(actions[1]?.actionLabel, "Search");
  assert.equal(JSON.stringify(actions).includes("api-key-secret"), false);
  assert.equal(buildComposioBatchActions({ tools: Array.from({ length: 70 }, () => ({ tool_slug: "GMAIL_SEARCH_EMAILS", arguments: {} })) }, "call-2", metadata).length, 50);
});

test("derives bounded contextual labels for searches, email sends, and nested execute calls", () => {
  assert.equal(composioActivityActionLabel("GOOGLEMAPS_SEARCH_BUSINESSES", { query: "Acme" }), "Searching for Acme");
  assert.equal(composioActivityActionLabel("GMAIL_SEND_EMAIL", { recipient_email: "tony@example.com", body: "private" }), "Sending the email to Tony");
  assert.equal(composioActivityActionLabel("COMPOSIO_EXECUTE_TOOL", { tool_slug: "GOOGLEMAPS_SEARCH_BUSINESSES", arguments: { query: "Acme" } }), "Searching for Acme");
  assert.equal(composioActivityActionLabel("GMAIL_SEND_EMAIL", { recipient_email: "api-key-secret@example.com" }), "Sending the email");
});

test("derives human-readable Treg, Monid, and remote activity labels without exposing arguments", () => {
  assert.equal(nativeActivityActionLabel("CHUCK_TREG_COMPANY_SEARCH", { query: "B2B SaaS companies in Florida" }), "Searching for companies matching B2B SaaS companies in Florida");
  assert.equal(nativeActivityActionLabel("CHUCK_MONID_INSPECT", { provider: "lead_sourcing", api_key: "private" }), "Inspecting the selected capability with lead_sourcing");
  assert.equal(nativeActivityActionLabel("COMPOSIO_REMOTE_WORKBENCH"), "Working in the remote workspace");
  assert.equal(fallbackActivityActionLabel("COMPOSIO_SEARCH_TOOLS"), "Finding the right connected capability");
  assert.equal(nativeActivityActionLabel("CHUCK_MONID_RUN", { provider: "api-key-secret" }), "Running the research action");
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

test("reads Composio SDK 0.21 batch response envelopes and matches duplicate slugs by request index", () => {
  const args = { tools: [
    { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} },
    { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} },
    { tool_slug: "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", arguments: {} },
  ] };
  const actions = buildComposioBatchActions(args, "sdk-call", new Map());
  const settled = settleComposioBatchActions(actions, { successful: false, data: { results: [
    { index: 0, tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: true, data: { messages: [{ id: "private" }] } } },
    { index: 1, tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: false, error: "provider rejected this request", data: {} }, error: "provider rejected this request" },
    { index: 2, tool_slug: "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", response: { successful: true, data: { updatedCells: 4 } } },
  ] } });
  assert.deepEqual(settled.map(({ status }) => status), ["completed", "failed", "completed"]);
  assert.deepEqual(settled.map(({ summary }) => summary), [
    "Provider confirmed this action",
    "Provider reported this action failed",
    "Provider confirmed this action",
  ]);
  assert.equal(JSON.stringify(settled).includes("private"), false);
});

test("leaves individual batch outcomes unknown when the provider gives only a batch receipt", () => {
  const actions = buildComposioBatchActions({ tools: [{ tool_slug: "GMAIL_SEARCH_EMAILS", arguments: {} }] }, "call-3", new Map());
  assert.deepEqual(settleComposioBatchActions(actions, { successful: true })[0], {
    id: "call-3:0",
    toolSlug: "GMAIL_SEARCH_EMAILS",
    actionLabel: "Search Emails",
    status: "unknown",
    summary: "The batch response did not include a matchable status for this action",
  });
});

test("returns only explicitly successful batch actions for trusted receipt evidence", () => {
  const args = { tools: [
    { tool_slug: "GOOGLESHEETS_UPDATE_VALUES_BATCH", arguments: { spreadsheet_id: "sheet-1", range: "Sheet1!A1:B3" } },
    { tool_slug: "GOOGLESHEETS_VALUES_GET", arguments: { spreadsheet_id: "sheet-1", range: "Sheet1!A1:D20" } },
  ] };
  const result = { data: { results: [
    { index: 0, tool_slug: "GOOGLESHEETS_UPDATE_VALUES_BATCH", response: { successful: true, data: { updatedCells: 6 } } },
    { index: 1, tool_slug: "GOOGLESHEETS_VALUES_GET", response: { successful: false, error: "provider failure" } },
  ] } };
  assert.deepEqual(successfulComposioBatchActions(args, result), [{
    toolSlug: "GOOGLESHEETS_UPDATE_VALUES_BATCH",
    index: 0,
    arguments: { spreadsheet_id: "sheet-1", range: "Sheet1!A1:B3" },
  }]);
  assert.deepEqual(successfulComposioBatchActions(args, { successful: true }), []);
});
