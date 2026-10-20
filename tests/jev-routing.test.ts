import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { JevClient, JevUnavailableError, NONE_OPTION, createRoutingDeadline, rankOptions, verifyCandidates, setJevClientForTests } from "../src/decisions/jev.js";
import { explicitlyNamedSkills, routeSkillsForTurn } from "../src/decisions/skillRouter.js";
import { clearComposioActionCache, composioDecisionContext, computeJevComposioDecision, routeComposioForTurn, toComposioAction, toComposioToolkitInfo, type ComposioAction, type ComposioToolkitInfo } from "../src/decisions/composioRouter.js";
import { computeTregTurnRoute, createTregEndpointJudge } from "../src/decisions/tregRouter.js";
import { computeTurnRoutingPlan } from "../src/decisions/turnRouter.js";
import { augmentNativeToolRoute, nativeToolManifest } from "../src/decisions/nativeToolRouter.js";
import { rankHits } from "../src/treg/gateway.js";
import { clearSkillCatalogCache } from "../src/skills/catalog.js";
import { recordRouteOutcome, resetJevRoutingStats, jevRoutingStats } from "../src/decisions/telemetry.js";
import type { TregEndpointHit } from "../src/treg/types.js";

const mutableConfig = config as unknown as Record<string, unknown>;

function withConfig(overrides: Record<string, unknown>): () => void {
  const previous: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) { previous[key] = mutableConfig[key]; mutableConfig[key] = value; }
  return () => { for (const [key, value] of Object.entries(previous)) mutableConfig[key] = value; };
}

const STOP = new Set(["the", "a", "an", "to", "and", "or", "of", "for", "my", "me", "in", "on", "with", "this", "that", "is", "it", "by", "from", "our", "your", "user", "user's", "app", "connected"]);
function words(value: unknown): Set<string> {
  const text = (typeof value === "string" ? value : JSON.stringify(value ?? "")).toLowerCase();
  return new Set(text.split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP.has(word)));
}
function overlap(a: Set<string>, b: Set<string>): number { let n = 0; for (const word of a) if (b.has(word)) n += 1; return n; }

type Captured = { url: string; body: Record<string, any> };

/** Deterministic stand-in for Jev: lexical overlap -> softmax. */
function fakeJev(captured: Captured[] = [], options: { delayMs?: number; status?: number; badChoice?: boolean; forceNone?: boolean } = {}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    captured.push({ url: String(url), body });
    if (options.delayMs) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, options.delayMs);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
    });
    if (options.forceNone) {
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries<any>(body.questions)) {
        answers[key] = question.type === "choice"
          ? { type: "choice", choice: "__none__", confidence: 0.97, probabilities: Object.fromEntries(Object.keys(question.criteria).map((id) => [id, id === "__none__" ? 0.97 : 0.03 / Math.max(1, Object.keys(question.criteria).length - 1)])) }
          : { type: "noul", noul: 0.02 };
      }
      return new Response(JSON.stringify({ model: body.model, answers }), { status: 200 });
    }
    if (options.status) return new Response("{}", { status: options.status });
    const stateWords = words(body.state?.request ?? body.state?.need ?? body.state);
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries<any>(body.questions)) {
      if (question.type === "choice") {
        const entries = Object.entries<string>(question.criteria);
        const scores = entries.map(([id, description]) => [id, id === "__none__" ? 0.5 : overlap(stateWords, words(`${id.replace(/_/g, " ")} ${description}`)) * 1.5] as const);
        const max = Math.max(...scores.map(([, s]) => s));
        const exp = scores.map(([id, s]) => [id, Math.exp(s - max)] as const);
        const total = exp.reduce((sum, [, e]) => sum + e, 0);
        const probabilities = Object.fromEntries(exp.map(([id, e]) => [id, e / total]));
        const [choice, p] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
        answers[key] = { type: "choice", choice: options.badChoice ? "not-an-option" : choice, confidence: p, probabilities };
      } else if (question.type === "noul") {
        const candidate = question.instructions?.candidate;
        const appRequest = /\b(?:gmail|slack|hubspot|notion|google calendar|shopify|zendesk|email|invoice|send|reply|post a message)\b/i.test(String(body.state?.request ?? ""));
        const hits = candidate ? overlap(stateWords, words(`${String(candidate.id).replace(/_/g, " ")} ${candidate.description}`)) : overlap(stateWords, words("email crm calendar invoice store ticket send reply"));
        answers[key] = { type: "noul", noul: hits >= 2 || appRequest ? 0.9 : hits === 1 ? 0.55 : 0.05 };
      } else {
        answers[key] = { type: "score", score: 0, confidence: 1, probabilities: { 0: 1 } };
      }
    }
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 100, cost: 0.000004 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("Jev client sends the OpenRouter decisions contract and validates answers", async () => {
  const captured: Captured[] = [];
  const client = new JevClient({ provider: "openrouter", apiKey: "test-key", fetchImpl: fakeJev(captured) });
  const result = await client.evaluate({ request: "send invoice reminder" }, {
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "invoice payment reminder", support: "bug ticket" } },
    urgent: { type: "noul", instructions: "Is it urgent?" },
  }, { sessionId: "run_1" });
  assert.equal(captured[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(captured[0].body.model, "typesafe/jev-1.14");
  assert.match(captured[0].body.session_id, /^[a-f0-9]{64}$/, "session id is hashed, never raw");
  assert.equal((result.answers.team as any).choice, "billing");
  assert.equal(result.costUsd, 0.000004);

  const typesafe: Captured[] = [];
  await new JevClient({ provider: "typesafe", apiKey: "k", fetchImpl: fakeJev(typesafe) }).evaluate("x", { q: { type: "noul", instructions: "?" } });
  assert.equal(typesafe[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(typesafe[0].body.model, "jev-1.14.0");
});

test("Jev coalesces independent same-turn routes and fans answers and cost back safely", async () => {
  const captured: Captured[] = [];
  const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) });
  const controller = new AbortController();
  const sessionId = "owner:run:one";
  const results = await Promise.all([
    client.evaluate({ request: "find interview schedule", recent_conversation: "interview tomorrow" }, { native: { type: "noul", instructions: "Need a native tool?" } }, { sessionId, signal: controller.signal }),
    client.evaluate({ request: "find interview schedule", connected_toolkits: ["googlecalendar"] }, { app: { type: "noul", instructions: "Need a connected app?" } }, { sessionId, signal: controller.signal }),
    client.evaluate({ request: "find interview schedule" }, { skill: { type: "choice", instructions: "Which skill?", criteria: { calendar: "calendar scheduling", [NONE_OPTION]: "none" } } }, { sessionId, signal: controller.signal }),
  ]);
  assert.equal(captured.length, 1, "independent routes in one turn share one provider round trip");
  assert.deepEqual(Object.keys(captured[0].body.questions).sort(), ["r0_native", "r1_app", "r2_skill"]);
  assert.deepEqual(results.map((result) => Object.keys(result.answers)), [["native"], ["app"], ["skill"]]);
  assert.ok(Math.abs(results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0) - 0.000004) < 1e-12, "allocated costs sum to provider cost");
  assert.equal(results[2].answers.skill?.type, "choice");
});

