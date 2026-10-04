import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isClearlyConversational } from "../src/decisions/actionGate.js";

test("routing fixture keeps every labeled action out of the compact path", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/routing-messages.json", import.meta.url), "utf8")) as Array<{ message: string; label: string }>;
  const misses = fixture.filter((item) => item.label === "action" && isClearlyConversational(item.message));
  assert.deepEqual(misses, []);
  const chat = fixture.filter((item) => item.label === "conversational");
  assert.ok(chat.filter((item) => isClearlyConversational(item.message)).length / chat.length >= 0.7);
});
