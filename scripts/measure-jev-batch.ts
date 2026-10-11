import { config } from "../src/config.js";
import { JevClient, type JevQuestion } from "../src/decisions/jev.js";

const key = config.jevProvider === "typesafe" ? config.jevApiKey : config.openRouterApiKey;
if (!key) throw new Error("No Jev API key is configured");

const request = "Find the official TinyFish Research API documentation and summarize its current capabilities.";
const routes: Array<{ name: string; state: Record<string, unknown>; questions: Record<string, JevQuestion> }> = [
  { name: "native", state: { request }, questions: { native: { type: "choice", instructions: "Which native capability is needed?", criteria: { CHUCK_TINYFISH_RESEARCH: "Run cited multi-source research.", __none__: "No native tool is needed." } } } },
  { name: "skill", state: { request, recent_conversation: "" }, questions: { skill: { type: "choice", instructions: "Which installed skill is relevant?", criteria: { research: "Research and cite multiple sources.", __none__: "No skill applies." } } } },
  { name: "composio", state: { request, connected_toolkits: [] }, questions: { app: { type: "noul", instructions: "Does this task require a connected third-party app?", criteria: { true: "Yes, a connected app is needed.", false: "No connected app is needed." } } } },
  { name: "treg", state: { request }, questions: { research: { type: "choice", instructions: "Which live-data tool should be used?", criteria: { CHUCK_TINYFISH_RESEARCH: "Research current web sources.", __none__: "No live external data is needed." } } } },
];

async function measure(label: string, batched: boolean): Promise<void> {
  // Give both paths a generous benchmark timeout; production's tighter
  // configured routing deadline is tested separately by jev-routing tests.
  let requestCount = 0;
  const client = new JevClient({
    timeoutMs: 10_000,
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1;
      return fetch(input, init);
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const sessionId = batched ? `jev-batch-probe-${Date.now()}` : undefined;
  const started = performance.now();
  const results = await Promise.all(routes.map(({ state, questions }) => client.evaluate(state, questions, {
    timeoutMs: 10_000,
    ...(batched ? { sessionId, signal: controller.signal } : {}),
  })));
  console.log(JSON.stringify({
    label,
    elapsedMs: Math.round(performance.now() - started),
    requestCount,
    returnedRoutes: results.length,
    totalProviderCostUsd: Number(results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0).toFixed(8)),
    routeAnswers: Object.fromEntries(results.map((result, index) => [routes[index].name, result.answers])),
  }));
}

async function main(): Promise<void> {
  await measure("concurrent-independent-baseline", false);
  await measure("same-turn-coalesced", true);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Jev benchmark failed");
  process.exitCode = 1;
});
