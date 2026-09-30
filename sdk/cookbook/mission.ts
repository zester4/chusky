import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-mission",
});

const mission = await chusky.missions.create(
  {
    title: "Turn a qualified inquiry into a confirmed order",
    objective:
      "Research the buyer, answer questions, prepare an offer, and stop for approval before purchase.",
    definitionOfDone:
      "The CRM record is updated, the offer is prepared, and no purchase is made without approval.",
    verificationMode: "strict",
    requiredEvidence: ["CRM record", "buyer requirements", "approval-ready offer"],
    steps: [
      {
        id: "research",
        title: "Research buyer",
        objective: "Collect verified facts and current requirements.",
      },
      {
        id: "qualify",
        title: "Qualify opportunity",
        objective: "Check fit, budget, and decision timeline.",
        dependsOn: ["research"],
      },
      {
        id: "offer",
        title: "Prepare offer",
        objective: "Draft a bounded offer for human review.",
        dependsOn: ["qualify"],
      },
    ],
    maxDurationSeconds: 3 * 60 * 60,
    maxSteps: 30,
    maxToolCalls: 100,
    maxCost: 15,
  },
  { idempotencyKey: "cookbook-buyer-inquiry-mission-0001" },
);

console.log("Mission started:", mission.id, mission.status);

const proof = await chusky.missions.proof(mission.id);
console.log({
  status: proof.status,
  nextAction: proof.nextAction,
  completedSteps: proof.steps.filter((step) => step.status === "completed").length,
  evidence: proof.evidence.length,
});

if (proof.status === "paused" || proof.status === "blocked") {
  console.log("Resolve the dependency, then call chusky.missions.resume(mission.id).");
}
