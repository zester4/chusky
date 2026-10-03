import test from "node:test";
import assert from "node:assert/strict";
import { collectR2BodyBounded } from "../src/lib/storage/r2.js";

async function* chunks(...values: number[][]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield Uint8Array.from(value);
}

test("bounded R2 reader collects streamed chunks within the configured limit", async () => {
  const result = await collectR2BodyBounded(chunks([1, 2], [3, 4]), 4);
  assert.deepEqual([...result], [1, 2, 3, 4]);
});

test("bounded R2 reader rejects an oversized chunk stream", async () => {
  await assert.rejects(() => collectR2BodyBounded(chunks([1, 2, 3], [4, 5]), 4), /exceeds the configured read limit/);
});

test("bounded R2 reader rejects an invalid limit", async () => {
  await assert.rejects(() => collectR2BodyBounded(chunks([1]), 0), /read limit is invalid/);
});
