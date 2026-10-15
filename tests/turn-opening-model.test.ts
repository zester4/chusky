import test from "node:test";
import assert from "node:assert/strict";
import { createTurnOpening } from "../src/turnOpeningModel.js";
import { openingFallback } from "../src/turnOpening.js";

test("opening model request is small, tool-free, latency-routed, and reports usage", async () => {
  const originalFetch = globalThis.fetch;
  const messages: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "openai/gpt-4.1-nano");
    assert.equal(body.tools, undefined);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[1].content.length, 3000);
    assert.equal(body.max_tokens, 96);
    assert.deepEqual(body.reasoning, { enabled: false });
    assert.deepEqual(body.provider.sort, { by: "latency" });
    assert.ok(init?.signal);
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "I'll review the relevant context." } }], usage: { cost: 0.0001 } }), { status: 200 });
  };
  try {
    const opening = createTurnOpening("x".repeat(5000), (text) => { messages.push(text); });
    await opening.ready;
    assert.deepEqual(messages, ["I'll review the relevant context."]);
    assert.equal(opening.cost, 0.0001);
    opening.close();
  } finally { globalThis.fetch = originalFetch; }
});

test("opening rate limits fall back without retrying or failing the agent", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const messages: string[] = [];
  globalThis.fetch = async () => { calls++; return new Response("rate limited", { status: 429 }); };
  try {
    const opening = createTurnOpening("Summarize my email", (text) => { messages.push(text); });
    await opening.ready;
    assert.equal(calls, 1);
    assert.deepEqual(messages, [openingFallback("Summarize my email")]);
    opening.close();
  } finally { globalThis.fetch = originalFetch; }
});

test("malformed provider content and truncated completions use local fallback", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const choice of [{ finish_reason: "stop", message: { content: { unexpected: true } } }, { finish_reason: "length", message: { content: "I'll review." } }]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ choices: [choice] }), { status: 200 });
      const opening = createTurnOpening("Inspect project", () => {});
      await opening.ready;
      assert.equal(opening.text, openingFallback("Inspect project"));
      opening.close();
    }
  } finally { globalThis.fetch = originalFetch; }
});
