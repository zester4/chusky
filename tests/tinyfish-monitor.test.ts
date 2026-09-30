import test from "node:test";
import assert from "node:assert/strict";
import { createAttentionRecord, initStore, listAttentionRecords } from "../src/store.js";
import { receiveTinyFishMonitorWebhook, tinyFishMonitorSignature, tinyFishMonitorSnapshotHash, validateTinyFishMonitorSchedule } from "../src/tinyfishMonitors.js";
import { reconcileTinyFishResearchRun } from "../src/tinyfishResearch.js";

test("TinyFish topic monitor schedules are bounded to at least 30 minutes", () => {
  assert.equal(validateTinyFishMonitorSchedule("search", "*/30 * * * *"), "*/30 * * * *");
  assert.equal(validateTinyFishMonitorSchedule("search", "CRON_TZ=Europe/London 0 9 * * 1-5"), "CRON_TZ=Europe/London 0 9 * * 1-5");
  assert.throws(() => validateTinyFishMonitorSchedule("search", "*/15 * * * *"), /at least 30 minutes/i);
  assert.throws(() => validateTinyFishMonitorSchedule("fetch", "* * * * *"), /at least 30 minutes/i);
  assert.equal(validateTinyFishMonitorSchedule("fetch", "0,30 9 * * *"), "0,30 9 * * *");
  assert.throws(() => validateTinyFishMonitorSchedule("fetch", "0,15 9 * * *"), /at least 30 minutes/i);
  assert.throws(() => validateTinyFishMonitorSchedule("fetch", "60 * * * *"), /out-of-range/i);
  assert.throws(() => validateTinyFishMonitorSchedule("fetch", "0 0 * *"), /five-field/i);
});

test("TinyFish monitor callbacks are signed, owner-scoped, deduplicated, and sent to Pulse only for changes", async () => {
  await initStore({ memoryOnly: true });
  const userId = 120045;
  const apiKey = "test-tinyfish-key";
  const callbackId = "a8d918fc-c7c9-4d78-a0ee-7b98ac4a23d1";
  const baseline = { results: [{ url: "https://example.org/pricing", title: "Plans", text: "Starter $10" }] };
  const monitor = await createAttentionRecord(userId, "tinyfish_monitor", {
    providerMonitorId: "provider-monitor-1", callbackId, monitorType: "fetch", name: "Pricing changes", scheduleCron: "0 9 * * *",
    targetUrl: "https://example.org/pricing", status: "active", snapshotHash: tinyFishMonitorSnapshotHash(baseline), runHistory: [],
  });
  const signature = tinyFishMonitorSignature(apiKey, userId, callbackId);
  const unchanged = { fetch_monitor_id: "provider-monitor-1", id: "run-1", is_baseline: false, ...baseline, errors: [] };
  const unchangedResult = await receiveTinyFishMonitorWebhook({ userId, internalId: callbackId, signature, apiKey, rawBody: Buffer.from(JSON.stringify(unchanged)) });
  assert.equal(unchangedResult.ignored, true);
  assert.equal((await listAttentionRecords(userId, "observation", { limit: 20 })).length, 0);

  const changed = { fetch_monitor_id: "provider-monitor-1", id: "run-2", is_baseline: false, meaningful: true, summary: "Starter plan increased from $10 to $12.", results: [{ url: "https://example.org/pricing", title: "Plans", text: "Starter $12" }], errors: [] };
  const changedResult = await receiveTinyFishMonitorWebhook({ userId, internalId: callbackId, signature, apiKey, rawBody: Buffer.from(JSON.stringify(changed)) });
  assert.equal(changedResult.accepted, true);
  assert.equal((await listAttentionRecords(userId, "observation", { limit: 20 })).length, 1);
  assert.match((await listAttentionRecords(userId, "observation", { limit: 20 }))[0]?.summary ?? "", /increased from \$10 to \$12/);
  assert.equal((await receiveTinyFishMonitorWebhook({ userId, internalId: callbackId, signature, apiKey, rawBody: Buffer.from(JSON.stringify(changed)) })).duplicate, true);
  assert.equal((await listAttentionRecords(userId, "observation", { limit: 20 })).length, 1);
  assert.equal((await listAttentionRecords(userId + 1, "tinyfish_monitor", { limit: 20 })).length, 0);
  assert.ok(monitor.id);
  await assert.rejects(() => receiveTinyFishMonitorWebhook({ userId: userId + 1, internalId: callbackId, signature, apiKey, rawBody: Buffer.from(JSON.stringify(changed)) }), /authorization/i);
  await assert.rejects(() => receiveTinyFishMonitorWebhook({ userId, internalId: callbackId, signature: "0".repeat(64), apiKey, rawBody: Buffer.from(JSON.stringify(changed)) }), /authorization/i);
});

