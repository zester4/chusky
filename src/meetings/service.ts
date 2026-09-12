import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import {
  addRecallMeeting,
  claimRecallMeetingCreation,
  getRecallMeeting,
  getMeetingRepresentativeProfile,
  isDurableStore,
  listRecallMeetings,
  releaseRecallMeetingCreation,
  updateRecallMeeting,
  type RecallMeetingRecord,
  type RecallMeetingStatus,
} from "../store.js";
import {
  buildRecallCreateBotRequest,
  createRecallBotWithRetry,
  createRecallMediaTicket,
  isValidRecallBotId,
  isRecallRegionSupported,
  RecallApiError,
  mapRecallBotStatus,
  recallApiRequest,
  type ParsedRecallChatWebhook,
  parseRecallChatWebhook,
  validateMeetingUrl,
  validateRecallJoinAt,
} from "./recall.js";

const ACTIVE = new Set<RecallMeetingStatus>(["creating", "scheduled", "joining", "waiting_room", "in_call", "leaving"]);

function requireRecall(): void {
  if (!config.recallMeetingsEnabled) throw new Error("Recall meeting support is disabled");
  if (!recallConfigurationReady()) {
    throw new Error("Recall meeting support is not fully configured");
  }
}

export function recallConfigurationReady(): boolean {
  let mediaPage: URL;
  try { mediaPage = new URL(config.recallMediaPageUrl); } catch { return false; }
  return Boolean(config.recallApiKey.trim())
    && isRecallRegionSupported(config.recallRegion)
    && mediaPage.protocol === "https:"
    && !mediaPage.username && !mediaPage.password && !mediaPage.hash && !mediaPage.searchParams.has("session")
    && config.recallBotName.trim().length > 0
    && Buffer.byteLength(config.recallMediaBridgeSecret.trim(), "utf8") >= 32
    && config.recallWebhookSecret.startsWith("whsec_")
    && Buffer.from(config.recallWebhookSecret.slice(6), "base64").length >= 16;
}

function validRecallVerificationSecret(secret: string): boolean {
  if (!secret.startsWith("whsec_")) return false;
  try { return Buffer.from(secret.slice(6), "base64").length >= 16; } catch { return false; }
}

export function recallChatConfigurationReady(): boolean {
  let publicWebhook: URL;
  try { publicWebhook = new URL(config.webhookUrl); } catch { return false; }
  return Boolean(config.recallMeetingsEnabled)
    && recallConfigurationReady()
    && validRecallVerificationSecret(config.recallRealtimeSecret)
    && Boolean(config.qstashToken.trim())
    && isDurableStore()
    && publicWebhook.protocol === "https:"
    && !publicWebhook.username && !publicWebhook.password && !publicWebhook.search && !publicWebhook.hash;
}

export function recallChatConfigurationStatus(): "configured" | "misconfigured" | "disabled" {
  if (!config.recallMeetingsEnabled || !config.recallRealtimeSecret.trim()) return "disabled";
  return recallChatConfigurationReady() ? "configured" : "misconfigured";
}

export function recallRealtimeWebhookUrl(): string {
  if (!recallChatConfigurationReady()) throw new Error("Recall meeting chat needs a public HTTPS URL, workspace verification secret, QStash, and Redis");
  const endpoint = new URL("/recall/realtime-webhook", config.webhookUrl);
  return endpoint.toString();
}

/** Validate signed event ownership against the bot ID recorded on the meeting. */
export async function resolveRecallChatWebhook(body: unknown): Promise<ParsedRecallChatWebhook | undefined> {
  const event = parseRecallChatWebhook(body);
  if (!event) return undefined;
  const meeting = await getRecallMeeting(event.userId, event.meetingId);
  if (!meeting || meeting.providerBotId !== event.providerBotId || !ACTIVE.has(meeting.status)) return undefined;
  if (event.command.kind === "ambient") {
    if (meeting.interactionMode !== "representative" || !(await getMeetingRepresentativeProfile(event.userId)).enabled) return undefined;
  }
  // Recall documents Webex inbound chat, but not sending chat messages. Keep
  // the one useful inbound action (leave) and avoid generating a reply we
  // cannot deliver to the meeting.
  if (meeting.platform === "webex" && event.command.kind !== "leave") return undefined;
  if (event.replyToParticipantId && meeting.platform !== "zoom" && event.command.kind !== "leave") return undefined;
  return event;
}

