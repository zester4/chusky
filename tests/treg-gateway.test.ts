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
      if (callsCount === 1) return new Response(JSON.stringify({ id: "endpoint-1", method: "POST", price_usd: 0.05, provider: "test" }), { status: 200 });
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

test("TregGateway rejects a method that differs from inspected catalog metadata before reserving or calling", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  const requests: string[] = [];
  let reservations = 0;
  try {
    const gateway = new TregGateway({
      spend: { reserve: async () => { reservations += 1; throw new Error("must not reserve"); } } as unknown as TregSpendGuard,
      recordReceipt: async () => {},
      fetchImpl: async (url) => {
        requests.push(new URL(url).pathname);
        return new Response(JSON.stringify({ id: "provider.search", method: "GET", price_usd: 0.01, price_unit: "call" }), { status: 200 });
      },
    });
    await assert.rejects(gateway.call({ userId: 1, endpointId: "provider.search", method: "POST", body: { q: "test" }, estimateUsd: 0.01 }), /requires GET; requested POST/i);
    assert.deepEqual(requests, ["/catalog/endpoints/provider.search"]);
    assert.equal(reservations, 0);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("read-only Treg resolution inspects methods and skips write endpoints", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken, retries: config.tregMaxRetries };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  config.tregMaxRetries = 0;
  const requests: string[] = [];
  const spend = new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} });
  const fetchImpl = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push(`${String(init.method)} ${path}`);
    if (path === "/catalog/search") {
      return new Response(JSON.stringify([
        { id: "company.profile.write", title: "Company profile update", provider: "test", category: "company", price_usd: 0.01, price_unit: "call" },
        { id: "company.signal.read", title: "Company signal search", provider: "test", category: "company", price_usd: 0.01, price_unit: "call" },
        { id: "company.signal.variable", title: "Variable company signal search", provider: "test", category: "company", cost: { type: "per_success", value: 0, usd: 0, unit: "call", varies: true } },
      ]), { status: 200 });
    }
    if (path.startsWith("/catalog/endpoints/")) {
      const id = decodeURIComponent(path.slice("/catalog/endpoints/".length));
      if (id === "company.signal.variable") return new Response(JSON.stringify({ endpoint: { id, method: "GET", provider: "test", category: "company", title: id, cost: { type: "per_success", value: 0, usd: 0, unit: "call", varies: true } } }), { status: 200 });
      return new Response(JSON.stringify({ endpoint: { id, method: id.endsWith(".write") ? "PATCH" : "GET", provider: "test", category: "company", title: id, price_usd: 0.01, price_unit: "call" } }), { status: 200 });
    }
    if (path === "/call/company.signal.read") {
      return new Response(JSON.stringify({ result: { company: "Acme", signal: "hiring" }, cost_usd: 0.01 }), { status: 200 });
    }
    throw new Error(`Unexpected Treg test request: ${path}`);
  };
  try {
    const gateway = new TregGateway({ spend, recordReceipt: async () => {}, fetchImpl });
    const result = await gateway.resolveDataNeed({ userId: 1, need: "company hiring signals", maxCalls: 1, maxSpendUsd: 0.05, readOnlyOnly: true });
    assert.deepEqual(result.endpointsUsed, ["company.signal.read"]);
    assert.ok(result.warnings.some((warning) => warning.includes("company.profile.write") && warning.includes("not explicitly declared read-only")));
    assert.ok(result.warnings.some((warning) => warning.includes("company.signal.variable") && warning.includes("per-call pricing could not be verified")));
    assert.equal(requests.some((request) => request.endsWith("/call/company.profile.write")), false);
    assert.equal(requests.some((request) => request.endsWith("/call/company.signal.variable")), false);
    assert.equal(requests.some((request) => request === "GET /call/company.signal.read"), true);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
    config.tregMaxRetries = previous.retries;
  }
});

