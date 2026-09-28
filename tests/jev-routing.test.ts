import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { JevClient, JevUnavailableError, NONE_OPTION, createRoutingDeadline, rankOptions, verifyCandidates, setJevClientForTests } from "../src/decisions/jev.js";
import { explicitlyNamedSkills, routeSkillsForTurn } from "../src/decisions/skillRouter.js";
import { clearComposioActionCache, composioDecisionContext, computeJevComposioDecision, routeComposioForTurn, toComposioAction, type ComposioAction } from "../src/decisions/composioRouter.js";
import { createTregEndpointJudge } from "../src/decisions/tregRouter.js";
import { rankHits } from "../src/treg/gateway.js";
import { clearSkillCatalogCache } from "../src/skills/catalog.js";
import { resetJevRoutingStats, jevRoutingStats } from "../src/decisions/telemetry.js";
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
        const hits = candidate ? overlap(stateWords, words(`${String(candidate.id).replace(/_/g, " ")} ${candidate.description}`)) : overlap(stateWords, words("email crm calendar invoice store ticket send reply"));
        answers[key] = { type: "noul", noul: hits >= 2 ? 0.9 : hits === 1 ? 0.55 : 0.05 };
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
  assert.equal(captured[0].body.model, "typesafe/jev-1.13");
  assert.match(captured[0].body.session_id, /^[a-f0-9]{64}$/, "session id is hashed, never raw");
  assert.equal((result.answers.team as any).choice, "billing");
  assert.equal(result.costUsd, 0.000004);

  const typesafe: Captured[] = [];
  await new JevClient({ provider: "typesafe", apiKey: "k", fetchImpl: fakeJev(typesafe) }).evaluate("x", { q: { type: "noul", instructions: "?" } });
  assert.equal(typesafe[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(typesafe[0].body.model, "jev-1.13.0");
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
      }
    }
  } finally { restore(); }
});

test("verifyCandidates returns independent multi-label scores", async () => {
  const client = new JevClient({ apiKey: "k", fetchImpl: fakeJev() });
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
    const toolkitQuestion = captured[0].body.questions.toolkit;
    assert.ok(!("slack" in toolkitQuestion.criteria), "inactive connections are not offered");
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

test("a confident __none__ never removes keyword skill routes or search fallback", async () => {
  const root = await skillRoot();
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["skills"]) });
  clearSkillCatalogCache();
  try {
    const route = await routeSkillsForTurn("Review overdue Stripe billing", { root, client: new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { forceNone: true }) }) });
    const selected = [...route.binding.primary, ...route.binding.supporting];
    assert.ok(selected.includes("billing-ops-pro"), `keyword route kept, got ${selected}`);
    assert.equal(route.allowSearchFallback, true, "fuzzy search fallback stays available");
    const explicit = await routeSkillsForTurn("use the seo-audit skill on this page", { root, client: new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { forceNone: true }) }) });
    assert.ok(explicit.binding.primary.includes("seo-audit"));
    assert.equal(explicit.allowSearchFallback, false, "an explicit skill selection disables fuzzy fallback");
  } finally { restore(); clearSkillCatalogCache(); await rm(root, { recursive: true, force: true }); }
});

test("a confident no-app answer keeps the keyword Composio domain route", async () => {
  clearComposioActionCache();
  const restore = withConfig({ jevMode: "enforce", jevSurfaces: new Set(["composio"]) });
  try {
    const decision = await routeComposioForTurn("Qualify the HubSpot pipeline", { accounts: [{ toolkit: "hubspot", status: "ACTIVE" }], listActions: async () => [], client: new JevClient({ apiKey: "k", fetchImpl: fakeJev([], { forceNone: true }) }) });
    assert.equal(decision.route?.domain, "crm");
    assert.deepEqual(decision.route?.connectedToolkits, ["hubspot"]);
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
