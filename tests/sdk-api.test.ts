import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { Hono } from "hono";
import { config } from "../src/config.js";
import { registerSdkApi, setWebAuthSessionResolverForTests } from "../src/sdkApi.js";
import { getSession, initStore } from "../src/store.js";

beforeEach(async () => {
  (config as { apiKey: string }).apiKey = "sdk-test-key";
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = false;
  setWebAuthSessionResolverForTests();
  await initStore({ memoryOnly: true });
});

function app(): Hono { const value = new Hono(); registerSdkApi(value); return value; }
function request(body: unknown, key = "idem_1") { return new Request("http://local/v1/threads", { method: "POST", headers: { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "tenant-user", "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }); }

test("SDK thread creation is authenticated, replay-safe, and rejects key/body mismatches", async () => {
  const api = app();
  const first = await api.fetch(request({ metadata: { source: "test" } }));
  assert.equal(first.status, 201); const created = await first.json() as { id: string };
  const replay = await api.fetch(request({ metadata: { source: "test" } }));
  assert.equal(replay.status, 201); assert.equal((await replay.json() as { id: string }).id, created.id);
  const mismatch = await api.fetch(request({ metadata: { source: "changed" } }));
  assert.equal(mismatch.status, 409); const mismatchBody = await mismatch.json() as { error: { code: string; requestId: string } }; assert.equal(mismatchBody.error.code, "idempotency_mismatch"); assert.equal(mismatch.headers.get("x-request-id"), mismatchBody.error.requestId);
  const forbidden = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: { "X-Chusky-User-Id": "tenant-user" } }));
  assert.equal(forbidden.status, 401);
});

test("SDK conversation lifecycle is owned, archive-aware, and protects active runs", async () => {
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "lifecycle-user", "Content-Type": "application/json" };
  const created = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers, body: JSON.stringify({ metadata: { title: "Original" } }) }));
  assert.equal(created.status, 201);
  const thread = await created.json() as { id: string; metadata: Record<string, unknown> };
  const renamed = await api.fetch(new Request(`http://local/v1/threads/${thread.id}`, { method: "PATCH", headers, body: JSON.stringify({ title: "Renamed" }) }));
  assert.equal(renamed.status, 200); assert.equal((await renamed.json() as typeof thread).metadata.title, "Renamed");
  const archived = await api.fetch(new Request(`http://local/v1/threads/${thread.id}`, { method: "PATCH", headers, body: JSON.stringify({ archived: true }) }));
  assert.equal(archived.status, 200);
  const activeThreads = await api.fetch(new Request("http://local/v1/threads", { headers }));
  assert.equal((await activeThreads.json() as { data: unknown[] }).data.length, 0);
  const allThreads = await api.fetch(new Request("http://local/v1/threads?includeArchived=true", { headers }));
  assert.equal((await allThreads.json() as { data: unknown[] }).data.length, 1);
  const invalid = await api.fetch(new Request(`http://local/v1/threads/${thread.id}`, { method: "PATCH", headers, body: JSON.stringify({ title: "x".repeat(121) }) }));
  assert.equal(invalid.status, 400);
  const deleted = await api.fetch(new Request(`http://local/v1/threads/${thread.id}`, { method: "DELETE", headers }));
  assert.equal(deleted.status, 204);
  const missing = await api.fetch(new Request(`http://local/v1/threads/${thread.id}`, { method: "DELETE", headers }));
  assert.equal(missing.status, 404);
});

test("SDK file intents enforce the configured allowlist and maximum size before storage access", async () => {
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "tenant-user", "Content-Type": "application/json" };
  const response = await api.fetch(new Request("http://local/v1/files", { method: "POST", headers, body: JSON.stringify({ name: "unsafe.exe", contentType: "application/x-msdownload", size: 10 }) }));
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_file");
});