test("Treg company hiring-signal search uses only the fixed routed endpoint and enforces its route budget", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken, retries: config.tregMaxRetries };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  config.tregMaxRetries = 0;
  const requests: Array<{ method: string; path: string; body?: string; headers: Headers }> = [];
  const spend = new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} });
  const fetchImpl = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ method: String(init.method), path, body: typeof init.body === "string" ? init.body : undefined, headers: new Headers(init.headers) });
    if (path === "/catalog/endpoints/treg.companies.jobs.search") {
      return new Response(JSON.stringify({ endpoint: { id: "treg.companies.jobs.search", method: "POST", provider: "treg", category: "company", title: "Search company job listings", price_usd: 0.009, price_unit: "call" } }), { status: 200 });
    }
    if (path === "/call/treg.companies.jobs.search") {
      return new Response(JSON.stringify({ result: { jobs: [{ company_name: "Acme", company_domain: "acme.example", title: "VP of Security", posted_at: "2026-10-01", job_url: "https://jobs.example/1" }] }, cost_usd: 0.009 }), { status: 200 });
    }
    throw new Error(`Unexpected Treg test request: ${path}`);
  };
  try {
    const gateway = new TregGateway({ spend, recordReceipt: async () => {}, fetchImpl });
    const result = await gateway.searchCompanyJobs({ userId: 1, domain: "acme.example", limit: 5, maxSpendUsd: 0.05 });
    assert.equal(result.jobs[0]?.title, "VP of Security");
    assert.deepEqual(result.jobs[0]?.sourceUrls, ["https://jobs.example/1"]);
    const request = requests.find((item) => item.path === "/call/treg.companies.jobs.search");
    assert.equal(request?.method, "POST");
    assert.deepEqual(JSON.parse(request?.body ?? "{}"), { domain: "acme.example", limit: 5 });
    assert.equal(request?.headers.get("X-Treg-Route-Max-Cost"), "0.050000");
    await assert.rejects(gateway.searchCompanyJobs({ userId: 1, name: "Acme", maxSpendUsd: 0.005 }), /exceeds the available per-call spend limit/i);
    assert.equal(requests.filter((item) => item.path === "/call/treg.companies.jobs.search").length, 1);
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
        if (calls === 1) return new Response(JSON.stringify({ id: "endpoint-1", method: "POST", price_usd: 0.05 }), { status: 200 });
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

test("generic Treg call results are bounded and redact credential-shaped fields", async () => {
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
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ id: "endpoint-1", method: "POST", price_usd: 0.01, price_unit: "call" }));
        return new Response(JSON.stringify({ result: { title: "safe", token: "private-token-value", nested: { authorization: "Bearer abcdefghijklmnop" }, url: "https://example.test/path?api_key=private" } }));
      },
    });
    const result = await gateway.call({ userId: 1, endpointId: "endpoint-1" });
    assert.deepEqual(result.result, { title: "safe", nested: {}, url: "https://example.test/path?api_key=[redacted]" });
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
    config.tregMaxRetries = previous.retries;
  }
});

test("routed people search enforces a hard route cost cap and preserves evidence and pending state", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken, cap: config.tregPerCallSoftCapUsd };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  config.tregPerCallSoftCapUsd = 0.25;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let snapshot: TregSpendSnapshot | undefined;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => snapshot, saveSnap: async (next) => { snapshot = next; } }),
      recordReceipt: async () => {},
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        if (url.includes("/catalog/endpoints/")) return new Response(JSON.stringify({ id: "treg.people.search", method: "POST", title: "People search", price_usd: 0.01 }), { status: 200 });
        return new Response(JSON.stringify({ result: { people: [{ full_name: "Ada Lovelace", title: "VP Sales", company_domain: "example.com", email: "ada@example.com", email_verification_status: "verified", source_url: "https://example.com/profile", confidence: 92 }, { full_name: "Grace Hopper", company_domain: "example.com", email: "grace@example.com" }] }, _treg: { served_by: "provider-a", tried: ["provider-a"] } }), { status: 200, headers: { "X-Treg-Cost-Micro": "12000", "X-Treg-Ignored-Filters": "title" } });
      },
    });
    const result = await gateway.searchPeople({ userId: 5, companyDomain: "example.com", title: "VP Sales", limit: 4, maxSpendUsd: 0.05 });
    const call = requests.find((item) => item.url.includes("/call/treg.people.search"))!;
    assert.equal((call.init?.headers as Record<string, string>)["X-Treg-Route-Max-Cost"], "0.050000");
    assert.equal(JSON.parse(String(call.init?.body)).limit, 4);
    assert.equal(result.people[0]?.fullName, "Ada Lovelace");
    assert.deepEqual(result.people[0]?.sourceUrls, ["https://example.com/profile"]);
    assert.equal(result.people[0]?.emailVerified, true, "explicit verified status is preserved even when returned as text");
    assert.equal(result.people[1]?.emailVerified, undefined, "an absent verification state remains unknown");
    assert.equal(result.servedBy, "provider-a");
    assert.ok(result.warnings.some((warning) => /not treated as verified/i.test(warning)));
    assert.ok(result.warnings.some((warning) => /could not apply: title/i.test(warning)));
    assert.equal(result.incomplete, true);
    assert.equal(snapshot?.spentUsd, 0.012);
  } finally {
    config.tregEnabled = previous.enabled; config.tregToken = previous.token; config.tregPerCallSoftCapUsd = previous.cap;
  }
});

