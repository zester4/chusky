import { createClient } from "./_client.js";

const chusky = createClient();
const thread = await chusky.threads.create(
  { metadata: { source: "sdk-example" } },
  { idempotencyKey: `stream-thread-${Date.now()}` },
);

const controller = new AbortController();
const stopAfterMs = setTimeout(() => controller.abort(), 60_000);

try {
  for await (const event of chusky.threads.runs(thread.id).stream(
    { input: "Summarize the account's current priorities in three bullets." },
    { signal: controller.signal },
  )) {
    switch (event.type) {
      case "run.status":
        console.error(`\n${event.text}`);
        break;
      case "run.delta":
        process.stdout.write(event.text);
        break;
      case "run.tool_started":
        console.error(`\nUsing ${event.toolSlug}...`);
        break;
      case "run.approval_required":
        console.error(`\nApproval required: ${event.approval.request ?? event.approval.toolSlug}`);
        console.error(`Approval ID: ${event.approval.id}`);
        break;
      case "run.failed":
        throw new Error(event.error.message);
      case "run.completed":
        console.error(`\nCompleted with status ${event.run.status}.`);
        break;
    }
  }
} finally {
  clearTimeout(stopAfterMs);
}
