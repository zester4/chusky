import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { routeBrowserNext } from "../src/decisions/browserRouter.js";
import { JevClient } from "../src/decisions/jev.js";
import { buildBrowserCandidates, browserObservationState, redactBrowserText, type BrowserObservation } from "../src/vault/browserObservation.js";

const mutableConfig = config as unknown as Record<string, unknown>;

function withConfig(overrides: Record<string, unknown>): () => void {
  const previous: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) { previous[key] = mutableConfig[key]; mutableConfig[key] = value; }
  return () => { for (const [key, value] of Object.entries(previous)) mutableConfig[key] = value; };
}

function fakeJev(fetchCalls: Array<Record<string, unknown>>): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    fetchCalls.push(body);
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries<any>(body.questions ?? {})) {
      const first = Object.keys(question.criteria).find((id) => id !== "__none__") ?? "__none__";
      const ids = Object.keys(question.criteria);
      answers[key] = { type: "choice", choice: first, confidence: 0.92, probabilities: Object.fromEntries(ids.map((id) => [id, id === first ? 0.92 : 0.08 / Math.max(1, ids.length - 1)])) };
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 100, cost: 0.000001 } }), { status: 200 });
  }) as typeof fetch;
}

const accessibility = {
  root: {
    role: "main",
    children: [
      { role: "button", name: "Search invoices", nodeId: "real-node-1" },
      { role: "textbox", name: "Email address", nodeId: "real-node-2", value: "person@example.com" },
      { role: "button", name: "Enter password", nodeId: "secret-node", disabled: false },
    ],
  },
};

test("browser observation redacts private values and never sends node IDs to Jev", () => {
  const observation = buildBrowserCandidates({ accessibility, goal: "Search the invoices", currentUrl: "https://billing.example.com/invoices?email=person@example.com", title: "Invoices for person@example.com" });
  assert.doesNotMatch(JSON.stringify(browserObservationState(observation)), /real-node|secret-node|person@example\.com/);
  assert.match(redactBrowserText("Call +1 (555) 555-1234 or email person@example.com, token 123456789"), /\[phone\]/);
  assert.doesNotMatch(JSON.stringify(observation.candidates), /Enter password/);
  assert.equal(observation.candidates.some((candidate) => candidate.id === "c_0"), true);
});

test("browser Jev routing is disabled without changing deterministic behavior", async () => {
  const observation = buildBrowserCandidates({ accessibility, goal: "Search the invoices", currentUrl: "https://billing.example.com/invoices" });
  const restore = withConfig({ jevMode: "off", jevSurfaces: new Set(["browser"]), openRouterApiKey: "test-key" });
  try {
    const decision = await routeBrowserNext({ observation, client: new JevClient({ apiKey: "test-key", fetchImpl: async () => { throw new Error("must not call Jev"); } }) });
    assert.equal(decision.source, "deterministic");
    assert.equal(decision.mode, "off");
    assert.equal(decision.candidate?.kind, "reinspect");
  } finally { restore(); }
});

test("shadow mode observes Jev but keeps deterministic browser selection", async () => {
  const observation = buildBrowserCandidates({ accessibility, goal: "Search the invoices", currentUrl: "https://billing.example.com/invoices" });
  const calls: Array<Record<string, unknown>> = [];
  const restore = withConfig({ jevMode: "shadow", jevSurfaces: new Set(["browser"]), openRouterApiKey: "test-key", jevMinConfidence: 0.45 });
  try {
    const decision = await routeBrowserNext({ observation, client: new JevClient({ apiKey: "test-key", fetchImpl: fakeJev(calls) }) });
    assert.equal(calls.length, 1);
    assert.equal(decision.source, "deterministic");
    assert.equal(decision.candidate?.kind, "reinspect");
  } finally { restore(); }
});

test("enforce mode selects only an inspected candidate and never authorizes a high-impact action", async () => {
  const safe = buildBrowserCandidates({ accessibility, goal: "Search the invoices", currentUrl: "https://billing.example.com/invoices" });
  const calls: Array<Record<string, unknown>> = [];
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["browser"]), openRouterApiKey: "test-key", jevMinConfidence: 0.45 });
  try {
    const selected = await routeBrowserNext({ observation: safe, client: new JevClient({ apiKey: "test-key", fetchImpl: fakeJev(calls) }) });
    assert.equal(selected.source, "jev");
    assert.equal(selected.candidate?.id, safe.candidates[0]?.id);
    assert.equal(selected.candidate?.nodeId, "real-node-1");

    const dangerous: BrowserObservation = {
      goal: "Place the order",
      origin: "https://shop.example.com",
      candidates: [
        { id: "c_danger", kind: "invoke", role: "button", name: "Place order", nodeId: "order-node", action: "place_order", risk: "high", description: "invoke button 'Place order'", requiresApproval: true, execution: { action: "invoke", nodeId: "order-node" } },
        { id: "c_safe", kind: "reinspect", action: "browse", risk: "low", description: "Re-inspect the current page", requiresApproval: false, execution: { action: "state" } },
      ],
    };
    const guarded = await routeBrowserNext({ observation: dangerous, client: new JevClient({ apiKey: "test-key", fetchImpl: fakeJev() }) });
    assert.equal(guarded.source, "deterministic");
    assert.equal(guarded.candidate?.id, "c_safe");
    assert.match(guarded.fallbackReason ?? "", /approval|unavailable|network/i);
  } finally { restore(); }
});
