import test from "node:test";
import assert from "node:assert/strict";
import { audioFormat } from "../src/handlers.js";

test("normalizes Telegram audio extensions for transcription", () => {
  assert.equal(audioFormat("voice.oga"), "ogg");
  assert.equal(audioFormat("VOICE.OGG"), "ogg");
  assert.equal(audioFormat("recording.webm"), "webm");
  assert.equal(audioFormat("recording"), "recording");
});
