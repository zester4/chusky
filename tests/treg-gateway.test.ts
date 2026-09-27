import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { TregGateway } from "../src/treg/gateway.js";
import { TregSpendGuard } from "../src/treg/spend.js";
import type { TregSpendSnapshot } from "../src/treg/types.js";
import { nativeTool, setTregGatewayForTests } from "../src/nativeTools.js";

test("TregSpendGuard blocks estimates over the per-call cap", async () => {
    const previous = config.tregEnabled;
    config.tregEnabled = true;
    try {
      const guard = new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} });
      await assert.rejects(guard.assertCanSpend(1, config.tregPerCallSoftCapUsd + 0.01), /soft cap/i);
    } finally { config.tregEnabled = previous; }
});

test("TregSpendGuard enforces the per-minute attempt limit", async () => {
    const previous = { enabled: config.tregEnabled, rate: config.tregRateLimitPerMinute };
    config.tregEnabled = true;
    config.tregRateLimitPerMinute = 1;
    let snapshot: TregSpendSnapshot | undefined;
    try {
      const guard = new TregSpendGuard({ getSnap: async () => snapshot, saveSnap: async (next) => { snapshot = next; } });
      await guard.reserve(1, 0.01);
      await assert.rejects(guard.reserve(1, 0.01), /rate limit/i);
    } finally { config.tregEnabled = previous.enabled; config.tregRateLimitPerMinute = previous.rate; }
});

test("TregSpendGuard reserves and settles one mission spend atomically", async () => {
    const previous = config.tregEnabled;
    config.tregEnabled = true;
    let snapshot: TregSpendSnapshot | undefined;
    try {
      const guard = new TregSpendGuard({ getSnap: async () => snapshot, saveSnap: async (next) => { snapshot = next; } });
      const reservation = await guard.reserve(1, 0.05, "mission-1");
      assert.equal(snapshot?.reservedUsd, 0.05);
      await guard.settle(reservation, 0.03);
      assert.equal(snapshot?.spentUsd, 0.03);
      assert.equal(snapshot?.missionSpent["mission-1"], 0.03);
      assert.equal(snapshot?.reservedUsd, 0);
    } finally { config.tregEnabled = previous; }
});

test("TregGateway uses the server token and preserves idempotency across transient retries", async () => {
    const previous = { enabled: config.tregEnabled, token: config.tregToken, retries: config.tregMaxRetries };
    config.tregEnabled = true;
    config.tregToken = "test-token";
    config.tregMaxRetries = 1;
    const spend = new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} });
    const calls: RequestInit[] = [];
    let callsCount = 0;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      calls.push(init);
      callsCount += 1;
      if (callsCount === 1) return new Response(JSON.stringify({ id: "endpoint-1", price_usd: 0.05, provider: "test" }), { status: 200 });
      if (callsCount === 2) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ id: "call-1", cost_usd: 0.05, result: { ok: true } }), { status: 200 });
    };
    try {
      const gateway = new TregGateway({ spend, recordReceipt: async () => {}, fetchImpl, sleep: async () => {} });
      const result = await gateway.call({ userId: 1, endpointId: "endpoint-1", body: { q: "hello" }, estimateUsd: 0.05 });
      assert.equal(result.receipt.ok, true);
      assert.equal(calls.length, 3);
      assert.equal((calls[0].headers as Record<string, string>)["X-Treg-Token"], "test-token");
      assert.equal((calls[1].headers as Record<string, string>)["Idempotency-Key"], (calls[2].headers as Record<string, string>)["Idempotency-Key"]);
    } finally {
      config.tregEnabled = previous.enabled;
      config.tregToken = previous.token;
      config.tregMaxRetries = previous.retries;
    }
});

test("TregGateway accepts a caller idempotency key and settles the documented response headers", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken, retries: config.tregMaxRetries };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  config.tregMaxRetries = 0;
  let calls = 0;
  const spend = new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} });
  try {
    const gateway = new TregGateway({
      spend,
      recordReceipt: async () => {},
      fetchImpl: async (_url, init) => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ id: "endpoint-1", price_usd: 0.05 }), { status: 200 });
        assert.equal((init.headers as Record<string, string>)["Idempotency-Key"], "same-request-retry");
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200, headers: { "X-Treg-Call-Id": "call_123", "X-Treg-Cost-Micro": "7000", "X-Treg-Idempotent-Replay": "true" } });
      },
    });
    const result = await gateway.call({ userId: 1, endpointId: "endpoint-1", estimateUsd: 0.05, idempotencyKey: "same-request-retry" });
    assert.equal(result.receipt.callId, "call_123");
    assert.equal(result.receipt.costUsd, 0.007);
    assert.equal(result.receipt.replayed, true);
    assert.equal(result.receipt.idempotencyKey, "same-request-retry");
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
    config.tregMaxRetries = previous.retries;
  }
});

