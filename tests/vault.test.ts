import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chuckTools, validateNativeToolArguments } from "../src/agentTools.js";
import { decryptCredential, encryptCredential } from "../src/vault/crypto.js";
import { classifyBrowserTarget, vaultActionPolicy } from "../src/vault/policy.js";
import { normaliseVaultOrigin, normaliseVaultService } from "../src/vault/vault.js";
import { redactVaultAudit } from "../src/vault/audit.js";
import { browserSessionIsRevoked, classifyBrowserIntent, createBrowserOperationPlan, normalizePlaybook, sessionHealth, verifyBrowserResult } from "../src/vault/browserOps.js";
import { getBrowserHandoff, initStore, listBrowserHandoffs, saveBrowserHandoff, updateBrowserHandoff } from "../src/store.js";

const masterKey = Buffer.alloc(32, 7).toString("base64url");

test("vault encryption uses a random envelope and restores only within the trusted process", () => {
  const first = encryptCredential({ username: "person@example.com", password: "not-returned" }, masterKey);
  const second = encryptCredential({ username: "person@example.com", password: "not-returned" }, masterKey);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(decryptCredential(first, masterKey), { username: "person@example.com", password: "not-returned" });
  assert.throws(() => decryptCredential(first, Buffer.alloc(32, 8).toString("base64url")));
});

test("envelope encryption supports separately named account-connection keys", () => {
  const connectionKey = Buffer.alloc(32, 9).toString("base64url");
  const encrypted = encryptCredential({ accessToken: "token" }, connectionKey, "MCP_CONNECTION_ENCRYPTION_KEY");
  assert.deepEqual(decryptCredential(encrypted, connectionKey, "MCP_CONNECTION_ENCRYPTION_KEY"), { accessToken: "token" });
  assert.throws(() => decryptCredential(encrypted, Buffer.alloc(32, 10).toString("base64url"), "MCP_CONNECTION_ENCRYPTION_KEY"));
});

test("model-facing vault tool schemas cannot carry credential material", () => {
  const names = ["CHUCK_VAULT_SAVE", "CHUCK_VAULT_LIST", "CHUCK_VAULT_STATUS", "CHUCK_VAULT_LOGIN", "CHUCK_VAULT_LOGOUT"];
  for (const name of names) {
    const tool = chuckTools.find((candidate) => candidate.function.name === name);
    assert.ok(tool, `${name} is exposed`);
    const props = Object.keys((tool!.function.parameters as { properties?: Record<string, unknown> }).properties ?? {});
    assert.equal(props.some((key) => /^(password|credential|cookie|secret|token|username)$/i.test(key)), false, `${name} must not accept secret material`);
  }
  validateNativeToolArguments("CHUCK_VAULT_LOGIN", { service: "amazon" });
  assert.throws(() => validateNativeToolArguments("CHUCK_VAULT_LOGIN", {}), /requires argument/);
});

test("vault accepts only exact HTTPS origins and stable service names", () => {
  assert.equal(normaliseVaultOrigin("https://www.amazon.com"), "https://www.amazon.com");
  assert.throws(() => normaliseVaultOrigin("http://www.amazon.com"), /HTTPS/);
  assert.throws(() => normaliseVaultOrigin("https://user:pass@example.com"), /clean HTTPS origin/);
  assert.equal(normaliseVaultService("Amazon Prime"), "amazon prime");
  assert.throws(() => normaliseVaultService("amazon<script>"), /unsupported/);
});

