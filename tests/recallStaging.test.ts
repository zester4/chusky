import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { initStore } from "../src/store.js";
import { joinRecallMeeting, leaveRecallMeeting } from "../src/meetings/service.js";
import { parseRecallStatusWebhook, verifyRecallWebhookSignature } from "../src/meetings/recall.js";

const fixturePath = process.env.RECALL_STAGING_STATUS_FIXTURE;
const fixtureEnabled = Boolean(fixturePath && process.env.RECALL_WEBHOOK_SECRET);

/**
 * Optional provider-contract check. The fixture must be captured from an actual
 * staging Recall delivery and kept outside the repository; it contains the exact
 * raw body and signature headers so this exercises the provider's wire format.
 */
test("actual Recall staging status fixture has a valid signature and documented envelope", { skip: !fixtureEnabled }, async () => {
  const fixture = JSON.parse(await readFile(fixturePath!, "utf8")) as {
    rawBody?: unknown;
    headers?: Record<string, string>;
  };
  assert.equal(typeof fixture.rawBody, "string");
  assert.ok(fixture.headers && typeof fixture.headers === "object");
  const headers = new Headers(fixture.headers);
  const signedAt = Number(headers.get("webhook-timestamp") ?? headers.get("svix-timestamp"));
  assert.ok(Number.isSafeInteger(signedAt) && signedAt > 0, "fixture must include Recall's timestamp header");
  assert.equal(verifyRecallWebhookSignature({
    secret: process.env.RECALL_WEBHOOK_SECRET!,
    body: fixture.rawBody as string,
    headers,
    // Captured fixtures may be older than the live-replay tolerance. This
    // anchors cryptographic verification to the signed timestamp; production
    // webhook handling still enforces its normal freshness window.
    nowSeconds: signedAt,
  }), true, "exact captured raw bytes must verify against Recall's actual signature");
  const body = JSON.parse(fixture.rawBody as string) as Record<string, any>;
  const parsed = parseRecallStatusWebhook(body);
  assert.ok(parsed, "expected a supported current or legacy Recall status envelope");
  assert.ok(parsed.providerBotId, "expected the provider bot identity");
});

const stagingCreateEnabled = process.env.RECALL_STAGING_CONFIRM === "I_AUTHORIZE_STAGING_BOT";

/** Explicitly gated, scheduled create/cancel smoke test; never runs in ordinary CI. */
test("staging Recall API accepts a scheduled bot and its pre-dispatch cancellation", { skip: !stagingCreateEnabled }, async () => {
  const apiKey = process.env.RECALL_API_KEY?.trim();
  const meetingUrl = process.env.RECALL_STAGING_MEETING_URL?.trim();
  assert.ok(apiKey, "set RECALL_API_KEY for the staging smoke test");
  assert.ok(meetingUrl, "set a dedicated RECALL_STAGING_MEETING_URL you are authorized to use");
  assert.ok(process.env.RECALL_MEDIA_PAGE_URL?.startsWith("https://"), "set the staging RECALL_MEDIA_PAGE_URL");
  assert.ok((process.env.RECALL_MEDIA_BRIDGE_SECRET ?? "").length >= 32, "set the staging RECALL_MEDIA_BRIDGE_SECRET");
  assert.ok(process.env.RECALL_WEBHOOK_SECRET?.startsWith("whsec_"), "set the staging RECALL_WEBHOOK_SECRET");

  config.recallMeetingsEnabled = true;
  config.recallApiKey = apiKey;
  config.recallRegion = process.env.RECALL_REGION ?? "us-west-2";
  config.recallBotName = "Chusky Meeting Assistant";
  config.recallMediaPageUrl = process.env.RECALL_MEDIA_PAGE_URL!;
  config.recallMediaBridgeSecret = process.env.RECALL_MEDIA_BRIDGE_SECRET!;
  config.recallWebhookSecret = process.env.RECALL_WEBHOOK_SECRET!;
  await initStore({ memoryOnly: true });

  const ownerId = 900_000_000 + (Date.now() % 90_000_000);
  const meeting = await joinRecallMeeting(ownerId, {
    meetingUrl,
    title: "Chusky staging smoke test",
    joinAt: new Date(Date.now() + 20 * 60_000).toISOString(),
  });
  assert.equal(meeting.status, "scheduled");
  let cancellationAccepted = false;
  try {
    const cancelled = await leaveRecallMeeting(ownerId, meeting.id);
    cancellationAccepted = Boolean(cancelled);
    assert.ok(cancellationAccepted, "Recall must accept deletion of the scheduled bot before dispatch");
  } finally {
    // If an assertion fails before cleanup, make one best-effort cancellation.
    // Never print provider responses, meeting URLs, or credentials.
    if (!cancellationAccepted) {
      try { await leaveRecallMeeting(ownerId, meeting.id); } catch { /* Already cancelled or no longer cancellable. */ }
    }
  }
});