test("SDK webhook creation replays the same subscription on a lost response", async () => {
  const api = app();
  const headers = { Authorization: "Bearer sdk-test-key", "X-Chusky-User-Id": "tenant-user", "Content-Type": "application/json", "Idempotency-Key": "webhook_once" };
  const create = () => new Request("http://local/v1/webhooks", { method: "POST", headers, body: JSON.stringify({ url: "https://hooks.example.test/chusky" }) });
  const first = await api.fetch(create());
  assert.equal(first.status, 201); const created = await first.json() as { id: string; secret: string };
  const replay = await api.fetch(create());
  assert.equal(replay.status, 201); const replayed = await replay.json() as { id: string; secret: string };
  assert.deepEqual(replayed, created);
  const list = await api.fetch(new Request("http://local/v1/webhooks", { headers }));
  assert.equal((await list.json() as { data: unknown[] }).data.length, 1);
  const remove = await api.fetch(new Request(`http://local/v1/webhooks/${created.id}`, { method: "DELETE", headers }));
  assert.equal(remove.status, 204);
  const empty = await api.fetch(new Request("http://local/v1/webhooks", { headers }));
  assert.equal((await empty.json() as { data: unknown[] }).data.length, 0);
});

test("root key provisions hash-only project keys with isolated SDK users and revocation", async () => {
  const api = app();
  const root = { Authorization: "Bearer sdk-test-key", "Content-Type": "application/json" };
  const provision = await api.fetch(new Request("http://local/v1/admin/projects", { method: "POST", headers: root, body: JSON.stringify({ name: "Acme" }) }));
  assert.equal(provision.status, 201); const project = await provision.json() as { id: string; key: string };
  assert.equal((await getSession(0)).sdkAudit?.some((entry) => entry.action === "POST /v1/admin/projects" && entry.status === 201), true);
  const adminAudit = await api.fetch(new Request("http://local/v1/admin/audit-events", { headers: root }));
  assert.equal((await adminAudit.json() as { data: Array<{ action: string }> }).data.some((entry) => entry.action === "POST /v1/admin/projects"), true);
  const headers = { Authorization: `Bearer ${project.key}`, "X-Chusky-User-Id": "shared-user", "Content-Type": "application/json" };
  const created = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers, body: "{}" }));
  assert.equal(created.status, 201);
  const restrict = await api.fetch(new Request(`http://local/v1/admin/projects/${project.id}`, { method: "PATCH", headers: root, body: JSON.stringify({ scopes: ["threads:read"] }) }));
  assert.equal(restrict.status, 200);
  const nowDenied = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers, body: "{}" }));
  assert.equal(nowDenied.status, 403);
  const rotatedResponse = await api.fetch(new Request(`http://local/v1/admin/projects/${project.id}/rotate-key`, { method: "POST", headers: root, body: "{}" }));
  assert.equal(rotatedResponse.status, 201); const rotated = await rotatedResponse.json() as { key: string };
  const stale = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers, body: "{}" }));
  assert.equal(stale.status, 401);
  const newHeaders = { ...headers, Authorization: `Bearer ${rotated.key}` };
  const fresh = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: newHeaders, body: "{}" }));
  assert.equal(fresh.status, 403);
  const revoke = await api.fetch(new Request(`http://local/v1/admin/projects/${project.id}`, { method: "DELETE", headers: root }));
  assert.equal(revoke.status, 204);
  const denied = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: newHeaders, body: "{}" }));
  assert.equal(denied.status, 401);
  const projects = await api.fetch(new Request("http://local/v1/admin/projects", { headers: root }));
  assert.equal(JSON.stringify(await projects.json()).includes(project.key), false);
});

