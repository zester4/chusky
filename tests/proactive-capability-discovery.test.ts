import test from "node:test";
import assert from "node:assert/strict";
import { discoverConnectedActionGaps, discoverMissingCapabilityGaps } from "../src/proactive/capabilityDiscovery.js";

test("capability discovery suggests useful missing connections without requiring a connected app", () => {
  const gaps = discoverMissingCapabilityGaps([], { maxSuggestions: 3 });

  assert.deepEqual(gaps.map((gap) => gap.key), ["gmail", "calendar", "documents"]);
  assert.match(gaps[0]!.reason, /inbox reviews/);
  assert.match(gaps[0]!.proposedAction, /Connected Apps/);
  assert.ok(gaps[0]!.capabilityIds.includes("unanswered_message"));
});

test("capability discovery stops suggesting a capability when any supported provider is active", () => {
  const gaps = discoverMissingCapabilityGaps([
    { toolkit: "GMAIL", status: "ACTIVE" },
    { toolkit: "GOOGLECALENDAR", status: "ACTIVE" },
    { toolkit: "Notion", status: "ACTIVE" },
    { toolkit: "Google Sheets", status: "ACTIVE" },
  ]);

  assert.equal(gaps.some((gap) => ["gmail", "calendar", "documents", "sheets"].includes(gap.key)), false);
});

test("capability discovery ignores disabled accounts and bounds suggestions", () => {
  const gaps = discoverMissingCapabilityGaps([
    { toolkit: "GMAIL", status: "DISABLED" },
    { toolkit: "SLACK", status: "ACTIVE" },
  ], { maxSuggestions: 2 });

  assert.equal(gaps.length, 2);
  assert.equal(gaps[0]!.key, "gmail");
  assert.equal(gaps.some((gap) => gap.key === "team-communication"), false);
});

test("capability discovery asks to reconnect an existing inactive account", () => {
  const gaps = discoverMissingCapabilityGaps([{ toolkit: "GMAIL", status: "EXPIRED" }], { maxSuggestions: 3 });

  assert.equal(gaps[0]?.key, "gmail");
  assert.equal(gaps[0]?.connectionState, "needs_reconnect");
  assert.equal(gaps[0]?.title, "Reconnect Gmail");
  assert.match(gaps[0]?.reason ?? "", /needs reconnection/);
  assert.match(gaps[0]?.proposedAction ?? "", /Reconnect Gmail from Connected Apps/);
});

test("connected action discovery recommends a capability gap without pretending the provider is disconnected", () => {
  const gaps = discoverConnectedActionGaps(
    [{ toolkit: "GMAIL", status: "ACTIVE" }],
    [{ toolkit: "gmail", slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", description: "Read recent inbox messages" }],
  );

  assert.equal(gaps.length, 0);
  const missing = discoverConnectedActionGaps([{ toolkit: "GMAIL", status: "ACTIVE" }], []);
  assert.equal(missing[0]?.key, "gmail-action-gap");
  assert.match(missing[0]?.reason ?? "", /app is connected/);
  assert.match(missing[0]?.proposedAction ?? "", /Composio/);
});
