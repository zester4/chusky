import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { JevClient } from "../src/decisions/jev.js";
import { buildAutonomyDecisionContext } from "../src/autonomy/decisionContext.js";
import { routeProactiveWork } from "../src/autonomy/proactiveRouter.js";

const mutableConfig = config as unknown as Record<string, unknown>;

function withConfig(overrides: Record<string, unknown>): () => void {
  const previous: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = mutableConfig[key];
    mutableConfig[key] = value;
  }
  return () => { for (const [key, value] of Object.entries(previous)) mutableConfig[key] = value; };
}

function fakeJev(): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, { type: string; criteria?: Record<string, string> }> };
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(body.questions ?? {})) {
      if (question.type === "choice") {
        const entries = Object.entries(question.criteria ?? {});
        const preferred = entries.find(([id, description]) => /GMAIL_SEND_EMAIL|gmail|email|communication/i.test(`${id} ${description}`));
        const choice = preferred?.[0] ?? entries.find(([id]) => id !== "__none__")?.[0] ?? "__none__";
        answers[key] = { type: "choice", choice, confidence: 0.96, probabilities: { [choice]: 0.96 } };
      } else if (question.type === "noul") {
        answers[key] = { type: "noul", noul: 0.96 };
      } else {
        answers[key] = { type: "score", score: 0, confidence: 0.96, probabilities: { "0": 1 } };
      }
    }
    return new Response(JSON.stringify({ model: "test-jev", answers }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("autonomy decision context is bounded and marks records as untrusted", () => {
  const context = buildAutonomyDecisionContext({
    now: Date.UTC(2026, 8, 28),
    loops: [{ id: "loop-1", userId: 1, title: "Follow up", objective: "Reply", priority: 1, confidence: 1, status: "open", nextAction: "Send the approved email", createdAt: 1, updatedAt: 1 }],
    orders: [{ id: "order-1", userId: 1, name: "Routine follow-up", instruction: "Send approved follow-ups", scope: ["gmail"], authority: "execute_reversible", status: "active", createdAt: 1, updatedAt: 1 }],
  });
  assert.equal(context.trigger, "attention_pulse");
  assert.match(context.constraints[0]!, /untrusted/i);
  assert.equal(JSON.stringify(context).includes("password"), false);
  assert.match(context.objective, /Send the approved email/);
});

test("proactive routing gives a connected exact action to the owning worker", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["composio"]), jevTurnBudgetMs: 1_000 });
  try {
    const context = buildAutonomyDecisionContext({
      now: Date.now(),
      loops: [{ id: "loop-1", userId: 1, title: "Reply to prospect", objective: "Send approved email", priority: 1, confidence: 1, status: "open", nextAction: "Send the approved email", createdAt: 1, updatedAt: 1 }],
      orders: [{ id: "order-1", userId: 1, name: "Email follow-ups", instruction: "Send approved follow-ups", scope: ["gmail"], authority: "execute_reversible", status: "active", createdAt: 1, updatedAt: 1 }],
    });
    const route = await routeProactiveWork("Send an approved email follow-up", context, {
      accounts: [{ toolkit: "gmail", status: "ACTIVE" }],
      listActions: async () => [{ slug: "GMAIL_SEND_EMAIL", name: "Send email", description: "Send an email message to a recipient", toolkit: "gmail", inputParameters: { type: "object", properties: { recipient_email: { type: "string" }, body: { type: "string" } }, required: ["recipient_email"] } }],
      listToolkits: async () => [],
      client: new JevClient({ apiKey: "test-key", fetchImpl: fakeJev() }),
    });
    assert.equal(route.worker, "ivy");
    assert.deepEqual(route.allowedComposioTools, ["GMAIL_SEND_EMAIL"]);
    assert.equal(route.approvalPolicy, "auto");
    assert.match(route.composioContext, /GMAIL_SEND_EMAIL/);
  } finally { restore(); }
});
