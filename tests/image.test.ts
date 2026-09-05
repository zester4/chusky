import test from "node:test";
import assert from "node:assert/strict";
import { generateImages } from "../src/agent.js";

test("image generation requests the requested count and returns every image", async () => {
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from(`image-${requests.length}`).toString("base64"), media_type: "image/png" }],
      usage: { cost: 0.12 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const images = await generateImages("three distinct icons", 3);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests, [
      { model: "x-ai/grok-imagine-image-2.0", prompt: "three distinct icons" },
      { model: "x-ai/grok-imagine-image-2.0", prompt: "three distinct icons" },
      { model: "x-ai/grok-imagine-image-2.0", prompt: "three distinct icons" },
    ]);
    assert.deepEqual(images.map((image) => [image.data.toString(), image.mediaType]), [["image-1", "image/png"], ["image-2", "image/png"], ["image-3", "image/png"]]);
    assert.equal(images[0]?.cost, 0.12);
    assert.equal(images[1]?.cost, 0.12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Grok image generation keeps supported controls and omits unsupported studio controls", async () => {
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
      prompt: "refresh the brand mark\n\nComposition guidance: Compose for a 9:16 canvas and keep important subjects inside safe margins. Use a composition intended for a 1024x1792 canvas. Use a transparent background if supported; otherwise keep the background clean and easily removable. Prioritize crisp, high-detail rendering.",
      input_references: [{ type: "image_url", image_url: { url: "https://example.com/logo.png" } }],
      aspect_ratio: "9:16",
      resolution: "2K",
      quality: "medium",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
