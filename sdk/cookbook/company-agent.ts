import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-company-agent",
});

const templates = await chusky.agents.templates();
const template = templates.data.find((item) => item.slug === "lead-research");
if (!template) throw new Error("The lead-research template is not available.");

const agent = await chusky.agents.create(
  {
    template: template.slug,
    name: "Qualified lead scout",
    instructions:
      "Return sourced, deduplicated company profiles. Draft external communication only.",
    policy: {
      tools: {
        allow: ["crm.read", "web.search", "email.draft"],
        requireApproval: ["crm.write", "email.send"],
      },
      budget: { duration: "30m", maxToolCalls: 80, maxCost: 8 },
    },
  },
  { idempotencyKey: "cookbook-create-lead-agent-0001" },
);

const { thread, run } = await chusky.runs.create(
  {
    agentId: agent.id,
    input:
      "Find qualified fintech companies with more than 50 employees and prepare CRM-ready profiles.",
    wait: false,
  },
  { idempotencyKey: "cookbook-lead-research-run-0001" },
);

console.log({
  agentId: agent.id,
  threadId: thread.id,
  runId: run.id,
  status: run.status,
});
