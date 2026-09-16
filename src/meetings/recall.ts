import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RecallTranscriptSegment } from "../store.js";

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
  variant?: { zoom: "web_4_core"; google_meet: "web_4_core"; microsoft_teams: "web_4_core" };
  metadata: Record<string, string>;
  output_media: {
    camera: { kind: "webpage"; config: { url: string } };
  };
  recording_config: {
    retention: null;
    include_bot_in_recording: { audio: true };
    video_mixed_mp4: null;
    video_mixed_layout?: "gallery_view_v2";
    video_separate_png?: Record<string, never>;
    audio_mixed_raw: null;
    audio_mixed_mp3: null;
    participant_events: null | Record<string, never>;
    meeting_metadata: null;
    transcript: null | {
      provider: { recallai_streaming: { mode: "prioritize_low_latency"; language_code: "en" } };
      diarization: { use_separate_streams_when_available: true };
    };
    realtime_endpoints?: Array<{
      type: "webhook" | "websocket";
      url: string;
      events: Array<"participant_events.chat_message" | "participant_events.join" | "participant_events.leave" | "participant_events.update" | "participant_events.speech_on" | "participant_events.speech_off" | "transcript.data" | "video_separate_png.data">;
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
  /** Ephemeral signed-provider display name; never interpreted as verified identity. */
  senderName?: string;
  /** For Zoom DMs, the participant to reply to instead of exposing it to everyone. */
  replyToParticipantId?: string;
}

export interface ParsedRecallParticipantWebhook {
  providerBotId: string;
  meetingId: string;
  userId: number;
  participant: { id: string; name: string; identityStatus?: "named" | "unknown"; isHost?: boolean; status: "present" | "left" };
}

export interface ParsedRecallSpeakerWebhook {
  providerBotId: string;
  meetingId: string;
  userId: number;
  speakerEvent: { type: "speech_on" | "speech_off"; participantId?: string; at: number };
}

export interface ParsedRecallTranscriptWebhook {
  providerBotId: string;
  meetingId: string;
  userId: number;
  segment: RecallTranscriptSegment;
}

function safeRecallDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  return name || undefined;
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
  interactionMode?: RecallMediaTicket["interactionMode"];
  joinAt?: string;
  realtimeWebhookUrl?: string;
  transcriptRetentionDays?: 1 | 7 | 30;
  screenShareContextEnabled?: boolean;
  visualWebsocketUrl?: string;
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
  const screenShareContextEnabled = input.screenShareContextEnabled === true;
  if (input.screenShareContextEnabled !== undefined && typeof input.screenShareContextEnabled !== "boolean") throw new Error("screenShareContextEnabled must be true or false");
  const transcriptRetentionDays = input.transcriptRetentionDays;
  if (transcriptRetentionDays !== undefined && transcriptRetentionDays !== 1 && transcriptRetentionDays !== 7 && transcriptRetentionDays !== 30) throw new Error("Meeting transcript retention must be 1, 7, or 30 days");
  if (transcriptRetentionDays !== undefined && !realtimeWebhookUrl) throw new Error("Retained meeting transcripts require the configured signed Recall real-time endpoint");
  let visualWebsocketUrl: string | undefined;
  if (screenShareContextEnabled) {
    if (meeting.platform === "webex") throw new Error("Recall real-time screen understanding supports Zoom, Google Meet, and Microsoft Teams, not Webex");
    if (!realtimeWebhookUrl) throw new Error("Shared-screen understanding requires the configured participant-disclosure webhook");
    let endpoint: URL;
    try { endpoint = new URL(input.visualWebsocketUrl ?? ""); } catch { throw new Error("Recall visual websocket URL must be WSS"); }
    if (endpoint.protocol !== "wss:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Recall visual websocket URL must use WSS and cannot contain credentials, query parameters, or a fragment");
    visualWebsocketUrl = endpoint.toString();
  }
  if (!/^mtg_[A-Za-z0-9_-]{1,80}$/.test(input.meetingId) || !Number.isSafeInteger(input.userId) || input.userId <= 0) throw new Error("Invalid Chusky meeting identity");
  const interactionMode = input.interactionMode ?? "addressed";
  if (!["addressed", "copilot", "representative"].includes(interactionMode)) throw new Error("Invalid meeting interaction mode");
  const transcriptCaptureEnabled = Boolean(realtimeWebhookUrl)
    && (interactionMode !== "addressed" || transcriptRetentionDays !== undefined);
  const realtimeEndpoints: NonNullable<RecallCreateBotRequest["recording_config"]["realtime_endpoints"]> = [];
  if (realtimeWebhookUrl) realtimeEndpoints.push({
    type: "webhook",
    url: realtimeWebhookUrl,
    events: ["participant_events.chat_message", "participant_events.join", "participant_events.leave", "participant_events.update", "participant_events.speech_on", "participant_events.speech_off", ...(transcriptCaptureEnabled ? ["transcript.data" as const] : [])],
  });
  if (visualWebsocketUrl) realtimeEndpoints.push({ type: "websocket", url: visualWebsocketUrl, events: ["video_separate_png.data"] });
  const participantDisclosure = interactionMode === "addressed"
    ? "Say ‘Chusky’ when you’d like a response; you may ask it to leave at any time."
    : "Chusky may contribute proactively when it can help; you may also address it directly or ask it to leave at any time.";
  const transcriptDisclosure = transcriptRetentionDays !== undefined
    ? ` At the owner’s request, Chusky will retain a searchable transcript for ${transcriptRetentionDays} day${transcriptRetentionDays === 1 ? "" : "s"} after the meeting, then delete it.`
    : transcriptCaptureEnabled
      ? " A live transcript is processed for conversation and the private meeting outcome, then deleted; it is not retained as a searchable record."
      : "";
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
      // This does not enable retained recordings or transcripts. It makes
      // Recall include Output Media speech when a recording is explicitly
      // produced, and removes its otherwise misleading dashboard warning.
      include_bot_in_recording: { audio: true },
      video_mixed_mp4: null,
      audio_mixed_raw: null,
      audio_mixed_mp3: null,
      participant_events: realtimeWebhookUrl ? {} : null,
      meeting_metadata: null,
      transcript: transcriptCaptureEnabled ? {
        provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } },
        diarization: { use_separate_streams_when_available: true },
      } : null,
      ...(realtimeEndpoints.length ? { realtime_endpoints: realtimeEndpoints } : {}),
      ...(visualWebsocketUrl ? { video_mixed_layout: "gallery_view_v2", video_separate_png: {} } : {}),
    },
    ...(screenShareContextEnabled ? { variant: { zoom: "web_4_core", google_meet: "web_4_core", microsoft_teams: "web_4_core" } } : {}),
    ...(realtimeWebhookUrl && meeting.platform !== "webex" ? {
      chat: {
        on_bot_join: {
          send_to: "everyone",
          message: `Chusky is a digital assistant joining this meeting. Live audio is processed to enable conversation; Recall recording and media retention are off.${transcriptDisclosure}${screenShareContextEnabled ? " Shared-screen frames may also be briefly analyzed to answer questions about what is shown; images are not added to meeting history." : ""} ${participantDisclosure}`,
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

/** A sanitized provider error that retains the HTTP status and a safe machine error code. */
export class RecallApiError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(`Recall API request failed (${status}${code ? `: ${code}` : ""})`);
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
    if (!response.ok) {
      let code: string | undefined;
      try {
        const errorBody: unknown = await response.clone().json();
        if (errorBody && typeof errorBody === "object" && !Array.isArray(errorBody)) {
          const candidate = (errorBody as Record<string, unknown>).code;
          if (typeof candidate === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(candidate)) code = candidate;
        }
      } catch { /* Keep the status-only error if Recall did not return JSON. */ }
      throw new RecallApiError(response.status, code);
    }
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
  const senderName = safeRecallDisplayName(participant.name);
  return { providerBotId, meetingId, userId, command, ...(senderName ? { senderName } : {}), ...(replyToParticipantId ? { replyToParticipantId } : {}) };
}

/** Extract a minimum live-roster update from a signed Recall event. Names are provider labels, not verified identities. */
export function parseRecallParticipantWebhook(value: unknown): ParsedRecallParticipantWebhook | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const event = String(body.event ?? "");
  if (event !== "participant_events.join" && event !== "participant_events.leave" && event !== "participant_events.update") return undefined;
  const envelope = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {};
  const eventData = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : {};
  const participant = eventData.participant && typeof eventData.participant === "object" && !Array.isArray(eventData.participant)
    ? eventData.participant as Record<string, unknown>
    : envelope.participant && typeof envelope.participant === "object" && !Array.isArray(envelope.participant)
      ? envelope.participant as Record<string, unknown>
      : eventData;
  const bot = envelope.bot && typeof envelope.bot === "object" && !Array.isArray(envelope.bot) ? envelope.bot as Record<string, unknown> : {};
  const metadata = bot.metadata && typeof bot.metadata === "object" && !Array.isArray(bot.metadata) ? bot.metadata as Record<string, unknown> : {};
  const providerBotId = String(bot.id ?? "");
  const meetingId = String(metadata.chusky_meeting_id ?? "");
  const userId = Number(metadata.chusky_user_id);
  const rawId = participant.id;
  const id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
  const name = typeof participant.name === "string" ? participant.name.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) : "";
  if (!isValidRecallBotId(providerBotId) || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId) || !Number.isSafeInteger(userId) || userId <= 0 || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return undefined;
  return {
    providerBotId,
    meetingId,
    userId,
    participant: { id, name: name || "Unknown participant", ...(!name ? { identityStatus: "unknown" as const } : {}), ...(typeof participant.is_host === "boolean" ? { isHost: participant.is_host } : {}), status: event === "participant_events.leave" ? "left" : "present" },
  };
}

/** Extract signed active-speaker transitions with only participant ID and absolute event time. */
export function parseRecallSpeakerWebhook(value: unknown): ParsedRecallSpeakerWebhook | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const event = body.event;
  if (event !== "participant_events.speech_on" && event !== "participant_events.speech_off") return undefined;
  const envelope = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {};
  const eventData = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : {};
  const participant = eventData.participant && typeof eventData.participant === "object" && !Array.isArray(eventData.participant) ? eventData.participant as Record<string, unknown> : {};
  const timestamp = eventData.timestamp && typeof eventData.timestamp === "object" && !Array.isArray(eventData.timestamp) ? eventData.timestamp as Record<string, unknown> : {};
  const bot = envelope.bot && typeof envelope.bot === "object" && !Array.isArray(envelope.bot) ? envelope.bot as Record<string, unknown> : {};
  const metadata = bot.metadata && typeof bot.metadata === "object" && !Array.isArray(bot.metadata) ? bot.metadata as Record<string, unknown> : {};
  const providerBotId = String(bot.id ?? "");
  const meetingId = String(metadata.chusky_meeting_id ?? "");
  const userId = Number(metadata.chusky_user_id);
  const rawId = participant.id;
  const participantId = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : undefined;
  const at = typeof timestamp.absolute === "string" ? Date.parse(timestamp.absolute) : Number.NaN;
  if (!isValidRecallBotId(providerBotId) || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId) || !Number.isSafeInteger(userId) || userId <= 0
    || !Number.isFinite(at) || at <= 0
    // Recall's participant-event schema includes a participant for both
    // speech transitions. An unattributed "off" must not close an arbitrary
    // speaker interval.
    || !participantId || !/^[A-Za-z0-9_-]{1,128}$/.test(participantId)) return undefined;
  return {
    providerBotId,
    meetingId,
    userId,
    speakerEvent: { type: event === "participant_events.speech_on" ? "speech_on" : "speech_off", ...(participantId ? { participantId } : {}), at },
  };
}

