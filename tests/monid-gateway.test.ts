import test from "node:test";
import assert from "node:assert/strict";
import { MonidGateway } from "../src/monid/gateway.js";
import { config } from "../src/config.js";
import { validateNativeToolArguments } from "../src/agentTools.js";
import { toolApprovalPolicy } from "../src/policy.js";
import { isSharedChannelToolDenied } from "../src/sharedChannelPolicy.js";

test("CHUCK_MONID_STOP argument validation and policy", () => {
  assert.doesNotThrow(() => validateNativeToolArguments("CHUCK_MONID_STOP", { runId: "01JGXYZABCDEFGHJKMNPQRSTVW" }));
  assert.throws(() => validateNativeToolArguments("CHUCK_MONID_STOP", { runId: "short" }), /at least 8 characters/i);
  assert.equal(toolApprovalPolicy("CHUCK_MONID_STOP"), "private");
  assert.equal(isSharedChannelToolDenied("CHUCK_MONID_STOP"), true);
});

test("MonidGateway handles object-structure pricing and composite input mapping", async () => {
  const previousEnabled = config.monidEnabled;
  const previousKey = config.monidApiKey;
  (config as any).monidEnabled = true;
  (config as any).monidApiKey = "monid_live_testkey123456";

  const savedReceipts: any[] = [];
  const requestsMade: { method: string; path: string; body?: any }[] = [];

  const fakeSpend = {
    reserve: async (userId: number, amountUsd: number, missionId?: string) => ({
      userId,
      amountUsd,
      missionId,
      reservationId: "res_123",
    }),
    settle: async () => {},
  };

  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    const pathname = new URL(urlStr).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requestsMade.push({ method: init?.method ?? "GET", path: pathname, body });

    if (pathname === "/v1/discover") {
      return new Response(JSON.stringify({
        items: [
          {
            provider: "apify",
            providerDisplayName: "Apify",
            endpoint: "/apidojo/tweet-scraper",
            displayDescription: "Scrape tweets and replies",
            price: {
              type: "PER_RESULT",
              amount: { value: 0.001, currency: "USD" },
              flatFee: { value: 0.05, currency: "USD" },
            },
            score: 0.95,
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (pathname === "/v1/inspect") {
      return new Response(JSON.stringify({
        id: "inspect_1",
        provider: "apify",
        endpoint: "/apidojo/tweet-scraper",
        input: {
          pathParams: { type: "object", properties: { orgId: { type: "string" } } },
          queryParams: { type: "object", properties: { limit: { type: "number" } } },
          body: { type: "object", properties: { searchTerms: { type: "array" }, maxItems: { type: "number" } } },
          bodyType: "json",
        },
        pricing: {
          type: "PER_RESULT",
          amount: { value: 0.001, currency: "USD" },
          flatFee: { value: 0.02, currency: "USD" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (pathname === "/v1/run") {
      return new Response(JSON.stringify({
        runId: "01JGXYZABCDEFGHJKMNPQRSTVW",
        status: "COMPLETED",
        cost: { value: 0.03, currency: "USD" },
        output: { items: [{ id: "1", text: "AI agent tweet" }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (pathname === "/v1/runs/01JGXYZABCDEFGHJKMNPQRSTVW/stop") {
      return new Response(JSON.stringify({
        runId: "01JGXYZABCDEFGHJKMNPQRSTVW",
        status: "STOPPING",
        message: "Stop accepted",
      }), { status: 202, headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };

  try {
    const gateway = new MonidGateway({
      spend: fakeSpend as any,
      saveReceipt: async (receipt) => { savedReceipts.push(receipt); },
      listReceipts: async () => savedReceipts,
      fetchImpl: fetchImpl as any,
    });

    const discoverRes = await gateway.discover("tweets", 5) as any;
    assert.equal(discoverRes.count, 1);
    assert.equal(discoverRes.results[0].provider, "apify");
    assert.equal(discoverRes.results[0].providerName, "Apify");

    // Test running with flat input arguments that should be adapted into composite format
    const runRes = await gateway.run({
      userId: 42,
      provider: "apify",
      endpoint: "/apidojo/tweet-scraper",
      input: {
        orgId: "org-99",
        limit: 10,
        searchTerms: ["AI agents"],
        maxItems: 5,
      },
      maxSpendUsd: 0.10,
    }) as any;

    assert.equal(runRes.runId, "01JGXYZABCDEFGHJKMNPQRSTVW");
    assert.equal(runRes.status, "COMPLETED");

    // Inspect the request body sent to /v1/run
    const runReq = requestsMade.find((r) => r.path === "/v1/run");
    assert.ok(runReq);
    assert.deepEqual(runReq?.body.input.pathParams, { orgId: "org-99" });
    assert.deepEqual(runReq?.body.input.queryParams, { limit: 10 });
    assert.deepEqual(runReq?.body.input.body, { searchTerms: ["AI agents"], maxItems: 5 });

    // Test stopRun
    const stopRes = await gateway.stopRun(42, "01JGXYZABCDEFGHJKMNPQRSTVW") as any;
    assert.equal(stopRes.status, "STOPPING");
    assert.equal(stopRes.runId, "01JGXYZABCDEFGHJKMNPQRSTVW");
  } finally {
    (config as any).monidEnabled = previousEnabled;
    (config as any).monidApiKey = previousKey;
  }
});