test("turn routing plan batches independent capability questions into one Jev request", async () => {
  const captured: Captured[] = [];
  const restore = withConfig({
    jevMode: "enforce",
    jevProvider: "openrouter",
    openRouterApiKey: "test-key",
    jevSurfaces: new Set(["skills", "composio", "treg", "monid", "native"]),
    jevNativeToolRouting: true,
    nativeToolLoading: "bundle",
    tregEnabled: true,
    monidEnabled: true,
  });
  try {
    const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) });
    const testManifest = [...nativeToolManifest.slice(0, 8), ...nativeToolManifest.filter((descriptor) => descriptor.bundle === "monid")];
    const availableTools = testManifest.map((descriptor) => ({ type: "function", function: { name: descriptor.slug, description: descriptor.description, parameters: { type: "object", properties: {} } } }));
    const plan = await computeTurnRoutingPlan({
      query: "Send an email and check live company information",
      recentContext: "The owner asked for a concise update.",
      skills: [
        { name: "email-workflow", description: "Prepare and send email messages through connected providers." },
        { name: "company-research", description: "Research companies and collect current firmographic evidence." },
        { name: "unrelated-cooking", description: "Recipes and meal planning." },
      ],
      nativeCandidates: testManifest,
      availableNativeTools: availableTools,
      connectedAccounts: [{ toolkit: "gmail", status: "ACTIVE" }, { toolkit: "slack", status: "ACTIVE" }],
      includeSkills: true,
      includeNative: true,
      includeComposio: true,
      includeTreg: true,
      includeMonid: true,
      sessionId: "turn-plan-test",
      client,
    });
    assert.equal(captured.length, 1, "all independent routing surfaces share one provider request");
    const questionKeys = Object.keys(captured[0].body.questions);
    assert.ok(questionKeys.includes("action_required"));
    assert.ok(questionKeys.some((key) => key.startsWith("skill_")));
    assert.ok(questionKeys.some((key) => key.startsWith("native_")));
    assert.ok(questionKeys.includes("composio_needs_app"));
    assert.ok(questionKeys.some((key) => key.startsWith("composio_toolkit_")));
    assert.ok(questionKeys.includes("treg_live_data"));
    assert.ok(questionKeys.includes("monid_needed"));
    assert.ok(questionKeys.some((key) => key.startsWith("monid_tool_")));
    assert.equal(plan.action.noActionNeeded, false);
    assert.ok(plan.skillRoute);
    assert.ok(plan.composioStage1);
    assert.ok(plan.tregRoute);
    assert.equal(plan.externalDataBackend?.selected, "treg");
    assert.equal(plan.monidRoute, undefined, "the shared backend arbiter must not select MonID alongside Treg");
    assert.ok(!plan.tregRoute || !plan.monidRoute?.selected.length, "overlapping live-data gateways are mutually exclusive");
    const augmented = augmentNativeToolRoute(availableTools, plan.nativeToolRoute!, []);
    assert.ok(augmented.selected.length > 0);
  } finally {
    restore();
  }
});

