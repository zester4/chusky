import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { JevClient } from "../src/decisions/jev.js";
import { computeNativeToolRoute, nativeToolManifest, routeNativeToolsForTurn, searchComposioGatewayManifest, searchDiscoveredToolManifest, searchNativeToolManifest } from "../src/decisions/nativeToolRouter.js";

const mutableConfig = config as unknown as Record<string, unknown>;

function withConfig(overrides: Record<string, unknown>): () => void {
  const previous: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) { previous[key] = mutableConfig[key]; mutableConfig[key] = value; }
  return () => { for (const [key, value] of Object.entries(previous)) mutableConfig[key] = value; };
}

function tools(): any[] {
  return [
    { type: "function", function: { name: "CHUCK_FIND_TOOLS", description: "Find hidden tools", parameters: { type: "object", properties: {} } } },
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

function chooseNoTool(): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { questions: Record<string, any> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key,
      question.type === "choice"
        ? { type: "choice", choice: "__none__", confidence: 0.96, probabilities: Object.fromEntries(Object.keys(question.criteria).map((id) => [id, id === "__none__" ? 0.96 : 0.04 / Math.max(1, Object.keys(question.criteria).length - 1)])) }
        : { type: "noul", noul: 0.02 },
    ]));
    return new Response(JSON.stringify({ model: body, answers }), { status: 200 });
  }) as typeof fetch;
}

function chooseEveryTool(): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { questions: Record<string, any> };
    const question = body.questions.rank;
    const ids = Object.keys(question.criteria);
    const probabilities = Object.fromEntries(ids.map((id) => [id, id === "__none__" ? 0.01 : 0.99 / Math.max(1, ids.length - 1)]));
    const selected = ids.find((id) => id !== "__none__") ?? "__none__";
    return new Response(JSON.stringify({ model: body, answers: { rank: { type: "choice", choice: selected, confidence: 0.99, probabilities } } }), { status: 200 });
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

test("bundle loading exposes core plus the matched bundle instead of the full native catalog", async () => {
  const restore = withConfig({ nativeToolLoading: "bundle", jevNativeToolRouting: false });
  try {
    const route = await routeNativeToolsForTurn(tools(), "Create a PDF report");
    const names = route.tools.map((tool: any) => tool.function.name);
    assert.ok(names.includes("CHUCK_FIND_TOOLS"));
    assert.ok(names.includes("CHUCK_CREATE_PDF"));
    assert.ok(names.includes("CHUCK_TOOL_PREFLIGHT"));
    assert.ok(!names.includes("CHUCK_BROWSER"));
    assert.ok(route.tools.length < tools().length);
  } finally { restore(); }
});

test("an explicit Jev abstention creates a discovery-only native route", async () => {
  const restore = withConfig({ nativeToolLoading: "bundle", jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true });
  try {
    const route = await routeNativeToolsForTurn(tools(), "What is the best way to phrase this reply?", { client: new JevClient({ apiKey: "k", fetchImpl: chooseNoTool() }) });
    assert.equal(route.noNativeTool, true);
    assert.deepEqual(route.selected, ["CHUCK_FIND_TOOLS"]);
    assert.equal(route.tools.filter((tool: any) => tool.function.name.startsWith("CHUCK_")).length, 1);
  } finally { restore(); }
});

test("native tool discovery returns bounded searchable metadata", () => {
  const found = searchNativeToolManifest("make a spreadsheet", undefined, 3);
  assert.ok(found.length <= 3);
  assert.ok(found.some((item) => item.slug.includes("SPREADSHEET")));
  assert.ok(found.every((item) => !Object.hasOwn(item, "parameters")));
});

test("bundle mode fails closed when a Jev route would expose the full native catalog", async () => {
  const restore = withConfig({ nativeToolLoading: "bundle", jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true });
  try {
    const all = tools().map((tool: any) => ({
      ...tool,
      function: { ...tool.function, description: `${tool.function.description} PDF report` },
    }));
    const route = await routeNativeToolsForTurn(all, "Create a PDF report", { client: new JevClient({ apiKey: "k", fetchImpl: chooseEveryTool() }) });
    const nativeNames = new Set(nativeToolManifest.map((item) => item.slug));
    const exposedNative = route.tools.filter((tool: any) => nativeNames.has(tool.function.name)).length;
    const baselineNative = all.filter((tool: any) => nativeNames.has(tool.function.name)).length;
    assert.ok(exposedNative < baselineNative, "bundle mode must never expose the full native catalog");
  } finally { restore(); }
});

