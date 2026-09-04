import test from "node:test";
import assert from "node:assert/strict";
import { generateImages } from "../src/agent.js";

test("image generation requests the requested count and returns every image", async () => {
  const originalFetch = globalThis.fetch;
  let request: any;
  globalThis.fetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      data: [
        { b64_json: Buffer.from("one").toString("base64"), media_type: "image/png" },
        { b64_json: Buffer.from("two").toString("base64"), media_type: "image/jpeg" },
        { b64_json: Buffer.from("three").toString("base64"), media_type: "image/webp" },
      ],
      usage: { cost: 0.12 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const images = await generateImages("three distinct icons", 3);
    assert.equal(typeof request.model, "string");
    assert.equal(request.prompt, "three distinct icons");
    assert.equal(request.n, 3);
    assert.deepEqual(images.map((image) => [image.data.toString(), image.mediaType]), [["one", "image/png"], ["two", "image/jpeg"], ["three", "image/webp"]]);
    assert.equal(images[0]?.cost, 0.12);
    assert.equal(images[1]?.cost, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
