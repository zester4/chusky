import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { JevClient, setJevClientForTests } from "../src/decisions/jev.js";
import { decideAutonomySignal, decideAutonomyStep, decideFollowUp, decideMemoryDisposition, decideRecovery } from "../src/autonomy/decisionLoop.js";

const mutableConfig = config as unknown as Record<string, unknown>;

function withJev<T>(run: (calls: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const previous = { mode: mutableConfig.jevMode, surfaces: mutableConfig.jevSurfaces, key: mutableConfig.openRouterApiKey };
  const calls: Array<Record<string, unknown>> = [];
  mutableConfig.jevMode = "enforce";
  mutableConfig.jevSurfaces = new Set(["autonomy"]);
  mutableConfig.openRouterApiKey = "test-key";
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, { type: string; criteria?: Record<string, string> }> };
    calls.push(body as unknown as Record<string, unknown>);
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(body.questions ?? {})) {
      const criteria = question.criteria ?? {};
      const ids = Object.keys(criteria).filter((id) => id !== "__none__" && id !== "none");
      if (question.type === "choice") {
        const choice = key === "action" ? (ids.includes("replan") ? "replan" : ids[0] ?? "__none__")
          : key === "triage" ? "actionable"
            : key === "channel" ? "email"
              : key === "timing" ? "scheduled"
                : key === "message_type" ? "check_in"
                  : key === "disposition" ? "remember_until_review"
                    : key === "review" ? "thirty_days"
                      : key === "recovery" ? "switch_provider"
                        : ids[0] ?? "__none__";
        answers[key] = { type: "choice", choice, confidence: 0.93, probabilities: { [choice]: 0.93, __none__: 0.01 } };
      } else if (question.type === "score") {
        answers[key] = { type: "score", score: 2, confidence: 0.9, probabilities: { "2": 0.9 } };
      } else {
        answers[key] = { type: "noul", noul: 0.9 };
      }
    }
    return new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers, usage: { cost: 0.0001 } }), { status: 200 });
  }) as typeof fetch;
  setJevClientForTests(new JevClient({ provider: "openrouter", apiKey: "test-key", fetchImpl }));
  return run(calls).finally(() => {
    setJevClientForTests(undefined);
    mutableConfig.jevMode = previous.mode;
    mutableConfig.jevSurfaces = previous.surfaces;
    mutableConfig.openRouterApiKey = previous.key;
  });
}

test("turning Jev off preserves deterministic autonomy and makes no Jev request", async () => {
  const previous = { mode: mutableConfig.jevMode, surfaces: mutableConfig.jevSurfaces, key: mutableConfig.openRouterApiKey };
  let calls = 0;
  mutableConfig.jevMode = "off";
  mutableConfig.jevSurfaces = new Set(["autonomy"]);
  mutableConfig.openRouterApiKey = "test-key";
  setJevClientForTests(new JevClient({ apiKey: "test-key", fetchImpl: (async () => { calls += 1; return new Response("{}"); }) as typeof fetch }));
  const result = await decideAutonomyStep({
    objective: "Continue the mission",
    items: [{ kind: "mission", id: "mission-1", title: "Launch", status: "blocked", nextAction: "Replan the failed step" }],
    authority: { level: "execute_reversible" },
    allowedActions: ["replan", "ask_owner"],
  });
  assert.equal(result.source, "deterministic");
  assert.equal(result.proposedAction, "replan");
  assert.equal(calls, 0);
  setJevClientForTests(undefined);
  mutableConfig.jevMode = previous.mode;
  mutableConfig.jevSurfaces = previous.surfaces;
  mutableConfig.openRouterApiKey = previous.key;
});

test("shadow autonomy preserves the deterministic runtime path", async () => {
  const previous = { mode: mutableConfig.jevMode, surfaces: mutableConfig.jevSurfaces, key: mutableConfig.openRouterApiKey };
  let calls = 0;
  mutableConfig.jevMode = "shadow";
  mutableConfig.jevSurfaces = new Set(["autonomy"]);
  mutableConfig.openRouterApiKey = "test-key";
  setJevClientForTests(new JevClient({ apiKey: "test-key", fetchImpl: (async () => { calls += 1; return new Response("{}"); }) as typeof fetch }));
  const result = await decideAutonomyStep({
    objective: "Continue the mission",
    items: [{ kind: "mission", id: "mission-shadow", title: "Launch", status: "blocked", nextAction: "Replan the failed step" }],
    authority: { level: "execute_reversible" },
    allowedActions: ["replan", "ask_owner"],
  });
  assert.equal(result.source, "deterministic");
  assert.equal(result.proposedAction, "replan");
  assert.equal(calls, 0);
  setJevClientForTests(undefined);
  mutableConfig.jevMode = previous.mode;
  mutableConfig.jevSurfaces = previous.surfaces;
  mutableConfig.openRouterApiKey = previous.key;
});

test("Jev proposes a next step, but deterministic authority converts high-impact work to owner approval", async () => {
  await withJev(async (calls) => {
    const result = await decideAutonomyStep({
      objective: "Recover the customer mission",
      items: [{ kind: "mission", id: "mission-1", title: "Recover customer mission", status: "blocked", nextAction: "Replan the failed step" }],
      authority: { level: "execute_reversible", highImpact: true },
      allowedActions: ["replan", "ask_owner"],
    });
    assert.equal(result.source, "jev");
    assert.equal(result.proposedAction, "replan");
    assert.equal(result.effectiveAction, "ask_owner");
    assert.equal(result.requiresApproval, true);
    assert.equal(calls.length, 1);
  });
});

test("autonomy decision loop covers signal triage, follow-up, memory, and recovery proposals", async () => {
  await withJev(async () => {
    const signal = await decideAutonomySignal({ source: "gmail", kind: "message", summary: "A customer asked for a proposal" });
    assert.equal(signal.triage, "actionable");
    const followUp = await decideFollowUp({ summary: "Customer agreed to receive the proposal by email", hasAgreedNextStep: true, preferredChannel: "email", dueAt: "2026-10-01T09:00:00Z" });
    assert.deepEqual({ relevant: followUp.relevant, channel: followUp.channel, timing: followUp.timing }, { relevant: true, channel: "email", timing: "scheduled" });
    const memory = await decideMemoryDisposition({ key: "customer preference", value: "Prefers short email summaries" });
    assert.equal(memory.disposition, "remember_until_review");
    assert.equal(memory.reviewAtDays, 30);
    const recovery = await decideRecovery({ operation: "search provider", error: "Provider unavailable", retryable: false, providerAvailable: false });
    assert.equal(recovery.action, "switch_provider");
  });
});
