export type XchatSubscriptionEvent = "chat.received" | "chat.conversation.join";

export type XchatSetupStatus = {
  status: "ready" | "misconfigured";
  botUserId?: string;
  botUsername?: string;
  webhookId?: string;
  subscriptions: Array<{ eventType: XchatSubscriptionEvent; status: "existing" | "created" }>;
  error?: string;
};

type FetchLike = typeof fetch;

const REQUIRED_EVENTS: Array<{ eventType: XchatSubscriptionEvent; tag: string }> = [
  { eventType: "chat.received", tag: "chusky-xchat-received" },
  { eventType: "chat.conversation.join", tag: "chusky-xchat-conversation-join" },
];

function boundedRemoteError(response: Response, body: string): Error {
  const detail = body.replace(/\s+/g, " ").trim().slice(0, 300);
  return new Error(`XChat API ${response.status}${detail ? `: ${detail}` : ""}`);
}

async function readJson(response: Response): Promise<any> {
  const body = await response.text();
  if (!response.ok) throw boundedRemoteError(response, body);
  try { return body ? JSON.parse(body) : {}; } catch { throw new Error("XChat API returned invalid JSON"); }
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
}

/**
 * Verify the bot identity and idempotently provision the X Activity API
 * subscriptions required for XChat webhook delivery.
 *
 * Webhook registration and activity subscriptions are separate X resources.
 * Keeping this reconciliation here makes restarts safe and prevents duplicate
 * subscriptions when multiple workers boot at the same time.
 */
export async function ensureXchatActivitySubscriptions(options: {
  accessToken: string;
  webhookId: string;
  expectedUsername?: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<XchatSetupStatus> {
  const accessToken = options.accessToken.trim();
  const webhookId = options.webhookId.trim();
  if (!accessToken || !webhookId) {
    return {
      status: "misconfigured",
      webhookId: webhookId || undefined,
      subscriptions: [],
      error: "XCHAT_BOT_TOKEN and XCHAT_WEBHOOK_ID are required",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.apiBaseUrl || "https://api.x.com").replace(/\/+$/, "");
  const headers = authHeaders(accessToken);
  const identity = await readJson(await fetchImpl(`${baseUrl}/2/users/me`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  }));
  const botUserId = String(identity?.data?.id ?? "").trim();
  const botUsername = String(identity?.data?.username ?? "").trim();
  if (!botUserId || !botUsername) throw new Error("XChat bot token did not resolve to a user identity");
  if (options.expectedUsername && options.expectedUsername.toLowerCase().replace(/^@/, "") !== botUsername.toLowerCase()) {
    return {
      status: "misconfigured",
      botUserId,
      botUsername,
      webhookId,
      subscriptions: [],
      error: `X_BOT_USERNAME does not match the token owner (@${botUsername})`,
    };
  }

  const listed = await readJson(await fetchImpl(`${baseUrl}/2/activity/subscriptions`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  }));
  const existing = Array.isArray(listed?.data) ? listed.data : [];
  const subscriptions: XchatSetupStatus["subscriptions"] = [];

  for (const required of REQUIRED_EVENTS) {
    const found = existing.some((candidate: any) =>
      (String(candidate?.event_type ?? "") === required.eventType ||
        (required.eventType === "chat.conversation.join" && String(candidate?.event_type ?? "") === "chat.conversation_join")) &&
      String(candidate?.webhook_id ?? "") === webhookId &&
      String(candidate?.filter?.user_id ?? "") === botUserId,
    );
    if (found) {
      subscriptions.push({ eventType: required.eventType, status: "existing" });
      continue;
    }

    const created = await fetchImpl(`${baseUrl}/2/activity/subscriptions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ event_type: required.eventType, filter: { user_id: botUserId }, tag: required.tag, webhook_id: webhookId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!created.ok && created.status !== 409) throw boundedRemoteError(created, await created.text());
    subscriptions.push({ eventType: required.eventType, status: created.status === 409 ? "existing" : "created" });
  }

  return { status: "ready", botUserId, botUsername, webhookId, subscriptions };
}
