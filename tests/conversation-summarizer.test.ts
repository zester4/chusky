import test from "node:test";
import assert from "node:assert/strict";
import { summarizeConversation } from "../src/conversationSummarizer.js";

test("conversation summarizer uses the configured ScaleDown model and continuity prompt", async () => {
  const originalFetch = globalThis.fetch;
  let request: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "Objective\nKeep the migration moving.\n\nPending Work\nConfirm the cutover owner." } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const summary = await summarizeConversation({
      previousSummaries: ["Earlier decision: preserve the legacy renderer until September."],
      droppedMessages: [{ role: "user", content: "The migration must be ready by July 18." }],
      retainedMessages: [{ role: "assistant", content: "I still need the cutover owner." }],
    });
    assert.match(summary ?? "", /Objective/);
    assert.equal(request?.model, "scaledown/summarize");
    assert.equal(request?.max_tokens, 900);
    const messages = request?.messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0]?.role, "system");
    assert.match(messages[0]?.content ?? "", /verified outcomes/i);
    assert.match(messages[1]?.content ?? "", /July 18/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

