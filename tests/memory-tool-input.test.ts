import test from "node:test";
import assert from "node:assert/strict";
import { nativeTool } from "../src/nativeTools.js";

test("memory and scratchpad tools explain blank text inputs before any persistence call", async () => {
  await assert.rejects(
    nativeTool(991218, "CHUCK_UPDATE_MEMORY", { key: "   ", value: "June" }),
    /requires a non-blank id or key/i,
  );
  await assert.rejects(
    nativeTool(991218, "CHUCK_SCRATCHPAD_WRITE", { key: "working-note", content: "   " }),
    /(?:requires argument: content|content.*pattern)/i,
  );
});
