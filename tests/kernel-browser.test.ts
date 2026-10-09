import test from "node:test";
import assert from "node:assert/strict";
import { CaptchaTracker, waitForChallengeClear } from "../e2b/browser-template/kernel-controller.mjs";
import { kernelLiveViewUrl } from "../src/lib/e2b/kernel.js";
import { config } from "../src/config.js";
import { E2BBrowserEngine } from "../src/lib/e2b/browser.js";
import { initStore, getSession, saveSession } from "../src/store.js";
import Kernel from "@onkernel/sdk";
import { Sandbox } from "e2b";


test("unordered CAPTCHA telemetry never constitutes page success", () => {
  let now = 0;
  const tracker = new CaptchaTracker(() => now, 1000);
  tracker.accept({ type: "captcha_solve_result", data: { task_id: "one", status: "success" } });
  tracker.accept({ type: "captcha_solve_started", data: { task_id: "one" } });
  assert.deepEqual(tracker.snapshot(), { pending: false, results: ["success"], challengeResults: [], pageVerificationRequired: true });
  tracker.accept({ type: "captcha_solve_started", data: { task_id: "two" } });
  assert.equal(tracker.snapshot().pending, true);
  now = 1001;
  assert.equal(tracker.snapshot().pending, false);
});

test("current challenge telemetry keeps press-and-hold terminal outcomes without a task id", () => {
  const tracker = new CaptchaTracker();
  tracker.accept({ type: "captcha_challenge_result", data: { challenge_id: "challenge-one", captcha_provider: "human", task_kind: "press_and_hold", status: "failure" } });
  assert.deepEqual(tracker.snapshot(), { pending: false, results: [], challengeResults: ["failure"], pageVerificationRequired: true });
  assert.equal(tracker.terminalSince(0)?.status, "failure");
});

test("challenge wait returns promptly on a terminal solver failure", async () => {
  let now = 0;
  const tracker = new CaptchaTracker(() => now, 1000);
  const options = { timeoutMs: 1000, now: () => now, tracker, afterSequence: tracker.cursor(), sleep: async () => {
    tracker.accept({ type: "captcha_solve_result", data: { captcha_provider: "human", task_kind: "press_and_hold", status: "failure" } });
    now += 100;
  } };
  const outcome = await waitForChallengeClear(async () => ({ detected: true, type: "captcha" }), options);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.terminalStatus, "failure");
});

test("challenge wait verifies clearance and stops at its deadline", async () => {
  let now = 0;
  const options = { timeoutMs: 1000, now: () => now, sleep: async (ms: number) => { now += ms; } };
  const cleared = await waitForChallengeClear(async () => ({ detected: now < 500, type: "captcha" }), options);
  assert.equal(cleared.verified, true);
  now = 0;
  const blocked = await waitForChallengeClear(async () => ({ detected: true, type: "captcha" }), options);
  assert.equal(blocked.verified, false);
  assert.equal(blocked.timedOut, true);
  assert.equal(now, 1000);
});

test("MFA does not enter the automated solver wait; cancellation fails closed", async () => {
  let slept = false;
  const outcome = await waitForChallengeClear(async () => ({ detected: true, type: "mfa" }), { timeoutMs: 1000, sleep: async () => { slept = true; } });
  assert.equal(slept, false);
  assert.equal(outcome.verified, false);
  await assert.rejects(waitForChallengeClear(async () => ({ detected: false }), { timeoutMs: 1000, signal: AbortSignal.abort() }), /cancelled/);
});

test("private live view URLs cannot point at unrelated or insecure origins", () => {
  assert.equal(kernelLiveViewUrl("https://browser.onkernel.com/live?id=private"), "https://browser.onkernel.com/live?id=private");
  for (const url of ["http://browser.onkernel.com", "https://onkernel.com.attacker.test", "https://owner:secret@browser.onkernel.com", "file:///etc/passwd"]) assert.throws(() => kernelLiveViewUrl(url));
});