test("expanded routing vocabulary ranks natural-language skill matches before Jev", async () => {
  const captured: Captured[] = [];
  const restore = withConfig({
    jevMode: "enforce",
    jevProvider: "openrouter",
    openRouterApiKey: "test-key",
    jevSurfaces: new Set(["skills"]),
    jevTurnPlanMaxCandidates: 1,
  });
  try {
    const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) });
    await computeTurnRoutingPlan({
      query: "Please check my threads",
      forceCapability: true,
      skills: [
        { name: "calendar-workflow", description: "Manage calendar meetings and events." },
        { name: "mail-reader", description: "Read email from connected providers." },
      ],
      includeSkills: true,
      client,
      sessionId: "alias-routing-test",
    });
    const skillQuestions = Object.values(captured[0]?.body.questions ?? {}).filter((question: any) => question.type === "noul" && question.instructions?.candidate);
    assert.equal(skillQuestions.length, 1, "the configured pre-filter should send only its top skill candidate");
    assert.equal((skillQuestions[0] as any).instructions.candidate.id, "mail-reader", "thread language should match the email skill before Jev evaluates it");
  } finally {
    restore();
  }
});

test("explicit MonID requests win the shared external-data backend arbitration", async () => {
  const captured: Captured[] = [];
  const restore = withConfig({
    jevMode: "enforce",
    jevProvider: "openrouter",
    openRouterApiKey: "test-key",
    jevSurfaces: new Set(["monid"]),
    monidEnabled: true,
    tregEnabled: false,
  });
  try {
    const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) });
    const plan = await computeTurnRoutingPlan({
      query: "Use MonID to find local customer reviews",
      forceCapability: true,
      includeMonid: true,
      nativeCandidates: nativeToolManifest.filter((descriptor) => descriptor.bundle === "monid"),
      client,
      sessionId: "monid-backend-test",
    });
    assert.equal(captured.length, 1);
    assert.equal(plan.externalDataBackend?.selected, "monid");
    assert.equal(plan.externalDataBackend?.fallbackReason, undefined);
    assert.ok(plan.monidRoute?.selected.length, "an explicit MonID request should expose a relevant MonID capability");
  } finally {
    restore();
  }
});

test("batched Composio routing reuses stage one before exact action discovery", async () => {
  clearComposioActionCache();
  const captured: Captured[] = [];
  const restore = withConfig({
    jevMode: "enforce",
    jevProvider: "openrouter",
    openRouterApiKey: "test-key",
    jevSurfaces: new Set(["composio"]),
    jevMaxOptionsPerQuestion: 100,
  });
  try {
    const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) });
    const stage1 = await computeTurnRoutingPlan({
      query: "Send an email to Ama with subject pricing",
      connectedAccounts: [{ toolkit: "gmail", status: "ACTIVE" }],
      includeComposio: true,
      client,
      sessionId: "batched-composio-test",
    });
    assert.equal(captured.length, 1);
    assert.ok(stage1.composioStage1?.toolkits.some((toolkit) => toolkit.id === "gmail"));

    const decision = await routeComposioForTurn("Send an email to Ama with subject pricing", {
      accounts: [{ toolkit: "gmail", status: "ACTIVE" }],
      listActions: async () => gmailCatalogue().filter((action) => ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"].includes(action.slug)),
      client,
      stage1: stage1.composioStage1,
      sessionId: "batched-composio-test",
    });
    assert.equal(decision.actions[0]?.id, "GMAIL_SEND_EMAIL");
    const followUpQuestions = captured.slice(1).flatMap((request) => Object.keys(request.body.questions));
    assert.equal(captured.length, 2, "bounded exact-action routing combines ranking and independent verification in one dependent request");
    assert.ok(followUpQuestions.includes("rank"), "dependent routing must rank exact actions");
    assert.ok(followUpQuestions.some((key) => key.startsWith("verify_")), "dependent routing must independently verify exact actions");
    assert.ok(!followUpQuestions.some((key) => key.startsWith("composio_")), "stage-one app/toolkit routing is not repeated");
  } finally {
    restore();
    clearComposioActionCache();
  }
});

test("Jev never coalesces across turns or conflicting state", async () => {
  const captured: Captured[] = [];
  const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) });
  const controller = new AbortController();
  const question = { q: { type: "noul" as const, instructions: "Is this needed?" } };
  await Promise.all([
    client.evaluate({ request: "same", detail: "first" }, question, { sessionId: "run-a", signal: controller.signal }),
    client.evaluate({ request: "same", detail: "second" }, question, { sessionId: "run-a", signal: controller.signal }),
    client.evaluate({ request: "same" }, question, { sessionId: "run-b", signal: controller.signal }),
  ]);
  assert.equal(captured.length, 3, "conflicting states and different run IDs stay isolated");
});

