import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpSessionBroker } from "../src/lib/browser-runtime/broker.js";
import { BrowserSessionManager } from "../src/lib/browser-runtime/manager.js";
import { BrowserMetrics } from "../src/lib/browser-runtime/metrics.js";
import { EncryptedBrowserProfileStore } from "../src/lib/browser-runtime/profiles.js";
import { BrowserRefRegistry } from "../src/lib/browser-runtime/refs.js";
import { WarmBrowserSessionPool } from "../src/lib/browser-runtime/pool.js";

test("warm pool schedules by owner, provider, region, profile, and capability without sharing sessions", () => {
  const pool = new WarmBrowserSessionPool(2, () => 100);
  pool.put({ id: "warm-us", ownerId: 7, provider: "e2b", region: "us-east", profileId: "profile-7", state: "ready", capabilities: ["headed"], createdAt: 1, lastUsedAt: 10 });
  pool.put({ id: "warm-eu", ownerId: 7, provider: "e2b", region: "eu-west", profileId: "profile-7", state: "ready", capabilities: ["headed", "kernel"] });
  pool.put({ id: "other", ownerId: 8, provider: "e2b", region: "us-east", profileId: "profile-8", state: "ready", capabilities: ["headed"] });
  const selected = pool.checkout({ ownerId: 7, region: "eu-west", profileId: "profile-7", capabilities: ["kernel"] });
  assert.equal(selected?.id, "warm-eu");
  assert.equal(pool.checkout({ ownerId: 8, region: "us-east", profileId: "profile-7" }), undefined);
  assert.equal(pool.get("warm-eu")?.leaseId, undefined);
});

test("CDP broker returns only owner-bound opaque tickets and never the provider URL", () => {
  let now = 10_000;
  const broker = new CdpSessionBroker(1_000, () => now);
  const raw = "wss://provider.example/devtools/browser/secret-token";
  const issued = broker.issue({ ownerId: 7, leaseId: "br_12345678", provider: "kernel", cdpUrl: raw });
  assert.doesNotMatch(JSON.stringify(issued), /provider\.example|secret-token/);
  assert.equal(broker.resolveInternal(issued.ticket, 8, issued.leaseId), undefined);
  assert.equal(broker.resolveInternal(issued.ticket, 7, issued.leaseId), raw);
  now += 10_001;
  assert.equal(broker.resolveInternal(issued.ticket, 7, issued.leaseId), undefined);
});

test("profile state is encrypted and account-bound", () => {
  const store = new EncryptedBrowserProfileStore("profile-secret");
  const envelope = store.seal(7, "profile-7", "kernel", { cookies: [{ name: "session", value: "private" }] });
  assert.doesNotMatch(envelope.ciphertext, /private|session/);
  assert.deepEqual(store.open(7, envelope), { cookies: [{ name: "session", value: "private" }] });
  assert.throws(() => store.open(8, envelope), /not owned/);
});

test("refs fail closed after navigation, DOM regeneration, or URL change", () => {
  const refs = new BrowserRefRegistry(10_000, () => 100);
  const ref = refs.issue({ ownerId: 7, nodeId: "node-1", observationId: "obs-1", pageGeneration: 1, url: "https://example.test/a" });
  assert.equal(refs.assertFresh(ref.ref, 7, { observationId: "obs-1", pageGeneration: 1, url: "https://example.test/a" }).nodeId, "node-1");
  assert.throws(() => refs.assertFresh(ref.ref, 7, { observationId: "obs-2", pageGeneration: 2, url: "https://example.test/b" }), /stale/);
  assert.equal(refs.invalidateForObservation(7, undefined, { observationId: "obs-2", pageGeneration: 2, url: "https://example.test/b" }), 1);
});

test("manager acquires, reconnects, renews, and releases a provider-neutral lease", async () => {
  let reconnects = 0;
  const manager = new BrowserSessionManager({ maxSessionsPerOwner: 1, now: () => 1_000 });
  manager.register({
    provider: "e2b", regions: ["us-east", "eu-west"],
    async acquire(request) { return { backendId: "sandbox-1", provider: "e2b", region: request.region, profileId: request.profileId, capabilities: ["headed", "snapshot"], reconnectable: true, cdpUrl: "wss://provider.example/cdp/secret" }; },
    async reconnect(session) { reconnects += 1; return { ...session, region: "eu-west" }; },
    async renew() {},
    async release() {},
  });
  const lease = await manager.acquire({ ownerId: 7, preferredProvider: "e2b", preferredRegion: "us-east", profileId: "profile-7" });
  assert.equal(lease.region, "us-east");
  assert.match(lease.cdpBrokerTicket ?? "", /^cdp_/);
  await assert.rejects(() => manager.execute({ ownerId: 7, leaseId: lease.leaseId, action: "purchase" }, async () => true), /requires an explicit matching approval/);
  assert.equal(await manager.execute({ ownerId: 7, leaseId: lease.leaseId, action: "search" }, async () => "ok"), "ok");
  await manager.reconnect(7, lease.leaseId);
  assert.equal(reconnects, 1);
  await manager.renew(7, lease.leaseId, 20_000);
  await manager.release(7, lease.leaseId);
  assert.equal(manager.activeFor(7), 0);
});

test("browser metrics expose bounded latency percentiles and challenge rate", () => {
  const metrics = new BrowserMetrics(100);
  metrics.record({ kind: "action", provider: "e2b", status: "success", durationMs: 10 });
  metrics.record({ kind: "action", provider: "e2b", status: "failure", durationMs: 30 });
  metrics.record({ kind: "challenge", provider: "kernel", status: "solved", durationMs: 50, challengeType: "press_and_hold" });
  const action = metrics.summary({ kind: "action", provider: "e2b" });
  assert.deepEqual({ count: action.count, failures: action.failures, p50Ms: action.p50Ms, p95Ms: action.p95Ms }, { count: 2, failures: 1, p50Ms: 10, p95Ms: 30 });
  assert.equal(metrics.summary({ kind: "challenge", provider: "kernel" }).challengeRate, 1);
});
