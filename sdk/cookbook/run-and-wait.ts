import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-run-and-wait",
});

const { thread, run } = await chusky.runs.create(
  {
    input:
      "Concisely list the tools currently available to you, grouped by category. Give category names and a few representative tool names only; do not enumerate the full catalogue. If you need a tool catalogue lookup to answer accurately, use at most one tool call.",
    wait: true,
    budget: {
      duration: "5m",
      maxToolCalls: 1,
      maxCost: 0.25,
    },
  },
  { idempotencyKey: "cookbook-tool-list-20260930-0001" },
);

console.log({
  threadId: thread.id,
  runId: run.id,
  status: run.status,
  output: run.output,
});
