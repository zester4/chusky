import { performance } from "node:perf_hooks";
import { config } from "../src/config.js";
import { runAgent } from "../src/agent.js";
import { initStore, upsertMemory } from "../src/store.js";

async function main() {
  await initStore({ memoryOnly: true });
  // Synthetic owner context; nothing is written to a real account.
  const userId = 991812;
  config.upstashVectorRestUrl = "";
  config.upstashVectorRestToken = "";
  await upsertMemory(userId, { category: "project", key: "latency probe project codename", value: "Cobalt Lantern", confidence: 1, source: "user" });
  const realFetch = globalThis.fetch;
  let metadataCalls = 0;
  let modelRequestedAt: number | undefined;
  let start = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("openrouter.ai/api/v1/models/")) metadataCalls++;
    if (url.includes("openrouter.ai/api/v1/chat/completions")) modelRequestedAt ??= performance.now();
    const isDecision = url.includes("/decisions") || url.includes("/systemone");
    const fetchStart = performance.now();
    if (isDecision) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      console.log(JSON.stringify({ stage: "jev_request", endpoint: new URL(url).pathname, questions: Object.entries(body.questions ?? {}).map(([name, q]: [string, any]) => ({ name, instructions: q.instructions, optionCount: Object.keys(q.criteria ?? {}).length })) }));
    }
    try {
      const response = await realFetch(input, init);
      if (isDecision) {
        const payload = await response.clone().json().catch(() => ({}));
        console.log(JSON.stringify({ stage: "jev_response", ms: Math.round(performance.now() - fetchStart), status: response.status, answers: Object.entries(payload.answers ?? {}).map(([name, a]: [string, any]) => ({ name, choice: a.choice, noul: a.noul, confidence: a.confidence })) }));
      }
      return response;
    } catch (error) {
      if (isDecision) console.log(JSON.stringify({ stage: "jev_failure", ms: Math.round(performance.now() - fetchStart), errorClass: error instanceof Error ? error.name : "unknown" }));
      throw error;
    }
  }) as typeof fetch;
  try {
    for (let sample = 1; sample <= 2; sample++) {
      start = performance.now();
      modelRequestedAt = undefined;
      metadataCalls = 0;
      let firstTextAt: number | undefined;
      const result = await runAgent(userId, "What is my latency probe project codename? Answer only with the codename from saved memory.", [], config.defaultModel,
        undefined, AbortSignal.timeout(60_000), () => { firstTextAt ??= performance.now(); }, undefined, undefined,
        { maxToolCalls: 3, maxCost: 0.05, instructions: "This is a diagnostic conversation. Only read information. Do not send messages, create schedules, modify app data, or change connections." });
      const passed = metadataCalls === 0 && result.text.includes("Cobalt Lantern") && result.toolsUsed.length === 0;
      console.log(JSON.stringify({ sample, passed, metadataCalls, contextRetained: result.text.includes("Cobalt Lantern"), toolCalls: result.toolsUsed.length,
        preparationMs: modelRequestedAt === undefined ? null : Math.round(modelRequestedAt - start),
        providerFirstTextMs: firstTextAt === undefined || modelRequestedAt === undefined ? null : Math.round(firstTextAt - modelRequestedAt),
        firstTextMs: firstTextAt === undefined ? null : Math.round(firstTextAt - start), totalMs: Math.round(performance.now() - start), costUsd: result.cost }));
      if (!passed) process.exitCode = 1;
    }
  } finally { globalThis.fetch = realFetch; }
  process.exit(process.exitCode ?? 0);
}
void main().catch((error) => { console.error(JSON.stringify({ failed: true, errorClass: error instanceof Error ? error.name : "unknown" })); process.exit(1); });