test("Jev client rejects out-of-set choices and opens the circuit breaker", async () => {
  let now = 1_000;
  const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { badChoice: true }), breakerThreshold: 2, breakerCooldownMs: 5_000, now: () => now });
  const ask = () => client.evaluate("s", { q: { type: "choice", instructions: "?", criteria: { a: "a", b: "b" } } });
  await assert.rejects(ask(), (error: unknown) => error instanceof JevUnavailableError && error.reason === "invalid_response");
  await assert.rejects(ask(), JevUnavailableError);
  assert.equal(client.available(), false);
  await assert.rejects(ask(), (error: unknown) => error instanceof JevUnavailableError && error.reason === "circuit_open");
  now += 6_000;
  assert.equal(client.available(), true);
});

test("Jev client times out within its budget", async () => {
  const client = new JevClient({ apiKey: "k", timeoutMs: 30, fetchImpl: ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as unknown as typeof fetch });
  await assert.rejects(client.evaluate("s", { q: { type: "noul", instructions: "?" } }), (error: unknown) => error instanceof JevUnavailableError && error.reason === "timeout");
});

test("rankOptions runs a sharded tournament for large option sets", async () => {
  const captured: Captured[] = [];
  const restore = withConfig({ jevMaxRequestTokens: 6_000 });
  try {
    const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) });
    const options = Array.from({ length: 330 }, (_, index) => ({ id: `ACTION_${index}`, description: `generic operation number ${index}` }));
    options[287] = { id: "GMAIL_SEND_EMAIL", description: "Send an email message to a recipient with subject and body" };
    const result = await rankOptions(client, { state: { request: "send an email to Ama with the subject pricing" }, instructions: "Which action?", options, noneDescription: "none", maxPerQuestion: 100 });
    assert.equal(result.ranked[0].id, "GMAIL_SEND_EMAIL");
    assert.ok(result.calls >= 2, "shards plus a final round");
    for (const request of captured) {
      for (const question of Object.values<any>(request.body.questions)) {
        assert.ok(Object.keys(question.criteria).length <= 101, "each shard respects the per-question option cap");
        assert.ok(NONE_OPTION in question.criteria, "every choice carries an abstain option");
        assert.match(question.instructions, /functional fit, not keyword overlap/);
        assert.match(question.instructions, /do not infer connection, authorization, safety, or completion/);
      }
    }
  } finally { restore(); }
});

test("verifyCandidates returns independent multi-label scores", async () => {
  const captured: Captured[] = [];
  const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) });
  const { scores } = await verifyCandidates(client, {
    state: { request: "build a landing page and run an seo audit on it" },
    candidates: [
      { id: "frontend-design", description: "landing page ui design" },
      { id: "seo-audit", description: "seo audit search ranking" },
      { id: "cold-email", description: "outbound cold email sequence" },
    ],
    question: () => "Would it help?",
  });
  assert.ok(scores["frontend-design"] >= 0.5);
  assert.ok(scores["seo-audit"] >= 0.5);
  assert.ok(scores["cold-email"] < 0.5);
  const firstQuestion = Object.values<any>(captured[0]?.body.questions ?? {})[0];
  assert.match(firstQuestion.instructions.decision_rules, /Assess this candidate independently/);
  assert.match(firstQuestion.instructions.decision_rules, /does not establish availability, authorization, or successful execution/);
});

async function skillRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "chusky-jev-skills-"));
  const skills: Array<[string, string]> = [
    ["frontend-design", "Design and build a landing page or marketing website UI with strong layout and typography."],
    ["seo-audit", "Run an SEO audit: meta tags, search ranking factors, crawlability, and keywords for a website."],
    ["cold-email", "Write outbound cold email sequences for prospects."],
    ["billing-ops-pro", "Invoices, collections, subscription billing, and payment follow-up in Stripe."],
  ];
  for (const [name, description] of skills) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
  }
  return root;
}

test("enforce mode binds every verified skill for a multi-skill request", async () => {
  const root = await skillRoot();
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["skills"]) });
  clearSkillCatalogCache();
  try {
    const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev() });
    const route = await routeSkillsForTurn("Build a landing page website and run an SEO audit for search ranking", { root, client });
    assert.equal(route.source, "jev");
    const selected = [...route.binding.primary, ...route.binding.supporting];
    assert.ok(selected.includes("frontend-design"), `got ${selected}`);
    assert.ok(selected.includes("seo-audit"), `got ${selected}`);
    assert.ok(!selected.includes("cold-email"));
  } finally { restore(); clearSkillCatalogCache(); await rm(root, { recursive: true, force: true }); }
});

