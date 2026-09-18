import test from "node:test";
import assert from "node:assert/strict";
import { missingComposioConnectionMessage, resolveComposioRoute } from "../src/composioRouting.js";

test("routes a business objective through domain and connected toolkit", () => {
  assert.deepEqual(resolveComposioRoute("Review Shopify orders", ["hubspot"]), {
    domain: "ecommerce", preferredToolkits: ["shopify", "woocommerce"], connectedToolkits: [], needsConnection: true,
  });
  const crm = resolveComposioRoute("Qualify the HubSpot pipeline", ["hubspot"]);
  assert.equal(crm?.domain, "crm");
  assert.deepEqual(crm?.connectedToolkits, ["hubspot"]);
  assert.equal(crm?.needsConnection, false);
});

test("returns an actionable connection message instead of selecting an unrelated app", () => {
  const route = resolveComposioRoute("Send a Zendesk support reply", []);
  assert.equal(route?.needsConnection, true);
  assert.match(missingComposioConnectionMessage(route!), /zendesk or intercom/);
});