test("memory discovery returns the complete memory and scratchpad tool family", () => {
  const found = searchNativeToolManifest("everything about memory", "memory");
  const slugs = found.map((item) => item.slug);
  for (const slug of ["CHUCK_SEARCH_MEMORY", "CHUCK_SAVE_MEMORY", "CHUCK_UPDATE_MEMORY", "CHUCK_FORGET_MEMORY", "CHUCK_MEMORY_BRIEF", "CHUCK_CONTEXT_SEARCH", "CHUCK_SCRATCHPAD_READ", "CHUCK_SCRATCHPAD_WRITE"]) {
    assert.ok(slugs.includes(slug), `${slug} should be in the memory family`);
  }
  assert.ok(found.length > 5, "the default family result must not truncate useful memory tools");
});

test("natural TinyFish aliases return every TinyFish tool in one discovery", () => {
  const found = searchNativeToolManifest("find tiny fish tools");
  assert.deepEqual(found.map((item) => item.slug).sort(), [
    "CHUCK_TINYFISH_FETCH",
    "CHUCK_TINYFISH_MONITOR",
    "CHUCK_TINYFISH_RESEARCH",
    "CHUCK_TINYFISH_SEARCH",
  ]);
});

test("native discovery finds the primary tool across browser, meeting, artifact, and reminder requests", () => {
  const cases = [
    ["fill in a web form using the browser", "CHUCK_BROWSER"],
    ["prepare context for a Zoom meeting", "CHUCK_MEETING_CONTEXT_PREPARE"],
    ["create a PDF report", "CHUCK_CREATE_PDF"],
    ["remind me tomorrow", "CHUCK_SET_REMINDER"],
  ] as const;
  for (const [query, expectedSlug] of cases) {
    const found = searchNativeToolManifest(query);
    assert.equal(found[0]?.slug, expectedSlug, `${query} should rank ${expectedSlug} first`);
  }
});

test("native discovery routes durable lead-generation campaigns to their campaign controller", () => {
  const found = searchNativeToolManifest("Find 100 qualified leads and track the campaign");
  assert.equal(found[0]?.slug, "CHUCK_LEAD_CAMPAIGN");
});

test("connected-app discovery is not pushed out by native keyword matches", () => {
  const found = searchDiscoveredToolManifest("search Gmail for an email and send a reply");
  const slugs = found.map((item) => item.slug);
  assert.ok(slugs.includes("COMPOSIO_SEARCH_TOOLS"));
  assert.ok(slugs.includes("COMPOSIO_GET_TOOL_SCHEMAS"));
  assert.ok(slugs.includes("COMPOSIO_EXECUTE_TOOL"));
  assert.ok(found.length <= 20);
});

test("explicit browser, meeting, artifact, and reminder families exclude unrelated tool classes", () => {
  const browser = searchNativeToolManifest("fill a web form in the browser");
  assert.ok(browser.length > 0);
  assert.ok(browser.every((item) => /^(CHUCK_BROWSER(?:_|$)|CHUCK_VAULT_)/.test(item.slug)));

  const meetings = searchNativeToolManifest("prepare for a Zoom meeting");
  assert.ok(meetings.length > 0);
  assert.ok(meetings.every((item) => item.slug.startsWith("CHUCK_MEETING_") || ["CHUCK_START_PHONE_CALL", "CHUCK_LIST_PHONE_CALLS"].includes(item.slug)));

  const artifacts = searchNativeToolManifest("create a PDF report");
  assert.ok(artifacts.some((item) => item.slug === "CHUCK_CREATE_PDF"));
  assert.ok(artifacts.every((item) => !item.slug.startsWith("CHUCK_DAYTONA_") || item.slug === "CHUCK_DAYTONA_IMAGE"));

  const reminders = searchNativeToolManifest("reminder", "reminders");
  assert.ok(reminders.length > 0);
  assert.ok(reminders.every((item) => item.slug.includes("REMINDER")));
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

test("a fresh mission test retains creation despite an old mission ID and a no-duplicates instruction", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true, jevNativeToolMaxCandidates: 12, jevNativeToolMinConfidence: 0.5, jevNativeToolMinProbability: 0.1 });
  try {
    const missionTools = ["CHUCK_MISSION_START", "CHUCK_MISSION_LIST", "CHUCK_MISSION_GET", "CHUCK_MISSION_RESUME", "CHUCK_MISSION_VERIFY", "CHUCK_MISSION_COMPLETE"]
      .map((name) => ({ type: "function", function: { name, description: `${name.replaceAll("_", " ")} durable mission control`, parameters: { type: "object", properties: {} } } }));
    const route = await computeNativeToolRoute(`Run one real mission test with a maximum duration of 5 minutes.
Start a strict-verification mission titled "Mission Reliability Test".
After waking, continue the same mission ID and read the sheet again.
Do not create another mission, sheet, or duplicate rows.`, [...tools(), ...missionTools], {
      recentContext: "assistant: The original mission mis_previous remains blocked because its budget expired.",
      client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool("CHUCK_TASK_WAIT") }),
    });
    assert.equal(route.source, "jev");
    const names = route.tools.map((tool: any) => tool.function.name);
    for (const tool of missionTools) assert.ok(names.includes(tool.function.name), `${tool.function.name} must remain callable for the new mission`);
  } finally { restore(); }
});