test("TregGateway records charged upstream failures returned with HTTP 2xx", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  let snapshot: TregSpendSnapshot | undefined;
  let receipt: import("../src/treg/types.js").TregCallReceipt | undefined;
  let calls = 0;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => snapshot, saveSnap: async (next) => { snapshot = next; } }),
      recordReceipt: async (next) => { receipt = next; },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ id: "endpoint-1", method: "POST", price_usd: 0.05 }), { status: 200 });
        return new Response(JSON.stringify({ result: null, _treg: { call_id: "call_paid_failure", charged_micro: 7000, upstream_failed: "status=500" } }), { status: 200, headers: { "X-Treg-Cost-Micro": "7000", "X-Treg-Call-Id": "call_paid_failure" } });
      },
    });
    await assert.rejects(gateway.call({ userId: 1, endpointId: "endpoint-1", estimateUsd: 0.05 }), /upstream failure.*call_paid_failure.*charged \$0\.007000/i);
    assert.equal(receipt?.ok, false);
    assert.equal(receipt?.costUsd, 0.007);
    assert.equal(receipt?.callId, "call_paid_failure");
    assert.equal(snapshot?.spentUsd, 0.007);
    assert.equal(snapshot?.reservedUsd, 0);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("routed async Treg calls are marked pending and reserve their capped budget", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken, cap: config.tregPerCallSoftCapUsd };
  config.tregEnabled = true; config.tregToken = "test-token"; config.tregPerCallSoftCapUsd = 0.25;
  let snapshot: TregSpendSnapshot | undefined;
  let receipt: any;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => snapshot, saveSnap: async (next) => { snapshot = next; } }),
      recordReceipt: async (next) => { receipt = next; },
      fetchImpl: async (url) => url.includes("/catalog/endpoints/")
        ? new Response(JSON.stringify({ id: "treg.people.search", method: "POST" }), { status: 200 })
        : new Response(JSON.stringify({ call_id: "async-call-1", _treg: { outcome: "pending", reserved_micro: 10000 } }), { status: 202 }),
    });
    const result = await gateway.searchPeople({ userId: 6, query: "founders at climate software companies", maxSpendUsd: 0.03 });
    assert.equal(result.incomplete, true);
    assert.ok(result.warnings.some((warning) => /Do not retry/i.test(warning)));
    assert.equal(receipt.pending, true);
    assert.equal(receipt.costIsEstimate, true);
    assert.equal(snapshot?.spentUsd, 0.03, "pending reserve is conservatively booked to prevent retry spend");
  } finally { config.tregEnabled = previous.enabled; config.tregToken = previous.token; config.tregPerCallSoftCapUsd = previous.cap; }
});

test("Treg email verification keeps unknown states explicit and never authorizes outreach", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken, cap: config.tregPerCallSoftCapUsd };
  config.tregEnabled = true; config.tregToken = "test-token"; config.tregPerCallSoftCapUsd = 0.25;
  const requests: RequestInit[] = [];
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url, init) => {
        requests.push(init);
        if (url.includes("/catalog/endpoints/")) return new Response(JSON.stringify({ id: "treg.people.email.verify", method: "POST", price_usd: 0.01 }), { status: 200 });
        return new Response(JSON.stringify({ result: { status: "unknown", catch_all: true } }), { status: 200, headers: { "X-Treg-Cost-Micro": "0" } });
      },
    });
    const result = await gateway.verifyEmail({ userId: 7, email: "person@example.com", maxSpendUsd: 0.04 });
    assert.equal((requests.at(-1)?.headers as Record<string, string>)["X-Treg-Route-Max-Cost"], "0.040000");
    assert.deepEqual(JSON.parse(String(requests.at(-1)?.body)), { email: "person@example.com" });
    assert.equal(result.valid, null);
    assert.equal(result.status, "unknown");
    assert.ok(result.warnings.some((warning) => /unknown state/i.test(warning)));
    await assert.rejects(gateway.verifyEmail({ userId: 7, email: "not-an-email" }), /valid email/i);
  } finally { config.tregEnabled = previous.enabled; config.tregToken = previous.token; config.tregPerCallSoftCapUsd = previous.cap; }
});

