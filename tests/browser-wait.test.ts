import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchBrowserWaitConditions, normalizeBrowserWaitConditions } from "../e2b/browser-template/browser-conditions.mjs";
import { normalizeBrowserWaitRequest } from "../src/lib/e2b/waitConditions.js";

test("wait requests normalize bounded URL, title, text, and load-state conditions", () => {
  assert.deepEqual(normalizeBrowserWaitRequest({
    timeoutSeconds: 2.5,
    role: "heading",
    name: "Results",
    nameMatch: "substring",
    urlIncludes: "/search",
    titleIncludes: "results",
    textExcludes: "error",
    loadState: "domcontentloaded",
  }), {
    action: "wait",
    timeoutMs: 2_500,
    role: "heading",
    name: "Results",
    nameMatch: "substring",
    urlIncludes: "/search",
    titleIncludes: "results",
    textExcludes: "error",
    loadState: "domcontentloaded",
  });
  assert.throws(() => normalizeBrowserWaitRequest({ loadState: "unsupported" }), /loadState/);
  assert.throws(() => normalizeBrowserWaitRequest({ textIncludes: "x".repeat(301) }), /textIncludes/);
});

test("wait matcher reports only unsatisfied conditions and compares page text safely", () => {
  const conditions = normalizeBrowserWaitConditions({
    timeoutMs: 5_000,
    urlIncludes: "/results",
    titleIncludes: "Results",
    textIncludes: "3 items",
    textExcludes: "error",
    loadState: "load",
  });
  assert.deepEqual(matchBrowserWaitConditions({
    url: "https://example.test/results?page=2",
    title: "Search Results",
    text: "3 items found",
    loadState: "load",
  }, conditions), { passed: true, missing: [] });
  assert.deepEqual(matchBrowserWaitConditions({
    url: "https://example.test/search",
    title: "Search",
    text: "Loading",
    loadState: "domcontentloaded",
  }, conditions), { passed: false, missing: ["urlIncludes", "titleIncludes", "textIncludes", "loadState"] });
});

test("the production template ships and uses the same wait-condition protocol", () => {
  const agent = readFileSync("e2b/browser-template/browser-agent.mjs", "utf8");
  const dockerfile = readFileSync("e2b/browser-template/Dockerfile", "utf8");
  assert.match(agent, /browser-conditions\.mjs/);
  assert.match(agent, /waitForBrowserConditions/);
  assert.match(dockerfile, /COPY browser-conditions\.mjs \.\//);
});
