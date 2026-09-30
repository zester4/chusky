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
  const watch = await createAttentionRecord(userId, "autonomy_watch", { name: "Invoices", domain: "stripe", objective: "Find changed invoices", mode: "business", toolSlugs: ["STRIPE_LIST_INVOICES", "STRIPE_CREATE_INVOICE"], cadenceSeconds: 300, authority: "observe", status: "active", maxItems: 20, nextCheckAt: 1 });
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

test("reconciliation writes deduplicated owner observations for changes, failures, and recovery", async () => {
  await initStore({ memoryOnly: true });
  const userId = 990009;
  const firstNow = Date.parse("2026-01-31T00:00:00Z");
  await createAttentionRecord(userId, "autonomy_watch", {
    name: "Inbox watch", domain: "gmail", objective: "Check for important new messages",
    toolSlugs: ["GMAIL_LIST_MESSAGES"], cadenceSeconds: 300, authority: "observe",
    status: "active", maxItems: 10, nextCheckAt: firstNow,
  });
  const changed = async () => ({ text: 'AUTONOMY_RESULT: {"changed":true,"summary":"A new message needs a reply","cursor":"mail-2"}' });

  await runDueAutonomyWatches(userId, { mode: "personal", now: firstNow, execute: changed as any });
  let observations = await listAttentionRecords(userId, "observation") as any[];
  assert.equal(observations.length, 1);
  assert.equal(observations[0].eventType, "watch.changed");
  assert.equal(observations[0].status, "new");
  assert.equal(observations[0].privacyScope, "private");
  assert.match(observations[0].summary, /new message needs a reply/);

  await runDueAutonomyWatches(userId, { mode: "personal", now: firstNow + 300_000, execute: changed as any });
  observations = await listAttentionRecords(userId, "observation") as any[];
  assert.equal(observations.length, 1, "replayed observation must deduplicate");

  const failNow = firstNow + 600_000;
  await runDueAutonomyWatches(userId, { mode: "personal", now: failNow, execute: async () => { throw new Error("connected provider unavailable: Bearer should-never-persist api_key=sk_test_12345678901234567890"); } });
  observations = await listAttentionRecords(userId, "observation") as any[];
  assert.equal(observations.length, 2);
  const failed = observations.find((item) => item.eventType === "watch.failed");
  assert.ok(failed);
  assert.match(failed.summary, /provider unavailable/);
  assert.doesNotMatch(failed.summary, /should-never-persist|sk_test_12345678901234567890/);

  await runDueAutonomyWatches(userId, { mode: "personal", now: failNow + 300_000, execute: changed as any });
  observations = await listAttentionRecords(userId, "observation") as any[];
  assert.equal(observations.length, 3);
  assert.ok(observations.some((item) => item.eventType === "watch.recovered"));
  assert.equal(observations.every((item) => item.userId === userId), true);
});

test("reconciliation never crosses personal and business watch boundaries", async () => {
  await initStore({ memoryOnly: true });
  const userId = 990006;
  await createAttentionRecord(userId, "autonomy_profile", { mode: "personal", enabled: true });
  await createAttentionRecord(userId, "autonomy_profile", { mode: "business", enabled: true });
  const personalWatch = await createAttentionRecord(userId, "autonomy_watch", { name: "Personal calendar", domain: "calendar", objective: "Check personal events", mode: "personal", toolSlugs: ["GOOGLECALENDAR_LIST_EVENTS"], cadenceSeconds: 300, authority: "observe", status: "active", maxItems: 10, nextCheckAt: 1 });
  const businessWatch = await createAttentionRecord(userId, "autonomy_watch", { name: "Business invoices", domain: "stripe", objective: "Check company invoices", mode: "business", toolSlugs: ["STRIPE_LIST_INVOICES"], cadenceSeconds: 300, authority: "observe", status: "active", maxItems: 10, nextCheckAt: 1 });
  const seen: string[] = [];
  const execute = async ({ watch }: { watch: { name: string } }) => {
    seen.push(watch.name);
    return { text: "AUTONOMY_RESULT: {\"changed\":false,\"summary\":\"No changes\"}" };
  };

  const personal = await runDueAutonomyWatches(userId, { mode: "personal", now: Date.now(), execute: execute as any });
  const business = await runDueAutonomyWatches(userId, { mode: "business", now: Date.now(), execute: execute as any });

  assert.deepEqual(personal.map((item) => item.watchId), [personalWatch.id]);
  assert.deepEqual(business.map((item) => item.watchId), [businessWatch.id]);
  assert.deepEqual(seen, ["Personal calendar", "Business invoices"]);
});