test("Treg pending call status retrieves bounded results and removes credential-like fields", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true; config.tregToken = "test-token";
  const urls: string[] = [];
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.endsWith("/calls/call-123")) return new Response(JSON.stringify({ status: "completed", provider: "provider-a", charged_micro: 12000 }), { status: 200 });
        return new Response(JSON.stringify({ result: { people: [{ name: "Ada", email: "ada@example.com" }], api_key: "must-not-return" } }), { status: 200 });
      },
    });
    const result = await gateway.callStatus("call-123");
    assert.equal(result.status, "completed");
    assert.equal(result.pending, false);
    assert.equal(result.costUsd, 0.012);
    assert.equal((result.result as any).api_key, undefined);
    assert.deepEqual(urls.map((url) => new URL(url).pathname), ["/calls/call-123", "/calls/call-123/result"]);
    await assert.rejects(gateway.callStatus("call/123"), /Invalid Treg call ID/i);
  } finally { config.tregEnabled = previous.enabled; config.tregToken = previous.token; }
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
        if (url.includes("/catalog/search")) return new Response(JSON.stringify({ results: [{ id: "person-email", method: "POST", title: "Work email", provider: "hunter", price_usd: 0.01 }] }), { status: 200 });
        if (url.includes("/catalog/endpoints/")) return new Response(JSON.stringify({ id: "person-email", method: "POST", title: "Work email", provider: "hunter", price_usd: 0.01 }), { status: 200 });
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
        if (url.includes("/catalog/search")) return new Response(JSON.stringify({ results: [{ id: "person-email", method: "POST", title: "Work email", provider: "hunter", price_usd: 0.01 }] }), { status: 200 });
        if (url.includes("/catalog/endpoints/")) return new Response(JSON.stringify({ id: "person-email", method: "POST", title: "Work email", provider: "hunter", price_usd: 0.01 }), { status: 200 });
        return new Response(JSON.stringify({ result: { email: "person@example.com", full_name: "A Person" } }), { status: 200 });
      },
    });
    const noScore = await noScoreGateway.enrichPerson({ userId: 1, name: "A Person" });
    assert.ok(noScore.items.length > 0);
    assert.ok(noScore.items.every((item) => !("providerScore" in item)));
  } finally { config.tregEnabled = previous.enabled; config.tregToken = previous.token; }
});