test("vault identity selectors stay origin-aware", () => {
  for (const name of ["CHUCK_VAULT_STATUS", "CHUCK_VAULT_LOGIN", "CHUCK_VAULT_LOGOUT", "CHUCK_BROWSER_SESSION_REVOKE"]) {
    const tool = chuckTools.find((candidate) => candidate.function.name === name);
    assert.ok(tool, `${name} is exposed`);
    const properties = (tool!.function.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(Object.hasOwn(properties, "origin"), `${name} must allow exact origin selection`);
  }
  const migration = readFileSync(join(process.cwd(), "cloudflare", "vault-worker", "migrations", "0004_vault_origin_identity.sql"), "utf8");
  assert.match(migration, /UNIQUE\(account_id, service, account_alias, origin\)/);
});

test("vault setup form uses the polished light theme and protected password visibility control", () => {
  const worker = readFileSync(join(process.cwd(), "cloudflare", "vault-worker", "src", "index.ts"), "utf8");
  assert.match(worker, /--amber:#c88719/);
  assert.match(worker, /--ink:#171717/);
  assert.match(worker, /font-family:Georgia/);
  assert.match(worker, /data-password-toggle/);
  assert.match(worker, /type=\"password\"/);
  assert.match(worker, /script-src 'nonce-\$\{nonce\}'/);
  assert.doesNotMatch(worker, /background:#10131a/);
});

test("vault action policy keeps browsing/cart autonomous but interlocks payment and account destruction", () => {
  assert.equal(vaultActionPolicy("add_to_cart"), "auto");
  assert.equal(vaultActionPolicy("place_order"), "approval_required");
  assert.equal(vaultActionPolicy("delete_account"), "blocked");
  assert.equal(classifyBrowserTarget("Add to cart"), "add_to_cart");
  assert.equal(classifyBrowserTarget("Proceed to checkout"), "place_order");
  assert.equal(classifyBrowserTarget("Delete my account"), "delete_account");
  assert.equal(vaultActionPolicy("unknown"), "approval_required");
});

test("vault audit records retain identifiers and keys only, never raw values", () => {
  const entry = redactVaultAudit({ userId: 99, event: "login_succeeded", service: "amazon", metadata: { origin: "https://www.amazon.com", password: { never: "stored" } } });
  assert.match(entry.userHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(entry.metadata, { origin: "https://www.amazon.com", password: "[redacted]" });
  assert.equal(JSON.stringify(entry).includes("stored"), false);
});

test("browser intent classification treats ambiguous and high-impact controls conservatively", () => {
  assert.equal(classifyBrowserIntent({ label: "Subscribe to Pro" }), "place_order");
  assert.equal(classifyBrowserIntent({ label: "Export account statement" }), "download_sensitive");
  assert.equal(classifyBrowserIntent({ label: "Confirm" }), "unknown");
  const plan = createBrowserOperationPlan("Prepare the cart and stop before payment", "https://shop.example.com");
  assert.equal(plan.requiresApproval, false);
  assert.match(plan.stopBefore.join(" "), /payment/i);
});

test("browser playbooks are bounded, origin-scoped, and never accept secret fields", () => {
  const playbook = normalizePlaybook({
    userId: 42,
    service: "shop",
    origin: "https://shop.example.com",
    accountAlias: "work",
    login: { steps: [{ role: "textbox", name: "Email", action: "fill" }], success: [{ urlIncludes: "/home" }] },
    tasks: [],
  });
  assert.equal(playbook.origin, "https://shop.example.com");
  assert.equal(playbook.accountAlias, "work");
  assert.throws(() => normalizePlaybook({
    userId: 42, service: "shop", origin: "https://shop.example.com", accountAlias: "default",
    login: { steps: [], success: [], failure: [] }, tasks: [],
  } as any), /login\.steps/);
});

test("browser session health recommends rechecking stale identities and logging in expired ones", () => {
  const stale = sessionHealth({ service: "shop", origin: "https://shop.example.com", workspaceId: "ws", status: "authenticated", lastUsedAt: Date.now() - 8 * 24 * 60 * 60_000 });
  assert.equal(stale.status, "stale");
  assert.equal(stale.recommendedAction, "recheck");
  const expired = sessionHealth({ service: "shop", origin: "https://shop.example.com", workspaceId: "ws", status: "authenticated", expiresAt: Date.now() - 1 });
  assert.equal(expired.status, "expired");
  assert.equal(expired.recommendedAction, "login");
});

test("revoked or expired browser identities require a fresh vault login", () => {
  const now = Date.now();
  assert.equal(browserSessionIsRevoked({ status: "logged_out" }, now), true);
  assert.equal(browserSessionIsRevoked({ status: "needs_reauth" }, now), true);
  assert.equal(browserSessionIsRevoked({ status: "authenticated", expiresAt: now - 1 }, now), true);
  assert.equal(browserSessionIsRevoked({ status: "authenticated", expiresAt: now + 60_000 }, now), false);
});

test("browser verification requires every required detector and returns no page content", () => {
  const passed = verifyBrowserResult({
    currentUrl: "https://shop.example.com/orders/123",
    title: "Order confirmed",
    text: "Thanks for your purchase",
    detectors: [{ urlIncludes: "/orders/", required: true }, { titleIncludes: "order confirmed", required: true }],
  });
  assert.equal(passed.passed, true);
  assert.deepEqual(passed.missing, []);
  const failed = verifyBrowserResult({ currentUrl: "https://shop.example.com/cart", detectors: [{ textIncludes: "order confirmed", required: true }] });
  assert.equal(failed.passed, false);
  assert.match(failed.missing.join(" "), /order confirmed/i);
  assert.equal(Object.hasOwn(failed, "text"), false);
});

test("browser handoffs are durable, owner-scoped, expiring, and require verification", async () => {
  await initStore({ memoryOnly: true });
  const userId = 99142;
  const now = Date.now();
  await saveBrowserHandoff(userId, { id: "bh_waiting", userId, workspaceId: "ws-1", service: "shop", origin: "https://shop.example.com", reason: "two_factor", status: "waiting", createdAt: now, expiresAt: now + 60_000 });
  assert.equal((await getBrowserHandoff(userId, "bh_waiting"))?.status, "waiting");
  assert.equal((await updateBrowserHandoff(userId, "bh_waiting", "awaiting_verification"))?.status, "awaiting_verification");
  assert.equal((await listBrowserHandoffs(userId))[0]?.status, "awaiting_verification");
  assert.equal(await getBrowserHandoff(userId + 1, "bh_waiting"), undefined);
  await saveBrowserHandoff(userId, { id: "bh_expired", userId, workspaceId: "ws-1", reason: "captcha", status: "waiting", createdAt: now - 120_000, expiresAt: now - 1 });
  assert.equal((await getBrowserHandoff(userId, "bh_expired"))?.status, "expired");
});
