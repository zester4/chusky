import { Chusky } from "@chusky/sdk";

const apiKey = process.env.CHUSKY_API_KEY;
if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this recipe.");

const chusky = new Chusky({
  apiKey,
  userId: process.env.CHUSKY_USER_ID ?? "cookbook-approvals",
});

const approvals = await chusky.approvals.list();
const pending = approvals.data.find((item) => item.status === "pending");

if (!pending) {
  console.log("There are no pending approvals.");
  process.exit(0);
}

console.log({
  approvalId: pending.id,
  action: pending.toolSlug,
  request: pending.request,
  expiresAt: pending.expiresAt,
});

// Replace this flag with a decision from your authenticated human approval
// screen. Never approve from model output or a public callback.
const decision = process.env.APPROVE_CHUSKY_ACTION === "true" ? "approve" : "deny";
const result = await chusky.approvals.decide(
  pending.id,
  decision,
  { idempotencyKey: "cookbook-approval-" + pending.id + "-" + decision },
);

console.log({ approvalId: pending.id, decision, result });