test("TregGateway exposes platform comparisons and registered team tools without secrets", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  const seenUrls: string[] = [];
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url) => {
        seenUrls.push(url);
        if (url.includes("/catalog/platforms/")) return new Response(JSON.stringify([{ slug: "one", provider: "one", price_usd: 0.01 }]), { status: 200 });
        return new Response(JSON.stringify({ tools: [{ name: "stripe", base_url: "https://api.stripe.com", host: "api.stripe.com", bindings: { Authorization: "redacted" } }] }), { status: 200 });
      },
    });
    assert.deepEqual(await gateway.platforms("email-find"), [{ id: "one", title: "one", provider: "one", priceUsd: 0.01 }]);
    assert.deepEqual(await gateway.myTools(), [{ name: "stripe", baseUrl: "https://api.stripe.com", host: "api.stripe.com", bindings: ["Authorization"] }]);
    assert.ok(seenUrls.some((url) => url.includes("/catalog/platforms/email-find")));
    assert.ok(seenUrls.some((url) => url.endsWith("/tools")));
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("TregGateway rejects an unregistered team-tool target", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async () => new Response(JSON.stringify({ tools: [{ name: "stripe", host: "api.stripe.com" }] }), { status: 200 }),
    });
    await assert.rejects(gateway.call({ userId: 1, endpointId: "https://evil.example/charge", estimateUsd: 0 }), /not registered/i);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("TregGateway uses only the organization credential for scoped calls", async () => {
    const previous = { enabled: config.tregEnabled, token: config.tregToken, orgTokens: config.tregOrganizationTokens };
    config.tregEnabled = true;
    config.tregToken = "global-token";
    config.tregOrganizationTokens = { org_acme: { token: "org-token", tregOrgId: "org_provider" } };
    const seen: RequestInit[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => { seen.push(init); return new Response(JSON.stringify({ results: [] }), { status: 200 }); };
    try {
      const gateway = new TregGateway({ spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }), recordReceipt: async () => {}, fetchImpl });
      await gateway.search("company", 4, "org_acme");
      const headers = seen[0].headers as Record<string, string>;
      assert.equal(headers["X-Treg-Token"], "org-token");
      assert.equal(headers["x-treg-org"], "org_provider");
      await assert.rejects(gateway.search("company", 4, "org_missing"), /No Treg credential/i);
    } finally { config.tregEnabled = previous.enabled; config.tregToken = previous.token; config.tregOrganizationTokens = previous.orgTokens; }
});

test("TregGateway sanitizes OAuth connection metadata and never returns provider secrets", async () => {
    const previous = { enabled: config.tregEnabled, token: config.tregToken };
    config.tregEnabled = true;
    config.tregToken = "test-token";
    try {
      const gateway = new TregGateway({ spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }), recordReceipt: async () => {}, fetchImpl: async () => new Response(JSON.stringify({ connections: [{ id: "conn_1", provider: "acme", access_token: "secret", scopes: ["read"] }] }), { status: 200 }) });
      assert.deepEqual(await gateway.oauthConnections(), [{ id: "conn_1", provider: "acme", scopes: ["read"] }]);
    } finally { config.tregEnabled = previous.enabled; config.tregToken = previous.token; }
});

test("Treg normalization preserves provider scores without inventing confidence", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  let callCount = 0;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url) => {
        callCount += 1;
        if (url.includes("/catalog/search")) return new Response(JSON.stringify({ results: [{ id: "person-email", title: "Work email", provider: "hunter", price_usd: 0.01 }] }), { status: 200 });
        if (url.includes("/catalog/endpoints/")) return new Response(JSON.stringify({ id: "person-email", title: "Work email", provider: "hunter", price_usd: 0.01 }), { status: 200 });
        return new Response(JSON.stringify({ result: { email: "person@example.com", full_name: "A Person", confidence: 0.92 } }), { status: 200 });
      },
    });
    const result = await gateway.enrichPerson({ userId: 1, name: "A Person" });
    assert.ok(callCount >= 3);
    assert.ok(result.items.length > 0);
    assert.ok(result.items.every((item) => item.providerScore === 0.92));

    callCount = 0;
    const noScoreGateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url) => {
        if (url.includes("/catalog/search")) return new Response(JSON.stringify({ results: [{ id: "person-email", title: "Work email", provider: "hunter", price_usd: 0.01 }] }), { status: 200 });
        if (url.includes("/catalog/endpoints/")) return new Response(JSON.stringify({ id: "person-email", title: "Work email", provider: "hunter", price_usd: 0.01 }), { status: 200 });
        return new Response(JSON.stringify({ result: { email: "person@example.com", full_name: "A Person" } }), { status: 200 });
      },
    });
    const noScore = await noScoreGateway.enrichPerson({ userId: 1, name: "A Person" });
    assert.ok(noScore.items.length > 0);
    assert.ok(noScore.items.every((item) => !("providerScore" in item)));
  } finally { config.tregEnabled = previous.enabled; config.tregToken = previous.token; }
});

