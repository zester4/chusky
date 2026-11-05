import assert from "node:assert/strict";
import test from "node:test";
import { getCamofoxUserId, validateCamofoxTargetUrl } from "../src/lib/camofox/engine.js";
import { executeCamofoxTool } from "../src/lib/camofox/tools.js";
import { prepareCamofoxLiveViewDelivery } from "../src/agent.js";
import { nativeToolManifest } from "../src/decisions/nativeToolRouter.js";
import { nativeTool } from "../src/nativeTools.js";
import { toolApprovalPolicy } from "../src/policy.js";

test("Camofox owner IDs are private, stable, and require a user principal", () => {
  const first = getCamofoxUserId({ principalType: "user", principalId: "123" });
  assert.equal(first, getCamofoxUserId({ principalType: "user", principalId: "123" }));
  assert.notEqual(first, getCamofoxUserId({ principalType: "user", principalId: "456" }));
  assert.match(first, /^chusky_[a-f0-9]{64}$/);
  assert.throws(() => getCamofoxUserId({ principalType: "organization", principalId: "123" }), /authenticated user session/);
});

test("Camofox URL validation permits only public HTTPS hostnames", () => {
  assert.equal(validateCamofoxTargetUrl("https://example.com/a"), "https://example.com/a");
  for (const value of [
    "http://example.com",
    "https://127.0.0.1",
    "https://[::1]",
    "https://localhost",
    "https://admin.internal",
    "https://user:password@example.com",
  ]) {
    assert.throws(() => validateCamofoxTargetUrl(value), /public HTTPS hostnames/);
  }
});

test("Camofox capabilities are routed through the browser bundle", () => {
  const tool = nativeToolManifest.find((entry) => entry.slug === "CHUCK_CAMOFOX_OPEN");
  assert.equal(tool?.bundle, "browser");
});

test("Camofox live-view URLs are delivered privately and stripped from model results", () => {
  const result = prepareCamofoxLiveViewDelivery({
    tabId: "tab-1",
    url: "https://example.com/",
    title: "Example",
    liveViewerUrl: "https://viewer.example.test/?token=secret",
    liveViewerExpiresInSeconds: 600,
  }, 1_000);

  assert.deepEqual(result.privateLink, {
    url: "https://viewer.example.test/?token=secret",
    expiresAt: 601_000,
    label: "Open live browser view",
    kind: "browser_live_view",
  });
  assert.equal(result.modelResult.liveViewerIssued, true);
  assert.equal(result.modelResult.liveViewerExpiresAt, 601_000);
  assert.equal("liveViewerUrl" in result.modelResult, false);
  assert.equal(JSON.stringify(result.modelResult).includes("secret"), false);
  assert.throws(() => prepareCamofoxLiveViewDelivery({
    liveViewerUrl: "http://viewer.example.test/?token=secret",
    liveViewerExpiresInSeconds: 600,
  }), /insecure live-view link/);
});

test("Camofox clicks and typing require approval while observation tools stay private", () => {
  assert.equal(toolApprovalPolicy("CHUCK_CAMOFOX_CLICK"), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_CAMOFOX_TYPE"), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_CAMOFOX_SNAPSHOT"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_CAMOFOX_OPEN"), "private");
});

test("Camofox execution hashes the owner and passes it to the service", async () => {
  const oldFetch = globalThis.fetch;
  const oldBaseUrl = process.env.CAMOFOX_BASE_URL;
  const oldAccessKey = process.env.CAMOFOX_ACCESS_KEY;
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  process.env.CAMOFOX_BASE_URL = "https://camofox.example.test";
  process.env.CAMOFOX_ACCESS_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const result = url.pathname === "/tabs"
      ? { tabId: "tab-1", url: "https://example.com", title: "Example" }
      : { url: "https://viewer.example.test/?t=signed-token" };
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await executeCamofoxTool(123, "CHUCK_CAMOFOX_OPEN", {
      url: "https://example.com",
    }, new AbortController().signal) as Record<string, unknown>;

    assert.equal(result.tabId, "tab-1");
    assert.equal(result.liveViewerUrl, "https://viewer.example.test/?t=signed-token");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url.pathname, "/tabs");
    const ownerId = requests[0].url.searchParams.get("userId");
    assert.match(ownerId ?? "", /^chusky_[a-f0-9]{64}$/);
    assert.equal(requests[1].url.searchParams.get("userId"), ownerId);
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      sessionKey: "main",
      url: "https://example.com/",
      userId: ownerId,
    });
    assert.match(new Headers(requests[0].init?.headers).get("authorization") ?? "", /^Bearer /);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldBaseUrl === undefined) delete process.env.CAMOFOX_BASE_URL;
    else process.env.CAMOFOX_BASE_URL = oldBaseUrl;
    if (oldAccessKey === undefined) delete process.env.CAMOFOX_ACCESS_KEY;
    else process.env.CAMOFOX_ACCESS_KEY = oldAccessKey;
  }
});

test("Camofox tools reject execution outside an owner-private conversation", async () => {
  await assert.rejects(
    nativeTool(123, "CHUCK_CAMOFOX_LIST_TABS", {}, { ownerPrivateRun: false }),
    /private owner conversation/,
  );
});
