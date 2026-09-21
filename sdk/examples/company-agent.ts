import { createClient } from "./_client.js";

const chusky = createClient();
const templates = await chusky.agents.templates();
const template = templates.data.find((item) => item.slug === "lead-research");

if (!template) {
  throw new Error("The lead-research template is not available for this project.");
}

const agent = await chusky.agents.create(
  {
    template: template.slug,
    name: "Fintech lead scout",
    instructions: "Return sourced, deduplicated company profiles. Draft external communication only.",
    policy: {
      tools: {
        allow: ["crm.read", "web.search", "email.draft"],
        requireApproval: ["crm.write", "email.send"],
      },
      budget: { duration: "30m", maxToolCalls: 80, maxCost: 8 },
    },
  },
  { idempotencyKey: "create-fintech-lead-agent-v1" },
);

const { thread, run } = await chusky.runs.create(
  {
    agentId: agent.id,
    input: "Find qualified fintech companies with more than 50 employees and prepare CRM-ready profiles.",
    wait: false,
  },
  { idempotencyKey: "fintech-lead-research-customer-123-v1" },
);

console.log({ agentId: agent.id, threadId: thread.id, runId: run.id, status: run.status });