export async function sendRecallMeetingChat(userId: number, meetingId: string, message: string, recipient = "everyone", signal?: AbortSignal): Promise<void> {
  assertUserId(userId);
  const meeting = await getRecallMeeting(userId, meetingId);
  if (!meeting || meeting.status !== "in_call" || !meeting.providerBotId) throw new Error("Meeting is not active or is not owned by you");
  if (!["zoom", "google_meet", "microsoft_teams"].includes(meeting.platform)) throw new Error("Recall chat sending is not supported for this meeting platform");
  const clean = String(message ?? "").trim();
  const maxLength = meeting.platform === "google_meet" ? 500 : 4096;
  if (!clean || [...clean].length > maxLength) throw new Error(`Meeting chat message must contain 1-${maxLength} characters`);
  if (recipient !== "everyone" && (meeting.platform !== "zoom" || !/^\d{1,32}$/.test(recipient))) throw new Error("Private meeting-chat replies are supported only for a Zoom participant");
  await recallApiRequest(config.recallRegion, config.recallApiKey, `/bot/${meeting.providerBotId}/send_chat_message/`, {
    method: "POST", body: { to: recipient, message: clean }, signal, timeoutMs: 8_000,
  });
}

async function cleanupRecallBot(providerBotId: string, joinAt?: string): Promise<void> {
  try {
    const scheduled = Boolean(joinAt && Date.parse(joinAt) - Date.now() >= 10 * 60_000);
    await recallApiRequest(config.recallRegion, config.recallApiKey, scheduled
      ? `/bot/${providerBotId}/`
      : `/bot/${providerBotId}/leave_call/`, {
      method: scheduled ? "DELETE" : "POST", timeoutMs: 8_000,
    });
  } catch {
    // Best-effort cleanup must not replace the original failure or expose the
    // provider's response, URL, or meeting link to the model/logs.
  }
}

async function retrieveRecallBotStatus(providerBotId: string, signal?: AbortSignal) {
  const bot = await recallApiRequest(config.recallRegion, config.recallApiKey, `/bot/${providerBotId}/`, {
    method: "GET", signal, timeoutMs: 8_000,
  });
  const providerStatus = bot.status && typeof bot.status === "object" && !Array.isArray(bot.status)
    ? (bot.status as Record<string, unknown>).code
    : bot.status;
  return mapRecallBotStatus(providerStatus);
}

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Meeting owner is invalid");
}

