import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { JevClient } from "../src/decisions/jev.js";
import { computeNativeToolRoute, nativeToolManifest, routeNativeToolsForTurn } from "../src/decisions/nativeToolRouter.js";

const mutableConfig = config as unknown as Record<string, unknown>;

function withConfig(overrides: Record<string, unknown>): () => void {
  const previous: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) { previous[key] = mutableConfig[key]; mutableConfig[key] = value; }
  return () => { for (const [key, value] of Object.entries(previous)) mutableConfig[key] = value; };
}

function tools(): any[] {
  return [
    { type: "function", function: { name: "CHUCK_TOOL_PREFLIGHT", description: "Check the next tool call before execution", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "CHUCK_CREATE_PDF", description: "Create a verified PDF report", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "CHUCK_BROWSER", description: "Browse a website, inspect pages, and fill forms", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "CHUCK_SEARCH_MEMORY", description: "Search the owner's saved memory", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "COMPOSIO_SEARCH_WEB", description: "Search the public web", parameters: { type: "object", properties: {} } } },
  ];
}

function chooseRequestedTool(): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { questions: Record<string, any> };
    const question = body.questions.rank;
    const ids = Object.keys(question.criteria).filter((id) => id !== "__none__");
    const selected = ids.find((id) => id === "CHUCK_CREATE_PDF") ?? ids[0];
    const probabilities = Object.fromEntries(Object.keys(question.criteria).map((id) => [id, id === selected ? 0.86 : id === "__none__" ? 0.01 : 0.13 / Math.max(1, ids.length - 1)]));
    return new Response(JSON.stringify({ model: body, answers: { rank: { type: "choice", choice: selected, confidence: 0.86, probabilities } } }), { status: 200 });
  }) as typeof fetch;
}

test("native routing is inert when Jev native routing is disabled", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: false });
  try {
    const all = tools();
    const route = await routeNativeToolsForTurn(all, "Create a PDF report", { client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool() }) });
    assert.equal(route.source, "fallback");
    assert.equal(route.tools, all);
  } finally { restore(); }
});

test("Link outcome reporting is published to native routing as a shopping write tool", () => {
  const descriptor = nativeToolManifest.find((item) => item.slug === "CHUCK_LINK_REPORT_OUTCOME");
  assert.ok(descriptor);
  assert.equal(descriptor.bundle, "shopping");
  assert.equal(descriptor.risk, "write");
  assert.equal(descriptor.alwaysAvailable, false);
});

test("enforce mode exposes only Jev-selected native schemas and preserves non-native tools", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true, jevNativeToolMaxCandidates: 8, jevNativeToolMinConfidence: 0.5, jevNativeToolMinProbability: 0.1 });
  try {
    const route = await computeNativeToolRoute("Create a PDF report", tools(), { client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool() }) });
    const names = route.tools.map((tool: any) => tool.function.name);
    assert.equal(route.source, "jev");
    assert.ok(names.includes("CHUCK_CREATE_PDF"));
    assert.ok(names.includes("COMPOSIO_SEARCH_WEB"));
    assert.ok(!names.includes("CHUCK_BROWSER"));
    assert.ok(!names.includes("CHUCK_SEARCH_MEMORY"));
  } finally { restore(); }
});

test("shadow mode evaluates native routing without changing the catalog", async () => {
  const restore = withConfig({ jevMode: "shadow", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true });
  try {
    const all = tools();
    const route = await routeNativeToolsForTurn(all, "Create a PDF report", { client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool() }) });
    assert.equal(route.source, "fallback");
    assert.equal(route.tools, all);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { restore(); }
});

test("native routing falls back when no request signal matches the local catalog", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true });
  try {
    const all = tools();
    const route = await computeNativeToolRoute("Tell me a joke", all, { client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool() }) });
    assert.equal(route.source, "fallback");
    assert.equal(route.tools, all);
    assert.equal(route.fallbackReason, "no_native_candidate_set");
  } finally { restore(); }
});