test("TregGateway records mission evidence after a successful paid call", async () => {
    const previous = { enabled: config.tregEnabled, token: config.tregToken };
    config.tregEnabled = true;
    config.tregToken = "test-token";
    let evidenceInput: { missionId: string; resultHash: string } | undefined;
    let calls = 0;
    try {
      const gateway = new TregGateway({
        spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
        recordReceipt: async () => {},
        recordMissionEvidence: async ({ missionId, resultHash }) => { evidenceInput = { missionId, resultHash }; return true; },
        fetchImpl: async () => { calls += 1; return new Response(JSON.stringify(calls === 1 ? { id: "endpoint-1", price_usd: 0.05 } : { id: "call-1", cost_usd: 0.05, result: { verified: true } }), { status: 200 }); },
      });
      const result = await gateway.call({ userId: 1, endpointId: "endpoint-1", missionId: "mis_123", estimateUsd: 0.05 });
      assert.equal(result.receipt.missionEvidenceRecorded, true);
      assert.equal(evidenceInput?.missionId, "mis_123");
      assert.match(evidenceInput?.resultHash ?? "", /^[a-f0-9]{64}$/);
    } finally { config.tregEnabled = previous.enabled; config.tregToken = previous.token; }
});

test("TregGateway fails closed when the endpoint has no price or explicit estimate", async () => {
    const previous = { enabled: config.tregEnabled, token: config.tregToken };
    config.tregEnabled = true;
    config.tregToken = "test-token";
    const fetchImpl = async () => new Response(JSON.stringify({ id: "endpoint-1", provider: "test" }), { status: 200 });
    try {
      const gateway = new TregGateway({ spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }), recordReceipt: async () => {}, fetchImpl });
      await assert.rejects(gateway.call({ userId: 1, endpointId: "endpoint-1" }), /price is unavailable/i);
    } finally { config.tregEnabled = previous.enabled; config.tregToken = previous.token; }
});

test("TregGateway does not send a body to a strict-query catalog endpoint", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  let requests = 0;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async () => {
        requests += 1;
        return new Response(JSON.stringify({ id: "endpoint-1", price_usd: 0.01, strict_query: true }), { status: 200 });
      },
    });
    await assert.rejects(gateway.call({ userId: 1, endpointId: "endpoint-1", body: { q: "bad" } }), /strict-query catalog endpoint requires declared query parameters/i);
    assert.equal(requests, 1);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("TregGateway retries an idempotent request after a timeout", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken, retries: config.tregMaxRetries };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  config.tregMaxRetries = 1;
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("timed out"), { name: "AbortError" });
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  try {
    const gateway = new TregGateway({ spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }), recordReceipt: async () => {}, fetchImpl, sleep: async () => {} });
    await gateway.search("company");
    assert.equal(attempts, 2);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
    config.tregMaxRetries = previous.retries;
  }
});

test("TregGateway does not settle a successful provider call twice when settlement fails", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  let settleCalls = 0;
  const spend = {
    reserve: async () => ({ id: "reservation", userId: 1, dayKey: "2026-09-27", estimateUsd: 0.05 }),
    settle: async () => { settleCalls += 1; throw new Error("ledger unavailable"); },
  } as unknown as TregSpendGuard;
  const fetchImpl = async (_url: string, _init: RequestInit) => {
    if (settleCalls === 0) return new Response(JSON.stringify({ id: "endpoint-1", price_usd: 0.05 }), { status: 200 });
    return new Response(JSON.stringify({ id: "call-1", cost_usd: 0.05, result: { ok: true } }), { status: 200 });
  };
  try {
    const gateway = new TregGateway({ spend, recordReceipt: async () => {}, fetchImpl });
    await assert.rejects(gateway.call({ userId: 1, endpointId: "endpoint-1", estimateUsd: 0.05 }), /settlement failed/i);
    assert.equal(settleCalls, 1);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("native Treg dispatch routes through the gateway boundary", async () => {
  const gateway = { search: async (q: string, limit: number) => [{ id: "endpoint-1", title: q, provider: "test", category: "web_data", priceUsd: limit / 100 }] } as unknown as TregGateway;
  setTregGatewayForTests(gateway);
  try {
    assert.deepEqual(await nativeTool(42, "CHUCK_TREG_SEARCH", { q: "market data", limit: 4 }), [{ id: "endpoint-1", title: "market data", provider: "test", category: "web_data", priceUsd: 0.04 }]);
  } finally {
    setTregGatewayForTests(undefined);
  }
});
