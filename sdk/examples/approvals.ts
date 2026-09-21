import { createClient } from "./_client.js";

const chusky = createClient();
const page = await chusky.approvals.list();
const pending = page.data.find((approval) => approval.status === "pending");

if (!pending) {
  console.log("There are no pending approvals.");
  process.exit(0);
}

console.log({
  id: pending.id,
  action: pending.toolSlug,
  request: pending.request,
  expiresAt: pending.expiresAt,
});

// Replace this with an authenticated human decision in your application UI.
const humanApproved = process.env.APPROVE_CHUSKY_ACTION === "true";
const decision = await chusky.approvals.decide(
  pending.id,
  humanApproved ? "approve" : "deny",
  { idempotencyKey: `approval:${pending.id}:${humanApproved ? "approve" : "deny"}` },
);

console.log(`Approval ${pending.id}:`, decision);