/** Normalize only finalized, bounded transcript words; provider payloads never escape this boundary. */
export function parseRecallTranscriptWebhook(value: unknown): ParsedRecallTranscriptWebhook | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (body.event !== "transcript.data") return undefined;
  const envelope = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {};
  const transcriptData = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : {};
  const bot = envelope.bot && typeof envelope.bot === "object" && !Array.isArray(envelope.bot) ? envelope.bot as Record<string, unknown> : {};
  const metadata = bot.metadata && typeof bot.metadata === "object" && !Array.isArray(bot.metadata) ? bot.metadata as Record<string, unknown> : {};
  const providerBotId = String(bot.id ?? "");
  const meetingId = String(metadata.chusky_meeting_id ?? "");
  const userId = Number(metadata.chusky_user_id);
  const participant = transcriptData.participant && typeof transcriptData.participant === "object" && !Array.isArray(transcriptData.participant)
    ? transcriptData.participant as Record<string, unknown>
    : {};
  const rawWords = transcriptData.words;
  if (!isValidRecallBotId(providerBotId) || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId) || !Number.isSafeInteger(userId) || userId <= 0
    || !Array.isArray(rawWords) || rawWords.length < 1 || rawWords.length > 500) return undefined;
  const words: Array<{ text: string; start: number; end: number }> = [];
  for (const raw of rawWords) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const word = raw as Record<string, unknown>;
    const startTimestamp = word.start_timestamp && typeof word.start_timestamp === "object" && !Array.isArray(word.start_timestamp) ? word.start_timestamp as Record<string, unknown> : {};
    const endTimestamp = word.end_timestamp && typeof word.end_timestamp === "object" && !Array.isArray(word.end_timestamp) ? word.end_timestamp as Record<string, unknown> : {};
    const start = startTimestamp.relative;
    const rawEnd = endTimestamp.relative;
    if (typeof word.text !== "string" || !word.text.trim()
      || typeof start !== "number" || !Number.isFinite(start) || start < 0 || start > 7_200
      || (rawEnd !== undefined && rawEnd !== null && (typeof rawEnd !== "number" || !Number.isFinite(rawEnd) || rawEnd < start || rawEnd > 7_200))) return undefined;
    const clean = word.text.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 200) return undefined;
    words.push({ text: clean, start, end: typeof rawEnd === "number" ? rawEnd : start });
  }
  words.sort((a, b) => a.start - b.start || a.end - b.end);
  const text = words.map((word) => word.text).join(" ").replace(/\s+([,.!?;:])/g, "$1").replace(/\s+/g, " ").trim();
  if (!text || text.length > 2_000) return undefined;
  const startMs = Math.floor(words[0]!.start * 1_000);
  const endMs = Math.floor(words.at(-1)!.end * 1_000);
  if (endMs < startMs || endMs - startMs > 120_000) return undefined;
  const rawParticipantId = participant.id;
  const speakerId = typeof rawParticipantId === "number" && Number.isSafeInteger(rawParticipantId) && rawParticipantId >= 0
    || typeof rawParticipantId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(rawParticipantId)
    ? String(rawParticipantId)
    : undefined;
  const speakerName = typeof participant.name === "string"
    ? participant.name.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || undefined
    : undefined;
  const id = createHash("sha256").update(`${providerBotId}\0${meetingId}\0${speakerId ?? "?"}\0${startMs}\0${endMs}\0${text}`).digest("hex");
  return {
    providerBotId,
    meetingId,
    userId,
    segment: { id, startMs, endMs, text, ...(speakerId ? { speakerId } : {}), ...(speakerId && speakerName ? { speakerName } : {}) },
  };
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