test("TregGateway unwraps nested endpoint metadata and normalizes live pricing", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async () => new Response(JSON.stringify({
        endpoint: {
          id: "treg.companies.enrich",
          name: "Company enrichment",
          provider: "treg",
          cost: { usd: 0.0018 },
          observed: { ok_rate: 0.7682, p50_ms: 420 },
          input: { body: { domain: {}, name: {} } },
        },
      }), { status: 200 }),
    });
    assert.deepEqual(await gateway.getEndpoint("treg.companies.enrich"), {
      id: "treg.companies.enrich",
      title: "Company enrichment",
      provider: "treg",
      category: "enrichment_company",
      priceUsd: 0.0018,
      priceUnit: "unknown",
      successRate: 0.7682,
      latencyMs: 420,
      requiresOwnAccount: false,
      requiresByok: false,
      strictQuery: false,
      inputFields: ["domain", "name"],
    });
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("TregGateway sends the company enrichment contract and unwraps provider output", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  let requestBody: Record<string, unknown> | undefined;
  let searchCalls = 0;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url, init) => {
        if (url.includes("/catalog/search")) {
          searchCalls += 1;
          return new Response(JSON.stringify({ results: searchCalls === 1 ? [] : [{ id: "treg.companies.enrich", method: "POST", title: "Company enrichment", provider: "treg", category: "company", price_usd: 0.01 }] }), { status: 200 });
        }
        if (url.includes("/catalog/endpoints/")) return new Response(JSON.stringify({ endpoint: { id: "treg.companies.enrich", method: "POST", name: "Company enrichment", provider: "treg", cost: { usd: 0.01 }, input: { body: { domain: {}, name: {} } } } }), { status: 200 });
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ result: { output: { name: "Acme", domain: "acme.test", industry: "software", employees: "1-10" }, raw: { secret: "not returned" } } }), { status: 200 });
      },
    });
    const result = await gateway.enrichCompany({ userId: 1, domain: "acme.test", name: "Acme" });
    assert.equal(searchCalls, 0, "standard company enrichment uses the Treg-routed endpoint");
    assert.deepEqual(requestBody, { domain: "acme.test", name: "Acme" });
    assert.deepEqual(result.items.map((item) => item.field), ["company_name", "domain", "industry", "employee_count"]);
    assert.equal(result.items.some((item) => item.field === "raw"), false);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("Treg person enrichment omits route verification and the gateway restricts that header to find routes", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  let providerCalls = 0;
  let enrichmentVerifyHeader: string | null = null;
  let emailFindVerifyHeader: string | null = null;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url, init) => {
        if (url.includes("/catalog/endpoints/")) {
          const endpointId = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
          return new Response(JSON.stringify({ endpoint: {
            id: endpointId, provider: "treg", method: "POST", title: endpointId,
            cost: { type: "per_success", value: 0.001, usd: 0.001, unit: "call", varies: false },
          } }), { status: 200 });
        }
        providerCalls += 1;
        const verifyHeader = new Headers(init.headers).get("X-Treg-Route-Verify");
        if (url.endsWith("/call/treg.people.email.find")) emailFindVerifyHeader = verifyHeader;
        else enrichmentVerifyHeader = verifyHeader;
        return new Response(JSON.stringify({ result: { full_name: "A Person", email: "person@example.com" } }), {
          status: 200,
          headers: { "X-Treg-Call-Id": `call_person_${providerCalls}`, "X-Treg-Cost-Micro": "1000" },
        });
      },
    });

    const enrichment = await gateway.enrichPerson({ userId: 1, name: "A Person", domain: "example.com", maxSpendUsd: 0.05 });
    assert.ok(enrichment.warnings.some((warning) => warning.includes("without explicit verified status")));
    assert.equal(enrichmentVerifyHeader, null);

    await gateway.call({ userId: 1, endpointId: "treg.people.email.find", body: { full_name: "A Person", domain: "example.com" }, estimateUsd: 0.05, routeVerify: true });
    assert.equal(emailFindVerifyHeader, "true");

    await assert.rejects(
      gateway.call({ userId: 1, endpointId: "treg.people.enrich", body: { full_name: "A Person" }, estimateUsd: 0.05, routeVerify: true }),
      /route verification is only supported for treg\.people\.email\.find and treg\.people\.phone\.find/,
    );
    assert.equal(providerCalls, 2, "the unsupported header is rejected before a provider call");
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("TregGateway maps company query to exactly one Treg identity and preflights its price once", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  let metadataCalls = 0;
  let providerCalls = 0;
  let requestBody: Record<string, unknown> | undefined;
  let idempotencyKey: string | undefined;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url, init) => {
        if (url.includes("/catalog/endpoints/")) {
          metadataCalls += 1;
          return new Response(JSON.stringify({ id: "treg.companies.search", method: "POST", title: "Company search", provider: "treg", price_usd: 0, price_unit: "call" }), { status: 200 });
        }
        providerCalls += 1;
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        idempotencyKey = (init.headers as Record<string, string>)["Idempotency-Key"];
        return new Response(JSON.stringify({ result: { companies: [{ name: "Acme", domain: "acme.example" }] } }), { status: 200, headers: { "X-Treg-Call-Id": "call_company_1", "X-Treg-Cost-Micro": "0" } });
      },
    });
    const result = await gateway.searchCompanies({
      userId: 1, query: "B2B SaaS companies", country: "London", limit: 3, maxSpendUsd: 0.1, idempotencyKey: "stable-company-search",
    });
    assert.deepEqual(requestBody, { q: "B2B SaaS companies", country: "London", limit: 3 });
    assert.equal(metadataCalls, 1, "the metadata used for preflight is reused for the call");
    assert.equal(providerCalls, 1, "one company search reaches the provider");
    assert.equal(idempotencyKey, "stable-company-search");
    assert.equal(result.callId, "call_company_1");
    assert.equal(result.companies[0]?.name, "Acme");
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("Treg company search excludes provider rows that do not match an exact requested domain", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url) => {
        if (url.includes("/catalog/endpoints/")) {
          return new Response(JSON.stringify({ id: "treg.companies.search", method: "POST", title: "Company search", provider: "treg", price_usd: 0, price_unit: "call" }), { status: 200 });
        }
        return new Response(JSON.stringify({ result: { companies: [
          { name: "HubSpot", domain: "https://www.hubspot.com/company/about" },
          { name: "LPL Financial Solutions", domain: "https://meetings-na2.hubspot.com/lalexander-lutterodt" },
        ] } }), { status: 200, headers: { "X-Treg-Call-Id": "call_company_domain_match", "X-Treg-Cost-Micro": "380" } });
      },
    });

    const result = await gateway.searchCompanies({ userId: 1, domain: "hubspot.com", limit: 1, maxSpendUsd: 0.1 });

    assert.deepEqual(result.companies.map((company) => company.name), ["HubSpot"]);
    assert.equal(result.incomplete, true);
    assert.match(result.warnings.join(" "), /1 company record\(s\).*exact match.*excluded/);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("Treg company search combines identity inputs into one q field and blocks an over-cap estimate", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  let providerCalls = 0;
  let requestBody: Record<string, unknown> | undefined;
  let metadataPriceUsd = 0.02;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url, init) => {
        if (url.includes("/catalog/endpoints/")) return new Response(JSON.stringify({ id: "treg.companies.search", method: "POST", title: "Company search", provider: "treg", price_usd: metadataPriceUsd, price_unit: "result" }), { status: 200 });
        providerCalls += 1;
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ result: { companies: [] } }), { status: 200, headers: { "X-Treg-Call-Id": "call_company_2", "X-Treg-Cost-Micro": "0" } });
      },
    });
    await gateway.searchCompanies({ userId: 1, query: "B2B SaaS", industry: "software", country: "London", limit: 3, maxSpendUsd: 0.1 });
    assert.deepEqual(requestBody, { q: "query: B2B SaaS; industry: software", country: "London", limit: 3 });
    assert.equal(providerCalls, 1);

    metadataPriceUsd = 0.04;
    await assert.rejects(
      gateway.searchCompanies({ userId: 1, industry: "software", country: "London", limit: 3, maxSpendUsd: 0.1 }),
      /estimate \$0\.120000 exceeds the \$0\.100000 limit; no provider call was made/,
    );
    assert.equal(providerCalls, 1, "over-cap requests stop after catalog inspection");
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("Treg company search accepts current variable per-success catalog pricing under the owner route cap", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  let providerCalls = 0;
  let routeMaxCost: string | null = null;
  let requestBody: Record<string, unknown> | undefined;
  let snapshot: { spentUsd: number; reservedUsd: number } | undefined;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({
        getSnap: async () => snapshot ? { userId: 1, dayKey: new Date().toISOString().slice(0, 10), ...snapshot, missionSpent: {}, missionReserved: {} } : null,
        saveSnap: async (value) => { snapshot = { spentUsd: value.spentUsd, reservedUsd: value.reservedUsd }; },
      }),
      recordReceipt: async () => {},
      fetchImpl: async (url, init) => {
        if (url.includes("/catalog/endpoints/")) {
          return new Response(JSON.stringify({ endpoint: {
            id: "treg.companies.search", method: "POST", provider: "treg", title: "Routed company search",
            cost: { type: "per_success", value: 0, usd: 0, currency: "USD", per: 1, unit: "call", varies: true },
          } }), { status: 200 });
        }
        providerCalls += 1;
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        routeMaxCost = new Headers(init.headers).get("X-Treg-Route-Max-Cost");
        return new Response(JSON.stringify({ result: { companies: [] } }), { status: 200, headers: { "X-Treg-Call-Id": "call_company_live_shape", "X-Treg-Cost-Micro": "12000" } });
      },
    });

    const result = await gateway.searchCompanies({ userId: 1, domain: "example.com", limit: 5, maxSpendUsd: 0.1 });
    assert.equal(providerCalls, 1);
    assert.deepEqual(requestBody, { domain: "example.com", limit: 5 });
    assert.equal(routeMaxCost, "0.100000");
    assert.equal(result.totalCostUsd, 0.012);
    assert.equal(result.callId, "call_company_live_shape");
    assert.deepEqual(snapshot, { spentUsd: 0.012, reservedUsd: 0 });
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("Treg company search rejects country-only input and unknown prices before provider dispatch", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  let metadataCalls = 0;
  let providerCalls = 0;
  let metadataPriceUsd = 0.01;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url) => {
        if (url.includes("/catalog/endpoints/")) {
          metadataCalls += 1;
          return new Response(JSON.stringify({ id: "treg.companies.search", method: "POST", title: "Company search", provider: "treg", price_usd: metadataPriceUsd }), { status: 200 });
        }
        providerCalls += 1;
        return new Response(JSON.stringify({ result: { companies: [] } }), { status: 200 });
      },
    });
    await assert.rejects(gateway.searchCompanies({ userId: 1, country: "London", maxSpendUsd: 0.1 }), /country filter alone is not enough/);
    assert.equal(metadataCalls, 0);
    await assert.rejects(gateway.searchCompanies({ userId: 1, query: "B2B SaaS", maxSpendUsd: 0.1 }), /price unit is unknown; no provider call was made/);
    assert.equal(metadataCalls, 1);
    assert.equal(providerCalls, 0);

    metadataPriceUsd = 0;
    await assert.rejects(gateway.searchCompanies({ userId: 1, domain: "example.com", maxSpendUsd: 0.1 }), /price unit is unknown; no provider call was made/);
    assert.equal(metadataCalls, 2, "a zero price with unknown units is also rejected");
    assert.equal(providerCalls, 0);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("TregGateway falls back to the work-email capability search when a person query is too specific", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  let searchCalls = 0;
  let requestBody: Record<string, unknown> | undefined;
  try {
    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: async (url, init) => {
        if (url.includes("/catalog/search")) {
          searchCalls += 1;
          return new Response(JSON.stringify({ results: searchCalls === 1 ? [] : [{ id: "treg.people.email.find", method: "POST", title: "Find a work email", provider: "treg", category: "enrichment_person", price_usd: 0.01, input_fields: ["full_name", "domain"] }] }), { status: 200 });
        }
        if (url.includes("/catalog/endpoints/")) return new Response(JSON.stringify({ id: "treg.people.email.find", method: "POST", title: "Find a work email", provider: "treg", category: "enrichment_person", price_usd: 0.01, input_fields: ["full_name", "domain"] }), { status: 200 });
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ result: { email: "person@example.com", full_name: "A Person" } }), { status: 200 });
      },
    });
    const result = await gateway.enrichPerson({ userId: 1, name: "A Person", domain: "example.com" });
    assert.equal(searchCalls, 2);
    assert.deepEqual(requestBody, { full_name: "A Person", domain: "example.com" });
    assert.deepEqual(result.endpointsUsed, ["treg.people.email.find"]);
    assert.equal(result.items.find((item) => item.field === "email")?.value, "person@example.com");
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
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
        fetchImpl: async () => { calls += 1; return new Response(JSON.stringify(calls === 1 ? { id: "endpoint-1", method: "POST", price_usd: 0.05 } : { id: "call-1", cost_usd: 0.05, result: { verified: true } }), { status: 200 }); },
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
    const fetchImpl = async () => new Response(JSON.stringify({ id: "endpoint-1", method: "POST", provider: "test" }), { status: 200 });
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
        return new Response(JSON.stringify({ id: "endpoint-1", method: "POST", price_usd: 0.01, strict_query: true }), { status: 200 });
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
    if (settleCalls === 0) return new Response(JSON.stringify({ id: "endpoint-1", method: "POST", price_usd: 0.05 }), { status: 200 });
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

