import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  browserLiveViewUrl,
  createBrowserLiveViewTicket,
  openBrowserLiveViewTicketFromStorage,
  renderBrowserLiveView,
  sealBrowserLiveViewTicketForStorage,
  verifyBrowserLiveViewTicket,
} from "../src/lib/e2b/liveView.js";

const now = 1_800_000_000_000;
const viewerId = "lv_012345678901234567890123456789";
const targetUrl = "https://sandbox-123.e2b.app/chusky-vnc.html#autoconnect=1&password=provider-secret";

function withLiveViewConfig<T>(run: () => T): T {
  const previous = { browserLiveViewSecret: config.browserLiveViewSecret, apiKey: config.apiKey, webhookSecret: config.webhookSecret, webhookUrl: config.webhookUrl };
  Object.assign(config, { browserLiveViewSecret: "live-view-test-secret", apiKey: "", webhookSecret: "", webhookUrl: "https://chusky.example" });
  try { return run(); } finally { Object.assign(config, previous); }
}

test("browser live-view tickets are encrypted, owner-shaped, tamper resistant, and expiring", () => withLiveViewConfig(() => {
  const ticket = createBrowserLiveViewTicket({ viewerId, userId: 42, provider: "e2b", mode: "read-only", targetUrl, expiresAt: now + 60_000 }, now);
  assert.doesNotMatch(ticket, /provider-secret|sandbox-123/);
  assert.deepEqual(verifyBrowserLiveViewTicket(ticket, now), { version: 1, viewerId, userId: 42, provider: "e2b", mode: "read-only", targetUrl, expiresAt: now + 60_000 });
  assert.equal(verifyBrowserLiveViewTicket(`${ticket.startsWith("a") ? "b" : "a"}${ticket.slice(1)}`, now), undefined);
  assert.equal(verifyBrowserLiveViewTicket(ticket, now + 60_000), undefined);
}));

test("live-view state can be reissued without storing the provider URL in plaintext", () => withLiveViewConfig(() => {
  const ticket = createBrowserLiveViewTicket({ viewerId, userId: 7, provider: "kernel", mode: "interactive", targetUrl: "https://browser.onkernel.com/live?id=private", expiresAt: now + 120_000 }, now);
  const stored = sealBrowserLiveViewTicketForStorage(ticket);
  assert.notEqual(stored, ticket);
  assert.equal(openBrowserLiveViewTicketFromStorage(stored), ticket);
  assert.equal(openBrowserLiveViewTicketFromStorage(`${stored.startsWith("a") ? "b" : "a"}${stored.slice(1)}`), undefined);
}));

test("public watch URL is Chusky-hosted and the viewer enforces its mode", () => withLiveViewConfig(() => {
  const readOnlyTicket = createBrowserLiveViewTicket({ viewerId, userId: 42, provider: "e2b", mode: "read-only", targetUrl, expiresAt: now + 60_000 }, now);
  const interactiveTicket = createBrowserLiveViewTicket({ viewerId: `${viewerId}x`, userId: 42, provider: "e2b", mode: "interactive", targetUrl, expiresAt: now + 60_000 }, now);
  const url = browserLiveViewUrl(readOnlyTicket);
  assert.ok(url?.startsWith("https://chusky.example/browser/live/"));
  assert.doesNotMatch(url ?? "", /provider-secret|sandbox-123/);
  const readOnlyHtml = renderBrowserLiveView(verifyBrowserLiveViewTicket(readOnlyTicket, now)!);
  assert.match(readOnlyHtml, /read-only view/);
  assert.match(readOnlyHtml, /pointer-events: none/);
  const interactiveHtml = renderBrowserLiveView(verifyBrowserLiveViewTicket(interactiveTicket, now)!);
  assert.match(interactiveHtml, /interactive handoff/);
  assert.doesNotMatch(interactiveHtml, /pointer-events: none/);
}));

test("unsafe or absent public origin disables Chusky-hosted delivery", () => withLiveViewConfig(() => {
  const ticket = createBrowserLiveViewTicket({ viewerId, userId: 42, provider: "e2b", mode: "read-only", targetUrl, expiresAt: now + 60_000 }, now);
  config.webhookUrl = "http://localhost:8787";
  assert.equal(browserLiveViewUrl(ticket), undefined);
  config.webhookUrl = "";
  assert.equal(browserLiveViewUrl(ticket), undefined);
}));
