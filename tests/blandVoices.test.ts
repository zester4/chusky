import test from "node:test";
import assert from "node:assert/strict";
import { listBlandCuratedVoices } from "../src/calls/blandVoices.js";

test("Bland picker only exposes public curated BTTS_V3 voices", async () => {
  const voices = await listBlandCuratedVoices("test-key", async (input, init) => {
    assert.equal(String(input), "https://api.bland.ai/v1/voices");
    assert.equal(new Headers(init?.headers).get("Authorization"), "test-key");
    return new Response(JSON.stringify({ voices: [
      { id: "11111111-1111-4111-8111-111111111111", name: "Zoe", description: "  clear\nvoice ", public: true, tags: ["Bland Curated"], service: "BTTS_V3" },
      { id: "22222222-2222-4222-8222-222222222222", name: "Private clone", public: false, tags: ["Bland Curated"], service: "BTTS_V3" },
      { id: "33333333-3333-4333-8333-333333333333", name: "Legacy", public: true, tags: ["Bland Curated"], service: "BTTS_V2" },
      { id: "44444444-4444-4444-8444-444444444444", name: "Community", public: true, tags: ["English"], service: "BTTS_V3" },
    ] }), { status: 200 });
  });
  assert.deepEqual(voices, [{ id: "11111111-1111-4111-8111-111111111111", name: "Zoe", description: "clear voice" }]);
});

test("Bland catalogue failures are clear and do not disclose provider response bodies", async () => {
  await assert.rejects(() => listBlandCuratedVoices("", async () => { throw new Error("not called"); }), /BLAND_API_KEY/);
  await assert.rejects(() => listBlandCuratedVoices("test-key", async () => new Response("private response body", { status: 401 })), /HTTP 401/);
  await assert.rejects(() => listBlandCuratedVoices("test-key", async () => new Response("not json", { status: 200 })), /invalid voice catalogue/);
});