test("native-only mission reliability prompts retain creation despite stale mission history", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true, jevNativeToolMaxCandidates: 12, jevNativeToolMinConfidence: 0.5, jevNativeToolMinProbability: 0.1 });
  try {
    const missionTools = ["CHUCK_MISSION_START", "CHUCK_MISSION_LIST", "CHUCK_MISSION_GET", "CHUCK_MISSION_RESUME", "CHUCK_MISSION_VERIFY", "CHUCK_MISSION_COMPLETE"]
      .map((name) => ({ type: "function", function: { name, description: `${name.replaceAll("_", " ")} durable mission control`, parameters: { type: "object", properties: {} } } }));
    const query = `No, I made an upgrade so run it again:

Run a strict native-only durable mission with exactly 3 sequential steps. Use no external providers, browser, Composio, or web tools.

Required evidence: mission ID and 3-step structure, a persisted pre-wait checkpoint, a real CHUCK_TASK_WAIT of at least 60 seconds, persisted post-wait checkpoint, and all 3 steps completed.`;
    const route = await computeNativeToolRoute(query, [...tools(), ...missionTools], {
      recentContext: "The previous mission mis_previous is blocked and must not be duplicated.",
      client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool("CHUCK_MISSION_START") }),
    });
    const names = route.tools.map((tool: any) => tool.function.name);
    assert.equal(route.source, "jev");
    assert.ok(names.includes("CHUCK_MISSION_START"), "the explicit fresh mission request must retain creation");
    for (const name of missionTools.map((tool) => tool.function.name)) assert.ok(names.includes(name), `${name} must remain callable for the new mission`);
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

test("current lifecycle intent takes precedence over stale history without widening the granted catalog", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["native"]), jevNativeToolRouting: true, jevNativeToolMaxCandidates: 12, jevNativeToolMinConfidence: 0.5, jevNativeToolMinProbability: 0.1 });
  try {
    const lifecycleTools = ["CHUCK_MISSION_START", "CHUCK_MISSION_RESUME", "CHUCK_TASK_CREATE", "CHUCK_TASK_GET"]
      .map((name) => ({ type: "function", function: { name, description: `${name.replaceAll("_", " ")} durable control`, parameters: { type: "object", properties: {} } } }));
    const cases = [
      { query: "Create a new durable task for the report", recentContext: "Existing task task_previous is blocked", create: "CHUCK_TASK_CREATE", expected: true },
      { query: "Resume the existing mission mis_previous. Do not start a new mission.", recentContext: "Start a new mission", create: "CHUCK_MISSION_START", expected: false },
      { query: "Continue the existing mission mis_previous. Don’t create another mission.", recentContext: "Start a fresh mission", create: "CHUCK_MISSION_START", expected: false },
      { query: "Continue task_previous. Never create a new task.", recentContext: "Create a new task", create: "CHUCK_TASK_CREATE", expected: false },
    ];
    for (const fixture of cases) {
      const route = await computeNativeToolRoute(fixture.query, [...tools(), ...lifecycleTools], {
        recentContext: fixture.recentContext,
        client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool(fixture.create) }),
      });
      assert.equal(route.source, "jev");
      assert.equal(route.tools.some((tool) => tool.function?.name === fixture.create), fixture.expected, fixture.query);
    }
    const granted = [...tools(), ...lifecycleTools.filter((tool) => tool.function.name !== "CHUCK_MISSION_START")];
    const route = await computeNativeToolRoute("Start a new mission", granted, { client: new JevClient({ apiKey: "k", fetchImpl: chooseRequestedTool("CHUCK_MISSION_RESUME") }) });
    assert.ok(!route.tools.some((tool) => tool.function?.name === "CHUCK_MISSION_START"), "routing must not add a tool absent from the granted catalog");
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

test("native discovery reveals only the allowed Composio gateway entries", () => {
  const results = searchComposioGatewayManifest("check Gmail and send the report", new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_EXECUTE_TOOL"]));
  assert.deepEqual(results.map((item) => item.slug), ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_EXECUTE_TOOL"]);
  assert.deepEqual(searchComposioGatewayManifest("tell me a joke", new Set(["COMPOSIO_SEARCH_TOOLS"])), []);
});
