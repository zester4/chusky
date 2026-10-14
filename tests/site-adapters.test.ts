import test from "node:test";
import assert from "node:assert/strict";
import { chuckTools, validateNativeToolArguments } from "../src/agentTools.js";
import { buildSiteEntry, getSiteAdapter, SITE_ADAPTERS } from "../src/shopping/siteAdapters.js";

test("the curated site-adapter matrix contains twenty unique HTTPS entry points", () => {
  assert.equal(SITE_ADAPTERS.length, 20);
  assert.equal(new Set(SITE_ADAPTERS.map((adapter) => adapter.id)).size, 20);
  for (const adapter of SITE_ADAPTERS) {
    assert.match(adapter.origin, /^https:\/\//);
    assert.equal(new URL(adapter.origin).pathname, "/");
  }
});

test("site adapters build bounded encoded search URLs without leaking intent into another origin", () => {
  const entry = buildSiteEntry({ site: "Target", query: "gray shirt & cotton" });
  assert.equal(entry.adapterId, "target");
  assert.equal(entry.strategy, "direct-search");
  assert.match(entry.url, /^https:\/\/www\.target\.com\/s\?/);
  assert.match(entry.url, /searchTerm=gray\+shirt\+%26\+cotton/);
  assert.equal(new URL(entry.url).origin, entry.origin);
  assert.equal(entry.steps.length, 0);
  assert.equal(entry.assertions.some((item) => item.kind === "url" && item.required), true);
});

test("site aliases and location adapters produce the expected safe starting state", () => {
  assert.equal(getSiteAdapter("best buy")?.id, "best-buy");
  const booking = buildSiteEntry({ site: "booking.com", location: "London" });
  assert.equal(booking.adapterId, "booking-com");
  assert.match(booking.url, /searchresults\.html\?ss=London/);
  assert.equal(booking.origin, "https://www.booking.com");
  const doordash = buildSiteEntry({ site: "doordash", query: "pizza", location: "90210" });
  assert.equal(doordash.strategy, "bootstrap-search");
  assert.equal(doordash.steps.length, 4);
  assert.equal(doordash.steps[0]?.action, "fill");
  assert.equal(doordash.steps[0]?.value, "90210");
});

test("site adapters fail closed when required intent is missing or the site is unknown", () => {
  assert.throws(() => buildSiteEntry({ site: "target" }), /query is required/i);
  assert.throws(() => buildSiteEntry({ site: "not-a-registered-site", query: "shirt" }), /No browser site adapter is registered/i);
  assert.throws(() => buildSiteEntry({ site: "target", query: "x".repeat(241) }), /query must be at most/i);
});

test("bootstrap plans use the browser runtime selector contract", () => {
  const plans = [
    buildSiteEntry({ site: "doordash", query: "pizza", location: "10001" }),
    buildSiteEntry({ site: "dominos", query: "pizza", location: "10001" }),
    buildSiteEntry({ site: "expedia", origin: "Accra", destination: "London" }),
    buildSiteEntry({ site: "united-airlines", origin: "Accra", destination: "London" }),
    buildSiteEntry({ site: "delta", origin: "Accra", destination: "London" }),
  ];
  for (const plan of plans) {
    assert.ok(plan.steps.length > 0);
    for (const step of plan.steps) {
      if (step.action === "wait") continue;
      assert.ok(step.selector, `${plan.adapterId} ${step.action} step must carry selector`);
      assert.ok(step.selector?.role || step.selector?.name || step.selector?.placeholder, `${plan.adapterId} ${step.action} selector must be addressable`);
    }
  }
});

test("site entry plans never include credential or payment fields", () => {
  const entry = buildSiteEntry({ site: "Amazon", query: "wireless keyboard" });
  const serialized = JSON.stringify(entry).toLowerCase();
  for (const forbidden of ["password", "cookie", "cvv", "card number", "payment token"]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("the agent receives a dedicated retailer-start tool with bounded intent fields", () => {
  const tool = chuckTools.find((item) => item.function.name === "CHUCK_BROWSER_RETAILER_START");
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.required, ["site"]);
  validateNativeToolArguments("CHUCK_BROWSER_RETAILER_START", { site: "target", query: "gray shirt" });
  assert.throws(() => validateNativeToolArguments("CHUCK_BROWSER_RETAILER_START", { site: "target", query: "x".repeat(241) }), /query.*maxLength/i);
});