test("skill routing falls back to keywords on timeout and stays keyword-only in shadow mode", async () => {
  const root = await skillRoot();
  clearSkillCatalogCache();
  resetJevRoutingStats();
  let restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["skills"]) });
  try {
    const slow = new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { delayMs: 200 }) });
    const route = await routeSkillsForTurn("Review overdue Stripe billing", { root, client: slow, budgetMs: 40 });
    assert.equal(route.source, "keyword");
    assert.equal(route.fallbackReason, "timeout");
    assert.ok(route.binding.primary.includes("billing-ops-pro"));
  } finally { restore(); }
  restore = withConfig({ jevMode: "shadow", jevSurfaces: new Set(["skills"]) });
  try {
    const captured: Captured[] = [];
    const route = await routeSkillsForTurn("Review overdue Stripe billing", { root, client: new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) }) });
    assert.equal(route.source, "keyword", "shadow never changes behaviour");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(captured.length >= 1, "shadow still evaluates in the background");
    assert.ok((jevRoutingStats().skills?.decisions ?? 0) >= 1);
  } finally { restore(); clearSkillCatalogCache(); await rm(root, { recursive: true, force: true }); }
});

test("explicit skill invocations are honoured without treating common words as names", () => {
  const names = ["pdf", "media", "seo-audit", "cold-email"];
  assert.deepEqual(explicitlyNamedSkills("use the seo-audit skill on our site", names), ["seo-audit"]);
  assert.deepEqual(explicitlyNamedSkills("/cold-email for these leads", names), ["cold-email"]);
  assert.deepEqual(explicitlyNamedSkills("make a pdf for social media", names), []);
  assert.deepEqual(explicitlyNamedSkills("use the pdf skill", names), ["pdf"]);
});

function gmailCatalogue(): ComposioAction[] {
  const actions: ComposioAction[] = Array.from({ length: 260 }, (_, index) => ({ slug: `GMAIL_OPERATION_${index}`, name: `Operation ${index}`, description: `Generic mailbox maintenance operation ${index}`, toolkit: "gmail" }));
  actions.push({ slug: "GMAIL_SEND_EMAIL", name: "Send email", description: "Send an email message to a recipient with subject and body", toolkit: "gmail", inputParameters: { type: "object", properties: { recipient_email: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["recipient_email"] } });
  actions.push({ slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", description: "Search and fetch email messages in the inbox by query", toolkit: "gmail" });
  actions.push({ slug: "GMAIL_OLD_SEND", name: "Old send", description: "Send email message recipient subject body", toolkit: "gmail", deprecated: true });
  return actions;
}

test("Composio routing picks the connected toolkit, then the exact action from a large catalogue", async () => {
  clearComposioActionCache();
  const restore = withConfig({ jevMaxRequestTokens: 8_000, jevMaxOptionsPerQuestion: 100 });
  try {
    const captured: Captured[] = [];
    const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) });
    let listed = 0;
    const decision = await computeJevComposioDecision("Send an email to Ama with subject pricing and body hello", {
      accounts: [{ toolkit: "gmail", status: "ACTIVE" }, { toolkit: "hubspot", status: "ACTIVE" }, { toolkit: "slack", status: "EXPIRED" }],
      listActions: async () => { listed += 1; return gmailCatalogue(); },
      client,
    });
    assert.equal(decision.toolkits[0].id, "gmail");
    assert.equal(decision.actions[0].id, "GMAIL_SEND_EMAIL");
    assert.ok(!decision.actions.some((action) => action.id === "GMAIL_OLD_SEND"), "deprecated actions are never routed");
    assert.equal((decision.directTools[0] as any).function.name, "GMAIL_SEND_EMAIL");
    assert.equal((decision.directTools[0] as any).function.parameters.type, "object");
    const toolkitQuestion = captured.map((item) => item.body.questions.rank).find((question) => question && "gmail" in question.criteria);
    assert.ok(toolkitQuestion, "toolkits are ranked");
    assert.match(toolkitQuestion.criteria.gmail, /CONNECTED/);
    assert.ok(!("slack" in toolkitQuestion.criteria), "inactive connections are not offered as connected apps without the catalogue");
    assert.ok(!JSON.stringify(captured.map((item) => item.body)).includes("alias"), "account aliases never leave Chusky");
    const context = composioDecisionContext(decision);
    assert.match(context, /GMAIL_SEND_EMAIL \[gmail\].*loaded as a direct tool/);
    // Catalogue is cached per toolkit.
    await computeJevComposioDecision("Send an email to Kofi", { accounts: [{ toolkit: "gmail", status: "ACTIVE" }], listActions: async () => { listed += 1; return gmailCatalogue(); }, client });
    assert.equal(listed, 1);
  } finally { restore(); clearComposioActionCache(); }
});