test("reconciliation respects denied domains and records a bounded failure without disabling the watch", async () => {
  await initStore({ memoryOnly: true });
  const userId = 990002;
  await createAttentionRecord(userId, "autonomy_profile", { mode: "personal", enabled: true, deniedDomains: ["gmail"] });
  await createAttentionRecord(userId, "autonomy_watch", { name: "Mail", domain: "gmail", objective: "Find changes", toolSlugs: ["GMAIL_LIST_MESSAGES"], cadenceSeconds: 300, authority: "observe", status: "active", maxItems: 10, nextCheckAt: 1 });
  const result = await runDueAutonomyWatches(userId, { mode: "personal", now: Date.now(), execute: async () => { throw new Error("must not execute"); } });
  assert.equal(result[0].status, "skipped");
});

test("reconciliation uses a distributed watch lease across concurrent workers", async () => {
  await initStore({ memoryOnly: true });
  const userId = 990003;
  await createAttentionRecord(userId, "autonomy_watch", { name: "Calendar", domain: "calendar", objective: "Find changed events", toolSlugs: ["GOOGLECALENDAR_LIST_EVENTS"], cadenceSeconds: 300, authority: "observe", status: "active", maxItems: 10, nextCheckAt: 1 });
  let executions = 0;
  const execute = async () => { executions++; await new Promise((resolve) => setTimeout(resolve, 30)); return { text: "AUTONOMY_RESULT: {\"changed\":false,\"summary\":\"No changes\"}" }; };
  const [left, right] = await Promise.all([
    runDueAutonomyWatches(userId, { mode: "personal", now: Date.now(), execute: execute as any }),
    runDueAutonomyWatches(userId, { mode: "personal", now: Date.now(), execute: execute as any }),
  ]);
  assert.equal(executions, 1);
  assert.equal([...left, ...right].filter((item) => item.status === "completed").length, 1);
  assert.equal([...left, ...right].filter((item) => item.status === "skipped").length, 1);
});

test("reconciliation fails closed on prose or malformed protocol and preserves its checkpoint", async () => {
  await initStore({ memoryOnly: true });
  const userId = 990007;
  await createAttentionRecord(userId, "autonomy_watch", { name: "Inbox", domain: "gmail", objective: "Find changes", toolSlugs: ["GMAIL_LIST_MESSAGES"], cursor: "page-1", cadenceSeconds: 300, authority: "observe", status: "active", maxItems: 10, nextCheckAt: 1 });
  const result = await runDueAutonomyWatches(userId, { mode: "personal", now: Date.parse("2026-01-31"), execute: async () => ({ text: "I found nothing new, and the provider said {not-json}." }) });
  assert.equal(result[0]?.status, "failed");
  const watch = (await listAttentionRecords(userId, "autonomy_watch") as any[])[0];
  assert.equal(watch.cursor, "page-1");
  assert.match(watch.lastError, /AUTONOMY_RESULT/);
  assert.equal(watch.lastResult, undefined);
});

test("reconciliation parses nested provider evidence without treating it as a checkpoint", async () => {
  await initStore({ memoryOnly: true });
  const userId = 990008;
  await createAttentionRecord(userId, "autonomy_watch", { name: "Inbox", domain: "gmail", objective: "Find changes", toolSlugs: ["GMAIL_LIST_MESSAGES"], cadenceSeconds: 300, authority: "observe", status: "active", maxItems: 10, nextCheckAt: 1 });
  const result = await runDueAutonomyWatches(userId, { mode: "personal", now: Date.parse("2026-01-31"), execute: async () => ({ text: 'prefix AUTONOMY_RESULT: {"changed":false,"summary":"No changes {confirmed}","cursor":"page-2","signals":[{"id":"m-1","source":"gmail","kind":"message","metadata":{"ignored":"data"}}]} trailing' }) });
  assert.equal(result[0]?.status, "completed");
  const watch = (await listAttentionRecords(userId, "autonomy_watch") as any[])[0];
  assert.equal(watch.cursor, "page-2");
});