test("TinyFish monitor provider judgment suppresses irrelevant changes and accepts nested callbacks", async () => {
  await initStore({ memoryOnly: true });
  const userId = 120048;
  const apiKey = "test-tinyfish-key";
  const callbackId = "d4db9119-20c9-4a95-8cfe-0f4b4f298b86";
  await createAttentionRecord(userId, "tinyfish_monitor", {
    providerMonitorId: "provider-monitor-2", callbackId, monitorType: "fetch", name: "Pricing only", targetUrl: "https://example.org/pricing",
    scheduleCron: "0 9 * * *", status: "active", snapshotHash: tinyFishMonitorSnapshotHash({ results: [{ text: "old" }] }), runHistory: [],
  });
  const signature = tinyFishMonitorSignature(apiKey, userId, callbackId);
  const irrelevant = { monitor_id: "provider-monitor-2", run_id: "run-ignored", data: { meaningful: false, summary: "Only the footer copyright changed.", results: [{ text: "new footer" }] } };
  const ignored = await receiveTinyFishMonitorWebhook({ userId, internalId: callbackId, signature, apiKey, rawBody: Buffer.from(JSON.stringify(irrelevant)) });
  assert.equal(ignored.ignored, true);
  assert.equal((await listAttentionRecords(userId, "observation", { limit: 10 })).length, 0);

  const meaningful = { monitor_id: "provider-monitor-2", run_id: "run-alert", data: { meaningful: true, summary: "The listed price dropped below $40." } };
  const accepted = await receiveTinyFishMonitorWebhook({ userId, internalId: callbackId, signature, apiKey, rawBody: Buffer.from(JSON.stringify(meaningful)) });
  assert.equal(accepted.accepted, true);
  assert.match((await listAttentionRecords(userId, "observation", { limit: 10 }))[0]?.summary ?? "", /dropped below \$40/);
});

test("TinyFish monitor baseline callbacks stay quiet and a failed check does not disable future checks", async () => {
  await initStore({ memoryOnly: true });
  const userId = 120049;
  const apiKey = "test-tinyfish-key";
  const callbackId = "6c4db4a0-93b6-48b1-856b-c08aa9383f1c";
  const monitor = await createAttentionRecord(userId, "tinyfish_monitor", {
    providerMonitorId: "provider-monitor-3", callbackId, monitorType: "fetch", name: "Availability",
    targetUrl: "https://example.org/status", scheduleCron: "0 9 * * *", status: "active", runHistory: [],
  });
  const common = { userId, internalId: callbackId, signature: tinyFishMonitorSignature(apiKey, userId, callbackId), apiKey };
  const baseline = await receiveTinyFishMonitorWebhook({
    ...common,
    rawBody: Buffer.from(JSON.stringify({ monitor_id: "provider-monitor-3", run_id: "baseline-1", data: { is_baseline: true, results: [{ text: "Initial snapshot" }] } })),
  });
  assert.equal(baseline.ignored, true);
  assert.equal((await listAttentionRecords(userId, "observation", { limit: 10 })).length, 0);

  const failed = await receiveTinyFishMonitorWebhook({
    ...common,
    rawBody: Buffer.from(JSON.stringify({ monitor_id: "provider-monitor-3", run_id: "failed-1", data: { errors: [{ error: "temporary fetch failure" }] } })),
  });
  assert.equal(failed.accepted, true);
  const saved = (await listAttentionRecords(userId, "tinyfish_monitor", { limit: 10 })).find((item) => item.id === monitor.id);
  assert.equal(saved?.status, "active");
  assert.match((saved as { lastError?: string })?.lastError ?? "", /could not be checked/);
  assert.equal((await listAttentionRecords(userId, "observation", { limit: 10 })).length, 1);
});

test("TinyFish topic monitor observations include only newly identified result titles", async () => {
  await initStore({ memoryOnly: true });
  const userId = 120046;
  const apiKey = "test-tinyfish-key";
  const callbackId = "c25394e1-11e7-4c00-91df-2b4f3d6586df";
  await createAttentionRecord(userId, "tinyfish_monitor", { providerMonitorId: "topic-1", callbackId, monitorType: "search", name: "Policy news", query: "policy update", scheduleCron: "0 * * * *", status: "active", runHistory: [] });
  const payload = { search_monitor_id: "topic-1", id: "search-run-1", new_result_positions: [1], results: [{ position: 1, title: "Official notice", url: "https://example.gov/notice", snippet: "The date changed." }, { position: 2, title: "Old result", url: "https://example.net/old" }] };
  await receiveTinyFishMonitorWebhook({ userId, internalId: callbackId, signature: tinyFishMonitorSignature(apiKey, userId, callbackId), apiKey, rawBody: Buffer.from(JSON.stringify(payload)) });
  const observations = await listAttentionRecords(userId, "observation", { limit: 5 });
  assert.equal(observations.length, 1);
  assert.match((observations[0] as { summary: string }).summary, /Official notice/);
  assert.doesNotMatch((observations[0] as { summary: string }).summary, /Old result/);
});

test("TinyFish Research reconciliation persists the cited report for its owner and emits one Pulse observation", async () => {
  await initStore({ memoryOnly: true });
  const userId = 120047;
  const run = await createAttentionRecord(userId, "tinyfish_research_run", { providerRunId: "provider-run-1", query: "official policy", mode: "standard", status: "RUNNING", citations: [] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.match(String(input), /\/v1\/research-run\/provider-run-1$/);
    assert.equal(new Headers(init?.headers).get("X-API-Key"), "server-key");
    return Response.json({ status: "COMPLETED", progress: "Final citations verified", quick_result: { answer: "Report text", citations: [{ url: "https://example.gov/source", title: "Official source" }] } });
  }) as typeof fetch;
  try {
    const completed = await reconcileTinyFishResearchRun(userId, run.id, "server-key");
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.report, "Report text");
    assert.equal(completed.progress, "Final citations verified");
    assert.equal(completed.citations[0]?.url, "https://example.gov/source");
    await reconcileTinyFishResearchRun(userId, run.id, "server-key");
    assert.equal((await listAttentionRecords(userId, "observation", { limit: 10 })).length, 1);
    await assert.rejects(() => reconcileTinyFishResearchRun(userId + 1, run.id, "server-key"), /not found/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