export interface ParsedRecallStatusWebhook {
  providerBotId: string;
  metadata: Record<string, unknown>;
  status: "joining" | "waiting_room" | "in_call" | "ended" | "failed";
  statusAt?: string;
  subCode?: string;
}

export interface ParsedRecallTranscriptArtifactWebhook {
  providerBotId: string;
  meetingId: string;
  userId: number;
  status: "processing" | "ready" | "failed";
  subCode?: string;
}

/** Parse dashboard artifact-status webhooks separately from per-bot transcript.data events. */
export function parseRecallTranscriptArtifactWebhook(value: unknown): ParsedRecallTranscriptArtifactWebhook | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const status = body.event === "transcript.processing" ? "processing"
    : body.event === "transcript.done" ? "ready"
      : body.event === "transcript.failed" ? "failed" : undefined;
  if (!status) return undefined;
  const envelope = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data as Record<string, unknown> : {};
  const artifact = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : {};
  const statusData = envelope.status && typeof envelope.status === "object" && !Array.isArray(envelope.status)
    ? envelope.status as Record<string, unknown>
    : artifact.status && typeof artifact.status === "object" && !Array.isArray(artifact.status)
      ? artifact.status as Record<string, unknown>
      : artifact;
  const bot = envelope.bot && typeof envelope.bot === "object" && !Array.isArray(envelope.bot) ? envelope.bot as Record<string, unknown> : {};
  const metadata = bot.metadata && typeof bot.metadata === "object" && !Array.isArray(bot.metadata) ? bot.metadata as Record<string, unknown> : {};
  const providerBotId = bot.id;
  const meetingId = metadata.chusky_meeting_id;
  const userId = Number(metadata.chusky_user_id);
  if (!isValidRecallBotId(providerBotId) || typeof meetingId !== "string" || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId)
    || !Number.isSafeInteger(userId) || userId <= 0) return undefined;
  const rawSubCode = statusData.sub_code ?? artifact.sub_code;
  const subCode = typeof rawSubCode === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(rawSubCode) ? rawSubCode : undefined;
  return { providerBotId, meetingId, userId, status, ...(status === "failed" && subCode ? { subCode } : {}) };
}

