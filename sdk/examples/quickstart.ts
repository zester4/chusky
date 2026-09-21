import { createClient } from "./_client.js";

const chusky = createClient();
const requestId = `quickstart-${Date.now()}`;

const { thread, run } = await chusky.runs.create(
  {
    input: "Prepare a concise renewal brief from the available account context.",
    wait: false,
    budget: { duration: "5m", maxToolCalls: 20, maxCost: 1 },
  },
  { idempotencyKey: requestId },
);

console.log(`Started run ${run.id} in thread ${thread.id}.`);
const completed = await chusky.runs.wait(thread.id, run.id, {
  timeoutMs: 120_000,
  intervalMs: 1_000,
});

if (completed.status === "failed") {
  throw new Error(completed.error?.message ?? "Chusky run failed.");
}

console.log(completed.output ?? "The run completed without text output.");
