import assert from "node:assert/strict";
import test from "node:test";
import { getTriggerTypeByToken, listTriggerCatalogue, listTriggerToolkits, listTriggerTypesForToolkit, requiredTriggerConfigFields, resetTriggerCatalogueForTests, type TriggerCatalogueClient } from "../src/triggerCatalog.js";

function client(): TriggerCatalogueClient {
  const gmail = Array.from({ length: 9 }, (_, index) => ({ slug: `GMAIL_EVENT_${index}`, name: `Gmail event ${index}`, description: "A Gmail event", toolkit: { slug: "gmail", name: "Gmail" }, config: {} }));
  return {
    async listTypes({ cursor } = {}) {
      if (!cursor) return { items: [...gmail.slice(0, 5), { slug: "STRIPE_PAYMENT", name: "Payment received", description: "A Stripe event", toolkit: { slug: "stripe", name: "Stripe" }, config: { required: ["customer_id", "customer_id"] } }], nextCursor: "next" };
      return { items: gmail.slice(5) };
    },
  };
}

test("catalogue paginates the provider, groups toolkits, and returns stable callback tokens", async () => {
  resetTriggerCatalogueForTests();
  const items = await listTriggerCatalogue(client());
  assert.equal(items.length, 10);
  assert.deepEqual((await listTriggerToolkits(client())).map(({ slug, triggerCount }) => [slug, triggerCount]), [["gmail", 9], ["stripe", 1]]);
  const gmail = await listTriggerTypesForToolkit(client(), "GMAIL");
  assert.equal(gmail.length, 9);
  assert.equal((await getTriggerTypeByToken(client(), gmail[0].token))?.slug, gmail[0].slug);
});

test("required trigger configuration fields are bounded and de-duplicated", () => {
  assert.deepEqual(requiredTriggerConfigFields({ required: ["repository", "repository", 7, "branch"] }), ["repository", "branch"]);
});
