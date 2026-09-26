import test from "node:test";
import assert from "node:assert/strict";
import { transferDaytonaImage, type DaytonaImageTransferDependencies } from "../src/daytonaImageTransfer.js";
import { selectRetrievedImageForAction, selectRequestedImage } from "../src/mediaBridge.js";

function png(): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write("IEND", 16, "ascii");
  return bytes;
}

test("imports a verified Daytona image as an owner asset for a same-run post", async () => {
  const image = png();
  let readPath = "";
  let savedOwner = 0;
  const dependencies = {
    readDaytonaFile: async (owner: number, path: string, limit: number) => {
      assert.equal(owner, 802001);
      assert.equal(limit, 25 * 1024 * 1024);
      readPath = path;
      return image;
    },
    writeDaytonaFile: async () => { throw new Error("export must not run"); },
    saveAsset: async (owner: number, input: any, bytes: Uint8Array) => {
      savedOwner = owner;
      assert.deepEqual(Buffer.from(bytes), image);
      assert.equal(input.contentType, "image/png");
      assert.match(input.name, /^artwork-[a-f0-9]{8}\.png$/);
      return { id: "img_daytona_1", r2Key: "images/802001/img_daytona_1.png", ...input, size: image.length } as any;
    },
    getAsset: async () => undefined,
    readAsset: async () => Buffer.alloc(0),
  } as DaytonaImageTransferDependencies;
  const result = await transferDaytonaImage(802001, { action: "import", path: "workspace/artwork.png" }, {}, dependencies);
  assert.equal(readPath, "workspace/artwork.png");
  assert.equal(savedOwner, 802001);
  assert.equal(result.id, "img_daytona_1");
  assert.deepEqual(selectRetrievedImageForAction("Post the Daytona image to LinkedIn", ["img_daytona_1"]), { source: "asset", assetId: "img_daytona_1" });
  await assert.rejects(() => transferDaytonaImage(802001, { action: "import", path: "../other-user/image.png" }, {}, dependencies), /workspace-relative path/);
});

test("exports a chat or saved image to a unique Daytona file without exposing bytes", async () => {
  const image = png();
  const writes: Array<{ owner: number; path: string; bytes: Buffer }> = [];
  const dependencies = {
    readDaytonaFile: async () => Buffer.alloc(0),
    writeDaytonaFile: async (owner: number, path: string, bytes: Buffer) => { writes.push({ owner, path, bytes }); return { path, bytes: bytes.length }; },
    saveAsset: async () => { throw new Error("import must not run"); },
    getAsset: async (owner: number, id: string) => owner === 802002 && id === "img_saved" ? { r2Key: "images/802002/saved.png", name: "brand.png" } as any : undefined,
    readAsset: async (key: string) => { assert.equal(key, "images/802002/saved.png"); return image; },
  } as DaytonaImageTransferDependencies;
  const current = await transferDaytonaImage(802002, { action: "export", source: "current", directory: "workspace/app/public" }, { currentImages: [{ data: image, mediaType: "image/png", filename: "hero.png" }] }, dependencies);
  const saved = await transferDaytonaImage(802002, { action: "export", source: "asset", assetId: "img_saved", directory: "workspace/app/public" }, {}, dependencies);
  assert.match(String(current.path), /^workspace\/app\/public\/hero-[a-f0-9]{8}\.png$/);
  assert.match(String(saved.path), /^workspace\/app\/public\/brand-[a-f0-9]{8}\.png$/);
  assert.equal(writes.length, 2);
  assert.equal(writes[0]!.owner, 802002);
  assert.deepEqual(writes[0]!.bytes, image);
  assert.equal(JSON.stringify(current).includes("iVBOR"), false);
  await assert.rejects(() => transferDaytonaImage(802002, { action: "export", source: "asset", assetId: "img_other" }, {}, dependencies), /not found/);
});

test("rejects invalid Daytona bytes and leaves provider actions untouched", async () => {
  let saved = false;
  const dependencies = {
    readDaytonaFile: async () => Buffer.from("not an image"),
    writeDaytonaFile: async () => { throw new Error("unexpected write"); },
    saveAsset: async () => { saved = true; throw new Error("unexpected save"); },
    getAsset: async () => undefined,
    readAsset: async () => Buffer.alloc(0),
  } as DaytonaImageTransferDependencies;
  await assert.rejects(() => transferDaytonaImage(802003, { action: "import", path: "workspace/fake.png" }, {}, dependencies), /Only valid JPEG, PNG, or WebP/);
  assert.equal(saved, false);
  assert.deepEqual(selectRequestedImage("Post the Daytona screenshot", { currentCount: 0, generatedCount: 1 }), { source: "generated", sourceIndex: 0 });
});
