import test from "node:test";
import assert from "node:assert/strict";
import { audioFormat } from "../src/handlers.js";
import { generateSpeech } from "../src/agent.js";

test("normalizes Telegram audio extensions for transcription", () => {
  assert.equal(audioFormat("voice.oga"), "ogg");
  assert.equal(audioFormat("VOICE.OGG"), "ogg");
  assert.equal(audioFormat("recording.webm"), "webm");
  assert.equal(audioFormat("recording"), "recording");
});

test("generates MP3 voice replies through the OpenRouter speech endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; body: any } | undefined;
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), body: JSON.parse(String(init?.body)) };
    return new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg", "x-generation-id": "gen_test" } });
  }) as typeof fetch;
  try {
    const result = await generateSpeech("Here is **your** [report](https://example.com).\n\n```js\nsecret();\n```");
    assert.equal(request?.url, "https://openrouter.ai/api/v1/audio/speech");
    assert.equal(request?.body.model, "deepgram/flux-tts:free");
    assert.equal(request?.body.voice, "flux-kit-en");
    assert.equal(request?.body.response_format, "mp3");
    assert.equal(request?.body.input, "Here is your report. Code block omitted.");
    assert.deepEqual([...result.data], [1, 2, 3]);
    assert.equal(result.mediaType, "audio/mpeg");
    assert.equal(result.generationId, "gen_test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