test("Composio routing keeps the not-connected guard and falls back on failure", async () => {
  clearComposioActionCache();
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["composio"]) });
  try {
    const failing = new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { status: 503 }) });
    const fallback = await routeComposioForTurn("Review Shopify orders", { accounts: [{ toolkit: "hubspot", status: "ACTIVE" }], listActions: async () => [], client: failing });
    assert.equal(fallback.source, "keyword");
    assert.equal(fallback.route?.domain, "ecommerce");
    assert.equal(fallback.route?.needsConnection, true);
    assert.ok(fallback.fallbackReason);
  } finally { restore(); clearComposioActionCache(); }
});

test("raw Composio tools map to routing actions safely", () => {
  assert.equal(toComposioAction({ slug: "bad slug!", name: "x" }, "gmail"), undefined);
  const action = toComposioAction({ slug: "GMAIL_SEND_EMAIL", name: "Send", description: "Send\u0000 mail", toolkit: { slug: "gmail" }, inputParameters: { type: "object", properties: {} }, isDeprecated: false }, "gmail");
  assert.equal(action?.description, "Send mail");
  assert.equal(action?.toolkit, "gmail");
});

test("Treg endpoint judge reorders candidates by semantic fit without bypassing economics", async () => {
  const hits: TregEndpointHit[] = [
    { id: "people-bulk-job", title: "Bulk people enrichment job status", provider: "p1", category: "enrichment_person", priceUsd: 0.01, successRate: 0.99 },
    { id: "work-email-finder", title: "Find work email for a person by name and company domain", provider: "p2", category: "other", priceUsd: 0.02, successRate: 0.95, inputFields: ["full_name", "domain"] },
    { id: "expensive-email", title: "Find work email person name domain premium", provider: "p3", category: "other", priceUsd: 5, successRate: 0.99 },
  ];
  const keyword = rankHits(hits, "enrich_person", 0.5, ["full_name", "domain"]);
  assert.equal(keyword[0].id, "people-bulk-job", "baseline favours the keyword category match");
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["treg"]) });
  try {
    const judge = createTregEndpointJudge({ client: new JevClient({ apiKey: "k", fetchImpl: fakeJev() }) });
    const fit = await judge({ intent: "enrich_person", need: "find work email for Ama Mensah at acme.com domain person name", hits, availableFields: ["full_name", "domain"] });
    assert.ok(fit);
    const ranked = rankHits(hits, "enrich_person", 0.5, ["full_name", "domain"], fit);
    assert.equal(ranked[0].id, "work-email-finder");
    assert.notEqual(ranked[0].id, "expensive-email", "over-budget endpoints stay penalised");
    const failed = await createTregEndpointJudge({ client: new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { status: 500 }) }) })({ intent: "enrich_person", need: "x", hits });
    assert.equal(failed, undefined, "judge failure keeps deterministic ranking");
  } finally { restore(); }
});

test("a confident Treg __none__ keeps deterministic endpoint ranking and is not logged as applied", async () => {
  const hits: TregEndpointHit[] = [
    { id: "email-by-domain", title: "Find a work email by domain", provider: "p1", category: "other", priceUsd: 0.02, successRate: 0.9 },
    { id: "company-enrich", title: "Enrich a company profile", provider: "p2", category: "enrichment_company", priceUsd: 0.03, successRate: 0.9 },
  ];
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["treg"]) });
  resetJevRoutingStats();
  try {
    const fit = await createTregEndpointJudge({ client: new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { forceNone: true }) }) })({ intent: "enrich_person", need: "find a work email", hits });
    assert.equal(fit, undefined, "an explicit no-match must preserve the deterministic score path");
    assert.equal(jevRoutingStats().treg_endpoint?.applied, 0, "a no-match is a fallback, not an applied routing decision");
  } finally { restore(); resetJevRoutingStats(); }
});

test("a Treg turn-level __none__ is reported as a fallback, not an applied route", async () => {
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["treg"]), tregEnabled: true });
  resetJevRoutingStats();
  try {
    const route = await computeTregTurnRoute("Tell me a joke", { client: new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { forceNone: true }) }) });
    assert.equal(route.tool, undefined);
    assert.equal(route.fallbackReason, "jev_none");
    assert.equal(jevRoutingStats().treg_tool?.applied, 0);
  } finally { restore(); resetJevRoutingStats(); }
});

test("gateway route outcomes are tracked separately from Jev predictions", () => {
  resetJevRoutingStats();
  recordRouteOutcome({ surface: "treg", route: "CHUCK_TREG_SEARCH", outcome: "success", latencyMs: 42 });
  recordRouteOutcome({ surface: "treg", route: "CHUCK_TREG_SEARCH", outcome: "pending", latencyMs: 8 });
  recordRouteOutcome({ surface: "monid", route: "CHUCK_MONID_RUN", outcome: "failure", latencyMs: 17, errorClass: "MonidApiError" });
  assert.deepEqual(jevRoutingStats().treg_outcomes, {
    decisions: 2,
    applied: 1,
    fallbacks: 0,
    agreements: 0,
    comparisons: 0,
    latencyMsTotal: 50,
    costUsdTotal: 0,
    pending: 1,
    meanLatencyMs: 25,
  });
  assert.equal(jevRoutingStats().monid_outcomes?.fallbacks, 1);
  resetJevRoutingStats();
});

