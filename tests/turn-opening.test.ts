import test from "node:test";
import assert from "node:assert/strict";
import { needsTurnOpening, openingFallback, startTurnOpening } from "../src/turnOpening.js";

test("publishes intent while preparation is still pending and before execution", async () => {
  const order: string[] = [];
  let release!: () => void;
  const preparation = new Promise<void>((resolve) => { release = resolve; });
  const opening = startTurnOpening({ text: "Summarize my last email", deadlineMs: 100,
    generate: async () => ({ text: "I'll check your latest email and summarize its key points.", cost: 0.001 }),
    publish: (text) => { order.push(text); },
  });
  const execution = (async () => { await preparation; await opening.ready; order.push("tool"); })();
  await opening.ready;
  assert.equal(order.length, 1);
  assert.match(order[0], /latest email/);
  release();
  await execution;
  assert.equal(order[1], "tool");
  assert.equal(opening.cost, 0.001);
  opening.close();
});

test("a stuck model falls back once and ignores its late completion", async () => {
  const messages: string[] = [];
  let complete!: (value: { text: string }) => void;
  let modelSignal!: AbortSignal;
  const opening = startTurnOpening({ text: "Summarize my email", deadlineMs: 5,
    generate: (signal) => { modelSignal = signal; return new Promise((resolve) => { complete = resolve; }); },
    publish: (text) => { messages.push(text); },
  });
  await opening.ready;
  assert.equal(modelSignal.aborted, true);
  assert.deepEqual(messages, [openingFallback("Summarize my email")]);
  complete({ text: "I'll read the email now." });
  await Promise.resolve();
  assert.equal(messages.length, 1);
  opening.close();
});

test("cancellation during generation suppresses all subsequent output", async () => {
  const abort = new AbortController();
  const messages: string[] = [];
  const opening = startTurnOpening({ text: "Read my email", deadlineMs: 100,
    signal: abort.signal, generate: () => new Promise(() => {}),
    publish: (text) => { messages.push(text); },
  });
  abort.abort();
  await opening.ready;
  assert.deepEqual(messages, []);
});

test("closing on preparation failure releases the gate without a late reply", async () => {
  const opening = startTurnOpening({ text: "Inspect project", deadlineMs: 100,
    generate: () => new Promise(() => {}), publish: () => assert.fail("closed run must not publish"),
  });
  opening.close();
  await opening.ready;
});

test("model and delivery failures do not fail the actual work", async () => {
  const opening = startTurnOpening({ text: "Inspect my project", deadlineMs: 100,
    generate: async () => { throw new Error("provider unavailable"); },
    publish: () => { throw new Error("client disconnected"); },
  });
  await assert.doesNotReject(opening.ready);
  assert.equal(opening.text, undefined, "a failed delivery must not tell the main model an opening was displayed");
  opening.close();
});

test("cancellation aborts a stalled transport and releases execution", async () => {
  const abort = new AbortController();
  let deliverySignal: AbortSignal | undefined;
  let started!: () => void;
  const delivering = new Promise<void>((resolve) => { started = resolve; });
  const opening = startTurnOpening({ text: "Inspect project", deadlineMs: 100, signal: abort.signal,
    generate: async () => ({ text: "I'll inspect the project." }),
    publish: (_text, signal) => { deliverySignal = signal; started(); return new Promise(() => {}); },
  });
  await delivering;
  abort.abort();
  await opening.ready;
  assert.equal(deliverySignal?.aborted, true);
  assert.equal(opening.text, undefined);
});

test("unsafe or truncated model output uses the bounded local fallback", async () => {
  for (const text of ["<think>secret</think>", "Use COMPOSIO_SEARCH_TOOLS.", "I'll read your", "https://private.invalid/path.", "a".repeat(401)]) {
    const messages: string[] = [];
    const opening = startTurnOpening({ text: "Summarize document", deadlineMs: 100,
      generate: async () => ({ text }), publish: (value) => { messages.push(value); },
    });
    await opening.ready;
    assert.deepEqual(messages, [openingFallback("Summarize document")]);
    opening.close();
  }
});

test("simultaneous owners keep their responses and cancellation isolated", async () => {
  const a: string[] = [], b: string[] = [];
  const first = startTurnOpening({ text: "Email", deadlineMs: 100, generate: () => new Promise(() => {}), publish: (text) => { a.push(text); } });
  const second = startTurnOpening({ text: "Project", deadlineMs: 100, generate: async () => ({ text: "I'll inspect the project." }), publish: (text) => { b.push(text); } });
  first.close();
  await Promise.all([first.ready, second.ready]);
  assert.deepEqual(a, []);
  assert.deepEqual(b, ["I'll inspect the project."]);
  second.close();
});

test("greetings and short confirmations do not pay for an extra model call", () => {
  for (const text of ["Hey!", "Thanks", "ok", "yes", "Well done", "Great job!", "That's great", ""]) assert.equal(needsTurnOpening(text), false);
  assert.equal(needsTurnOpening("Thanks, can you summarize my last email?"), true);
  assert.equal(needsTurnOpening("Hey, summarize my last email"), true);
});

test("fallbacks stay truthful with neutral copy instead of pretending to know the request", () => {
  const fallback = "Just a moment — I’m working through that.";
  for (const text of ["What do you suggest I do tomorrow?", "Draft a reply to this email", "What about that?", "Help me plan a launch"]) {
    assert.equal(openingFallback(text), fallback);
  }
});
