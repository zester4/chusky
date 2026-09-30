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
    { type: "function", function: { name: "CHUCK_ATTENTION_STATE", description: "Read or explicitly update durable attention state and delivery preferences", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "CHUCK_CREATE_PDF", description: "Create a verified PDF report", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "CHUCK_BROWSER", description: "Browse a website, inspect pages, and fill forms", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "CHUCK_SEARCH_MEMORY", description: "Search the owner's saved memory", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "COMPOSIO_SEARCH_WEB", description: "Search the public web", parameters: { type: "object", properties: {} } } },
  ];
}

function chooseRequestedTool(requestedSlug = "CHUCK_CREATE_PDF"): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { questions: Record<string, any> };
    const question = body.questions.rank;
    const ids = Object.keys(question.criteria).filter((id) => id !== "__none__");
    const selected = ids.find((id) => id === requestedSlug) ?? ids[0];
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

test("enforce routing always retains attention state, even below the core-tool candidate budget", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true, jevNativeToolMaxCandidates: 4, jevNativeToolMinConfidence: 0.5, jevNativeToolMinProbability: 0.1 });
  try {
    const route = await computeNativeToolRoute("Create a PDF report", tools(), { client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool() }) });
    const names = route.tools.map((tool: any) => tool.function.name);
    assert.equal(route.source, "jev");
    assert.ok(names.includes("CHUCK_ATTENTION_STATE"));
    assert.equal(nativeToolManifest.find((item) => item.slug === "CHUCK_ATTENTION_STATE")?.alwaysAvailable, true);
  } finally { restore(); }
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

test("existing-mission recovery exposes lifecycle controls but suppresses mission creation even if Jev selects start", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true, jevNativeToolMaxCandidates: 12, jevNativeToolMinConfidence: 0.5, jevNativeToolMinProbability: 0.1 });
  try {
    const missionTools = [
      "CHUCK_MISSION_START", "CHUCK_MISSION_LIST", "CHUCK_MISSION_GET", "CHUCK_MISSION_PROOF",
      "CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_WAIT_EVENT", "CHUCK_MISSION_STEP_COMPLETE",
      "CHUCK_MISSION_REPLAN", "CHUCK_MISSION_PAUSE", "CHUCK_MISSION_RESUME",
      "CHUCK_MISSION_CANCEL", "CHUCK_MISSION_BLOCK", "CHUCK_MISSION_COMPLETE",
      "CHUCK_MISSION_EVIDENCE", "CHUCK_MISSION_VERIFY",
    ].map((name) => ({ type: "function", function: { name, description: `${name.replaceAll("_", " ")} durable mission control`, parameters: { type: "object", properties: {} } } }));
    const all = [...tools(), ...missionTools];
    const route = await computeNativeToolRoute("That mission is still open", all, {
      recentContext: "The running work item has id mis_abc and a saved checkpoint.",
      client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool("CHUCK_MISSION_START") }),
    });
    const names = route.tools.map((tool: any) => tool.function.name);
    assert.equal(route.source, "jev");
    for (const tool of missionTools.filter((tool) => tool.function.name !== "CHUCK_MISSION_START")) assert.ok(names.includes(tool.function.name), `${tool.function.name} must remain callable for recovery`);
    assert.ok(!names.includes("CHUCK_MISSION_START"), "a recovery request must not be able to create another mission");
    assert.ok(!names.includes("CHUCK_CREATE_PDF"));
  } finally { restore(); }
});

test("mission controls are not added to unrelated enforce-mode turns", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true, jevNativeToolMaxCandidates: 12, jevNativeToolMinConfidence: 0.5, jevNativeToolMinProbability: 0.1 });
  try {
    const missionTools = ["CHUCK_MISSION_START", "CHUCK_MISSION_RESUME"].map((name) => ({ type: "function", function: { name, description: `${name.replaceAll("_", " ")} durable mission control`, parameters: { type: "object", properties: {} } } }));
    const route = await computeNativeToolRoute("Create a PDF report", [...tools(), ...missionTools], { client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool() }) });
    const names = route.tools.map((tool: any) => tool.function.name);
    assert.ok(!names.includes("CHUCK_MISSION_START"));
    assert.ok(!names.includes("CHUCK_MISSION_RESUME"));
  } finally { restore(); }
});

test("existing-task recovery exposes task lifecycle controls and suppresses task creation", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true, jevNativeToolMaxCandidates: 12, jevNativeToolMinConfidence: 0.5, jevNativeToolMinProbability: 0.1 });
  try {
    const taskTools = ["CHUCK_TASK_CREATE", "CHUCK_TASK_LIST", "CHUCK_TASK_GET", "CHUCK_TASK_CHECKPOINT", "CHUCK_TASK_BLOCK", "CHUCK_TASK_COMPLETE", "CHUCK_TASK_CANCEL", "CHUCK_TASK_RETRY", "CHUCK_TASK_SCHEDULE", "CHUCK_TASK_WAIT"]
      .map((name) => ({ type: "function", function: { name, description: `${name.replaceAll("_", " ")} durable task control`, parameters: { type: "object", properties: {} } } }));
    const route = await computeNativeToolRoute("Continue the existing durable task task_123 from its checkpoint", [...tools(), ...taskTools], {
      client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool("CHUCK_TASK_CREATE") }),
    });
    const names = route.tools.map((tool: any) => tool.function.name);
    assert.ok(!names.includes("CHUCK_TASK_CREATE"), "recovery must not be routed to new-task creation");
    for (const tool of taskTools.filter((item) => item.function.name !== "CHUCK_TASK_CREATE")) assert.ok(names.includes(tool.function.name), `${tool.function.name} must remain available`);
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