test("TregGateway findEmail discovers and verifies emails with domain matching", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  try {
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/catalog/endpoints/")) {
        return new Response(JSON.stringify({ id: "treg.people.email.find", method: "POST", title: "Find work email", provider: "treg", price_usd: 0.005 }), { status: 200 });
      }
      if (url.includes("/call/treg.people.email.find")) {
        const headers = new Headers();
        headers.set("X-Treg-Call-Id", "call_email_123");
        headers.set("X-Treg-Cost-Micro", "5000");
        headers.set("X-Treg-Served-By", "quickenrich");
        return new Response(JSON.stringify({
          output: { email: "satya@microsoft.com", first_name: "Satya", last_name: "Nadella", full_name: "Satya Nadella", domain: "microsoft.com" },
          _treg: {
            served_by: "quickenrich",
            domain_match: true,
            verification: { verdict: "valid" },
            advice: "Address verified deliverable by provider SMTP probe",
          },
        }), { status: 200, headers });
      }
      return new Response("Not found", { status: 404 });
    };

    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: fetchMock,
    });

    const result = await gateway.findEmail({
      userId: 1,
      fullName: "Satya Nadella",
      domain: "microsoft.com",
    });

    assert.equal(result.email, "satya@microsoft.com");
    assert.equal(result.verified, true);
    assert.equal(result.domainMatch, true);
    assert.equal(result.servedBy, "quickenrich");
    assert.equal(result.totalCostUsd, 0.005);
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("TregGateway findPhone and similarCompanies retrieve and normalize responses", async () => {
  const previous = { enabled: config.tregEnabled, token: config.tregToken };
  config.tregEnabled = true;
  config.tregToken = "test-token";
  try {
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/catalog/endpoints/")) {
        const id = url.split("/catalog/endpoints/")[1]?.split("?")[0] || "treg.mock";
        return new Response(JSON.stringify({ id, method: "POST", title: "Mock endpoint", provider: "treg", price_usd: 0.01 }), { status: 200 });
      }
      if (url.includes("/call/treg.people.phone.find")) {
        const headers = new Headers();
        headers.set("X-Treg-Call-Id", "call_phone_456");
        headers.set("X-Treg-Cost-Micro", "10000");
        headers.set("X-Treg-Served-By", "blitzapi");
        return new Response(JSON.stringify({
          output: { phone: "+14155550199", full_name: "Patrick Collison", country: "US" },
          _treg: { served_by: "blitzapi", verification: { verdict: "valid" } },
        }), { status: 200, headers });
      }
      if (url.includes("/call/treg.companies.similar")) {
        const headers = new Headers();
        headers.set("X-Treg-Call-Id", "call_sim_789");
        headers.set("X-Treg-Cost-Micro", "8900");
        headers.set("X-Treg-Served-By", "tomba");
        return new Response(JSON.stringify({
          output: {
            companies: [
              { domain: "adyen.com", name: "Adyen", similarity: 0.94, employees: 3500 },
              { domain: "checkout.com", name: "Checkout.com", similarity: 0.88, employees: 2000 },
            ],
          },
        }), { status: 200, headers });
      }
      return new Response("Not found", { status: 404 });
    };

    const gateway = new TregGateway({
      spend: new TregSpendGuard({ getSnap: async () => null, saveSnap: async () => {} }),
      recordReceipt: async () => {},
      fetchImpl: fetchMock,
    });

    const phoneRes = await gateway.findPhone({
      userId: 1,
      linkedinUrl: "https://www.linkedin.com/in/patrickcollison",
    });
    assert.equal(phoneRes.phone, "+14155550199");
    assert.equal(phoneRes.verified, true);
    assert.equal(phoneRes.servedBy, "blitzapi");

    const simRes = await gateway.similarCompanies({
      userId: 1,
      domain: "stripe.com",
    });
    assert.equal(simRes.companies.length, 2);
    assert.equal(simRes.companies[0]?.domain, "adyen.com");
    assert.equal(simRes.companies[0]?.employeeCount, 3500);
    assert.equal(simRes.companies[1]?.domain, "checkout.com");
  } finally {
    config.tregEnabled = previous.enabled;
    config.tregToken = previous.token;
  }
});

