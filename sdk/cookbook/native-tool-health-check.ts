import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-native-tool-check",
});

const nativeTools = await chusky.tools.list({ source: "native" });
console.log({
  tools: nativeTools.data.map((tool) => ({
    slug: tool.slug,
    approval: tool.approval,
    execution: tool.execution,
  })),
});

const tool = await chusky.tools.get("CHUCK_INTEGRATION_HEALTH");
console.log("Selected capability:", tool.description);

const { thread, run } = await chusky.tools.run(
  {
    tool: "CHUCK_INTEGRATION_HEALTH",
    arguments: { operation: "all" },
  },
  { idempotencyKey: "cookbook-integration-health-0001" },
);

const completed = await chusky.runs.wait(thread.id, run.id, {
  timeoutMs: 120_000,
});

console.log({
  runId: run.id,
  status: completed.status,
  output: completed.output,
});