test("explicit Treg capability requests route deterministically before Jev", async () => {
  const captured: Captured[] = [];
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["treg"]), tregEnabled: true });
  resetJevRoutingStats();
  try {
    const route = await computeTregTurnRoute("Hey, tell me what you can do with Treg", { client: new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) }) });
    assert.deepEqual(route, { tool: "CHUCK_TREG_PLAN", probability: 1, needsLiveData: 0 });
    assert.equal(captured.length, 0, "the explicit product request must not wait for a second routing model");
    assert.equal(jevRoutingStats().treg_tool?.fallbacks, 1);
  } finally { restore(); resetJevRoutingStats(); }
});

test("routing is inert when JEV_MODE is off", async () => {
  const restore = withConfig({ jevMode: "off" });
  try {
    const captured: Captured[] = [];
    setJevClientForTests(new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) }));
    const decision = await routeComposioForTurn("Review Shopify orders", { accounts: [], listActions: async () => [] });
    assert.equal(decision.source, "keyword");
    assert.equal(captured.length, 0);
  } finally { restore(); setJevClientForTests(undefined); }
});

test("a confident skill __none__ stops keyword and fuzzy routing but honors explicit skill requests", async () => {
  const root = await skillRoot();
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["skills"]) });
  clearSkillCatalogCache();
  try {
    const captured: Captured[] = [];
    const route = await routeSkillsForTurn("Review overdue Stripe billing", { root, client: new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured, { forceNone: true }) }) });
    const selected = [...route.binding.primary, ...route.binding.supporting];
    assert.deepEqual(selected, [], "a confident none must not be overridden by deterministic keyword routing");
    assert.equal(route.allowSearchFallback, false, "a confident none must not invoke fuzzy discovery");
    assert.equal(captured.length, 1, "none returns before candidate verification");
    const explicit = await routeSkillsForTurn("use the seo-audit skill on this page", { root, client: new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { forceNone: true }) }) });
    assert.ok(explicit.binding.primary.includes("seo-audit"));
    assert.equal(explicit.allowSearchFallback, false, "an explicit skill selection disables fuzzy fallback");
  } finally { restore(); clearSkillCatalogCache(); await rm(root, { recursive: true, force: true }); }
});

test("a confident Composio no-app answer skips public catalogue discovery and keyword override", async () => {
  clearComposioActionCache();
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["composio"]) });
  try {
    let listed = 0;
    const decision = await routeComposioForTurn("Qualify the HubSpot pipeline", {
      accounts: [{ toolkit: "hubspot", status: "ACTIVE" }],
      listActions: async () => [],
      listToolkits: async () => { listed += 1; return TOOLKIT_CATALOGUE; },
      client: new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { forceNone: true }) }),
    });
    assert.equal(decision.noAppNeeded, true);
    assert.equal(decision.route, undefined, "a confident no-app result is not replaced by keyword routing");
    assert.equal(composioDecisionContext(decision), "");
    assert.equal(listed, 0, "the public toolkit catalogue is not loaded for no-app requests");
  } finally { restore(); clearComposioActionCache(); }
});

test("all routes share one per-turn deadline and run concurrently", async () => {
  const root = await skillRoot();
  clearSkillCatalogCache();
  clearComposioActionCache();
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["skills", "composio"]) });
  try {
    const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { delayMs: 400 }) });
    const deadline = createRoutingDeadline(120);
    const started = Date.now();
    const [skills, composio] = await Promise.all([
      routeSkillsForTurn("Review overdue Stripe billing", { root, client, deadline }),
      // Simulate the connected-account lookup running inside the same deadline.
      new Promise((resolve) => setTimeout(resolve, 60)).then(() => routeComposioForTurn("Review overdue Stripe billing", { accounts: [{ toolkit: "stripe", status: "ACTIVE" }], listActions: async () => [], client, deadline })),
    ]);
    const elapsed = Date.now() - started;
    deadline.dispose();
    assert.ok(elapsed < 250, `routing stayed within the shared deadline (${elapsed}ms)`);
    assert.equal(skills.source, "keyword");
    assert.equal(composio.source, "keyword");
    assert.equal(composio.route?.domain, "billing");
    assert.equal(client.available(), true, "deadline aborts do not open the circuit breaker");
  } finally { restore(); clearSkillCatalogCache(); clearComposioActionCache(); await rm(root, { recursive: true, force: true }); }
});