test("native Treg resolution cannot widen a trusted signal-monitor budget", async () => {
  let received: Record<string, unknown> | undefined;
  const gateway = { resolveDataNeed: async (options: Record<string, unknown>) => (received = options) } as unknown as TregGateway;
  setTregGatewayForTests(gateway);
  try {
    await nativeTool(42, "CHUCK_TREG_RESOLVE", { need: "new hiring signals", maxCalls: 5, maxSpendUsd: 10 }, { tregMaxCalls: 1, tregMaxSpendUsd: 0.25 });
    assert.equal(received?.maxCalls, 1);
    assert.equal(received?.maxSpendUsd, 0.25);
    assert.equal(received?.readOnlyOnly, undefined);
  } finally {
    setTregGatewayForTests(undefined);
  }
});

test("Muna Treg resolution is read-only, one-call, and capped by the per-call budget", async () => {
  let received: Record<string, unknown> | undefined;
  const gateway = { resolveDataNeed: async (options: Record<string, unknown>) => (received = options) } as unknown as TregGateway;
  setTregGatewayForTests(gateway);
  try {
    await nativeTool(42, "CHUCK_TREG_RESOLVE", { need: "recent company buying signals", maxCalls: 5, maxSpendUsd: 10 }, { worker: "muna", tregMaxCalls: 4, tregMaxSpendUsd: 0.5 });
    assert.equal(received?.maxCalls, 1);
    assert.equal(received?.maxSpendUsd, Math.min(config.tregPerCallSoftCapUsd, 0.5, 10));
    assert.equal(received?.readOnlyOnly, true);
  } finally {
    setTregGatewayForTests(undefined);
  }
});

