import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateImageCatalogBackfillCandidate } from "../src/durableImageCatalogBackfill.js";
import type { ImageAsset } from "../src/store.js";

const asset = (overrides: Partial<ImageAsset> = {}): ImageAsset => ({
  id: "img_123_abcdef12",
  userId: 42,
  name: "brand mark",
  purpose: "reference",
  description: "",
  tags: [],
  r2Key: "images/42/img_123_abcdef12.png",
  contentType: "image/png",
  size: 512,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

test("image catalog backfill accepts only exact owner-prefixed asset references", () => {
  assert.equal(validateImageCatalogBackfillCandidate(42, asset(), 1024), undefined);
  assert.equal(validateImageCatalogBackfillCandidate(41, asset(), 1024), "owner_mismatch");
  assert.equal(validateImageCatalogBackfillCandidate(0, asset(), 1024), "invalid_owner");
});

test("image catalog backfill rejects unsafe keys, IDs, type-extension mismatches, and out-of-bound sizes", () => {
  assert.equal(validateImageCatalogBackfillCandidate(42, null, 1024), "invalid_asset");
  assert.equal(validateImageCatalogBackfillCandidate(42, { ...asset(), contentType: "constructor" }, 1024), "unsupported_content_type");
  assert.equal(validateImageCatalogBackfillCandidate(42, asset({ r2Key: "images/43/private.png" }), 1024), "invalid_key");
  assert.equal(validateImageCatalogBackfillCandidate(42, asset({ r2Key: "images/42/../private.png" }), 1024), "invalid_key");
  assert.equal(validateImageCatalogBackfillCandidate(42, asset({ r2Key: "images/42/asset.jpg" }), 1024), "extension_mismatch");
  assert.equal(validateImageCatalogBackfillCandidate(42, asset({ id: "../asset" }), 1024), "invalid_asset_id");
  assert.equal(validateImageCatalogBackfillCandidate(42, asset({ size: 2048 }), 1024), "invalid_size");
});

test("image catalog backfill is dry-run by default and never mutates sessions or deletes R2 objects", async () => {
  const script = await readFile(new URL("../scripts/backfill-r2-image-catalog.ts", import.meta.url), "utf8");
  assert.match(script, /const apply = process\.argv\.includes\("--apply"\)/);
  assert.match(script, /--confirm-r2-image-catalog-backfill/);
  assert.match(script, /maxOwners > 10/);
  assert.match(script, /maxWrites > 10/);
  assert.match(script, /readCanonicalImageAssets\(userId\)/);
  assert.match(script, /initStore\(\{ suppressStorageMetrics: true \}\)/);
  assert.doesNotMatch(script, /\bgetSession\s*\(/);
  assert.doesNotMatch(script, /\bdeleteR2Object\s*\(/);
  assert.match(script, /Backfill never deletes R2 objects/);
});
