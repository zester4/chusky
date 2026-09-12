import { createHmac, timingSafeEqual } from "node:crypto";

export type RecallMeetingPlatform = "zoom" | "google_meet" | "microsoft_teams" | "webex";

export interface ValidatedMeetingUrl {
  url: string;
  platform: RecallMeetingPlatform;
}

export interface RecallMediaTicket {
  meetingId: string;
  userId: number;
  expiresAt: number;
  /** Missing on legacy short-lived tickets; those retain addressed-only behavior. */
  interactionMode?: "addressed" | "copilot" | "representative";
}

export interface RecallCreateBotRequest {
  meeting_url: string;
  bot_name: string;
  join_at?: string;
  metadata: Record<string, string>;
  output_media: {
    camera: { kind: "webpage"; config: { url: string } };
  };
  recording_config: {
    retention: null;
    video_mixed_mp4: null;
    audio_mixed_raw: null;
    audio_mixed_mp3: null;
    participant_events: null | Record<string, never>;
    meeting_metadata: null;
    transcript: null;
    realtime_endpoints?: Array<{
      type: "webhook";
      url: string;
      events: ["participant_events.chat_message"];
    }>;
  };
  chat?: {
    on_bot_join: {
      send_to: "everyone";
      message: string;
    };
  };
}

export type RecallChatCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "leave" }
  | { kind: "message"; text: string }
  | { kind: "ambient"; text: string };

export interface ParsedRecallChatWebhook {
  providerBotId: string;
  meetingId: string;
  userId: number;
  command: RecallChatCommand;
  /** For Zoom DMs, the participant to reply to instead of exposing it to everyone. */
  replyToParticipantId?: string;
}

const RECALL_REGIONS = new Set(["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"]);

/** Provider IDs are opaque; validate them before placing them into a URL path. */
export function isValidRecallBotId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function isRecallRegionSupported(region: string): boolean {
  return RECALL_REGIONS.has(region);
}

