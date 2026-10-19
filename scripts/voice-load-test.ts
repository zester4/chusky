/**
 * Controlled voice capacity/load harness. It is dry-run by default because
 * each POST creates a real provider call and incurs provider charges.
 */

const baseUrl = (process.env.VOICE_LOAD_BASE_URL ?? "").trim().replace(/\/+$/, "");
const authToken = (process.env.VOICE_LOAD_AUTH_TOKEN ?? "").trim();
const numbers = (process.env.VOICE_LOAD_TEST_NUMBERS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const concurrency = Math.max(1, Math.min(20, Number(process.env.VOICE_LOAD_CONCURRENCY ?? 2)));
const confirmation = (process.env.VOICE_LOAD_CONFIRM ?? "").trim();

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

async function main(): Promise<void> {
  console.log(JSON.stringify({ mode: confirmation === "PLACE_CONTROLLED_LOAD_CALLS" ? "live" : "dry-run", concurrency, numbers: numbers.length, distributedLimit: "TWILIO_VOICE_MAX_ACTIVE_CALLS" }));
  if (confirmation !== "PLACE_CONTROLLED_LOAD_CALLS") {
    console.log("Dry-run only. Set VOICE_LOAD_CONFIRM=PLACE_CONTROLLED_LOAD_CALLS with a dedicated test-number list to place real calls.");
    return;
  }
  if (!/^https:\/\//i.test(baseUrl) || !authToken || !numbers.length || numbers.some((number) => !/^\+[1-9]\d{7,14}$/.test(number))) throw new Error("Load testing requires an HTTPS base URL, auth token, and comma-separated E.164 test numbers.");
  const queue = [...numbers];
  const results: unknown[] = [];
  const worker = async () => {
    while (queue.length) {
      const phoneNumber = queue.shift();
      if (!phoneNumber) return;
      const key = `voice-load-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      try {
        const body = await request("/v1/account/calls", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ phoneNumber, purpose: "Controlled voice capacity test", callProfile: "business" }) });
        results.push({ ok: true, id: body?.id ?? body?.data?.id, phoneNumber });
      } catch (error) {
        results.push({ ok: false, phoneNumber, error: error instanceof Error ? error.message : "request failed" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, numbers.length) }, () => worker()));
  console.log(JSON.stringify({ results }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });

