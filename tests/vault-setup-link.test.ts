import test from "node:test";
import assert from "node:assert/strict";
import { prepareVaultSetupDelivery } from "../src/vault/setupLink.js";

test("vault setup links are delivered directly and removed from model output", () => {
  const expiresAt = Date.now() + 60_000;
  const delivery = prepareVaultSetupDelivery({
    setupUrl: "https://vault.example/setup/ticket-id?token=private-token",
    expiresAt,
    service: "shop",
  });
  assert.equal(delivery.privateLink.url, "https://vault.example/setup/ticket-id?token=private-token");
  assert.equal(delivery.privateLink.expiresAt, expiresAt);
  assert.equal(delivery.privateLink.label, "Open your private website setup form");
  assert.deepEqual(delivery.modelResult, {
    setupLinkIssued: true,
    expiresAt,
    message: "The private setup link was sent directly to you. Open it to save the login; do not share the link.",
  });
  assert.doesNotMatch(JSON.stringify(delivery.modelResult), /private-token|setupUrl/);
});

test("vault setup link delivery rejects invalid, expired, and non-HTTPS links", () => {
  for (const setupUrl of [
    "http://vault.example/setup/ticket-id?token=private-token",
    "https://vault.example/setup/ticket-id",
    "https://vault.example/other/ticket-id?token=private-token",
    "https://user:pass@vault.example/setup/ticket-id?token=private-token",
  ]) {
    assert.throws(() => prepareVaultSetupDelivery({ setupUrl, expiresAt: Date.now() + 60_000 }), /valid private setup link/);
  }
  assert.throws(() => prepareVaultSetupDelivery({
    setupUrl: "https://vault.example/setup/ticket-id?token=private-token",
    expiresAt: Date.now() - 1,
  }), /valid private setup link/);
});
