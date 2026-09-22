import test from "node:test";
import assert from "node:assert/strict";
import { getMeetingCapabilities } from "../src/meetings/capabilities.js";

test("meeting capability matrix is conservative about Webex gaps", () => {
  const webex = getMeetingCapabilities("webex");
  assert.equal(webex.audio, "supported");
  assert.equal(webex.outboundChat, "unsupported");
  assert.equal(webex.screenShare, "unsupported");
  assert.equal(webex.inboundChat, "supported");
});
test("meeting capability matrix exposes provider-limited controls", () => {
  const zoom = getMeetingCapabilities("zoom");
  assert.equal(zoom.audio, "supported");
  assert.equal(zoom.screenShare, "supported");
  assert.equal(zoom.admissionControl, "limited");
  assert.ok(zoom.notes.length > 0);
});
