import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { chuckTools, validateNativeToolArguments } from "../src/agentTools.js";
import { initStore } from "../src/store.js";
import { cancelShopping, listSavedShoppingSites, listShopping, pauseShopping, resumeShopping, saveShoppingSitePreference, selectShoppingRetailer, startShopping, updateShopping } from "../src/shopping/shopping.js";
import { suggestRetailers } from "../src/shopping/retailers.js";
import { shoppingActionPolicy } from "../src/shopping/policy.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("shopping tools are exposed without accepting credentials or payment data", () => {
  for (const name of ["CHUCK_SHOPPING_START", "CHUCK_SHOPPING_LIST", "CHUCK_SHOPPING_SELECT_RETAILER", "CHUCK_SHOPPING_UPDATE", "CHUCK_SHOPPING_CANCEL", "CHUCK_SHOPPING_PAUSE", "CHUCK_SHOPPING_RESUME", "CHUCK_SHOPPING_SAVE_SITE", "CHUCK_SHOPPING_LIST_SITES", "CHUCK_SHOPPING_REMOVE_SITE", "CHUCK_DAYTONA_BROWSER_HANDOFF"]) {
    const tool = chuckTools.find((candidate) => candidate.function.name === name);
    assert.ok(tool, `${name} is exposed`);
    const properties = Object.keys((tool!.function.parameters as { properties?: Record<string, unknown> }).properties ?? {});
    assert.equal(properties.some((key) => /password|credential|cookie|token|payment|card/i.test(key)), false, `${name} has no secret or payment input`);
  }
  validateNativeToolArguments("CHUCK_SHOPPING_START", { items: ["milk"] });
  assert.throws(() => validateNativeToolArguments("CHUCK_SHOPPING_START", {}), /requires argument/);
});

test("shopping starts retailer-neutral and suggests local options", async () => {
  const result = await startShopping(9001, { items: ["milk", "bread"], category: "groceries", country: "GB", deliveryPreference: "delivery" });
  assert.equal(result.status, "awaiting_retailer");
  assert.equal(result.suggestions.some((retailer) => retailer.id === "tesco"), true);
  assert.equal(result.suggestions.some((retailer) => retailer.id === "amazon"), true);
  assert.match(result.nextStep, /retailer/i);
  assert.equal((await listShopping(9001))[0]?.id, result.id);
  assert.deepEqual(await listShopping(9002), []);
});

test("shopping supports any clean HTTPS retailer after selection", async () => {
  const started = await startShopping(9003, { items: ["dog food"], category: "household" });
  const selected = await selectShoppingRetailer(9003, { id: started.id, retailer: "Pet Store", origin: "https://shop.example.com" });
  assert.equal(selected.status, "awaiting_connection");
  assert.equal(selected.retailer?.origin, "https://shop.example.com");
  await assert.rejects(() => selectShoppingRetailer(9003, { id: started.id, retailer: "Unsafe", origin: "http://shop.example.com" }), /HTTPS/);
});

test("shopping plans update privately and cancellation does not affect an external cart", async () => {
  const started = await startShopping(9004, { items: ["pasta"], category: "groceries" });
  const updated = await updateShopping(9004, { id: started.id, items: ["pasta", "tomatoes"], budget: 50, currency: "GBP" });
  assert.deepEqual(updated.items, ["pasta", "tomatoes"]);
  assert.equal(updated.budget, 50);
  const cancelled = await cancelShopping(9004, started.id);
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.message, /No browser cart/i);
});

test("retailer suggestions and checkout policy remain safe", () => {
  assert.equal(suggestRetailers({ country: "US", category: "groceries", deliveryPreference: "pickup" }).some((retailer) => retailer.id === "walmart"), true);
  assert.equal(shoppingActionPolicy("add_to_cart"), "auto");
  assert.equal(shoppingActionPolicy("place_order"), "approval_required");
});

test("catalogue covers Jumia Ghana and users can save a private retailer preference", async () => {
  const ghana = suggestRetailers({ country: "GH", category: "electronics", deliveryPreference: "delivery" });
  assert.equal(ghana.some((retailer) => retailer.id === "jumia-ghana"), true);
  const site = await saveShoppingSitePreference(9005, { name: "My Local Grocer", origin: "https://grocer.example" });
  assert.equal(site.origin, "https://grocer.example");
  assert.equal((await listSavedShoppingSites(9005))[0]?.id, site.id);
  assert.deepEqual(await listSavedShoppingSites(9006), []);
  const started = await startShopping(9005, { items: ["rice"], category: "groceries" });
  const selected = await selectShoppingRetailer(9005, { id: started.id, retailer: "My Local Grocer" });
  assert.equal(selected.retailer?.origin, "https://grocer.example");
});

test("a CAPTCHA pause and resume preserve the shopping plan without repeating a website action", async () => {
  const started = await startShopping(9007, { items: ["tea"], category: "groceries", retailer: "Tesco" });
  const paused = await pauseShopping(9007, { id: started.id, reason: "captcha" });
  assert.equal(paused.status, "awaiting_user_interaction");
  assert.equal(paused.pausedReason, "captcha");
  const resumed = await resumeShopping(9007, started.id);
  assert.equal(resumed.status, "shopping");
  assert.equal(resumed.pausedReason, undefined);
  assert.match(resumed.message, /Inspect the current page/i);
});
