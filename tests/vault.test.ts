import assert from "node:assert/strict";
import test from "node:test";
import { chuckTools, validateNativeToolArguments } from "../src/agentTools.js";
import { decryptCredential, encryptCredential } from "../src/vault/crypto.js";
import { classifyBrowserTarget, vaultActionPolicy } from "../src/vault/policy.js";
import { normaliseVaultOrigin, normaliseVaultService } from "../src/vault/vault.js";
import { redactVaultAudit } from "../src/vault/audit.js";

const masterKey = Buffer.alloc(32, 7).toString("base64url");

test("vault encryption uses a random envelope and restores only within the trusted process", () => {
  const first = encryptCredential({ username: "person@example.com", password: "not-returned" }, masterKey);
  const second = encryptCredential({ username: "person@example.com", password: "not-returned" }, masterKey);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(decryptCredential(first, masterKey), { username: "person@example.com", password: "not-returned" });
  assert.throws(() => decryptCredential(first, Buffer.alloc(32, 8).toString("base64url")));
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

test("vault action policy keeps browsing/cart autonomous but interlocks payment and account destruction", () => {
  assert.equal(vaultActionPolicy("add_to_cart"), "auto");
  assert.equal(vaultActionPolicy("place_order"), "approval_required");
  assert.equal(vaultActionPolicy("delete_account"), "blocked");
  assert.equal(classifyBrowserTarget("Add to cart"), "add_to_cart");
  assert.equal(classifyBrowserTarget("Proceed to checkout"), "place_order");
  assert.equal(classifyBrowserTarget("Delete my account"), "delete_account");
});

test("vault audit records retain identifiers and keys only, never raw values", () => {
  const entry = redactVaultAudit({ userId: 99, event: "login_succeeded", service: "amazon", metadata: { origin: "https://www.amazon.com", password: { never: "stored" } } });
  assert.match(entry.userHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(entry.metadata, { origin: "https://www.amazon.com", password: "[redacted]" });
  assert.equal(JSON.stringify(entry).includes("stored"), false);
});
