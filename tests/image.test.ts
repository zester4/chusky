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

test("image generation forwards studio controls and references", async () => {
  const originalFetch = globalThis.fetch;
  let request: any;
  globalThis.fetch = (async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("edited").toString("base64"), media_type: "image/png" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    await generateImages("refresh the brand mark", 1, {
      inputReferences: [{ type: "image_url", image_url: { url: "https://example.com/logo.png" } }],
      aspectRatio: "9:16",
      resolution: "2K",
      size: "1024x1792",
      quality: "high",
      outputFormat: "webp",
      background: "transparent",
      seed: 42,
    });
    assert.deepEqual(request, {
      model: request.model,
      prompt: "refresh the brand mark",
      input_references: [{ type: "image_url", image_url: { url: "https://example.com/logo.png" } }],
      aspect_ratio: "9:16",
      resolution: "2K",
      size: "1024x1792",
      quality: "high",
      output_format: "webp",
      background: "transparent",
      seed: 42,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
