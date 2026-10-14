import test from "node:test";
import assert from "node:assert/strict";
import { BrowserTrustLedger, BrowserTrustRouter, stableBrowserIdentityKey } from "../src/lib/browser-runtime/trustRouter.js";
import { SiteCapabilityRegistry, browserSiteCapabilities, normalizeBrowserOrigin } from "../src/lib/browser-runtime/siteCapabilities.js";

test("site capabilities normalize HTTPS origins and keep common interactive sites on the headed browser", () => {
  assert.equal(normalizeBrowserOrigin("https://target.com/search?q=shirt"), "https://target.com");
  assert.equal(browserSiteCapabilities.resolve("https://www.target.com/p/shirt").preferred, "browser");
  assert.deepEqual(browserSiteCapabilities.resolve("https://www.target.com/p/shirt").routes, ["browser", "human-handoff"]);
  assert.throws(() => normalizeBrowserOrigin("http://target.com"), /HTTPS/);
  assert.throws(() => normalizeBrowserOrigin("https://user:password@target.com"), /credentials/);
});

test("site capability registry supports explicitly verified non-browser routes without inventing them", () => {
  const registry = new SiteCapabilityRegistry([]);
  registry.register({ origin: "https://api.example.com", routes: ["api", "human-handoff"], preferred: "api", ownerChromeAllowed: false, reason: "Verified partner API" });
  assert.equal(registry.resolve("https://api.example.com/v1/items").preferred, "api");
  assert.equal(registry.resolve("https://unknown.example.com").preferred, "browser");
  assert.throws(() => registry.register({ origin: "http://bad.example.com", routes: ["browser"], preferred: "browser", ownerChromeAllowed: false }), /HTTPS/);
});

test("stable browser identity is owner- and origin-bound without exposing raw owner ids", () => {
  const first = stableBrowserIdentityKey(7, "https://target.com/a");
  assert.equal(first, stableBrowserIdentityKey(7, "https://target.com/b"));
  assert.notEqual(first, stableBrowserIdentityKey(8, "https://target.com/a"));
  assert.match(first, /^bi_[a-f0-9]{32}$/);
  assert.doesNotMatch(first, /(^|_)7(_|$)/);
});

test("trust ledger opens a bounded circuit and clears only after verified human resolution", () => {
  let now = 1_000;
  const ledger = new BrowserTrustLedger({ threshold: 2, cooldownMs: 5_000, now: () => now });
  assert.equal(ledger.recordSignal(7, "https://target.com", "challenge").state, "closed");
  const open = ledger.recordSignal(7, "https://target.com", "challenge");
  assert.equal(open.state, "open");
  assert.equal(open.strikes, 2);
  now += 5_001;
  assert.equal(ledger.status(7, "https://target.com").state, "closed");
  ledger.recordSignal(7, "https://target.com", "access_denied");
  ledger.clearAfterVerifiedHuman(7, "https://target.com");
  assert.deepEqual(ledger.status(7, "https://target.com"), { state: "closed", strikes: 0, threshold: 2, retryAfterMs: 0 });
});

test("trust router routes an open owner circuit to private handoff and blocks shared retries", () => {
  const ledger = new BrowserTrustLedger({ threshold: 1, cooldownMs: 10_000, now: () => 10_000 });
  const router = new BrowserTrustRouter(new SiteCapabilityRegistry([]), ledger);
  router.recordOutcome(7, { url: "https://shop.example/product", challenge: true });
  const privateDecision = router.beforeNavigation({ ownerId: 7, url: "https://shop.example/product", ownerPrivateRun: true });
  const sharedDecision = router.beforeNavigation({ ownerId: 7, url: "https://shop.example/product", ownerPrivateRun: false });
  assert.equal(privateDecision.route, "human-handoff");
  assert.equal(sharedDecision.route, "blocked");
  assert.equal(privateDecision.identity.profile, "stable-owner-origin");
  assert.equal(privateDecision.identity.webBotAuth, "disabled");
  router.clearAfterVerifiedHuman(7, "https://shop.example/product");
  assert.equal(router.beforeNavigation({ ownerId: 7, url: "https://shop.example/product", ownerPrivateRun: true }).route, "browser");
});

test("trust readiness exposes identity posture but no private key material", () => {
  const readiness = new BrowserTrustRouter().readiness();
  assert.equal(readiness.stableOwnerOriginProfiles, true);
  assert.ok(["e2b", "kernel", "dedicated"].includes(readiness.provider));
  assert.equal("privateKey" in readiness, false);
  assert.equal(readiness.ownerChrome.adapter, "not-configured");
});
