import assert from "node:assert/strict";
import test from "node:test";
import { getTriggerTypeBySlug, getTriggerTypeByToken, listTriggerCatalogue, listTriggerToolkits, listTriggerTypesForToolkit, requiredTriggerConfigFields, resetTriggerCatalogueForTests, triggerTypeForAgent, type TriggerCatalogueClient } from "../src/triggerCatalog.js";

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

test("trigger discovery resolves only exact provider slugs and returns safe bounded configuration guidance", async () => {
  resetTriggerCatalogueForTests();
  const types = await listTriggerTypesForToolkit(client(), "gmail");
  assert.equal((await getTriggerTypeBySlug(client(), types[0]!.slug))?.slug, types[0]!.slug);
  assert.equal(await getTriggerTypeBySlug(client(), `${types[0]!.slug}_GUESSED`), undefined);
  const projected = triggerTypeForAgent({
    ...types[0]!,
    config: {
      required: ["query", "api_key"],
      properties: {
        query: { type: "string", description: "Mailbox filter", maxLength: 200 },
        api_key: { type: "string", description: "A secret credential value" },
      },
    },
  });
  assert.deepEqual(projected.requiredFields, ["query", "api_key"]);
  assert.deepEqual(projected.fields, [
    { name: "query", required: true, type: "string", description: "Mailbox filter", maxLength: 200 },
    { name: "api_key", required: true, sensitive: true },
  ]);
});
