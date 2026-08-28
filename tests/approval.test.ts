import test from "node:test";
import assert from "node:assert/strict";

type Approval = { status: "pending" | "approved" | "consumed" | "denied"; expiresAt: number; toolSlug: string; args: Record<string, unknown> };
function canConsume(item: Approval | undefined, slug: string, args: Record<string, unknown>): boolean {
  return Boolean(item && item.status === "approved" && item.expiresAt > Date.now() && item.toolSlug === slug && JSON.stringify(item.args) === JSON.stringify(args));
}

test("accepts a matching unexpired approval", () => {
  assert.equal(canConsume({ status: "approved", expiresAt: Date.now() + 1000, toolSlug: "GMAIL_SEND_EMAIL", args: { to: "a@b.com" } }, "GMAIL_SEND_EMAIL", { to: "a@b.com" }), true);
});

test("rejects changed arguments", () => {
  assert.equal(canConsume({ status: "approved", expiresAt: Date.now() + 1000, toolSlug: "GMAIL_SEND_EMAIL", args: { to: "a@b.com" } }, "GMAIL_SEND_EMAIL", { to: "other@b.com" }), false);
});

test("rejects expired, denied, and consumed approvals", () => {
  for (const status of ["denied", "consumed"] as const) assert.equal(canConsume({ status, expiresAt: Date.now() + 1000, toolSlug: "X_SEND", args: {} }, "X_SEND", {}), false);
  assert.equal(canConsume({ status: "approved", expiresAt: Date.now() - 1, toolSlug: "X_SEND", args: {} }, "X_SEND", {}), false);
});
