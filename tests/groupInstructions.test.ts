import assert from "node:assert/strict";
import test from "node:test";
import { sharedGroupInstructions } from "../src/channels/groupInstructions.js";

test("shared group instructions direct verified deliverables back to the originating group", () => {
  const instructions = sharedGroupInstructions("Telegram");
  assert.match(instructions, /CHUCK_CREATE_PDF/);
  assert.match(instructions, /CHUCK_CREATE_PRESENTATION/);
  assert.match(instructions, /CHUCK_ARTIFACT/);
  assert.match(instructions, /actual file back into this same Telegram group/);
  assert.match(instructions, /do not use private memories or assets/i);
  assert.match(instructions, /COMPOSIO_SEARCH_WEB/);
  assert.match(instructions, /COMPOSIO_SEARCH_FETCH_URL_CONTENT/);
  assert.doesNotMatch(instructions, /COMPOSIO_SEARCH_TOOLS/);
  assert.match(instructions, /do not answer from training data alone/i);
});