test("Kernel rejects shared access, model credentials and foreign auth IDs before provider dispatch", async () => {
  await initStore({ memoryOnly: true });
  const previous = { browserProvider: config.browserProvider, kernelApiKey: config.kernelApiKey };
  Object.assign(config, { browserProvider: "kernel", kernelApiKey: "test-key-not-live" });
  try {
    const engine = new E2BBrowserEngine();
    await assert.rejects(engine.browser(961001, { action: "status" }), /owner.*private/);
    await assert.rejects(engine.browser(961001, { action: "auth_start", password: "not-a-real-secret" }, { ownerPrivateRun: true }), /metadata/);
    await assert.rejects(engine.browser(961001, { action: "auth_status", authId: "another-owner" }, { ownerPrivateRun: true }), /not found for this owner/);
  } finally { Object.assign(config, previous); }
});

test("managed auth verifies ownership binding and does not restart active login", async (t) => {
  await initStore({ memoryOnly: true });
  const previous = { browserProvider: config.browserProvider, kernelApiKey: config.kernelApiKey };
  Object.assign(config, { browserProvider: "kernel", kernelApiKey: "test-key-not-live" });
  const owner = 961002;
  const session = await getSession(owner);
  session.kernelAuthConnections = [{ id: "auth-owned", domain: "example.com", profileId: "profile-owned", profileName: "owned-profile", accountAlias: "default" }];
  await saveSession(owner, session);
  const client = new Kernel({ apiKey: "test" });
  const proto = Object.getPrototypeOf(client.auth.connections);
  let changed = false;
  t.mock.method(proto, "retrieve", async () => ({ profile_name: changed ? "foreign-profile" : "owned-profile", domain: "example.com", status: "NEEDS_AUTH", flow_status: "IN_PROGRESS" }));
  const login = t.mock.method(proto, "login", async () => { throw new Error("must not restart login"); });
  try {
    const engine = new E2BBrowserEngine();
    const result = await engine.browser(owner, { action: "auth_status", authId: "auth-owned" }, { ownerPrivateRun: true }) as { status: string };
    assert.equal(result.status, "NEEDS_AUTH");
    await assert.rejects(engine.browser(owner, { action: "auth_resume", authId: "auth-owned" }, { ownerPrivateRun: true }), /not completed successfully/);
    assert.equal(login.mock.callCount(), 0);
    changed = true;
    await assert.rejects(engine.browser(owner, { action: "auth_status", authId: "auth-owned" }, { ownerPrivateRun: true }), /identity changed/);
  } finally { Object.assign(config, previous); }
});

test("uncertain controller recovery preserves the retained browser and never creates a replacement", async (t) => {
  await initStore({ memoryOnly: true });
  const previous = { browserProvider: config.browserProvider, kernelApiKey: config.kernelApiKey, e2bEnabled: config.e2bEnabled, e2bApiKey: config.e2bApiKey };
  Object.assign(config, { browserProvider: "kernel", kernelApiKey: "test", e2bEnabled: true, e2bApiKey: "test" });
  const owner = 961003;
  const session = await getSession(owner);
  session.e2bBrowser = { sandboxId: "controller-owned", kernel: { sessionId: "remote-owned", profileId: "profile-owned" }, createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 60_000 };
  await saveSession(owner, session);
  t.mock.method(Sandbox, "connect", async () => { throw new Error("uncertain connection failure"); });
  const client = new Kernel({ apiKey: "test" });
  const created = t.mock.method(Object.getPrototypeOf(client.browsers), "create", async () => { throw new Error("must not create replacement"); });
  try {
    await assert.rejects(new E2BBrowserEngine().browser(owner, { action: "start" }, { ownerPrivateRun: true }), /no browser action was replayed/);
    assert.equal(created.mock.callCount(), 0);
    assert.equal((await getSession(owner)).e2bBrowser?.kernel?.sessionId, "remote-owned");
  } finally { Object.assign(config, previous); }
});

