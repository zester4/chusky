import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-streaming",
});

const thread = await chusky.threads.create(
  { metadata: { source: "sdk-cookbook", recipe: "streaming" } },
  { idempotencyKey: "cookbook-stream-thread-0001" },
);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);

try {
  for await (const event of chusky.threads.runs(thread.id).stream(
    {
      input:
        "Review the latest customer context and give a three-bullet account summary. Ask for approval before any external write.",
      budget: { duration: "5m", maxToolCalls: 8, maxCost: 1 },
    },
    { signal: controller.signal },
  )) {
    if (event.type === "run.status") console.error(event.text);
    if (event.type === "run.delta") process.stdout.write(event.text);
    if (event.type === "run.tool_started") {
      console.error("\nUsing " + event.toolSlug + "...");
    }
    if (event.type === "run.approval_required") {
      console.error("\nApproval required: " + event.approval.id);
    }
    if (event.type === "run.failed") throw new Error(event.error.message);
    if (event.type === "run.completed") {
      console.error("\nCompleted: " + event.run.status);
    }
  }
} finally {
  clearTimeout(timeout);
}
