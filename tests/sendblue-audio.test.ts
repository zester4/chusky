import test from "node:test";
import assert from "node:assert/strict";
import { sendblueCafTranscodeArgs } from "../src/channels/sendblueAudio.js";
import { sendblueFileExtensionForMime } from "../src/channels/sendblueMedia.js";

test("Sendblue CAF audio is converted to mono Ogg/Opus before STT", () => {
  assert.deepEqual(sendblueCafTranscodeArgs("input.caf", "output.ogg"), [
    "-nostdin", "-v", "error", "-i", "input.caf", "-map", "0:a:0", "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "24k", "output.ogg",
  ]);
});

test("Sendblue media URLs retain documented audio filename extensions", () => {
  assert.equal(sendblueFileExtensionForMime("audio/mpeg"), "mp3");
  assert.equal(sendblueFileExtensionForMime("audio/mp4"), "m4a");
  assert.equal(sendblueFileExtensionForMime("audio/x-caf"), "caf");
});