test("Muna hiring-signal search cannot widen its trusted per-call Treg budget", async () => {
  let received: Record<string, unknown> | undefined;
  const gateway = { searchCompanyJobs: async (options: Record<string, unknown>) => (received = options) } as unknown as TregGateway;
  setTregGatewayForTests(gateway);
  try {
    await nativeTool(42, "CHUCK_TREG_COMPANY_JOBS_SEARCH", { domain: "example.com", maxSpendUsd: 10 }, { worker: "muna", tregMaxSpendUsd: 0.03 });
    assert.equal(received?.maxSpendUsd, Math.min(config.tregPerCallSoftCapUsd, 0.03, 10));
  } finally {
    setTregGatewayForTests(undefined);
  }
});

test("Muna people search, company search, and email verification share the trusted Treg spend cap", async () => {
  const received: Array<{ tool: string; maxSpendUsd?: unknown }> = [];
  const gateway = {
    searchPeople: async (options: Record<string, unknown>) => { received.push({ tool: "people", maxSpendUsd: options.maxSpendUsd }); },
    searchCompanies: async (options: Record<string, unknown>) => { received.push({ tool: "company", maxSpendUsd: options.maxSpendUsd }); },
    verifyEmail: async (options: Record<string, unknown>) => { received.push({ tool: "verify", maxSpendUsd: options.maxSpendUsd }); },
  } as unknown as TregGateway;
  setTregGatewayForTests(gateway);
  try {
    const runtime = { worker: "muna", tregMaxSpendUsd: 0.03 };
    await nativeTool(42, "CHUCK_TREG_PEOPLE_SEARCH", { query: "security leaders", maxSpendUsd: 10 }, runtime);
    await nativeTool(42, "CHUCK_TREG_COMPANY_SEARCH", { domain: "example.com" }, runtime);
    await nativeTool(42, "CHUCK_TREG_EMAIL_VERIFY", { email: "person@example.com" }, runtime);
    assert.deepEqual(received, [
      { tool: "people", maxSpendUsd: 0.03 },
      { tool: "company", maxSpendUsd: 0.03 },
      { tool: "verify", maxSpendUsd: 0.03 },
    ]);
  } finally {
    setTregGatewayForTests(undefined);
  }
});

test("repeated identical company searches in one agent run reuse the same idempotency key", async () => {
  const keys: Array<string | undefined> = [];
  const gateway = {
    searchCompanies: async (options: { idempotencyKey?: string }) => { keys.push(options.idempotencyKey); return { companies: [] }; },
  } as unknown as TregGateway;
  setTregGatewayForTests(gateway);
  try {
    const args = { query: "B2B SaaS companies", country: "London", limit: 3, maxSpendUsd: 0.1 };
    const runtime = { currentRunId: "run-company-search-1" };
    await nativeTool(42, "CHUCK_TREG_COMPANY_SEARCH", args, runtime);
    await nativeTool(42, "CHUCK_TREG_COMPANY_SEARCH", args, runtime);
    await nativeTool(42, "CHUCK_TREG_COMPANY_SEARCH", { ...args, limit: 4 }, runtime);
    assert.ok(keys[0]);
    assert.equal(keys[0], keys[1], "the exact same request is replay-safe within the run");
    assert.notEqual(keys[0], keys[2], "a materially different request receives a different key");
  } finally {
    setTregGatewayForTests(undefined);
  }
});