test("Treg judge scores task fit without preferring synchronous endpoints", async () => {
  const captured: Captured[] = [];
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["treg"]) });
  try {
    const hits: TregEndpointHit[] = [
      { id: "single-email", title: "Find one work email for a person", provider: "p1", category: "enrichment_person", priceUsd: 0.02 },
      { id: "bulk-email", title: "Bulk work email enrichment for a list of people batch", provider: "p2", category: "enrichment_person", priceUsd: 0.02 },
    ];
    const judge = createTregEndpointJudge({ client: new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) }) });
    const fit = await judge({ intent: "enrich_person", need: "bulk enrich work email for a list of 500 people batch", hits });
    const instructions = String(captured[0].body.questions.endpoint.instructions);
    assert.doesNotMatch(instructions, /single synchronous call/);
    assert.match(instructions, /synchronous, asynchronous, and bulk/);
    assert.match(captured[0].body.questions.endpoint.criteria["bulk-email"], /mode: bulk/);
    assert.ok(fit && fit["bulk-email"] > fit["single-email"], "a bulk need routes to the bulk endpoint");
  } finally { restore(); }
});

const TOOLKIT_CATALOGUE: ComposioToolkitInfo[] = [
  { slug: "gmail", name: "Gmail", description: "Send and read email messages", categories: ["communication"] },
  { slug: "slack", name: "Slack", description: "Post messages to Slack channels and direct messages", categories: ["communication"] },
  { slug: "hubspot", name: "HubSpot", description: "CRM contacts, deals, and pipeline", categories: ["crm"] },
  { slug: "notion", name: "Notion", description: "Pages, databases, and notes", categories: ["productivity"] },
];

function slackCatalogue(): ComposioAction[] {
  return [
    { slug: "SLACK_SEND_MESSAGE", name: "Send message", description: "Post a message to a Slack channel", toolkit: "slack", inputParameters: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } } } },
    { slug: "SLACK_LIST_CHANNELS", name: "List channels", description: "List workspace channels", toolkit: "slack" },
  ];
}

test("Composio routing reaches apps the user has not connected and asks to connect first", async () => {
  clearComposioActionCache();
  const restore = withConfig({ jevComposioRouteUnconnected: true });
  try {
    const captured: Captured[] = [];
    const decision = await computeJevComposioDecision("Post a message to the Slack sales channel about the launch", {
      accounts: [{ toolkit: "hubspot", status: "ACTIVE" }],
      listActions: async (toolkit) => toolkit === "slack" ? slackCatalogue() : [],
      listToolkits: async () => {
        assert.equal(captured.length, 1, "app-need triage must finish before public catalogue discovery starts");
        assert.ok(captured[0].body.questions.needs_app);
        return TOOLKIT_CATALOGUE;
      },
      client: new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) }),
    });
    assert.equal(decision.toolkits[0].id, "slack");
    assert.equal(decision.toolkits[0].connected, false);
    assert.deepEqual(decision.unconnectedToolkits, ["slack"]);
    assert.equal(decision.actions[0].id, "SLACK_SEND_MESSAGE");
    assert.equal(decision.actions[0].connected, false);
    assert.equal(decision.directTools.length, 0, "unconnected actions are never exposed as executable tools");
    const context = composioDecisionContext(decision);
    assert.match(context, /slack is not connected yet\. Call COMPOSIO_MANAGE_CONNECTIONS for slack/);
    assert.match(context, /SLACK_SEND_MESSAGE \[slack\].*app not connected; connect first/);
  } finally { restore(); clearComposioActionCache(); }
});

test("unconnected routing can be disabled and the catalogue is cached", async () => {
  clearComposioActionCache();
  let listed = 0;
  const listToolkits = async () => { listed += 1; return TOOLKIT_CATALOGUE; };
  let restore = withConfig({ jevComposioRouteUnconnected: false });
  try {
    const captured: Captured[] = [];
    await computeJevComposioDecision("Post a Slack message", { accounts: [{ toolkit: "hubspot", status: "ACTIVE" }], listActions: async () => [], listToolkits, client: new JevClient({ apiKey: "k", fetchImpl: fakeJev(captured) }) });
    assert.equal(listed, 0);
    const rank = captured.map((item) => item.body.questions.rank).find(Boolean);
    assert.deepEqual(Object.keys(rank.criteria).sort(), ["__none__", "hubspot"]);
  } finally { restore(); }
  restore = withConfig({ jevComposioRouteUnconnected: true });
  try {
    const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev() });
    await computeJevComposioDecision("Post a Slack message", { accounts: [], listActions: async () => [], listToolkits, client });
    await computeJevComposioDecision("Write a Notion page", { accounts: [], listActions: async () => [], listToolkits, client });
    assert.equal(listed, 1);
  } finally { restore(); clearComposioActionCache(); }
});

test("raw Composio toolkits map to catalogue entries safely", () => {
  assert.equal(toComposioToolkitInfo({ slug: "bad slug!" }), undefined);
  assert.deepEqual(toComposioToolkitInfo({ slug: "Gmail", name: "Gmail", meta: { description: "Mail\u0000 app", categories: [{ slug: "comm", name: "Communication" }] } }), { slug: "gmail", name: "Gmail", description: "Mail app", categories: ["Communication"] });
});
