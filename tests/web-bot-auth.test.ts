import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { component, verifySignature, type RequestDescriptor, type ResponseDescriptor } from "http-message-sig";
import { config } from "../src/config.js";
import { createSignedWebBotAuthDirectory, webBotAuthConfigurationIssue, webBotAuthConfigurationStatus, webBotAuthKeyId, webBotAuthSandboxEnvironment, webBotAuthSigningEnabled, WEB_BOT_AUTH_DIRECTORY_PATH } from "../src/webBotAuth.js";
import { createWebBotAuthHeaders } from "../e2b/browser-template/web-bot-auth.mjs";

function testKey() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyB64: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicJwk: pair.publicKey.export({ format: "jwk" }),
    privateKey: pair.privateKey,
  };
}

function testVerifier(jwk: { crv: string; kty: string; x: string }) {
  const keyid = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("base64url");
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  return {
    algorithm: "ed25519",
    keyid,
    verify: (data: Uint8Array, signature: Uint8Array) => cryptoVerify(null, Buffer.from(data), publicKey, Buffer.from(signature)),
  };
}

test("Web Bot Auth configuration is opt-in and validates canonical HTTPS identity", () => {
  const prior = { enabled: config.webBotAuthEnabled, signRequests: config.webBotAuthSignRequests, url: config.webBotAuthDirectoryUrl, key: config.webBotAuthPrivateKeyB64 };
  try {
    config.webBotAuthEnabled = false;
    config.webBotAuthSignRequests = false;
    assert.equal(webBotAuthConfigurationStatus(), "disabled");
    config.webBotAuthSignRequests = true;
    assert.equal(webBotAuthConfigurationStatus(), "misconfigured");
    assert.match(webBotAuthConfigurationIssue() ?? "", /requires WEB_BOT_AUTH_ENABLED/);
    config.webBotAuthEnabled = true;
    config.webBotAuthDirectoryUrl = `http://chusky.example${WEB_BOT_AUTH_DIRECTORY_PATH}`;
    config.webBotAuthPrivateKeyB64 = "not-a-key";
    config.webBotAuthSignRequests = false;
    assert.equal(webBotAuthConfigurationStatus(), "misconfigured");
    assert.match(webBotAuthConfigurationIssue() ?? "", /HTTPS URL/);
    assert.deepEqual(webBotAuthSandboxEnvironment(), {});
  } finally {
    config.webBotAuthEnabled = prior.enabled;
    config.webBotAuthSignRequests = prior.signRequests;
    config.webBotAuthDirectoryUrl = prior.url;
    config.webBotAuthPrivateKeyB64 = prior.key;
  }
});