/** Normalize Recall's current status_change envelope and its legacy status-specific envelope. */
export function parseRecallStatusWebhook(value: unknown): ParsedRecallStatusWebhook | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data as Record<string, unknown>
    : undefined;
  if (!data) return undefined;
  const providerBot = data.bot && typeof data.bot === "object" && !Array.isArray(data.bot)
    ? data.bot as Record<string, unknown>
    : undefined;
  const providerBotId = data.bot_id ?? providerBot?.id;
  if (!isValidRecallBotId(providerBotId)) return undefined;
  const currentStatus = data.status && typeof data.status === "object" && !Array.isArray(data.status)
    ? data.status as Record<string, unknown>
    : undefined;
  const legacyStatus = data.data && typeof data.data === "object" && !Array.isArray(data.data)
    ? data.data as Record<string, unknown>
    : undefined;
  const eventName = typeof body.event === "string" ? body.event : "";
  const eventStatus = eventName.startsWith("bot.") && eventName !== "bot.status_change"
    ? eventName.slice("bot.".length)
    : undefined;
  const status = mapRecallBotStatus(currentStatus?.code ?? legacyStatus?.code ?? eventStatus);
  if (!status) return undefined;
  const metadata = providerBot?.metadata && typeof providerBot.metadata === "object" && !Array.isArray(providerBot.metadata)
    ? providerBot.metadata as Record<string, unknown>
    : {};
  const statusAt = currentStatus?.created_at ?? legacyStatus?.updated_at ?? legacyStatus?.created_at;
  const subCode = currentStatus?.sub_code ?? legacyStatus?.sub_code;
  return {
    providerBotId,
    metadata,
    status,
    ...(typeof statusAt === "string" ? { statusAt } : {}),
    ...(typeof subCode === "string" ? { subCode } : {}),
  };
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
