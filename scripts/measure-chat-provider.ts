import { performance } from "node:perf_hooks";
import { config } from "../src/config.js";
import { orChat } from "../src/agent.js";

// Read-only provider probe. No account state or connected-app tools are used.
async function main() {
const model = config.defaultModel;
for (let sample = 1; sample <= 3; sample++) {
  const metadataStart = performance.now();
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/models/${encodeURIComponent(model.replace(/^~/, ""))}`, {
      headers: { Authorization: `Bearer ${config.openRouterApiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    await response.arrayBuffer();
    console.log(JSON.stringify({ sample, stage: "metadata", ms: Math.round(performance.now() - metadataStart), status: response.status }));
  } catch {
    console.log(JSON.stringify({ sample, stage: "metadata", failed: true, ms: Math.round(performance.now() - metadataStart) }));
  }
  const start = performance.now();
  let firstTextMs: number | undefined;
  try {
    const result = await orChat(model, [
      { role: "system", content: "Answer briefly and directly." },
      { role: "user", content: "In one sentence, explain why the sky looks blue." },
    ], [], AbortSignal.timeout(30_000), () => { firstTextMs ??= Math.round(performance.now() - start); });
    console.log(JSON.stringify({ sample, stage: "inference", model, firstTextMs, totalMs: Math.round(performance.now() - start), promptTokens: result.usage?.prompt_tokens, costUsd: result.usage?.cost }));
  } catch (error) {
    console.log(JSON.stringify({ sample, stage: "inference", failed: true, errorClass: error instanceof Error ? error.name : "unknown", totalMs: Math.round(performance.now() - start) }));
  }
}
process.exit(0);
}
void main().catch(() => { console.error("Provider probe failed."); process.exit(1); });