test("signed directory publishes only the public Ed25519 JWK and verifies as the configured origin", async () => {
  const prior = { enabled: config.webBotAuthEnabled, signRequests: config.webBotAuthSignRequests, url: config.webBotAuthDirectoryUrl, key: config.webBotAuthPrivateKeyB64 };
  const key = testKey();
  const origin = `https://chusky.example${WEB_BOT_AUTH_DIRECTORY_PATH}`;
  try {
    config.webBotAuthEnabled = true;
    config.webBotAuthSignRequests = false;
    config.webBotAuthDirectoryUrl = origin;
    config.webBotAuthPrivateKeyB64 = key.privateKeyB64;
    assert.equal(webBotAuthConfigurationStatus(), "configured");
    assert.equal(webBotAuthSigningEnabled(), false);
    assert.deepEqual(webBotAuthSandboxEnvironment(), {}, "directory-only rollout must not expose the key to E2B");
    const directory = await createSignedWebBotAuthDirectory(origin);
    assert.equal(directory.headers["content-type"], "application/http-message-signatures-directory+json");
    assert.equal(directory.headers["cache-control"], "no-store");
    const body = JSON.parse(directory.body) as { keys: Array<Record<string, string>> };
    assert.equal(body.keys.length, 1);
    assert.deepEqual(Object.keys(body.keys[0]).sort(), ["crv", "kty", "x"]);
    assert.equal(body.keys[0].x, key.publicJwk.x);
    const verifier = testVerifier(key.publicJwk);
    assert.equal(webBotAuthKeyId(), verifier.keyid);

    const request: RequestDescriptor = { kind: "request", method: "GET", targetUri: origin, fields: [{ name: "host", value: "chusky.example" }] };
    const response: ResponseDescriptor = {
      kind: "response", status: 200,
      fields: [
        { name: "signature", value: directory.headers.signature },
        { name: "signature-input", value: directory.headers["signature-input"] },
      ],
      request,
    };
    const verified = await verifySignature(response, {
      policy: {
        algorithms: ["ed25519"],
        requiredComponents: [component("@authority", { req: true })],
        requiredParameters: ["alg", "keyid", "created", "expires", "nonce", "tag"],
        maxAge: 60,
        clockSkew: 10,
      },
      resolveVerifier: (candidate) => {
        assert.equal(candidate.parameters.keyid, verifier.keyid);
        return verifier;
      },
    });
    assert.equal(verified.parameters.tag, "http-message-signatures-directory");
    await assert.rejects(createSignedWebBotAuthDirectory(`https://attacker.example${WEB_BOT_AUTH_DIRECTORY_PATH}`), /origin/);
    config.webBotAuthSignRequests = true;
    assert.equal(webBotAuthSigningEnabled(), true);
    assert.equal(webBotAuthSandboxEnvironment().CHUSKY_WEB_BOT_AUTH_PRIVATE_KEY_B64, key.privateKeyB64);
  } finally {
    config.webBotAuthEnabled = prior.enabled;
    config.webBotAuthSignRequests = prior.signRequests;
    config.webBotAuthDirectoryUrl = prior.url;
    config.webBotAuthPrivateKeyB64 = prior.key;
  }
});

test("E2B request signing binds authority and signature-agent and strips page-supplied identity headers", async () => {
  const key = testKey();
  const privateKey = createPrivateKey({ key: Buffer.from(key.privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  const publicJwk = key.publicJwk;
  const keyId = (await import("node:crypto")).createHash("sha256").update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x })).digest("base64url");
  const signer = { algorithm: "ed25519", sign: (data: Uint8Array) => cryptoSign(null, Buffer.from(data), privateKey) };
  const directoryUrl = `https://chusky.example${WEB_BOT_AUTH_DIRECTORY_PATH}`;
  const headers = await createWebBotAuthHeaders({
    url: "https://shop.example/search?q=phone",
    method: "GET",
    headers: [
      { name: "accept", value: "text/html" },
      { name: "Signature", value: "page-forged" },
      { name: "Signature-Input", value: "page-forged" },
      { name: "Signature-Agent", value: "page-forged" },
    ],
  }, { signer, keyId, directoryUrl, now: new Date(), generateNonce: () => Buffer.alloc(64, 7).toString("base64") });
  assert.equal(headers.filter((header) => header.name.toLowerCase() === "signature").length, 1);
  assert.equal(headers.find((header) => header.name.toLowerCase() === "signature-agent")?.value, `"${directoryUrl}"`);
  const request: RequestDescriptor = {
    kind: "request", method: "GET", targetUri: "https://shop.example/search?q=phone",
    fields: headers.map(({ name, value }) => ({ name: name.toLowerCase(), value })),
  };
  const verifier = testVerifier(key.publicJwk);
  const verified = await verifySignature(request, {
    policy: {
      algorithms: ["ed25519"],
      requiredComponents: [component("@authority"), component("signature-agent")],
      requiredParameters: ["created", "expires", "nonce", "tag", "keyid"],
      maxAge: 60,
      clockSkew: 10,
    },
    resolveVerifier: (candidate) => {
      assert.equal(candidate.parameters.keyid, verifier.keyid);
      return verifier;
    },
  });
  assert.equal(verified.parameters.tag, "web-bot-auth");
});
