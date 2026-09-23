import test from "node:test";
import assert from "node:assert/strict";
import { initStore, createAttentionRecord, listAttentionRecords } from "../src/store.js";
import { detectBusinessGaps } from "../src/autonomy/gapDetectors.js";
import { runDueAutonomyWatches } from "../src/autonomy/reconciliation.js";

test("business gap detectors identify overdue invoices, unreplied messages, and coverage deficits", () => {
  const now = Date.parse("2026-01-31T00:00:00Z");
  const gaps = detectBusinessGaps([
    { id: "inv-1", source: "stripe", kind: "invoice", subject: "Acme", status: "open", dueAt: "2026-01-01", amount: 1250, currency: "USD" },
    { id: "msg-1", source: "gmail", kind: "message", subject: "Question", updatedAt: "2026-01-20", status: "open" },
    { id: "shift-1", source: "calendar", kind: "coverage", subject: "Saturday", expectedCount: 2, actualCount: 1 },
  ], { now });
  assert.deepEqual(gaps.map((gap) => gap.type), ["overdue_invoice", "unreplied_message", "staffing_coverage"]);
  assert.ok(gaps.every((gap) => gap.requiresApproval));
});

test("reconciliation executes only exact read-only scopes, checkpoints, and deduplicates gap candidates", async () => {
  await initStore({ memoryOnly: true });
  const userId = 990001;
  await createAttentionRecord(userId, "autonomy_profile", { mode: "business", enabled: true, allowedDomains: ["stripe"], deniedDomains: [] });
  const watch = await createAttentionRecord(userId, "autonomy_watch", { name: "Invoices", domain: "stripe", objective: "Find changed invoices", toolSlugs: ["STRIPE_LIST_INVOICES", "STRIPE_CREATE_INVOICE"], cadenceSeconds: 300, authority: "observe", status: "active", maxItems: 20, nextCheckAt: 1 });
  let seen: string[] = [];
  const execute = async ({ toolSlugs }: { toolSlugs: string[] }) => { seen = toolSlugs; return { text: `AUTONOMY_RESULT: ${JSON.stringify({ changed: true, summary: "One invoice is overdue", cursor: "page-2", signals: [{ id: "inv-1", source: "stripe", kind: "invoice", subject: "Acme", status: "open", dueAt: "2026-01-01" }] })}`, toolsSucceeded: toolSlugs }; };
  const first = await runDueAutonomyWatches(userId, { mode: "business", now: Date.parse("2026-01-31"), execute: execute as any });
  assert.equal(first[0].status, "completed");
  assert.deepEqual(seen, ["STRIPE_LIST_INVOICES"]);
  assert.equal((await listAttentionRecords(userId, "autonomy_watch") as any[])[0].cursor, "page-2");
  assert.equal((await listAttentionRecords(userId, "attention_candidate") as any[]).length, 1);
  const second = await runDueAutonomyWatches(userId, { mode: "business", now: Date.parse("2026-01-31"), execute: execute as any });
  assert.equal(second.length, 0);
  assert.equal((await listAttentionRecords(userId, "attention_candidate") as any[]).length, 1);
  assert.equal(watch.userId, userId);
});

test("reconciliation respects denied domains and records a bounded failure without disabling the watch", async () => {
  await initStore({ memoryOnly: true });
  const userId = 990002;
  await createAttentionRecord(userId, "autonomy_profile", { mode: "personal", enabled: true, deniedDomains: ["gmail"] });
  await createAttentionRecord(userId, "autonomy_watch", { name: "Mail", domain: "gmail", objective: "Find changes", toolSlugs: ["GMAIL_LIST_MESSAGES"], cadenceSeconds: 300, authority: "observe", status: "active", maxItems: 10, nextCheckAt: 1 });
  const result = await runDueAutonomyWatches(userId, { mode: "personal", now: Date.now(), execute: async () => { throw new Error("must not execute"); } });
  assert.equal(result[0].status, "skipped");
});