test("stopping an already expired remote browser still closes its controller", async (t) => {
  await initStore({ memoryOnly: true });
  const previous = { browserProvider: config.browserProvider, kernelApiKey: config.kernelApiKey };
  Object.assign(config, { browserProvider: "kernel", kernelApiKey: "test" });
  const owner = 961004;
  const session = await getSession(owner);
  session.e2bBrowser = { sandboxId: "controller-owned", kernel: { sessionId: "remote-owned", profileId: "profile-owned" }, createdAt: 1, updatedAt: 1, expiresAt: 2 };
  await saveSession(owner, session);
  const client = new Kernel({ apiKey: "test" });
  t.mock.method(Object.getPrototypeOf(client.browsers), "deleteByID", async () => { throw Object.assign(new Error("gone"), { status: 404 }); });
  const killed = t.mock.method(Sandbox, "kill", async () => true);
  try {
    const result = await new E2BBrowserEngine().browser(owner, { action: "stop" }, { ownerPrivateRun: true }) as { stopped: boolean; provider: string };
    assert.equal(result.stopped, true);
    assert.equal(result.provider, "kernel");
    assert.equal(killed.mock.callCount(), 1);
    assert.equal((await getSession(owner)).e2bBrowser, undefined);
  } finally { Object.assign(config, previous); }
});

test("partially provisioned browser blocks replacement until cleanup", async (t) => {
  await initStore({ memoryOnly: true });
  const previous = { browserProvider: config.browserProvider, kernelApiKey: config.kernelApiKey, e2bEnabled: config.e2bEnabled, e2bApiKey: config.e2bApiKey };
  Object.assign(config, { browserProvider: "kernel", kernelApiKey: "test", e2bEnabled: true, e2bApiKey: "test" });
  const owner = 961005;
  const session = await getSession(owner);
  session.kernelBrowserPending = { sessionId: "pending-remote", profileId: "profile-owned", createdAt: Date.now() };
  await saveSession(owner, session);
  const client = new Kernel({ apiKey: "test" });
  const removed = t.mock.method(Object.getPrototypeOf(client.browsers), "deleteByID", async () => undefined);
  try {
    const engine = new E2BBrowserEngine();
    await assert.rejects(engine.browser(owner, { action: "start" }, { ownerPrivateRun: true }), /partially created/);
    await engine.browser(owner, { action: "stop" }, { ownerPrivateRun: true });
    assert.equal(removed.mock.callCount(), 1);
    assert.equal((await getSession(owner)).kernelBrowserPending, undefined);
  } finally { Object.assign(config, previous); }
});

test("a lost create response retains a provider-resolvable name instead of duplicating creation", async (t) => {
  await initStore({ memoryOnly: true });
  const previous = { browserProvider: config.browserProvider, kernelApiKey: config.kernelApiKey, e2bEnabled: config.e2bEnabled, e2bApiKey: config.e2bApiKey };
  Object.assign(config, { browserProvider: "kernel", kernelApiKey: "test", e2bEnabled: true, e2bApiKey: "test" });
  const owner = 961006;
  const session = await getSession(owner);
  session.kernelBrowserProfileId = "profile-owned";
  await saveSession(owner, session);
  const client = new Kernel({ apiKey: "test" });
  const created = t.mock.method(Object.getPrototypeOf(client.browsers), "create", async () => { throw new Error("lost create response"); });
  const removed = t.mock.method(Object.getPrototypeOf(client.browsers), "deleteByID", async () => undefined);
  try {
    const engine = new E2BBrowserEngine();
    await assert.rejects(engine.browser(owner, { action: "start" }, { ownerPrivateRun: true }), /lost create response/);
    const pending = (await getSession(owner)).kernelBrowserPending;
    assert.match(pending?.sessionId ?? "", /^chusky-961006-/);
    await assert.rejects(engine.browser(owner, { action: "start" }, { ownerPrivateRun: true }), /partially created/);
    assert.equal(created.mock.callCount(), 1);
    await engine.browser(owner, { action: "stop" }, { ownerPrivateRun: true });
    assert.equal(removed.mock.calls[0].arguments[0], pending?.sessionId);
  } finally { Object.assign(config, previous); }
});
