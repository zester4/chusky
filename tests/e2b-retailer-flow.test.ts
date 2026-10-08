import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findAddToCartControl, findFirstAvailableVariant, findProductCandidate, findVariantControl, interactiveMatches } from "../src/lib/e2b/retailerFlow.js";

test("retailer flow resolver recognizes Costco-style product URLs and relevant names", () => {
  const candidate = findProductCandidate([
    { role: "link", name: "Blue shirt search", href: "https://www.costco.com/s?keyword=blue%20shirt" },
    { role: "link", name: "Classic blue shirt", href: "https://www.costco.com/classic-blue-shirt.product.100123.html" },
  ], "https://www.costco.com/s?keyword=blue%20shirt");
  assert.equal(candidate, "https://www.costco.com/classic-blue-shirt.product.100123.html");
});

test("retailer flow resolver merges inspected form controls with accessible matches", () => {
  const matches = interactiveMatches({ matches: [{ role: "heading", name: "Phone" }], forms: [{ controls: [{ role: "button", name: "Color: Black" }], submitControls: [{ role: "button", name: "Add to cart" }] }] });
  assert.equal(findVariantControl(matches)?.name, "Color: Black");
  assert.equal(findFirstAvailableVariant(matches)?.name, "Color: Black");
  assert.equal(findAddToCartControl(matches)?.name, "Add to cart");
});

test("retailer flow resolver excludes irreversible purchase controls", () => {
  assert.equal(findAddToCartControl([{ role: "button", name: "Place order" }]), undefined);
  assert.equal(findFirstAvailableVariant([{ role: "button", name: "favorite this device" }]), undefined);
});

test("retailer flow resolver recognizes standalone add controls used by grocery sites", () => {
  const match = findAddToCartControl([{ role: "button", name: "Add", index: 0 }]);
  assert.equal(match?.name, "Add");
  assert.equal(findAddToCartControl([{ role: "button", name: "Add payment method", index: 0 }]), undefined);
});

test("live retailer harness includes a separate food-flow suite and preserves the checkout boundary", () => {
  const source = readFileSync("scripts/e2b-retailer-live-matrix.ts", "utf8");
  assert.match(source, /const foodRetailers/);
  assert.match(source, /process\.argv\.includes\("--food"\)/);
  assert.match(source, /neverSubmitPayment/);
  assert.match(source, /stoppedBeforePurchase = true/);
});
