import assert from "node:assert/strict";
import test from "node:test";
import { getCamofoxUserId, validateCamofoxTargetUrl } from "../src/lib/camofox/engine.js";
import { executeCamofoxTool } from "../src/lib/camofox/tools.js";
import { prepareAgentCardLinkDelivery, prepareCamofoxLiveViewDelivery } from "../src/agent.js";
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

test("Camofox browser tools and AgentCard shopping tools use separate bundles", () => {
  for (const slug of ["CHUCK_CAMOFOX_OPEN"]) {
    const tool = nativeToolManifest.find((entry) => entry.slug === slug);
    assert.equal(tool?.bundle, "browser", slug);
  }
  for (const slug of [
    "CHUCK_AGENTCARD_PAY_ARM",
    "CHUCK_AGENTCARD_ENROL",
    "CHUCK_AGENTCARD_BUY",
    "CHUCK_AGENTCARD_PRESETS",
  ]) {
    const tool = nativeToolManifest.find((entry) => entry.slug === slug);
    assert.equal(tool?.bundle, "shopping", slug);
  }
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

test("AgentCard spending and purchase mutations require Chusky approval", () => {
  assert.equal(toolApprovalPolicy("CHUCK_AGENTCARD_PAY_ARM"), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_AGENTCARD_ENROL"), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_AGENTCARD_BUY", { confirm: true }), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_AGENTCARD_BUY", { new_order: true }), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_AGENTCARD_PRESETS", { action: "set" }), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_AGENTCARD_PRESETS", { action: "attach" }), "approval_required");
  assert.equal(toolApprovalPolicy("CHUCK_AGENTCARD_BUY", { confirm: false }), "private");
  assert.equal(toolApprovalPolicy("CHUCK_AGENTCARD_PAY_STATUS"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_AGENTCARD_PAY_DISARM"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_AGENTCARD_CARDS"), "private");
  assert.equal(toolApprovalPolicy("CHUCK_AGENTCARD_PRESETS", { action: "list" }), "private");
});

test("AgentCard bearer links are delivered privately and removed from model results", () => {
  const result = prepareAgentCardLinkDelivery({
    approvalUrl: "https://payments.example.com/approve?token=signed-value",
    results: [{ login: "Continue at https://merchant.example.com/login?token=merchant-key" }],
  }, "CHUCK_AGENTCARD_PAY_STATUS");

  assert.deepEqual(result.privateLinks.map((link) => link.url), [
    "https://payments.example.com/approve?token=signed-value",
    "https://merchant.example.com/login?token=merchant-key",
  ]);
  assert.equal(result.privateLinks[0].label, "Review AgentCard payment");
  assert.equal(result.privateLinks[0].kind, "agentcard_action");
  assert.equal(JSON.stringify(result.modelResult).includes("signed-value"), false);
  assert.equal(JSON.stringify(result.modelResult).includes("merchant-key"), false);
  assert.equal(JSON.stringify(result.modelResult).includes("https://"), false);

  const unsafe = prepareAgentCardLinkDelivery({ url: "http://example.test/unsafe" }, "CHUCK_AGENTCARD_ENROL");
  assert.equal(unsafe.privateLinks.length, 0);
  assert.match(String(unsafe.modelResult.privateLinkDeliveryWarning), /withheld/);
  assert.equal(JSON.stringify(unsafe.modelResult).includes("http://"), false);

  const cardData = prepareAgentCardLinkDelivery({ cards: [{ brand: "Visa", last4: "4242", cardNumber: "4242424242424242" }] }, "CHUCK_AGENTCARD_CARDS");
  assert.equal(JSON.stringify(cardData.modelResult).includes("4242424242424242"), false);
  assert.equal(cardData.modelResult.sensitivePaymentDataWithheld, 1);
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

test("AgentCard operations use the authenticated owner's Camofox namespace and documented endpoints", async () => {
  const oldFetch = globalThis.fetch;
  const oldBaseUrl = process.env.CAMOFOX_BASE_URL;
  const oldAccessKey = process.env.CAMOFOX_ACCESS_KEY;
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  process.env.CAMOFOX_BASE_URL = "https://camofox.example.test";
  process.env.CAMOFOX_ACCESS_KEY = "test-key";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const response = url.pathname.includes("/payment")
      ? init?.method === "DELETE"
        ? { ok: true, disarmed: true }
        : init?.method === "POST"
          ? { attachmentId: "pay-1", tabId: "tab-1" }
          : { attachmentId: "pay-1", phase: "pending", approvalUrl: "https://payments.example.test/approve?t=secret", purchaseId: null, results: [] }
      : url.pathname === "/agentcard/vault/enrol"
        ? { url: "https://cards.example.test/enrol?t=secret" }
        : url.pathname === "/agentcard/vault/cards"
          ? { cards: [] }
          : url.pathname === "/agentcard/commerce/buy"
            ? { links: ["https://shop.example.test/continue?t=secret"] }
            : url.pathname === "/agentcard/merchants"
              ? { merchants: [] }
              : url.pathname === "/agentcard/presets"
                ? { presets: [] }
                : url.pathname.endsWith("/attach")
                  ? { ok: true, attached: true }
                  : { ok: true, label: "weekly-limit" };
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  };
  try {
    const signal = new AbortController().signal;
    await executeCamofoxTool(123, "CHUCK_AGENTCARD_PAY_ARM", {
      tabId: "tab-1", merchant: "Store", amount: 2306, currency: "usd",
      checkoutOrigin: "https://shop.example.com", cardId: "card-1",
    }, signal);
    await executeCamofoxTool(123, "CHUCK_AGENTCARD_PAY_STATUS", { tabId: "tab-1", attachmentId: "pay-1" }, signal);
    await executeCamofoxTool(123, "CHUCK_AGENTCARD_PAY_DISARM", { tabId: "tab-1", attachmentId: "pay-1" }, signal);
    await executeCamofoxTool(123, "CHUCK_AGENTCARD_ENROL", { addAnother: true }, signal);
    await executeCamofoxTool(123, "CHUCK_AGENTCARD_CARDS", {}, signal);
    await executeCamofoxTool(123, "CHUCK_AGENTCARD_BUY", { ask: "Find a book", confirm: false }, signal);
    await executeCamofoxTool(123, "CHUCK_AGENTCARD_MERCHANTS", { q: "books", limit: 5 }, signal);
    await executeCamofoxTool(123, "CHUCK_AGENTCARD_PRESETS", { action: "list" }, signal);
    await executeCamofoxTool(123, "CHUCK_AGENTCARD_PRESETS", {
      action: "set", label: "weekly-limit", rules: { perWeekCents: 5000 },
    }, signal);
    await executeCamofoxTool(123, "CHUCK_AGENTCARD_PRESETS", {
      action: "attach", label: "weekly-limit", cardId: "card-1",
    }, signal);

    assert.deepEqual(requests.map(({ url, init }) => [url.pathname, init?.method ?? "GET"]), [
      ["/agentcard/tabs/tab-1/payment", "POST"],
      ["/agentcard/tabs/tab-1/payment/pay-1", "GET"],
      ["/agentcard/tabs/tab-1/payment/pay-1", "DELETE"],
      ["/agentcard/vault/enrol", "POST"],
      ["/agentcard/vault/cards", "GET"],
      ["/agentcard/commerce/buy", "POST"],
      ["/agentcard/merchants", "GET"],
      ["/agentcard/presets", "GET"],
      ["/agentcard/presets/weekly-limit", "PUT"],
      ["/agentcard/presets/weekly-limit/attach", "POST"],
    ]);
    const expectedOwner = getCamofoxUserId({ principalType: "user", principalId: "123" });
    for (const { url } of requests) assert.equal(url.searchParams.get("userId"), expectedOwner);
    assert.equal(JSON.parse(String(requests[0].init?.body)).userId, expectedOwner);
    assert.equal(JSON.parse(String(requests[5].init?.body)).userId, expectedOwner);
    assert.equal(JSON.parse(String(requests[8].init?.body)).rules.perWeekCents, 5000);
    assert.equal(JSON.parse(String(requests[9].init?.body)).cardId, "card-1");
    assert.equal(requests[6].url.searchParams.get("q"), "books");
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
  await assert.rejects(
    nativeTool(123, "CHUCK_AGENTCARD_CARDS", {}, { ownerPrivateRun: false }),
    /private owner conversation/,
  );
  await assert.rejects(
    nativeTool(123, "CHUCK_AGENTCARD_BUY", { ask: "Find a book" }, {
      ownerPrivateRun: true,
      missionId: "mission-1",
    }),
    /direct private owner conversation/,
  );
});