function safeMeeting(record: RecallMeetingRecord) {
  return {
    id: record.id,
    platform: record.platform,
    status: record.status,
    interactionMode: record.interactionMode === "copilot" || record.interactionMode === "representative" ? record.interactionMode : "addressed",
    title: record.title,
    joinAt: record.joinAt,
    error: record.error,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

function recallStatusTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function joinRecallMeeting(userId: number, input: {
  meetingUrl: unknown;
  title?: unknown;
  joinAt?: unknown;
  interactionMode?: unknown;
}, signal?: AbortSignal) {
  requireRecall();
  assertUserId(userId);
  const meeting = validateMeetingUrl(input.meetingUrl);
  const joinAt = validateRecallJoinAt(input.joinAt);
  const interactionMode = input.interactionMode === undefined ? "addressed" : input.interactionMode;
  if (interactionMode !== "addressed" && interactionMode !== "copilot" && interactionMode !== "representative") throw new Error("interactionMode must be addressed, copilot, or representative");
  if (interactionMode === "representative" && !(await getMeetingRepresentativeProfile(userId)).enabled) {
    throw new Error("Configure and enable your meeting representative profile before joining in representative mode");
  }
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
  const meetingUrlHash = createHash("sha256").update(meeting.url).digest("hex");
  // Immediate joins dedupe by URL; scheduled joins dedupe by URL + exact
  // occurrence, so a recurring meeting link can have future instances.
  const meetingInstanceHash = createHash("sha256").update(`${meeting.url}\0${joinAt ?? "adhoc"}`).digest("hex");
  const now = Date.now();
  const id = `mtg_${randomUUID()}`;
  const reservationToken = randomUUID();
  // Ten Recall attempts (25s request timeout + nine 30s backoffs) fit inside
  // this lease. A crashed worker releases it automatically through Redis TTL.
  const reservationLeaseMs = 12 * 60_000;
  const reserved = await claimRecallMeetingCreation(userId, meetingInstanceHash, reservationToken, reservationLeaseMs);
  if (!reserved) {
    const existing = (await listRecallMeetings(userId, 20)).find((item) => ACTIVE.has(item.status)
      && (item.meetingInstanceHash === meetingInstanceHash
        || (!item.meetingInstanceHash && item.meetingUrlHash === meetingUrlHash)));
    if (existing) return { ...safeMeeting(existing), alreadyActive: true };
    throw new Error("A matching meeting assistant is already being created; try again shortly");
  }
  const record: RecallMeetingRecord = {
    id,
    userId,
    platform: meeting.platform,
    interactionMode,
    status: "creating",
    meetingUrlHash,
    meetingInstanceHash,
    ...(title ? { title } : {}),
    ...(joinAt ? { joinAt } : {}),
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  let providerBotId: string | undefined;
  try {
    const stored = await addRecallMeeting(userId, record);
    if (stored.id !== id) return { ...safeMeeting(stored), alreadyActive: true };

    const mediaBase = new URL(config.recallMediaPageUrl);
    if (mediaBase.protocol !== "https:" || mediaBase.username || mediaBase.password || mediaBase.searchParams.has("session") || mediaBase.hash) {
      await updateRecallMeeting(userId, id, { status: "failed", error: "Recall media page configuration is invalid" });
      throw new Error("Recall media page URL must be HTTPS and cannot contain a session ticket");
    }
    const expiry = Math.floor(((joinAt ? Date.parse(joinAt) : now) + 6 * 60 * 60_000) / 1000);
    const ticket = createRecallMediaTicket({ meetingId: id, userId, expiresAt: expiry, interactionMode }, config.recallMediaBridgeSecret);
    // Fragments are available to the trusted page JavaScript but never travel
    // in HTTP requests/access logs. The ticket is then sent in the first
    // encrypted websocket frame rather than in its URL/query string.
    mediaBase.hash = new URLSearchParams({ session: ticket }).toString();
    const request = buildRecallCreateBotRequest({
      meetingUrl: meeting.url,
      botName: config.recallBotName,
      mediaPageUrl: mediaBase.toString(),
      meetingId: id,
      userId,
      ...(recallChatConfigurationReady() ? { realtimeWebhookUrl: recallRealtimeWebhookUrl() } : {}),
      ...(joinAt ? { joinAt } : {}),
    });

    const response = await createRecallBotWithRetry({
      signal,
      create: () => recallApiRequest(config.recallRegion, config.recallApiKey, "/bot/", {
        method: "POST", body: request, signal, timeoutMs: 25_000,
      }),
    });
    providerBotId = String(response.id ?? "");
    if (!isValidRecallBotId(providerBotId)) throw new Error("Recall returned an invalid bot identifier");
    if (signal?.aborted) {
      await cleanupRecallBot(providerBotId, joinAt);
      throw new Error("Recall meeting creation was cancelled");
    }
    const status: RecallMeetingStatus = joinAt ? "scheduled" : "joining";
    const updated = await updateRecallMeeting(userId, id, { providerBotId, status });
    if (!updated) {
      await cleanupRecallBot(providerBotId, joinAt);
      throw new Error("Could not save Recall meeting state");
    }
    if (signal?.aborted) {
      await cleanupRecallBot(providerBotId, joinAt);
      await updateRecallMeeting(userId, id, { status: "failed", error: "Meeting creation was cancelled" });
      throw new Error("Recall meeting creation was cancelled");
    }
    return safeMeeting(updated);
  } catch (error) {
    if (providerBotId && !signal?.aborted) await cleanupRecallBot(providerBotId, joinAt);
    await updateRecallMeeting(userId, id, {
      status: "failed",
      error: signal?.aborted ? "Meeting creation was cancelled" : "Recall could not create the meeting bot",
    });
    throw error instanceof Error && error.message.startsWith("Recall ") ? error : new Error("Could not start the Recall meeting bot");
  } finally {
    try { await releaseRecallMeetingCreation(userId, meetingInstanceHash, reservationToken); }
    catch { /* Expiring Redis lease is the crash-safe fallback. */ }
  }
}

export async function listRecallMeetingsForUser(userId: number, limit = 10) {
  requireRecall();
  assertUserId(userId);
  return (await listRecallMeetings(userId, limit)).map(safeMeeting);
}

export async function getRecallMeetingForUser(userId: number, id: string) {
  requireRecall();
  assertUserId(userId);
  if (!/^mtg_[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid meeting ID");
  const record = await getRecallMeeting(userId, id);
  return record ? safeMeeting(record) : undefined;
}

export async function authorizeRecallMedia(userId: number, id: string): Promise<boolean> {
  if (!config.recallMeetingsEnabled || !config.recallMediaBridgeSecret) return false;
  assertUserId(userId);
  if (!/^mtg_[A-Za-z0-9_-]{1,80}$/.test(id)) return false;
  const meeting = await getRecallMeeting(userId, id);
  return meeting?.status === "in_call";
}

export async function leaveRecallMeeting(userId: number, id: string, signal?: AbortSignal) {
  requireRecall();
  assertUserId(userId);
  if (!/^mtg_[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid meeting ID");
  const meeting = await getRecallMeeting(userId, id);
  if (!meeting) throw new Error("Meeting not found or not owned by you");
  if (!ACTIVE.has(meeting.status)) return { ...safeMeeting(meeting), alreadyFinished: true };
  if (!meeting.providerBotId) throw new Error("Meeting bot is still being created; try again shortly");

  const scheduled = meeting.status === "scheduled";
  await updateRecallMeeting(userId, id, { status: "leaving" });
  try {
    if (scheduled) {
      try {
        await recallApiRequest(config.recallRegion, config.recallApiKey, `/bot/${meeting.providerBotId}/`, {
          method: "DELETE", signal, timeoutMs: 15_000,
        });
      } catch (error) {
        // Recall returns 405 when a scheduled bot has already been dispatched.
        // It can no longer be deleted, but the live leave-call action is valid.
        if (!(error instanceof RecallApiError) || error.status !== 405) throw error;
        await recallApiRequest(config.recallRegion, config.recallApiKey, `/bot/${meeting.providerBotId}/leave_call/`, {
          method: "POST", signal, timeoutMs: 15_000,
        });
      }
    } else {
      await recallApiRequest(config.recallRegion, config.recallApiKey, `/bot/${meeting.providerBotId}/leave_call/`, {
        method: "POST", signal, timeoutMs: 15_000,
      });
    }
  } catch (error) {
    // Recall may already have ended the bot while its signed status webhook is
    // still in flight. Reconcile a rejected leave against the provider state
    // instead of leaving Chusky's local meeting record stuck as active.
    if (error instanceof RecallApiError && error.status === 400 && meeting.providerBotId) {
      let providerStatus: ReturnType<typeof mapRecallBotStatus>;
      try { providerStatus = await retrieveRecallBotStatus(meeting.providerBotId, signal); }
      catch { providerStatus = undefined; }
      if (providerStatus === "ended" || providerStatus === "failed") {
        const finished = await updateRecallMeeting(userId, id, { status: providerStatus });
        return { ...safeMeeting(finished ?? meeting), alreadyFinished: true };
      }
      const latest = await getRecallMeeting(userId, id);
      if (latest?.status === "leaving") {
        await updateRecallMeeting(userId, id, { status: providerStatus ?? meeting.status });
      }
    } else {
      // Don't overwrite a terminal status delivered concurrently by Recall.
      const latest = await getRecallMeeting(userId, id);
      if (latest?.status === "leaving") await updateRecallMeeting(userId, id, { status: meeting.status });
    }
    throw error;
  }
  const updated = await updateRecallMeeting(userId, id, { status: "ended" });
  return updated ? safeMeeting(updated) : safeMeeting(meeting);
}

export async function applyRecallStatusWebhook(input: {
  eventId: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  onMeetingEnded?: (userId: number, meetingId: string) => Promise<void>;
}): Promise<"updated" | "ignored"> {
  requireRecall();
  const data = input.body.data && typeof input.body.data === "object" ? input.body.data as Record<string, unknown> : {};
  const providerBot = data.bot && typeof data.bot === "object" ? data.bot as Record<string, unknown> : {};
  const botId = String(data.bot_id ?? providerBot.id ?? "");
  if (!isValidRecallBotId(botId)) return "ignored";
  // Recall's documented status-change envelope carries our bot metadata. Use
  // it directly on the signed event; only use authenticated retrieval for
  // older/incomplete envelopes. This avoids a serial API round-trip per status.
  let metadata = providerBot.metadata && typeof providerBot.metadata === "object"
    ? providerBot.metadata as Record<string, unknown>
    : {};
  if (!metadata.chusky_meeting_id || !metadata.chusky_user_id) {
    let bot: Record<string, unknown>;
    try {
      bot = await recallApiRequest(config.recallRegion, config.recallApiKey, `/bot/${botId}/`, {
        method: "GET", signal: input.signal, timeoutMs: 8_000,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("(404)")) return "ignored";
      throw error;
    }
    metadata = bot.metadata && typeof bot.metadata === "object" ? bot.metadata as Record<string, unknown> : {};
  }
  const meetingId = String(metadata.chusky_meeting_id ?? "");
  const userId = Number(metadata.chusky_user_id);
  if (!/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId) || !Number.isSafeInteger(userId) || userId <= 0) return "ignored";
  const meeting = await getRecallMeeting(userId, meetingId);
  if (!meeting || meeting.providerBotId !== botId) return "ignored";

  const statusData = data.data && typeof data.data === "object" ? data.data as Record<string, unknown> : {};
  const alternateStatus = data.status && typeof data.status === "object" ? data.status as Record<string, unknown> : {};
  const eventStatus = String(input.body.event ?? "").replace(/^bot\./, "");
  const status = mapRecallBotStatus(statusData.code ?? alternateStatus.code ?? eventStatus);
  if (!status) return "ignored";
  const providerStatusAt = recallStatusTime(statusData.updated_at ?? alternateStatus.created_at);
  if (["ended", "failed"].includes(meeting.status)) {
    // A previous signed status delivery may have updated Redis but failed to
    // enqueue the durable outcome. Re-enqueue on Recall retries; the workflow
    // ID is deterministic and the worker independently deduplicates effects.
    if (meeting.status === "ended" && status === "ended" && meeting.interactionMode === "representative") {
      await input.onMeetingEnded?.(userId, meetingId);
    }
    return "ignored";
  }
  const order: Record<RecallMeetingStatus, number> = { creating: 0, scheduled: 0, joining: 1, waiting_room: 2, in_call: 3, leaving: 4, ended: 5, failed: 5 };
  if ((meeting.status === "leaving" && status !== "ended" && status !== "failed") || order[status] < order[meeting.status]) return "ignored";
  if (providerStatusAt !== undefined && meeting.providerStatusAt !== undefined && providerStatusAt < meeting.providerStatusAt) return "ignored";
  const errorCode = String(statusData.sub_code ?? (data.data && typeof data.data === "object" ? (data.data as Record<string, unknown>).sub_code : "")).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const error = status === "failed"
    ? `Recall could not join the meeting${errorCode ? ` (${errorCode})` : ""}`
    : undefined;
  const patch: Partial<Pick<RecallMeetingRecord, "status" | "error" | "providerStatusAt">> = { status, ...(providerStatusAt ? { providerStatusAt } : {}), error };
  const updated = await updateRecallMeeting(userId, meetingId, patch);
  if (updated && status === "ended" && meeting.interactionMode === "representative") await input.onMeetingEnded?.(userId, meetingId);
  return updated ? "updated" : "ignored";
}