function trustedHost(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Accept only real meeting links that Recall supports; arbitrary URLs are never forwarded. */
export function validateMeetingUrl(input: unknown): ValidatedMeetingUrl {
  if (typeof input !== "string" || !input.trim() || input.length > 2048) throw new Error("meetingUrl must be a supported Zoom, Google Meet, Microsoft Teams, or Webex link");
  let parsed: URL;
  try { parsed = new URL(input.trim()); }
  catch { throw new Error("meetingUrl must be a supported Zoom, Google Meet, Microsoft Teams, or Webex link"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) throw new Error("Meeting links must use HTTPS and must not contain credentials or a custom port");

  const host = parsed.hostname.toLowerCase();
  let platform: RecallMeetingPlatform;
  if (trustedHost(host, "zoom.us")) platform = "zoom";
  else if (host === "meet.google.com") platform = "google_meet";
  else if (trustedHost(host, "teams.microsoft.com") || trustedHost(host, "teams.live.com") || trustedHost(host, "teams.microsoft.us")) platform = "microsoft_teams";
  else if (trustedHost(host, "webex.com") && (
    /^\/(?:meet|join)\/[^/?#]+\/?$/i.test(parsed.pathname)
    || (/\/j\.php$/i.test(parsed.pathname) && Boolean(parsed.searchParams.get("MTID")))
  )) platform = "webex";
  else throw new Error("Only supported Zoom, Google Meet, Microsoft Teams, or Webex links are accepted for interactive meetings");

  parsed.hash = "";
  return { url: parsed.toString(), platform };
}

export function buildRecallCreateBotRequest(input: {
  meetingUrl: string;
  botName: string;
  mediaPageUrl: string;
  meetingId: string;
  userId: number;
  joinAt?: string;
  realtimeWebhookUrl?: string;
}): RecallCreateBotRequest {
  const meeting = validateMeetingUrl(input.meetingUrl);
  const botName = String(input.botName ?? "").trim();
  if (!botName || botName.length > 100) throw new Error("Recall bot name must be 1-100 characters");
  const mediaPage = new URL(input.mediaPageUrl);
  if (mediaPage.protocol !== "https:" || mediaPage.username || mediaPage.password) throw new Error("Recall media page URL must be HTTPS");
  if (mediaPage.searchParams.has("session")) throw new Error("Recall media tickets must not be placed in URL query strings");
  let realtimeWebhookUrl: string | undefined;
  if (input.realtimeWebhookUrl) {
    let endpoint: URL;
    try { endpoint = new URL(input.realtimeWebhookUrl); } catch { throw new Error("Recall real-time webhook URL must be HTTPS"); }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Recall real-time webhook URL must be HTTPS and cannot contain credentials, query parameters, or a fragment");
    realtimeWebhookUrl = endpoint.toString();
  }
  if (!/^mtg_[A-Za-z0-9_-]{1,80}$/.test(input.meetingId) || !Number.isSafeInteger(input.userId) || input.userId <= 0) throw new Error("Invalid Chusky meeting identity");
  const request: RecallCreateBotRequest = {
    meeting_url: meeting.url,
    bot_name: botName,
    metadata: { chusky_meeting_id: input.meetingId, chusky_user_id: String(input.userId) },
    output_media: { camera: { kind: "webpage", config: { url: mediaPage.toString() } } },
    // Output Media supplies the live audio path. Do not also create retained
    // recording artifacts or transcripts: Recall supports retention:null for
    // zero-data-retention meetings.
    recording_config: {
      retention: null,
      video_mixed_mp4: null,
      audio_mixed_raw: null,
      audio_mixed_mp3: null,
      participant_events: realtimeWebhookUrl ? {} : null,
      meeting_metadata: null,
      transcript: null,
      ...(realtimeWebhookUrl ? { realtime_endpoints: [{
        type: "webhook",
        url: realtimeWebhookUrl,
        events: ["participant_events.chat_message"],
      }] } : {}),
    },
    ...(realtimeWebhookUrl && meeting.platform !== "webex" ? {
      chat: {
        on_bot_join: {
          send_to: "everyone",
        message: "Chusky is a disclosed AI meeting representative. It may listen and contribute to this meeting, and live audio is processed. Recall recording and transcript retention are disabled. Address Chusky by name to ask a question; you may ask it to leave at any time.",
        },
      },
    } : {}),
  };
  if (input.joinAt) request.join_at = input.joinAt;
  return request;
}

export interface RecallApiRequestOptions {
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** A sanitized provider error that retains only the HTTP status needed for retry policy. */
export class RecallApiError extends Error {
  constructor(readonly status: number) {
    super(`Recall API request failed (${status})`);
    this.name = "RecallApiError";
  }
}

function waitForRecallRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Recall meeting creation was cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Recall meeting creation was cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Recall asks clients to retry capacity-related 507 responses every 30 seconds, at most ten times. */
export async function createRecallBotWithRetry<T>(input: {
  create: () => Promise<T>;
  signal?: AbortSignal;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<T> {
  const wait = input.wait ?? waitForRecallRetry;
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Recall meeting creation was cancelled");
    try {
      return await input.create();
    } catch (error) {
      if (!(error instanceof RecallApiError) || error.status !== 507) throw error;
      if (attempt === 10) throw new Error("Recall API returned 507 after 10 attempts");
      await wait(30_000, input.signal);
    }
  }
  throw new Error("Recall Create Bot retry loop ended unexpectedly");
}

export async function recallApiRequest(
  region: string,
  apiKey: string,
  path: string,
  options: RecallApiRequestOptions,
): Promise<Record<string, unknown>> {
  if (!isRecallRegionSupported(region)) throw new Error("RECALL_REGION is not a supported Recall region");
  if (!apiKey.trim()) throw new Error("RECALL_API_KEY is required");
  const chatSendPath = /^\/bot\/[A-Za-z0-9_-]{1,128}\/send_chat_message\/$/.test(path);
  const allowedPath = path === "/bot/"
    || chatSendPath
    || /^\/bot\/[A-Za-z0-9_-]{1,128}\/leave_call\/$/.test(path)
    || /^\/bot\/[A-Za-z0-9_-]{1,128}\/$/.test(path);
  if (!allowedPath) throw new Error("Unsupported Recall API path");
  if ((path === "/bot/" && options.method !== "POST")
    || (chatSendPath && options.method !== "POST")
    || (/\/leave_call\/$/i.test(path) && options.method !== "POST")
    || (/^\/bot\/[A-Za-z0-9_-]{1,128}\/$/.test(path) && !["GET", "DELETE"].includes(options.method))) {
    throw new Error("Unsupported Recall API method");
  }
  if (chatSendPath) validateRecallChatSendBody(options.body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Recall API request timed out")), Math.max(1000, Math.min(options.timeoutMs ?? 20_000, 60_000)));
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await (options.fetchImpl ?? fetch)(`https://${region}.recall.ai/api/v1${path}`, {
      method: options.method,
      headers: { Authorization: `Token ${apiKey}`, Accept: "application/json", ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new RecallApiError(response.status);
    if (response.status === 204) return {};
    let result: unknown;
    try { result = await response.json(); } catch { throw new Error("Recall API returned an invalid response"); }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Recall API returned an invalid response");
    return result as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function validateRecallChatSendBody(value: unknown): asserts value is { message: string; to?: string; pin?: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unsupported Recall API body");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["message", "to", "pin"].includes(key))) throw new Error("Unsupported Recall API body");
  if (typeof body.message !== "string" || !body.message.trim() || [...body.message].length > 4096) throw new Error("Recall chat message must contain 1-4096 characters");
  if (body.to !== undefined && (typeof body.to !== "string" || !["everyone", "host", "everyone_except_host"].includes(body.to) && !/^\d{1,32}$/.test(body.to))) throw new Error("Invalid Recall chat recipient");
  if (body.pin !== undefined && typeof body.pin !== "boolean") throw new Error("Invalid Recall chat pin option");
}

/** Only act on direct mentions/addresses; unrelated ambient chat is not an agent prompt. */
export function recallChatCommand(value: unknown): RecallChatCommand | undefined {
  if (typeof value !== "string" || value.length > 1_000) return undefined;
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
  const match = text.match(/^(?:\/chusky(?:@[A-Za-z0-9_]+)?|@chusky|(?:(?:hey|hi|hello)\s+)?chusky)\b\s*(?::|,)?\s*([\s\S]*)$/i);
  if (!match) return text && text.length <= 900 ? { kind: "ambient", text } : undefined;
  const commandText = match[1]?.trim() ?? "";
  if (/^(?:leave|please\s+leave|remove(?:\s+yourself)?|stop|exit)(?:\s+the\s+meeting)?[.!]?$/i.test(commandText)) return { kind: "leave" };
  if (/^help[.!]?$/i.test(commandText)) return { kind: "help" };
  if (/^status[.!]?$/i.test(commandText)) return { kind: "status" };
  if (!commandText || commandText.length > 900) return undefined;
  return { kind: "message", text: commandText };
}

/** Extract only the addressed message and owner metadata; participant identity fields are discarded. */
export function parseRecallChatWebhook(value: unknown): ParsedRecallChatWebhook | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (body.event !== "participant_events.chat_message") return undefined;
  const envelope = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {};
  const chatEvent = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : {};
  const chatData = chatEvent.data && typeof chatEvent.data === "object" && !Array.isArray(chatEvent.data) ? chatEvent.data as Record<string, unknown> : {};
  const bot = envelope.bot && typeof envelope.bot === "object" && !Array.isArray(envelope.bot) ? envelope.bot as Record<string, unknown> : {};
  const participant = chatEvent.participant && typeof chatEvent.participant === "object" && !Array.isArray(chatEvent.participant) ? chatEvent.participant as Record<string, unknown> : {};
  const metadata = bot.metadata && typeof bot.metadata === "object" && !Array.isArray(bot.metadata) ? bot.metadata as Record<string, unknown> : {};
  const providerBotId = String(bot.id ?? "");
  const meetingId = String(metadata.chusky_meeting_id ?? "");
  const userId = Number(metadata.chusky_user_id);
  if (!isValidRecallBotId(providerBotId) || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId) || !Number.isSafeInteger(userId) || userId <= 0) return undefined;
  const command = recallChatCommand(chatData.text);
  if (!command) return undefined;
  const recipient = typeof chatData.to === "string" ? chatData.to.trim().toLowerCase() : "everyone";
  let replyToParticipantId: string | undefined;
  if (recipient && recipient !== "everyone") {
    const participantId = participant.id;
    if (!(typeof participantId === "string" || typeof participantId === "number") || !/^\d{1,32}$/.test(String(participantId))) return undefined;
    replyToParticipantId = String(participantId);
  }
  return { providerBotId, meetingId, userId, command, ...(replyToParticipantId ? { replyToParticipantId } : {}) };
}

export function validateRecallJoinAt(value: unknown, nowMs = Date.now()): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("joinAt must be a future ISO-8601 timestamp");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("joinAt must be a future ISO-8601 timestamp");
  if (timestamp < nowMs + 10 * 60_000) throw new Error("Scheduled meetings must start at least 10 minutes from now; omit joinAt to join immediately");
  if (timestamp > nowMs + 30 * 24 * 60 * 60_000) throw new Error("Meetings can be scheduled at most 30 days ahead");
  return new Date(timestamp).toISOString();
}

export function mapRecallBotStatus(code: unknown): "joining" | "waiting_room" | "in_call" | "ended" | "failed" | undefined {
  switch (String(code ?? "").toLowerCase()) {
    case "joining_call": return "joining";
    case "in_waiting_room": return "waiting_room";
    case "in_call_not_recording":
    case "recording_permission_allowed":
    case "recording_permission_denied":
    case "in_call_recording": return "in_call";
    case "call_ended":
    case "done": return "ended";
    case "fatal": return "failed";
    default: return undefined;
  }
}

export function createRecallMediaTicket(claim: RecallMediaTicket, secret: string): string {
  if (!secret || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(claim.meetingId) || !Number.isSafeInteger(claim.userId) || claim.userId <= 0 || !Number.isSafeInteger(claim.expiresAt) || (claim.interactionMode !== undefined && !["addressed", "copilot", "representative"].includes(claim.interactionMode))) throw new Error("Invalid Recall media ticket claim");
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyRecallMediaTicket(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): RecallMediaTicket | undefined {
  if (!secret || typeof token !== "string" || token.length > 2048) return undefined;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); } catch { return undefined; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  try {
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<RecallMediaTicket>;
    if (Object.keys(claim).some((key) => !["meetingId", "userId", "expiresAt", "interactionMode"].includes(key))) return undefined;
    if (typeof claim.meetingId !== "string" || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(claim.meetingId)) return undefined;
    if (!Number.isSafeInteger(claim.userId) || Number(claim.userId) <= 0 || !Number.isSafeInteger(claim.expiresAt) || Number(claim.expiresAt) <= nowSeconds) return undefined;
    if (claim.interactionMode !== undefined && claim.interactionMode !== "addressed" && claim.interactionMode !== "copilot" && claim.interactionMode !== "representative") return undefined;
    return { meetingId: claim.meetingId, userId: Number(claim.userId), expiresAt: Number(claim.expiresAt), ...(claim.interactionMode ? { interactionMode: claim.interactionMode } : {}) };
  } catch { return undefined; }
}

export function verifyRecallWebhookSignature(input: {
  secret: string;
  body: string;
  headers: Headers | Record<string, string | undefined>;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const { secret, body } = input;
  if (!secret.startsWith("whsec_")) return false;
  const getHeader = (name: string): string | undefined => input.headers instanceof Headers
    ? input.headers.get(name) ?? undefined
    : Object.entries(input.headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const id = getHeader("webhook-id") ?? getHeader("svix-id");
  const timestamp = getHeader("webhook-timestamp") ?? getHeader("svix-timestamp");
  const signature = getHeader("webhook-signature") ?? getHeader("svix-signature");
  if (!id || id.length > 200 || !timestamp || !/^\d{1,12}$/.test(timestamp) || !signature || signature.length > 2048) return false;
  const timestampSeconds = Number(timestamp);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > (input.toleranceSeconds ?? 300)) return false;
  let key: Buffer;
  try { key = Buffer.from(secret.slice("whsec_".length), "base64"); } catch { return false; }
  if (!key.length) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(" ").some((versioned) => {
    const [version, encoded] = versioned.split(",");
    if (version !== "v1" || !encoded) return false;
    try {
      const supplied = Buffer.from(encoded, "base64");
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    } catch { return false; }
  });
}