test("root-only admin routes never require an SDK end-user header", async () => {
  const api = app();
  const response = await api.fetch(new Request("https://chusky.selithub.shop/v1/admin/projects", { headers: { Authorization: "Bearer sdk-test-key" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [] });
});

test("project scopes are enforced at the v1 boundary", async () => {
  const api = app(); const root = { Authorization: "Bearer sdk-test-key", "Content-Type": "application/json" };
  const provision = await api.fetch(new Request("http://local/v1/admin/projects", { method: "POST", headers: root, body: JSON.stringify({ name: "Read only", scopes: ["threads:read"] }) }));
  const project = await provision.json() as { key: string };
  const headers = { Authorization: `Bearer ${project.key}`, "X-Chusky-User-Id": "customer", "Content-Type": "application/json" };
  const response = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers, body: "{}" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "insufficient_scope");
});

test("verified dashboard users can only manage their own bounded project keys", async () => {
  (config as { betterAuthEnabled: boolean }).betterAuthEnabled = true;
  setWebAuthSessionResolverForTests(async (headers) => {
    const id = headers.get("x-test-web-user");
    return id ? { user: { id, emailVerified: headers.get("x-test-verified") !== "false" } } : null;
  });
  const api = app();
  const web = (user: string, path: string, init: RequestInit = {}) => new Request(`http://local/v1${path}`, {
    ...init,
    headers: { "X-Test-Web-User": user, "X-Test-Verified": "true", "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

  const unauthenticated = await api.fetch(new Request("http://local/v1/account/projects"));
  assert.equal(unauthenticated.status, 401);
  const unverified = await api.fetch(web("unverified", "/account/projects", { method: "POST", headers: { "X-Test-Verified": "false" }, body: JSON.stringify({ name: "Nope" }) }));
  assert.equal(unverified.status, 403);
  assert.equal((await unverified.json() as { error: { code: string } }).error.code, "email_verification_required");

  const root = { Authorization: "Bearer sdk-test-key", "Content-Type": "application/json" };
  await api.fetch(new Request("http://local/v1/admin/projects", { method: "POST", headers: root, body: JSON.stringify({ name: "Operator only" }) }));
  const create = await api.fetch(web("alice", "/account/projects", { method: "POST", body: JSON.stringify({ name: "Production" }) }));
  assert.equal(create.status, 201);
  const created = await create.json() as { id: string; key: string; keyPrefix: string; scopes: string[] };
  assert.match(created.key, /^chsk_/);
  assert.deepEqual(created.scopes, ["*"]);
  const control = await getSession(0);
  const stored = control.sdkProjects!.find((project) => project.id === created.id)!;
  assert.equal(stored.ownerWebAuthUserId, "alice");
  assert.notEqual(stored.keyHash, created.key);
  assert.equal(JSON.stringify(await api.fetch(web("alice", "/account/projects")).then((response) => response.json())).includes(created.key), false);
  assert.deepEqual((await api.fetch(web("bob", "/account/projects")).then((response) => response.json()) as { data: unknown[] }).data, []);

  const otherUser = await api.fetch(web("bob", `/account/projects/${created.id}`, { method: "PATCH", body: JSON.stringify({ scopes: ["threads:read"] }) }));
  assert.equal(otherUser.status, 404);
  const invalidScopes = await api.fetch(web("alice", "/account/projects", { method: "POST", body: JSON.stringify({ name: "Invalid", scopes: ["admin:write"] }) }));
  assert.equal(invalidScopes.status, 400);
  const update = await api.fetch(web("alice", `/account/projects/${created.id}`, { method: "PATCH", body: JSON.stringify({ scopes: ["threads:read"] }) }));
  assert.equal(update.status, 200);
  const rotatedResponse = await api.fetch(web("alice", `/account/projects/${created.id}/rotate-key`, { method: "POST" }));
  assert.equal(rotatedResponse.status, 201);
  const rotated = await rotatedResponse.json() as { key: string };
  const stale = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: { Authorization: `Bearer ${created.key}`, "X-Chusky-User-Id": "customer" }, body: "{}" }));
  assert.equal(stale.status, 401);
  const revoke = await api.fetch(web("alice", `/account/projects/${created.id}`, { method: "DELETE" }));
  assert.equal(revoke.status, 204);
  const revoked = await api.fetch(new Request("http://local/v1/threads", { method: "POST", headers: { Authorization: `Bearer ${rotated.key}`, "X-Chusky-User-Id": "customer" }, body: "{}" }));
  assert.equal(revoked.status, 401);

  for (let index = 0; index < 10; index += 1) {
    const response = await api.fetch(web("alice", "/account/projects", { method: "POST", body: JSON.stringify({ name: `Key ${index}` }) }));
    assert.equal(response.status, 201);
  }
  const overLimit = await api.fetch(web("alice", "/account/projects", { method: "POST", body: JSON.stringify({ name: "Too many" }) }));
  assert.equal(overLimit.status, 409);
  assert.equal((await overLimit.json() as { error: { code: string } }).error.code, "project_limit_reached");
});
