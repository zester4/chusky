import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-workflow",
});

const workflow = await chusky.workflows.create(
  {
    name: "Research then prepare follow-up",
    description: "A reusable two-stage sales workflow.",
    stages: [
      {
        id: "research",
        title: "Research account",
        objective: "Collect current, source-backed account facts.",
      },
      {
        id: "prepare",
        title: "Prepare follow-up",
        objective: "Draft the next message using the research result.",
        dependsOn: ["research"],
        requiresApproval: true,
      },
    ],
  },
  { idempotencyKey: "cookbook-sales-workflow-0001" },
);

console.log({
  workflowId: workflow.id,
  status: workflow.status,
  stages: workflow.stages.map((stage) => stage.id),
});

const started = await chusky.workflows.start(
  workflow.id,
  { idempotencyKey: "cookbook-sales-workflow-run-0001" },
);

console.log({
  workflowId: started.id,
  status: started.status,
  taskId: started.taskId,
  workflowRunId: started.workflowRunId,
});
