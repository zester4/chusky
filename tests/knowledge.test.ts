import test from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../src/lib/knowledge/chunker.js";

test("chunks extracted text with deterministic overlap", () => {
  const chunks = chunkText("alpha ".repeat(80), { maxCharacters: 100, overlapCharacters: 20 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].id, "chunk_0");
  assert.ok(chunks[1].start < chunks[0].end);
});

test("ignores empty documents", () => assert.deepEqual(chunkText(" \n\n "), []));