test("Treg lead-signal watches bound tools, persist first-seen signals, and suppress repeats", async () => {
  await initStore({ memoryOnly: true });
  const userId = 990010;
  const firstNow = Date.parse("2026-02-01T00:00:00Z");
  const watch = await createAttentionRecord(userId, "autonomy_watch", {
    name: "AI SaaS buyer signals", domain: "leads", toolkit: "treg", mode: "business",
    objective: "Find US SaaS companies hiring sales staff or publicly seeking customer-support automation; return evidence and source links.",
    query: "US SaaS, 20-200 employees, hiring sales or discussing support automation",
    cadenceSeconds: 3600, authority: "observe", status: "active", maxItems: 10, nextCheckAt: firstNow,
  });
  let prompt = "";
  let toolSlugs: string[] = [];
  const execute = async (input: { prompt: string; toolSlugs: string[] }) => {
    prompt = input.prompt;
    toolSlugs = input.toolSlugs;
    return { text: `AUTONOMY_RESULT: ${JSON.stringify({ changed: true, summary: "Two candidate signals returned by Treg", signals: [
      { id: "provider-signal-1", source: "treg.linkedin", kind: "hiring", subject: "Acme is hiring its first SDR", createdAt: "2026-01-31T12:00:00Z", metadata: { company: "Acme", url: "https://example.com/jobs/1", score: 0.92, email: "must-not-persist@example.com" } },
      { id: "provider-signal-2", source: "treg.reddit", kind: "intent", subject: "Looking for support automation", metadata: { signal: "Public request", url: "http://unsafe.example/post" } },
    ] })}` };
  };
  const first = await runDueAutonomyWatches(userId, { mode: "business", now: firstNow, tregEnabled: true, execute: execute as any });
  assert.equal(first[0]?.status, "completed");
  assert.equal(first[0]?.changed, true);
  assert.deepEqual(toolSlugs, ["CHUCK_TREG_SEARCH", "CHUCK_TREG_RESOLVE"]);
  assert.match(prompt, /trusted runtime enforces maxSpendUsd=\$0\.25 and maxCalls=1/);
  assert.match(prompt, /Never contact anyone/);
  const firstSignals = (await listAttentionRecords(userId, "observation") as any[]).filter((item) => item.eventType === "lead_signal.detected");
  assert.equal(firstSignals.length, 2);
  assert.equal(firstSignals[0].metadata.email, undefined);
  assert.equal(firstSignals[1].metadata.url, undefined, "non-HTTPS source URLs are dropped");
  const persistedWatch = (await listAttentionRecords(userId, "autonomy_watch") as any[]).find((item) => item.id === watch.id);
  assert.equal(persistedWatch.seenSignalKeys.length, 2);

  const second = await runDueAutonomyWatches(userId, { mode: "business", now: firstNow + 3_600_000, tregEnabled: true, execute: execute as any });
  assert.equal(second[0]?.status, "completed");
  assert.equal(second[0]?.changed, false);
  assert.match(second[0]?.summary ?? "", /No new lead signals/);
  const observations = await listAttentionRecords(userId, "observation") as any[];
  assert.equal(observations.filter((item) => item.eventType === "lead_signal.detected").length, 2);
});

test("Treg lead-signal watches fail closed when Treg is disabled", async () => {
  await initStore({ memoryOnly: true });
  const userId = 990011;
  await createAttentionRecord(userId, "autonomy_watch", { name: "Lead signals", domain: "leads", toolkit: "treg", objective: "Find signals", cadenceSeconds: 300, authority: "observe", status: "active", maxItems: 5, nextCheckAt: 1 });
  const result = await runDueAutonomyWatches(userId, { mode: "personal", now: Date.now(), tregEnabled: false, execute: async () => { throw new Error("must not execute"); } });
  assert.equal(result[0]?.status, "failed");
  assert.match(result[0]?.error ?? "", /Treg is disabled/);
});
