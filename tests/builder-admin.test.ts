import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { config } from "../src/config.js";
import { registerBuilderAdmin, builderRole, freshBuilderSession, type BuilderSession } from "../src/builderAdmin.js";
import { BuilderExecutionGate, parseBuilderControl, type BuilderControl, type BuilderAuditEvent, type BuilderRepository } from "../src/builderControl.js";

const identity = (): BuilderSession => ({ user: { id: "builder-id", name: "Builder", emailVerified: true, twoFactorEnabled: true }, session: { token: "test-session-token", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
class Repository implements BuilderRepository {
  state: BuilderControl = { version: 0, agentEnabled: true };
  audit: BuilderAuditEvent[] = [];
  verifiedTokens = new Set(["test-session-token"]);
  allowed = true;
  async read() { return this.state; }
  async change(expected: number, enabled: boolean, event: BuilderAuditEvent) {
    if (expected !== this.state.version) return undefined;
    this.state = { version: expected + 1, agentEnabled: enabled, changedAt: event.at };
    this.audit.unshift({ ...event, version: this.state.version }); return this.state;
  }
  async events() { return this.audit; }
  async record(event: BuilderAuditEvent) { this.audit.push(event); }
  async verified(token: string) { return this.verifiedTokens.has(token); }
  async verify(token: string) { this.verifiedTokens.add(token); }
  async admit() { return this.allowed; }
}
function setup(options: { session?: BuilderSession | null; role?: "builder_admin" | "builder_viewer" | null; enabled?: boolean; totpFailure?: boolean } = {}) {
  const repo = new Repository(); const app = new Hono();
  registerBuilderAdmin(app, {
    enabled: () => options.enabled !== false, session: async () => options.session === undefined ? identity() : options.session,
    role: () => options.role === undefined ? "builder_admin" : options.role ?? undefined, repository: () => repo,
    verifyTotp: async (_headers, code) => { if (options.totpFailure || code !== "123456") throw new Error("Invalid code"); },
    snapshot: async () => ({ uptimeSeconds: 1, storage: {} }),
  });
  const request = (path: string, body?: unknown, extra: Record<string, string> = {}) => app.request(`/builder/v1/${path}`, body === undefined ? { headers: extra } : { method: path === "verify" ? "POST" : "PATCH", headers: { Origin: config.betterAuthTrustedOrigins[0], "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
  return { repo, app, request };
}
test("builder roles use exact immutable account IDs, never emails or organization role", () => {
  assert.equal(builderRole("user", "builder-id", "viewer-id"), undefined);
  assert.equal(builderRole("builder-id", " builder-id ", ""), "builder_admin");
  assert.equal(builderRole("viewer-id", "", "viewer-id"), "builder_viewer");
  assert.equal(builderRole("", "", ""), undefined);
});
test("admin requires an enabled service and a verified, non-impersonated builder cookie", async () => {
  assert.equal((await setup({ enabled: false }).request("access")).status, 503);
  assert.equal((await setup({ session: null }).request("access")).status, 401);
  assert.equal((await setup({ role: null }).request("overview")).status, 403);
  const unverified = identity(); unverified.user.emailVerified = false;
  assert.equal((await setup({ session: unverified }).request("overview")).status, 403);
  const impersonated = identity(); impersonated.session.impersonatedBy = "other";
  assert.equal((await setup({ session: impersonated }).request("overview")).status, 403);
  assert.equal((await setup().request("overview", undefined, { Authorization: "Bearer root-key" })).status, 403);
  const expired = identity(); expired.session.expiresAt = "invalid";
  assert.equal((await setup({ session: expired }).request("access")).status, 401);
});
test("a valid builder must complete MFA, and another session cannot reuse verification", async () => {
  const { repo, request } = setup();
  repo.verifiedTokens.clear();
  assert.equal((await request("overview")).status, 403);
  assert.equal((await request("access")).status, 200);
  assert.equal((await request("verify", { code: "123456" })).status, 200);
  assert.equal((await request("overview")).status, 200);
  assert.equal(repo.audit[0].action, "builder_verified");
  const other = identity(); other.session.token = "another-session";
  assert.equal((await setup({ session: other }).request("overview")).status, 403);
  const failed = setup({ totpFailure: true }); failed.repo.verifiedTokens.clear();
  assert.equal((await failed.request("verify", { code: "123456" })).status, 403);
  assert.equal(failed.repo.audit.length, 0);
});
test("builder changes require permissions, a fresh session, valid origin and bounded JSON", async () => {
  const input = { version: 0, agentEnabled: false, reason: "incident" };
  assert.equal((await setup({ role: "builder_viewer" }).request("controls", input)).status, 403);
  const stale = identity(); stale.session.createdAt = new Date(Date.now() - 16 * 60_000);
  assert.equal(freshBuilderSession(stale), false);
  assert.equal((await setup({ session: stale }).request("controls", input)).status, 403);
  assert.equal((await setup().request("controls", input, { Origin: "https://attacker.example" })).status, 403);
  assert.equal((await setup().request("controls", input, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await setup().request("controls", input, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await setup().request("controls", { ...input, agentEnabled: "false" })).status, 400);
  assert.equal((await setup().request("controls", { ...input, secret: "should-not-be-stored" })).status, 400);
  assert.equal((await setup().request("controls", { ...input, reason: "x".repeat(3000) })).status, 413);
  const limited = setup(); limited.repo.allowed = false;
  assert.equal((await limited.request("controls", input)).status, 429);
});
test("control writes use optimistic concurrency and preserve a reviewable audit event", async () => {
  const { repo, request } = setup(); const input = { version: 0, agentEnabled: false, reason: "incident" };
  const responses = await Promise.all([request("controls", input), request("controls", input)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(repo.state.agentEnabled, false);
  assert.equal(repo.audit.length, 1);
  assert.equal(repo.audit[0].actorId, "builder-id");
  assert.equal((await request("audit")).headers.get("cache-control"), "private, no-store");
});
test("Redis failures block administration without leaking provider errors", async () => {
  const { repo, request } = setup(); repo.read = async () => { throw new Error("redis://private-token@host"); };
  const response = await request("controls");
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private-token"));
});
test("execution controls cache concurrent reads, observe pauses, and fail closed on outages", async () => {
  let now = 0; let reads = 0; let state = { version: 0, agentEnabled: true };
  const gate = new BuilderExecutionGate(async () => { reads++; return state; }, () => now);
  await Promise.all([gate.assertEnabled(), gate.assertEnabled()]);
  assert.equal(reads, 1);
  await gate.assertEnabled(); assert.equal(reads, 1);
  state = { version: 1, agentEnabled: false }; now = 5001;
  await assert.rejects(gate.assertEnabled(), /paused/);
  gate.invalidate(); state = { version: 2, agentEnabled: true };
  await gate.assertEnabled();
  const failed = new BuilderExecutionGate(async () => { throw new Error("unavailable"); });
  await assert.rejects(failed.assertEnabled(), /unavailable/);
  assert.deepEqual(parseBuilderControl(null), { version: 0, agentEnabled: true });
  assert.throws(() => parseBuilderControl('{"version":0,"agentEnabled":"true"}'));
});
test("an in-flight read cannot overwrite a newer local control write", async () => {
  let release!: (state: BuilderControl) => void; let reads = 0;
  const gate = new BuilderExecutionGate(() => ++reads === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ version: 1, agentEnabled: false }));
  const pending = gate.assertEnabled(); gate.invalidate();
  release({ version: 0, agentEnabled: true });
  await assert.rejects(pending, /paused/);
});
