import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultMediaInstruction } from "../src/mediaInput.js";
import { extractMediaText } from "../src/lib/knowledge/ingest.js";

test("captionless media uses one neutral instruction across transports", () => {
  assert.equal(defaultMediaInstruction("image"), "Inspect the attached image and respond helpfully to the user.");
  assert.equal(defaultMediaInstruction("document"), "Read the attached document and respond helpfully to the user.");
  assert.equal(defaultMediaInstruction("video"), "Inspect the attached video and respond helpfully to the user.");
  assert.equal(defaultMediaInstruction("attachment"), "Inspect the attached media and respond helpfully to the user.");
});

test("media extraction uses the selected model before the vision fallback", async () => {
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    return new Response(JSON.stringify({ choices: [{ message: { content: "visible text" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const text = await extractMediaText(new Uint8Array([1, 2, 3]), "image.png", "image/png", "selected/model");
    assert.equal(text, "visible text");
    assert.deepEqual(models, ["selected/model"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("media extraction falls back only when the selected model rejects the modality", async () => {
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    if (body.model === "selected/model") return new Response("No endpoints found that support image input", { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "fallback text" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const text = await extractMediaText(new Uint8Array([1, 2, 3]), "image.png", "image/png", "selected/model");
    assert.equal(text, "fallback text");
    assert.deepEqual(models, ["selected/model", "openai/gpt-5.6-luna"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
