import test from "node:test";
import assert from "node:assert/strict";
import { isClearlyConversational } from "../src/decisions/actionGate.js";
import { config } from "../src/config.js";
import { computeNativeToolRoute, routeNativeToolsForTurn, type NativeToolRoute } from "../src/decisions/nativeToolRouter.js";
import { JevClient } from "../src/decisions/jev.js";

const mutableConfig = config as unknown as Record<string, unknown>;
function withConfig(overrides: Record<string, unknown>): () => void {
  const previous: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) { previous[key] = mutableConfig[key]; mutableConfig[key] = value; }
  return () => { for (const [key, value] of Object.entries(previous)) mutableConfig[key] = value; };
}

const tools = [
  "CHUCK_FIND_TOOLS", "CHUCK_MEMORY_BRIEF", "CHUCK_TASK_CREATE", "CHUCK_GENERATE_IMAGE",
].map((name) => ({ type: "function", function: { name, description: name.replaceAll("_", " "), parameters: { type: "object", properties: {} } } }));

test("only explicit pleasantries enter the clearly conversational gate", () => {
  const chat = ["hey", "thanks!", "good morning", "how are you", "lol", "okay"];
  const action = ["any new emails?", "show my tasks", "yes do it", "continue", "approve", "what's the weather in Accra", "who is the CEO of Stripe", "text John I'm late"];
  assert.ok(chat.every((message) => isClearlyConversational(message)), "pleasantries should remain compact candidates");
  assert.ok(action.every((message) => !isClearlyConversational(message)), "action and knowledge requests must not be compact candidates");
  assert.equal(isClearlyConversational("thanks", "assistant: I sent the email"), false, "follow-up context keeps capability available");
});

test("Jev none is native-only and carries a confidence, without hiding connected tools", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true, nativeToolLoading: "bundle" });
  try {
    const route = await computeNativeToolRoute("hey", tools, {
      client: new JevClient({ apiKey: "k", fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const answers = Object.fromEntries(Object.entries<any>(body.questions).map(([key, question]) => [key, question.type === "choice"
          ? { type: "choice", choice: "__none__", confidence: 0.96, probabilities: { __none__: 0.96 }
          } : { type: "noul", noul: 0.01 }]));
        return new Response(JSON.stringify({ model: body.model, answers }), { status: 200 });
      } }),
    });
    assert.equal(route.noNativeTool, true);
    assert.ok((route.noNativeToolConfidence ?? 0) >= 0.85);
  } finally { restore(); }
});

test("Jev unavailability never marks a route as no native tool", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true, nativeToolLoading: "bundle" });
  try {
    const route: NativeToolRoute = await routeNativeToolsForTurn(tools, "show my tasks", {
      client: new JevClient({ apiKey: "k", fetchImpl: async () => new Response("{}", { status: 503 }) }),
    });
    assert.equal(isClearlyConversational("show my tasks"), false);
    assert.equal(isClearlyConversational("show my tasks") && route.noNativeTool === true, false, "a fallback on an action request cannot enter the compact path");
  } finally { restore(); }
});
