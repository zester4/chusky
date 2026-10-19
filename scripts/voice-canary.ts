/**
 * Controlled production voice canary.
 *
 * This script is intentionally inert unless the operator supplies the exact
 * confirmation string. It makes one outbound call by default, polls the
 * owner-scoped call record, and verifies that the provider lifecycle and
 * outcome become durable. It never retries a POST with a new idempotency key.
 */

const baseUrl = (process.env.VOICE_CANARY_BASE_URL ?? "").trim().replace(/\/+$/, "");
const authToken = (process.env.VOICE_CANARY_AUTH_TOKEN ?? "").trim();
const phoneNumber = (process.env.VOICE_CANARY_PHONE_NUMBER ?? "").trim();
const purpose = (process.env.VOICE_CANARY_PURPOSE ?? "Production voice canary — one controlled call").trim();
const confirmation = (process.env.VOICE_CANARY_CONFIRM ?? "").trim();
const timeoutMs = Math.max(60_000, Math.min(20 * 60_000, Number(process.env.VOICE_CANARY_TIMEOUT_MS ?? 900_000)));

const manualMatrix = [
  "inbound answered",
  "outbound answered",
  "no-answer",
  "busy",
  "failed",
  "voicemail",
  "barge-in/interruption",
  "Composio tool call",
  "human handoff",
  "transcript and outcome persistence",
  "duplicate webhook and retry behavior",
  "Deepgram reconnect",
  "ambiguous provider response without duplicate dialing",
];

function redact(value: unknown): string {
  return typeof value === "string" ? value.replace(/\d(?=\d{4})/g, "•") : "";
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

async function main(): Promise<void> {
  if (confirmation !== "PLACE_ONE_CONTROLLED_CALL") {
    console.log("Dry-run only. The production canary will place exactly one real call only when VOICE_CANARY_CONFIRM=PLACE_ONE_CONTROLLED_CALL.");
    console.log(`Required inputs: VOICE_CANARY_BASE_URL, VOICE_CANARY_AUTH_TOKEN, VOICE_CANARY_PHONE_NUMBER (currently ${redact(phoneNumber) || "missing"}).`);
    console.log("Manual/controlled matrix to complete with a dedicated test number:");
    for (const item of manualMatrix) console.log(`- ${item}`);
    return;
  }
  if (!baseUrl || !/^https:\/\//i.test(baseUrl) || !authToken || !/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    throw new Error("A canary requires an HTTPS VOICE_CANARY_BASE_URL, VOICE_CANARY_AUTH_TOKEN, and E.164 VOICE_CANARY_PHONE_NUMBER.");
  }
  const idempotencyKey = `voice-canary-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const created = await request("/v1/account/calls", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ phoneNumber, purpose, callProfile: "business" }),
  });
  const callId = String(created?.id ?? created?.data?.id ?? "");
  if (!/^twc_[A-Za-z0-9_-]{1,120}$/.test(callId)) throw new Error("Canary did not return a durable Twilio call ID; do not retry manually.");
  console.log(`Canary started once: ${callId} -> ${redact(phoneNumber)}`);
  const startedAt = Date.now();
  let latest: any = created;
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const listing = await request("/v1/account/calls");
    const calls = Array.isArray(listing?.data) ? listing.data : [];
    latest = calls.find((item: any) => item?.id === callId) ?? latest;
    console.log(JSON.stringify({ id: callId, status: latest.status, providerStatus: latest.providerStatus, outcomeStatus: latest.outcomeStatus, timelineEvents: Array.isArray(latest.timeline) ? latest.timeline.length : 0 }));
    if (["ended", "failed"].includes(String(latest.status)) && latest.outcomeStatus === "completed") {
      const answered = Array.isArray(latest.timeline) && latest.timeline.some((item: any) => item?.type === "call_answered");
      const transcriptTurns = latest.transcript?.turns?.length ?? 0;
      console.log(JSON.stringify({ ok: true, callId, terminal: latest.status, providerStatus: latest.providerStatus, answered, transcriptTurns, outcomeStatus: latest.outcomeStatus }));
      return;
    }
  }
  throw new Error(`Canary timed out waiting for terminal lifecycle and outcome for ${callId}. Do not dial it again; inspect the call record and reconciliation queue.`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });

