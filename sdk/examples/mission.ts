import { createClient } from "./_client.js";

const chusky = createClient();
const mission = await chusky.missions.create(
  {
    title: "Qualified fintech leads",
    objective: "Find 20 fintech companies matching our ICP and prepare CRM-ready profiles.",
    definitionOfDone: "Every lead has a source URL, qualification reason, duplicate check, and approval-ready CRM payload.",
    verificationMode: "strict",
    requiredEvidence: ["source URL", "qualification assertion", "deduplication check"],
    steps: [
      { id: "research", title: "Research companies", objective: "Collect source-backed company facts." },
      { id: "qualify", title: "Qualify and deduplicate", objective: "Apply the ICP and remove duplicates.", dependsOn: ["research"] },
      { id: "prepare", title: "Prepare CRM payload", objective: "Draft the bounded CRM import.", dependsOn: ["qualify"] },
    ],
    maxDurationSeconds: 3 * 60 * 60,
    maxSteps: 30,
    maxToolCalls: 100,
    maxCost: 15,
  },
  { idempotencyKey: "mission-fintech-leads-customer-123-v1" },
);

console.log(`Mission ${mission.id} is ${mission.status}.`);

const proof = await chusky.missions.proof(mission.id);
console.log({
  status: proof.status,
  nextAction: proof.nextAction,
  completedSteps: proof.steps.filter((step) => step.status === "completed").length,
  evidence: proof.evidence.length,
});

// Attach evidence only after your application has actually verified it.
if (proof.status === "completed" && proof.steps[0]?.status === "completed") {
  await chusky.missions.evidence(mission.id, {
    stepId: "research",
    evidence: [{
      id: `source-check-${Date.now()}`,
      kind: "source",
      summary: "Company facts were checked against the cited source URLs.",
      verified: true,
      verifiedBy: "system",
    }],
  });
}
