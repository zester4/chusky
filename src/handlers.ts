import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { config } from "./config.js";
import {
  runAgent, fetchModels, getConnectionUrl, getToolkitStates, listConnectedAccounts, disconnectConnectedAccount, invalidateSession, ApprovalRequiredError,
  transcribeAudio, generateImage, generateSpeech,
  listTriggers, createTrigger, setTriggerState, deleteTrigger, listAvailableTriggerToolkits, listAvailableTriggerTypes, getAvailableTriggerType,
  searchTools, type AgentChannelContext,
} from "./agent.js";
import { requiredTriggerConfigFields, type TriggerCatalogueItem } from "./triggerCatalog.js";
import type { ContentPart } from "./types.js";
import {
  getSession, appendMessages, addUsage, canSpend, clearHistory, clearSession, setModel, getModel, checkRateLimit,
  getChannelConversation, appendChannelConversationMessages, setChannelConversationModel, clearChannelConversationHistory,
  setTelegramChatId, getApproval, setApprovalStatus, claimApproval, createCliPairing, listCliDevices, revokeCliDeviceHash, setVoiceReplies, listVideoJobs, registerImageAsset,
  setLiveVoicePreference, claimTelegramUpdate, listHandoffRecords, saveHandoffRecord, cancelTask, retryTask, listApprovals, listJobs, listReminders, listTasks, listMissions, getMission, updateMission, updateTask, pauseMission, resumeMission, cancelMission,
  getMeetingRepresentativeProfile, updateMeetingRepresentativeProfile, listRecallMeetings, listCalendarMeetingPreparations, listMeetingContacts, deleteMeetingContact,
  searchMemories, readScratchpad, listBrowserPlaybooks, listBrowserAudit, listBrowserHandoffs,
} from "./store.js";
import { acquireUserLock, releaseUserLock } from "./store.js";
import { mdToTelegramHtml, splitHtml } from "./markdown.js";
import { markdownToTelegramRichHtml } from "./telegramRich.js";
import { vectorConfigured } from "./lib/knowledge/vector.js";
import { extractMediaText, indexExtractedDocument } from "./lib/knowledge/ingest.js";
import { putR2Object, r2Configured } from "./lib/storage/r2.js";
import { logger } from "./logger.js";
import { randomUUID } from "node:crypto";
import { createLinkCode, linkChannelIdentity, listLinkedChannels, setProactivePreference } from "./channels/identity.js";
import { createSendblueGroupLinkCode, redeemWebTelegramLinkCode } from "./store.js";
import { notifyTriggerApproval, enqueueAutonomyApprovalResume } from "./triggerWorkflow.js";
import { enqueueTaskWithClaim } from "./taskEnqueue.js";
import { findMissionApprovalTarget, resumeMissionTaskAfterApproval } from "./missionApproval.js";
import { resumeApprovedDelegation } from "./subagents/executor.js";
import { nativeTool } from "./nativeTools.js";
import { validateNativeToolArguments } from "./agentTools.js";
import { posthog } from "./posthog.js";
import { createTelegramProject, listTelegramProjects, revokeTelegramProject, rotateTelegramProjectKey } from "./developerProjects.js";
import { conversationIdFor } from "./channels/contracts.js";
import { sharedGroupInstructions } from "./channels/groupInstructions.js";
import { telegramCardFallbackHtml, telegramCardFallbackKeyboard, telegramCardRichHtml, type TelegramCard } from "./telegramCards.js";
import { MODEL_PROVIDER_LABELS, isModelProvider, modelsForProvider, type ModelProvider } from "./modelProviders.js";
import { listBlandCuratedVoices, type BlandSelectableVoice } from "./calls/blandVoices.js";
import { FLUX_TTS_VOICES, fluxTtsVoiceName, type LiveVoiceProvider } from "./voiceSettings.js";
import { daytonaEngine } from "./lib/daytona/index.js";
import { connectMcpServer, disconnectMcpServer, listMcpCatalog, listMcpConnections } from "./mcp/client.js";
import { browserSessionHealth } from "./vault/vault.js";
import { defaultMediaInstruction } from "./mediaInput.js";
import {
  cancelAutomaticCalendarMeetingJoins, getRecallMeetingForUser, joinPreparedCalendarMeeting, joinRecallMeeting, leaveRecallMeeting,
  listRecallMeetingsForUser, lookupRecallMeetingContext, prepareRecallMeetingMission,
} from "./meetings/service.js";

const activeRequests = new Map<number, AbortController>();
const MODEL_PAGE_SIZE = 8;
const TRIGGER_PAGE_SIZE = 8;
const VOICE_PAGE_SIZE = 8;
const TELEGRAM_API_EMBED_SCOPES = ["threads:read", "threads:write", "tasks:read", "tasks:write", "tools:read", "skills:read", "files:read", "files:write", "artifacts:read", "artifacts:write"];

function apiKeyMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚡ Create full-access key", "api:new:full").row()
    .text("🤖 Create app-embed key", "api:new:embed").row()
    .text("📋 My API keys", "api:list").row()
    .text("ℹ️ Integration guide", "api:help");
}

function apiKeyProjectKeyboard(projects: Array<{ id: string; name: string }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const project of projects.slice(0, 8)) {
    keyboard.text(`🔄 ${project.name}`.slice(0, 58), `api:rotate:${project.id}`).text("🗑", `api:revoke:${project.id}`).row();
  }
  return keyboard.text("➕ Create key", "api:menu");
}

function apiKeyDelivery(project: { name: string; key: string; keyPrefix: string; scopes: string[] }, rotated = false): string {
  const baseUrl = (config.webhookUrl || config.dashboardUrl || "https://your-chusky-host").replace(/\/+$/, "");
  return `${rotated ? "🔄" : "✅"} <b>${rotated ? "API key rotated" : "API key created"}</b> — ${escapeTelegramHtml(project.name)}\n\n` +
    `<b>Copy it now. It will not be shown again.</b>\n<code>${escapeTelegramHtml(project.key)}</code>\n\n` +
    `<b>Use it only on your server:</b>\n<pre>Authorization: Bearer ${escapeTelegramHtml(project.key)}\nX-Chusky-User-Id: your-user-id</pre>\n` +
    `<i>Base URL:</i> <code>${escapeTelegramHtml(baseUrl)}/v1</code>\n` +
    `Scopes: <code>${escapeTelegramHtml(project.scopes.join(", "))}</code>\n\n` +
    `Never put this key in browser code, a public repository, or a client app. Prefix: <code>${escapeTelegramHtml(project.keyPrefix)}</code>`;
}

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * grammY 1.x intentionally does not yet type Bot API 10.x Rich Message
 * methods. Keep this narrow raw transport at the Telegram boundary instead
 * of weakening types throughout the rest of Chusky.
 */
async function telegramRaw(method: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      logger.debug({ method, status: response.status }, "Telegram rich feature unavailable; using compatibility fallback");
      return false;
    }
    const body = await response.json() as { ok?: boolean };
    return body.ok === true;
  } catch (error) {
    logger.debug({ err: error, method }, "Telegram rich feature request failed; using compatibility fallback");
    return false;
  }
}

async function replyCard(ctx: Context, card: TelegramCard): Promise<void> {
  const replyMarkup = telegramCardFallbackKeyboard(card);
  const richSent = await telegramRaw("sendRichMessage", {
    chat_id: ctx.chat!.id,
    rich_message: { html: telegramCardRichHtml(card) },
  });
  if (!richSent) await ctx.reply(telegramCardFallbackHtml(card), { parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}

async function editCard(ctx: Context, messageId: number, card: TelegramCard): Promise<void> {
  const replyMarkup = telegramCardFallbackKeyboard(card);
  const richEdited = await telegramRaw("editMessageText", {
    chat_id: ctx.chat!.id,
    message_id: messageId,
    rich_message: { html: telegramCardRichHtml(card) },
  });
  if (!richEdited) await ctx.api.editMessageText(ctx.chat!.id, messageId, telegramCardFallbackHtml(card), { parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}

function approvalCard(toolSlug: string, approvalId: string): TelegramCard {
  return {
    title: "⚠️ Approval required",
    body: ["Chusky prepared an external action that needs your review.", `Requested capability: ${toolSlug}`],
    detail: "Approve executes the exact action reviewed by Chusky. Deny leaves everything unchanged.",
    buttons: [[
      { text: "✅ Approve", callbackData: `appr:approve:${approvalId}`, style: "success" },
      { text: "🛑 Deny", callbackData: `appr:deny:${approvalId}`, style: "danger" },
    ]],
  };
}

async function canSendEphemeralToOwner(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from || !isTelegramShared(ctx)) return false;
  try {
    const me = await ctx.api.getMe();
    const membership = await ctx.api.getChatMember(ctx.chat.id, me.id);
    return membership.status === "administrator" || membership.status === "creator";
  } catch (error) {
    logger.debug({ err: error, chatId: ctx.chat.id }, "Could not check ephemeral-message administrator permission");
    return false;
  }
}

/**
 * Group chats never receive approval details. Prefer Telegram's owner-only
 * ephemeral delivery when Chusky is an administrator; if Telegram cannot
 * deliver it, use the owner's existing private Chusky chat. The approval
 * record—not either presentation—is the authority for execution.
 */
async function deliverGroupApproval(ctx: Context, card: TelegramCard): Promise<"ephemeral" | "private"> {
  const replyMarkup = telegramCardFallbackKeyboard(card);
  if (await canSendEphemeralToOwner(ctx)) {
    const delivered = await telegramRaw("sendRichMessage", {
      chat_id: ctx.chat!.id,
      rich_message: { html: telegramCardRichHtml(card) },
      ephemeral_message_parameters: { receiver_user_id: ctx.from!.id },
    });
    if (delivered) return "ephemeral";
  }

  // A private chat ID is the owner's Telegram user ID. This does not use the
  // current group chat ID, which would risk sending sensitive review UI back
  // into the group after a restart.
  const richDelivered = await telegramRaw("sendRichMessage", {
    chat_id: ctx.from!.id,
    rich_message: { html: telegramCardRichHtml(card) },
  });
  if (!richDelivered) await ctx.api.sendMessage(ctx.from!.id, telegramCardFallbackHtml(card), { parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  return "private";
}

async function editApprovalOutcome(ctx: Context, text: string): Promise<void> {
  const message = ctx.callbackQuery?.message as { ephemeral_message_id?: number; message_id?: number } | undefined;
  if (message?.ephemeral_message_id && ctx.chat && ctx.from) {
    const edited = await telegramRaw("editEphemeralMessageText", {
      chat_id: ctx.chat.id,
      receiver_user_id: ctx.from.id,
      ephemeral_message_id: message.ephemeral_message_id,
      text,
    });
    if (edited) return;
  }
  await ctx.editMessageText(text);
}

function voiceFeatureEnabled(provider: LiveVoiceProvider): boolean {
  if (provider === "twilio") return config.twilioVoiceEnabled;
  if (provider === "bland") return config.blandVoiceEnabled;
  return config.recallMeetingsEnabled;
}

function liveVoiceCurrentLabel(session: Awaited<ReturnType<typeof getSession>>, provider: LiveVoiceProvider): string {
  if (provider === "bland") return session.voicePreferences?.bland?.name ?? `${config.blandVoice || "Maya"} (service default)`;
  const model = provider === "twilio" ? session.voicePreferences?.twilio : session.voicePreferences?.meetings;
  return model ? `${fluxTtsVoiceName(model)} (${model})` : "Service default";
}

function voiceSettingsCard(session: Awaited<ReturnType<typeof getSession>>): TelegramCard {
  const providerLine = (provider: LiveVoiceProvider, label: string) =>
    `${label}: ${liveVoiceCurrentLabel(session, provider)} · ${voiceFeatureEnabled(provider) ? "enabled" : "not enabled"}`;
  return {
    title: "🔊 Voice settings",
    body: [
      `Telegram audio replies: ${session.voiceReplies === true ? "on" : "off"}`,
      providerLine("twilio", "Twilio calls"),
      providerLine("bland", "Bland calls"),
      providerLine("meetings", "Live meetings"),
    ],
    detail: "Choose voices independently for each live-call provider. A new selection applies to the next call or meeting; active sessions are not changed.",
    buttons: [
      [{ text: "☎️ Twilio voice", callbackData: "home:voice:provider:twilio" }, { text: "📞 Bland voice", callbackData: "home:voice:provider:bland" }],
      [{ text: "🗣️ Meeting voice", callbackData: "home:voice:provider:meetings" }],
      [{ text: session.voiceReplies === true ? "Turn Telegram voice replies off" : "Turn Telegram voice replies on", callbackData: `home:voice:${session.voiceReplies === true ? "off" : "on"}` }],
      [{ text: "← Workspace", callbackData: "home:refresh" }],
    ],
  };
}

function voicePickerCard(provider: LiveVoiceProvider, voices: BlandSelectableVoice[] | undefined, current: string | undefined, page: number): TelegramCard {
  const title = provider === "twilio" ? "☎️ Twilio voice" : provider === "bland" ? "📞 Bland voice" : "🗣️ Meeting voice";
  const options = provider === "bland" ? (voices ?? []) : FLUX_TTS_VOICES.map((voice) => ({ id: voice.id, name: voice.name, description: `${voice.accent} English` }));
  const pages = Math.max(1, Math.ceil(options.length / VOICE_PAGE_SIZE));
  const selectedPage = Math.min(Math.max(0, page), pages - 1);
  const buttons: NonNullable<TelegramCard["buttons"]> = [];
  const pageOptions = options.slice(selectedPage * VOICE_PAGE_SIZE, (selectedPage + 1) * VOICE_PAGE_SIZE);
  for (let index = 0; index < pageOptions.length; index += 2) {
    buttons.push(pageOptions.slice(index, index + 2).map((voice) => ({
      text: `${voice.id === current ? "✓ " : ""}${voice.name}${voice.description ? ` · ${voice.description}` : ""}`.slice(0, 60),
      callbackData: `home:voice:set:${provider}:${voice.id}`,
      ...(voice.id === current ? { style: "primary" as const } : {}),
    })));
  }
  if (pages > 1) buttons.push([
    ...(selectedPage > 0 ? [{ text: "‹ Previous", callbackData: `home:voice:page:${provider}:${selectedPage - 1}` }] : []),
    ...(selectedPage < pages - 1 ? [{ text: "Next ›", callbackData: `home:voice:page:${provider}:${selectedPage + 1}` }] : []),
  ]);
  buttons.push([{ text: "Use service default", callbackData: `home:voice:reset:${provider}` }]);
  buttons.push([{ text: "← Voice settings", callbackData: "home:voice" }]);
  const currentName = provider === "bland"
    ? voices?.find((voice) => voice.id === current)?.name ?? (current ? "Selected Bland voice" : `${config.blandVoice || "Maya"} (service default)`)
    : current ? `${fluxTtsVoiceName(current)} (${current})` : "Service default";
  const body = [`Current: ${currentName}`, `${options.length ? `${options.length} available voices · page ${selectedPage + 1} of ${pages}` : "No selectable voices were returned by Bland."}`];
  if (!voiceFeatureEnabled(provider)) body.push("This provider is currently disabled in the Chusky deployment. You can still save a preference for when it is enabled.");
  body.push(provider === "bland" ? "Only public Bland-curated BTTS_V3 voices are shown; private cloned voices are intentionally excluded." : "English Deepgram Flux streaming voices. The same voice catalogue is used by the Twilio and Recall meeting bridges.");
  return { title, body, buttons };
}

async function editVoiceSettings(ctx: Context, messageId: number): Promise<void> {
  await editCard(ctx, messageId, voiceSettingsCard(await getSession(ctx.from!.id)));
}

async function editVoiceProvider(ctx: Context, messageId: number, provider: LiveVoiceProvider, page = 0): Promise<void> {
  const session = await getSession(ctx.from!.id);
  const current = provider === "bland"
    ? session.voicePreferences?.bland?.id
    : provider === "twilio" ? session.voicePreferences?.twilio : session.voicePreferences?.meetings;
  if (provider !== "bland") {
    await editCard(ctx, messageId, voicePickerCard(provider, undefined, current, page));
    return;
  }
  if (!config.blandApiKey) {
    await editCard(ctx, messageId, {
      ...voicePickerCard(provider, [], current, page),
      body: ["Bland's live voice catalogue is unavailable because BLAND_API_KEY is not configured.", "No placeholder voice list is shown. Configure the Bland API key, then reopen this menu."],
      buttons: [[{ text: "← Voice settings", callbackData: "home:voice" }]],
    });
    return;
  }
  const voices = await listBlandCuratedVoices(config.blandApiKey);
  await editCard(ctx, messageId, voicePickerCard(provider, voices, current, page));
}

function telegramMeetingParticipantLine(participant: { name?: string; isHost?: boolean; status?: string }): string {
  const name = escapeTelegramHtml(participant.name?.trim() || "Unknown participant");
  return `• ${name}${participant.isHost ? " · host" : ""}${participant.status ? ` · ${escapeTelegramHtml(participant.status)}` : ""}`;
}

function telegramMeetingLine(meeting: {
  id: string; platform: string; status: string; title?: string; interactionMode?: string;
  participantRoster?: Array<{ name?: string; isHost?: boolean; status?: string }>;
}): string {
  const present = (meeting.participantRoster ?? []).filter((person) => person.status !== "left").map((person) => person.name).filter(Boolean).slice(0, 8);
  return `• <code>${escapeTelegramHtml(meeting.id)}</code> · <b>${escapeTelegramHtml(meeting.status)}</b> · ${escapeTelegramHtml(meeting.platform)} · ${escapeTelegramHtml(meeting.title || "Untitled meeting")}`
    + `${meeting.interactionMode ? ` · ${escapeTelegramHtml(meeting.interactionMode)}` : ""}`
    + `${present.length ? `\n  Participants: ${escapeTelegramHtml(present.join(", "))}` : ""}`;
}

function telegramPreparationLine(preparation: {
  id: string; status: string; title?: string; startAt?: string; participants?: string[]; meetingUrlAvailable?: boolean;
}): string {
  const time = preparation.startAt ? new Date(preparation.startAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "time not supplied";
  const people = preparation.participants?.filter(Boolean).slice(0, 8).join(", ");
  return `• <code>${escapeTelegramHtml(preparation.id)}</code> · <b>${escapeTelegramHtml(preparation.status)}</b> · ${escapeTelegramHtml(preparation.title || "Untitled event")}\n  ${escapeTelegramHtml(time)}${people ? ` · ${escapeTelegramHtml(people)}` : ""}${preparation.meetingUrlAvailable === false ? " · no supported meeting link" : ""}`;
}

function telegramMeetingDetail(meeting: any, contacts: any[]): string {
  const lines = [
    `<b>${escapeTelegramHtml(meeting.title || "Meeting assistant")}</b>`,
    `<code>${escapeTelegramHtml(meeting.id)}</code> · ${escapeTelegramHtml(meeting.platform)} · <b>${escapeTelegramHtml(meeting.status)}</b>`,
    `Mode: ${escapeTelegramHtml(meeting.interactionMode || "copilot")}`,
  ];
  if (meeting.mission) lines.push(`Mission: ${escapeTelegramHtml(meeting.mission.clientName)} — ${escapeTelegramHtml(meeting.mission.objective || "")}`);
  if (meeting.participantRoster?.length) {
    lines.push(`<b>Participants</b>\n${meeting.participantRoster.map(telegramMeetingParticipantLine).join("\n")}`);
  }
  if (contacts.length) {
    lines.push(`<b>Captured follow-up contacts</b>\n${contacts.map((contact) => `• <code>${escapeTelegramHtml(contact.id)}</code> · ${escapeTelegramHtml(contact.participantName)} · ${escapeTelegramHtml(contact.email || contact.phone || "no contact")}${contact.interest ? `\n  ${escapeTelegramHtml(contact.interest)}` : ""}`).join("\n")}`);
  }
  if (meeting.outcome) {
    const outcome = meeting.outcome;
    lines.push(`<b>Outcome</b>\n${escapeTelegramHtml(outcome.summary || "Outcome recorded")}`);
    if (Array.isArray(outcome.decisions) && outcome.decisions.length) lines.push(`Decisions: ${escapeTelegramHtml(outcome.decisions.join("; "))}`);
    if (Array.isArray(outcome.actionItems) && outcome.actionItems.length) lines.push(`Action items: ${escapeTelegramHtml(outcome.actionItems.map((item: any) => `${item.task}${item.owner ? ` (${item.owner})` : ""}`).join("; "))}`);
  }
  if (meeting.history?.length) {
    const recent = meeting.history.slice(-6).map((message: any) => `${message.role === "assistant" ? "Chusky" : "Meeting"}: ${message.content}`).join("\n");
    lines.push(`<b>Recent meeting context</b>\n${escapeTelegramHtml(recent)}`);
  }
  return lines.join("\n\n");
}

function telegramMeetingJoinFields(raw: string): { meetingUrl: string; clientName?: string; objective?: string; clientContext?: string } | undefined {
  const fields = raw.split("|").map((field) => field.trim());
  if (!fields[0]) return undefined;
  return {
    meetingUrl: fields[0],
    ...(fields[1] ? { clientName: fields[1] } : {}),
    ...(fields[2] ? { objective: fields[2] } : {}),
    ...(fields[3] ? { clientContext: fields[3] } : {}),
  };
}

function workspaceCard(input: { model: string; connectedApps: number; connectedAccounts: number; pendingApprovals: number; activeWorkers: number; triggerCount: number; activeReminders: number; activeJobs: number; activeTasks: number; activeMissions: number; activeMeetings: number; preparedMeetings: number; meetingContacts: number; mcpConnections: number; voiceReplies: boolean; attentionPulseEnabled: boolean }): TelegramCard {
  const connectionLine = input.connectedApps
    ? `🟢 ${input.connectedApps} app${input.connectedApps === 1 ? "" : "s"} connected across ${input.connectedAccounts} account${input.connectedAccounts === 1 ? "" : "s"}`
    : "⚪ No connected apps yet";
  return {
    title: "⚡ Chusky Workspace",
    body: [
      connectionLine,
      `🧠 Model: ${input.model}`,
      `📌 ${input.pendingApprovals} pending approval${input.pendingApprovals === 1 ? "" : "s"} · ${input.activeWorkers} active task${input.activeWorkers === 1 ? "" : "s"}`,
      `⚡ ${input.triggerCount} active trigger${input.triggerCount === 1 ? "" : "s"}`,
      `⏰ ${input.activeReminders} reminder${input.activeReminders === 1 ? "" : "s"} · 🗓️ ${input.activeJobs} recurring schedule${input.activeJobs === 1 ? "" : "s"}`,
      `📋 ${input.activeTasks} task${input.activeTasks === 1 ? "" : "s"} in progress · ${input.voiceReplies ? "🔊 voice replies on" : "🔇 voice replies off"}`,
      `🚀 ${input.activeMissions} active mission${input.activeMissions === 1 ? "" : "s"} · long-running work that can pause and resume`,
      `🤝 ${input.activeMeetings} live meeting${input.activeMeetings === 1 ? "" : "s"} · ${input.preparedMeetings} prepared · ${input.meetingContacts} follow-up contact${input.meetingContacts === 1 ? "" : "s"}`,
      `🔗 ${input.mcpConnections} third-party MCP server${input.mcpConnections === 1 ? "" : "s"} connected`,
      `🧭 Attention pulse: ${input.attentionPulseEnabled ? "enabled" : "disabled"}`,
    ],
    detail: "Connected accounts, tasks, and approvals remain private to your Chusky account.",
    buttons: [
      [{ text: "🧩 Apps", callbackData: "home:apps", style: "primary" }, { text: "⚡ Triggers", callbackData: "home:triggers" }],
      [{ text: "⏰ Reminders", callbackData: "home:reminders" }, { text: "🗓️ Schedules", callbackData: "home:schedules" }],
      [{ text: "📋 Tasks", callbackData: "home:tasks" }, { text: "✅ Approvals", callbackData: "home:approvals" }],
      [{ text: "🚀 Missions", callbackData: "home:missions", style: "primary" }, { text: "🤝 Meetings", callbackData: "home:meetings" }],
      [{ text: "🔊 Voice", callbackData: "home:voice" }],
      [{ text: input.attentionPulseEnabled ? "🧭 Pulse on · Disable" : "🧭 Pulse off · Enable", callbackData: "home:pulse:toggle", style: input.attentionPulseEnabled ? "success" : "primary" }],
      [{ text: "MCP servers", callbackData: "home:mcp" }, { text: "🔄 Refresh", callbackData: "home:refresh" }],
    ],
  };
}

function mcpAuthLabel(auth: "none" | "bearer" | "oauth"): string {
  return auth === "none" ? "public" : auth === "oauth" ? "OAuth" : "access token";
}

async function showMcpWorkspace(ctx: Context, messageId?: number): Promise<void> {
  if (isTelegramShared(ctx)) {
    const card: TelegramCard = {
      title: "Third-party MCP",
      body: ["MCP connections are private to your Chusky account. Open /home in a private chat to manage them."],
      buttons: [[{ text: "← Workspace", callbackData: "home:refresh" }]],
    };
    if (messageId) await editCard(ctx, messageId, card); else await replyCard(ctx, card);
    return;
  }

  const catalog = listMcpCatalog();
  if (catalog.errors.length) logger.warn({ count: catalog.errors.length }, "Some MCP catalog entries were skipped");
  const connections = await listMcpConnections(ctx.from!.id);
  const connected = new Set(connections.map((connection) => connection.serverId));
  const servers = catalog.servers.slice(0, 8);
  const buttons: NonNullable<TelegramCard["buttons"]> = [];

  for (const server of servers) {
    const serverConnected = connected.has(server.id);
    const statusButton = { text: serverConnected ? "Connected" : "Status", callbackData: `home:mcp:s:${server.id}`, style: serverConnected ? "success" as const : undefined };
    if (server.enabled === false) {
      buttons.push([statusButton]);
    } else if (serverConnected) {
      buttons.push([statusButton, { text: "Disconnect", callbackData: `home:mcp:d:${server.id}`, style: "danger" as const }]);
    } else {
      buttons.push([{ text: "Connect", callbackData: `home:mcp:c:${server.id}`, style: "primary" as const }, statusButton]);
    }
  }
  buttons.push([{ text: "Refresh status", callbackData: "home:mcp:r" }, { text: "← Workspace", callbackData: "home:refresh" }]);

  const body = !config.mcpEnabled
    ? ["Third-party MCP is currently disabled for this deployment.", "No MCP server connections can be changed until it is enabled."]
    : servers.length
      ? [ ...(connections.length ? [] : ["No third-party MCP servers are currently connected."]), ...servers.map((server) => `${server.name} — ${server.enabled === false ? "unavailable" : connected.has(server.id) ? "connected" : "not connected"} · ${mcpAuthLabel(server.auth)}`) ]
      : ["No third-party MCP servers are currently published in Chusky's catalog."];
  const detail = !config.mcpEnabled
    ? "An operator must set MCP_ENABLED=true and publish approved server definitions in src/mcp/mcp.json."
    : servers.length
      ? "Public MCP servers can be connected here. OAuth and access-token servers use a secure dashboard/API handoff; never paste credentials into Telegram. Connected tools remain account-scoped and risky actions still require approval."
      : "The catalog is empty. Approved servers are added by the Chusky operator; user credentials never belong in the catalog.";
  const card: TelegramCard = { title: "Third-party MCP", body, detail, buttons };
  if (messageId) await editCard(ctx, messageId, card); else await replyCard(ctx, card);
}

async function showWorkspace(ctx: Context, messageId?: number): Promise<void> {
  if (isTelegramShared(ctx)) {
    const card: TelegramCard = {
      title: "⚡ Chusky in this group",
      body: ["This is a shared workspace. Personal apps, browser sessions, API keys, memory, and approval details stay private."],
      buttons: [[{ text: "🧩 Group apps", callbackData: "home:apps", style: "primary" }, { text: "⚡ Triggers", callbackData: "home:triggers" }]],
    };
    if (messageId) await editCard(ctx, messageId, card); else await replyCard(ctx, card);
    return;
  }
  const [session, states, approvals, handoffs, triggers, reminders, jobs, tasks, missions, meetings, preparations, contacts, mcpConnections] = await Promise.all([
    getSession(ctx.from!.id),
    getToolkitStates(ctx.from!.id).catch((error) => { logger.warn({ err: error, userId: ctx.from!.id }, "Could not load workspace app summary"); return []; }),
    listApprovals(ctx.from!.id, 50),
    listHandoffRecords(ctx.from!.id),
    listTriggers(ctx.from!.id).catch((error) => { logger.warn({ err: error, userId: ctx.from!.id }, "Could not load workspace trigger summary"); return []; }),
    listReminders(ctx.from!.id),
    listJobs(ctx.from!.id),
    listTasks(ctx.from!.id),
    listMissions(ctx.from!.id),
    listRecallMeetings(ctx.from!.id, 20),
    listCalendarMeetingPreparations(ctx.from!.id, 20),
    listMeetingContacts(ctx.from!.id, 50),
    listMcpConnections(ctx.from!.id).catch((error) => { logger.warn({ err: error, userId: ctx.from!.id }, "Could not load workspace MCP summary"); return []; }),
  ]);
  const connected = states.filter((state) => state.connected);
  const activeWorkerStatuses = new Set(["queued", "cancel_requested", "interrupted", "requires_approval", "requires_tool_request"]);
  const card = workspaceCard({
    model: session.model,
    connectedApps: connected.length,
    connectedAccounts: connected.reduce((total, state) => total + (state.accountCount ?? 0), 0),
    pendingApprovals: approvals.filter((approval) => approval.status === "pending" && approval.expiresAt > Date.now()).length,
    activeWorkers: handoffs.filter((handoff) => activeWorkerStatuses.has(handoff.status)).length,
    triggerCount: triggers.length,
    activeReminders: reminders.filter((reminder) => reminder.status === "scheduled").length,
    activeJobs: jobs.filter((job) => job.status === "active").length,
    activeTasks: tasks.filter((task) => !["completed", "cancelled", "failed"].includes(task.status)).length,
    activeMissions: missions.filter((mission) => !["completed", "cancelled", "failed"].includes(mission.status)).length,
    activeMeetings: meetings.filter((meeting) => ["creating", "scheduled", "joining", "waiting_room", "in_call", "leaving"].includes(meeting.status)).length,
    preparedMeetings: preparations.filter((preparation) => ["prepared", "auto_scheduled"].includes(preparation.status)).length,
    meetingContacts: contacts.length,
    mcpConnections: config.mcpEnabled ? mcpConnections.length : 0,
    voiceReplies: session.voiceReplies === true,
    attentionPulseEnabled: jobs.some((job) => job.kind === "attention_pulse" && job.status === "active"),
  });
  if (messageId) await editCard(ctx, messageId, card); else await replyCard(ctx, card);
}

function modelProviderKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Anthropic", "mpv:anthropic").text("OpenAI", "mpv:openai").row()
    .text("Google", "mpv:google").text("Meta Muse", "mpv:meta-muse").row()
    .text("DeepSeek", "mpv:deepseek").text("Qwen", "mpv:qwen").row()
    .text("GLM", "mpv:z-ai").text("Kimi", "mpv:moonshotai").row()
    .text("Grok", "mpv:x-ai").text("MiniMax", "mpv:minimax").row()
    .text("Browse all models", "mpv:all");
}

function modelListKeyboard(models: Array<{ id: string; name: string }>, provider: ModelProvider, page: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const start = page * MODEL_PAGE_SIZE;
  for (let index = start; index < Math.min(start + MODEL_PAGE_SIZE, models.length); index++) {
    const model = models[index];
    // Keep two models legible on one mobile keyboard row. The callback still
    // carries the exact live OpenRouter model ID.
    const label = (model.name || model.id).slice(0, 28);
    keyboard.text(label, `msel:${model.id}`);
    if ((index - start) % 2 === 1 || index === Math.min(start + MODEL_PAGE_SIZE, models.length) - 1) keyboard.row();
  }
  const pageCount = Math.max(1, Math.ceil(models.length / MODEL_PAGE_SIZE));
  if (page > 0) keyboard.text("← Previous", `mpg:${provider}:${page - 1}`);
  keyboard.text(`Page ${page + 1}/${pageCount}`, "mpg:noop");
  if (page + 1 < pageCount) keyboard.text("Next →", `mpg:${provider}:${page + 1}`);
  keyboard.row().text("← Providers", "mpv:__back");
  return keyboard;
}

function triggerMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Add a trigger", "trg:apps:0").row()
    .text("📋 My triggers", "trg:my").row()
    .text("ℹ️ How triggers work", "trg:help");
}

function triggerToolkitKeyboard(toolkits: Array<{ slug: string; name: string; triggerCount: number; accountCount: number }>, page: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const start = page * TRIGGER_PAGE_SIZE;
  for (const toolkit of toolkits.slice(start, start + TRIGGER_PAGE_SIZE)) {
    keyboard.text(`${toolkit.name} (${toolkit.triggerCount})`, `trg:types:${toolkit.slug}:${page}`).row();
  }
  const totalPages = Math.max(1, Math.ceil(toolkits.length / TRIGGER_PAGE_SIZE));
  if (page > 0) keyboard.text("← Previous", `trg:apps:${page - 1}`);
  keyboard.text(`Page ${page + 1}/${totalPages}`, "trg:noop");
  if (page + 1 < totalPages) keyboard.text("Next →", `trg:apps:${page + 1}`);
  return keyboard.row().text("← Triggers", "trg:menu");
}

function triggerTypeKeyboard(types: TriggerCatalogueItem[], toolkit: string, toolkitPage: number, page: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const start = page * TRIGGER_PAGE_SIZE;
  for (const trigger of types.slice(start, start + TRIGGER_PAGE_SIZE)) {
    keyboard.text(trigger.name.slice(0, 55), `trg:type:${trigger.token}:${toolkitPage}`).row();
  }
  const totalPages = Math.max(1, Math.ceil(types.length / TRIGGER_PAGE_SIZE));
  if (page > 0) keyboard.text("← Previous", `trg:typepage:${toolkit}:${toolkitPage}:${page - 1}`);
  keyboard.text(`Page ${page + 1}/${totalPages}`, "trg:noop");
  if (page + 1 < totalPages) keyboard.text("Next →", `trg:typepage:${toolkit}:${toolkitPage}:${page + 1}`);
  return keyboard.row().text("← Apps", `trg:apps:${toolkitPage}`);
}

async function triggerToolkitView(ctx: Context, requestedPage: number): Promise<void> {
  const toolkits = await listAvailableTriggerToolkits(ctx.from!.id, true);
  if (!toolkits.length) {
    await ctx.editMessageText("<b>Create a trigger</b>\n\nConnect an app first with <code>/apps</code> or <code>/connect gmail</code>, then return here.", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("← Triggers", "trg:menu") });
    return;
  }
  const pageCount = Math.max(1, Math.ceil(toolkits.length / TRIGGER_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  await ctx.editMessageText(
    `<b>Choose an app</b>\n\nShowing connected apps with available triggers. Select an app, then choose what should wake Chusky.\n\n<i>${toolkits.length} connected app${toolkits.length === 1 ? "" : "s"} · page ${page + 1}/${pageCount}</i>`,
    { parse_mode: "HTML", reply_markup: triggerToolkitKeyboard(toolkits, page) }
  );
}

async function triggerTypeView(ctx: Context, toolkit: string, toolkitPage: number, requestedPage: number): Promise<void> {
  const types = await listAvailableTriggerTypes(toolkit);
  if (!types.length) {
    await ctx.editMessageText("No trigger types are currently available for that app.", { reply_markup: new InlineKeyboard().text("← Apps", `trg:apps:${toolkitPage}`) });
    return;
  }
  const pageCount = Math.max(1, Math.ceil(types.length / TRIGGER_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const label = escapeTelegramHtml(types[0].toolkit.name);
  await ctx.editMessageText(`<b>${label} triggers</b>\n\nChoose the event that should wake Chusky.\n\n<i>${types.length} available · page ${page + 1}/${pageCount}</i>`, { parse_mode: "HTML", reply_markup: triggerTypeKeyboard(types, toolkit, toolkitPage, page) });
}

async function showTriggerConfirmation(ctx: Context, trigger: TriggerCatalogueItem, accountId: string, toolkitPage: number): Promise<void> {
  const required = requiredTriggerConfigFields(trigger.config);
  const base = `<b>${escapeTelegramHtml(trigger.name)}</b>\n\n${escapeTelegramHtml(trigger.description || "This event will wake Chusky.")}`;
  if (required.length) {
    const example = Object.fromEntries(required.map((field) => [field, "…"]));
    await ctx.editMessageText(
      `${base}\n\n<b>Configuration required</b>\nSend:\n<code>/trigger create ${escapeTelegramHtml(trigger.slug)} ${escapeTelegramHtml(JSON.stringify({ connectedAccountId: accountId, triggerConfig: example }))}</code>\n\nRequired: ${required.map((field) => `<code>${escapeTelegramHtml(field)}</code>`).join(", ")}`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("← Triggers", `trg:types:${trigger.toolkit.slug}:${toolkitPage}`) }
    );
    return;
  }
  const accountIndex = (await listConnectedAccounts(ctx.from!.id, trigger.toolkit.slug)).filter((account) => account.status.toUpperCase() === "ACTIVE").findIndex((account) => account.id === accountId);
  if (accountIndex < 0) throw new Error("That connected account is no longer available");
  await ctx.editMessageText(`${base}\n\nReady to activate this trigger for the selected ${escapeTelegramHtml(trigger.toolkit.name)} account.`, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("✅ Create trigger", `trg:create:${trigger.token}:${accountIndex}`).row().text("← Triggers", `trg:types:${trigger.toolkit.slug}:${toolkitPage}`),
  });
}

function channelLinkKeyboard(userId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("💼 Slack", `chlink:p:slack:${userId}`)
    .text("🟢 WhatsApp", `chlink:p:whatsapp:${userId}`).row()
    .text("📱 iMessage", `chlink:p:sendblue:${userId}`)
    .text("✉️ Telegram", `chlink:t:${userId}`).row()
    .text("⌨️ CLI", `chlink:cli:${userId}`).row()
    .text("💬 SMS", `chlink:p:sms:${userId}`)
    .text("𝕏 XChat", `chlink:p:xchat:${userId}`).row()
    .text("👥 Link an iMessage group", `chlink:g:sendblue:${userId}`);
}

async function sendCliLink(ctx: Context): Promise<void> {
  const code = await createCliPairing(ctx.from!.id);
  const serverHint = config.webhookUrl
    ? ` --server ${escapeTelegramHtml(config.webhookUrl.replace(/\/$/, ""))}`
    : "";
  await ctx.reply(`🔐 <b>Terminal pairing code</b>\n\n<code>${code}</code>\n\nThis code expires in 10 minutes and can be used once. In your terminal run:\n\n<code>chusky auth link${serverHint}</code>`, { parse_mode: "HTML" });
}

async function sendPrivateChannelLink(ctx: Context, provider: "slack" | "whatsapp" | "sendblue" | "sms" | "xchat"): Promise<void> {
  const code = await createLinkCode(ctx.from!.id, provider);
  if (provider === "slack" && config.webhookUrl && config.slackClientId && config.slackRedirectUri) {
    const install = `${config.webhookUrl.replace(/\/$/, "")}/slack/install?code=${encodeURIComponent(code)}`;
    await replyHtml(ctx, `<b>Link Slack</b>\n\n<a href="${install}">Install Chusky in Slack</a>\n\nThis one-time link expires in 10 minutes.`);
    return;
  }
  const label = provider === "sendblue" ? "iMessage/Sendblue" : provider === "sms" ? "SMS/Twilio" : provider === "xchat" ? "XChat" : provider;
  await replyHtml(ctx, `<b>Link ${label}</b>\n\nOne-time code: <code>${code}</code>\n\nSend <code>/link ${code}</code> from the ${label} account you want to link. It expires in 10 minutes.`);
}

async function sendGroupChannelLink(ctx: Context): Promise<void> {
  const code = await createSendblueGroupLinkCode(ctx.from!.id);
  await replyHtml(ctx, `<b>Link an iMessage group</b>\n\nOne-time code: <code>${code}</code>\n\nSend <code>/link-group ${code}</code> inside the iMessage group from the linked Sendblue number. It expires in 10 minutes.`);
}
async function acquireQueuedLock(userId: number, token: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (true) {
    if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
    if (await acquireUserLock(userId, token)) return;
    if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
    if (Date.now() >= deadline) throw new Error("Timed out waiting for another Chusky request to finish");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function withTelegramUserLock<T>(userId: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const lockToken = randomUUID();
  activeRequests.set(userId, controller);
  try {
    await acquireQueuedLock(userId, lockToken, controller.signal);
    return await work(controller.signal);
  } finally {
    await releaseUserLock(userId, lockToken).catch(() => undefined);
    if (activeRequests.get(userId) === controller) activeRequests.delete(userId);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAllowed(ctx: Context): boolean {
  if (config.allowedUsers.length === 0) return true;
  return config.allowedUsers.includes(String(ctx.from?.id ?? ""));
}

async function guard(ctx: Context): Promise<boolean> {
  if (ctx.from && ctx.chat && isAllowed(ctx)) {
    // Keep a direct-chat route for private fallback delivery. A group ID must
    // never replace it, otherwise a later approval could be sent publicly.
    if (ctx.chat.type === "private") await setTelegramChatId(ctx.from.id, ctx.chat.id);
    await linkChannelIdentity(ctx.from.id, { provider: "telegram", externalUserId: String(ctx.from.id), displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") });
  }
  if (isAllowed(ctx)) return true;
  await ctx.reply("⛔ You are not authorised to use Chusky.");
  return false;
}

async function replyHtml(ctx: Context, html: string): Promise<void> {
  for (const chunk of splitHtml(html)) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(chunk.replace(/<[^>]+>/g, ""));
    }
  }
}

async function editHtml(ctx: Context, msgId: number, html: string): Promise<void> {
  const chunks = splitHtml(html);
  try {
    await ctx.api.editMessageText(ctx.chat!.id, msgId, chunks[0], { parse_mode: "HTML" });
  } catch { /* ignore */ }
  for (const chunk of chunks.slice(1)) await replyHtml(ctx, chunk);
}

async function sendVoiceReply(ctx: Context, text: string, enabled: boolean): Promise<void> {
  if (!enabled || !text.trim()) return;
  try {
    const audio = await generateSpeech(text);
    await ctx.replyWithAudio(new InputFile(audio.data, "chusky.mp3"), { title: "Chusky voice reply", performer: "Chusky" });
  } catch (error) {
    // Text delivery has already succeeded; TTS is an optional enhancement and
    // must never turn a successful agent response into a failed request.
    logger.warn({ err: error, userId: ctx.from?.id }, "Voice reply generation failed");
  }
}

function telegramConversationId(ctx: Context): string {
  return conversationIdFor({
    provider: "telegram",
    providerConversationId: String(ctx.chat!.id),
    providerThreadId: (ctx.message as { message_thread_id?: string | number } | undefined)?.message_thread_id ? String((ctx.message as { message_thread_id: string | number }).message_thread_id) : undefined,
  });
}

async function telegramGroupModel(ctx: Context, fallback: string): Promise<string> {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") return fallback;
  return (await getChannelConversation(telegramConversationId(ctx)))?.model ?? config.groupDefaultModel;
}

function isTelegramShared(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

/** Exact greetings stay lightweight and conversational; requests such as
 * "hey, check my calendar" still enter the normal agent path. */
export function isSimpleTelegramGreeting(text: string): boolean {
  return /^(?:hi|hello|hey|hiya|howdy|good\s+(?:morning|afternoon|evening))(?:[\s!,.?…]*)$/i.test(text.trim());
}

function disconnectAccountKeyboard(accounts: Array<{ id: string; toolkit: string; alias?: string }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const account of accounts.slice(0, 20)) {
    const label = account.alias ? `${account.toolkit} · ${account.alias}` : account.toolkit;
    keyboard.text(`Disconnect ${label}`.slice(0, 58), `acct:disconnect:select:${account.id}`).row();
  }
  return keyboard;
}

function disconnectAccountText(accounts: Array<{ id: string; toolkit: string; alias?: string }>): string {
  if (!accounts.length) return "No connected Composio accounts to disconnect.";
  return `<b>Disconnect a connected app</b>\n\nChoose the account to remove. This revokes Chusky’s access; you can reconnect it later with <code>/connect</code>.`;
}

function disconnectConfirmation(account: { id: string; toolkit: string; alias?: string }): { text: string; reply_markup: InlineKeyboard } {
  const label = account.alias ? `${account.toolkit} (${account.alias})` : account.toolkit;
  return {
    text: `<b>Disconnect ${escapeTelegramHtml(label)}?</b>\n\nChusky will revoke this connected account. Existing memories and conversation history are not deleted.`,
    reply_markup: new InlineKeyboard()
      .text("Disconnect", `acct:disconnect:confirm:${account.id}`)
      .text("Cancel", `acct:disconnect:cancel:${account.id}`),
  };
}

/**
 * Keep Telegram's transport scope explicit at the agent boundary. The handler
 * already uses the shared conversation history for groups, but runAgent also
 * needs this context to suppress private memory, knowledge, account metadata,
 * and account-only native actions in the core loop.
 */
export function telegramAgentChannelContext(ctx: Context, userId: number): AgentChannelContext {
  return {
    accountId: `account_${userId}`,
    provider: "telegram",
    conversationId: telegramConversationId(ctx),
    scope: isTelegramShared(ctx) ? "shared" : "private",
  };
}

const SHARED_GROUP_TOOL_DENY = [
  "CHUCK_SAVE_MEMORY", "CHUCK_UPDATE_MEMORY", "CHUCK_SEARCH_MEMORY", "CHUCK_FORGET_MEMORY",
  "CHUCK_SAVE_IMAGE_ASSET", "CHUCK_SEARCH_IMAGE_ASSETS", "CHUCK_GET_IMAGE_ASSET", "CHUCK_FORGET_IMAGE_ASSET",
  // A setup link is a bearer credential and an authenticated identity belongs
  // to one account, never a shared group conversation.
  "CHUCK_VAULT_SAVE", "CHUCK_VAULT_LIST", "CHUCK_VAULT_STATUS", "CHUCK_VAULT_LOGIN", "CHUCK_VAULT_LOGOUT",
  "CHUCK_DAYTONA_BROWSER", "CHUCK_DAYTONA_COMPUTER", "CHUCK_BROWSER_PLAN", "CHUCK_BROWSER_SESSION_HEALTH", "CHUCK_BROWSER_SESSION_REVOKE", "CHUCK_BROWSER_PLAYBOOK_SAVE", "CHUCK_BROWSER_PLAYBOOK_LIST", "CHUCK_BROWSER_PLAYBOOK_REMOVE", "CHUCK_BROWSER_VERIFY", "CHUCK_BROWSER_AUDIT_LIST",
  // Shopping plans include private purchase intent and lead into a private
  // website identity, so a shared group must not create or inspect them.
  "CHUCK_DAYTONA_BROWSER_HANDOFF", "CHUCK_BROWSER_HANDOFF_STATUS", "CHUCK_BROWSER_HANDOFF_COMPLETE",
  "CHUCK_SHOPPING_START", "CHUCK_SHOPPING_LIST", "CHUCK_SHOPPING_SELECT_RETAILER", "CHUCK_SHOPPING_UPDATE", "CHUCK_SHOPPING_CANCEL", "CHUCK_SHOPPING_PAUSE", "CHUCK_SHOPPING_RESUME", "CHUCK_SHOPPING_SAVE_SITE", "CHUCK_SHOPPING_LIST_SITES", "CHUCK_SHOPPING_REMOVE_SITE",
] as const;

async function telegramConversationHistory(ctx: Context, privateHistory: Awaited<ReturnType<typeof getSession>>["history"]) {
  if (!isTelegramShared(ctx)) return privateHistory;
  return (await getChannelConversation(telegramConversationId(ctx)))?.history ?? [];
}

async function saveTelegramConversation(ctx: Context, userId: number, text: string, response: string, createdAt: number): Promise<void> {
  const messages = [{ role: "user" as const, content: text, createdAt }, { role: "assistant" as const, content: response, createdAt }];
  if (!isTelegramShared(ctx)) {
    await appendMessages(userId, messages);
    return;
  }
  await appendChannelConversationMessages({
    id: telegramConversationId(ctx), accountId: `account_${userId}`, userId, provider: "telegram", scope: "shared", messages,
  });
}

/** Send expiring browser handoff URLs outside saved conversational history. */
async function sendPrivateBrowserLinks(ctx: Context, links: Awaited<ReturnType<typeof runAgent>>["privateLinks"]): Promise<void> {
  for (const link of links ?? []) {
    // A Telegram URL button preserves the signed Daytona preview exactly and
    // avoids an automatic chat-link preview navigating to a dashboard login.
    await ctx.reply(`${link.label}\n\nThis private session expires soon. Complete the website step there, then return here and say continue.`, {
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[{ text: "Open private browser session", url: link.url }]],
      },
    });
  }
}

function telegramAgentOptions(ctx: Context, receivedAt: number) {
  const shared = isTelegramShared(ctx);
  return {
    ...(shared ? { instructions: sharedGroupInstructions("Telegram"), toolDeny: [...SHARED_GROUP_TOOL_DENY] } : {}),
    temporalContext: { messageReceivedAt: receivedAt, timezone: config.timezone },
  };
}

async function isTelegramGroupAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.from || !ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) return false;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === "creator" || member.status === "administrator";
  } catch (error) {
    logger.warn({ err: error, chatId: ctx.chat.id, userId: ctx.from.id }, "Could not verify Telegram group administrator");
    return false;
  }
}

async function sendGeneratedArtifacts(ctx: Context, files: Array<{ data: Buffer; name: string; contentType: string; artifactId: string; type: string }> | undefined): Promise<void> {
  for (const file of files ?? []) {
    try {
      const input = file.data.length
        ? new InputFile(file.data, file.name)
        : new InputFile((await daytonaEngine.streamArtifact(ctx.from?.id ?? 0, file.artifactId)).stream, file.name);
      await ctx.replyWithDocument(input, { caption: `📦 ${file.name}\nArtifact ID: ${file.artifactId}` });
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from?.id, artifactId: file.artifactId }, "Artifact delivery failed");
      await ctx.reply(`I created ${file.name}, but Telegram could not deliver the file. Artifact ID: ${file.artifactId}`);
    }
  }
}

async function editMarkdown(ctx: Context, msgId: number, markdown: string, suffix = ""): Promise<void> {
  const rich = markdownToTelegramRichHtml(markdown);
  if (rich.safe) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/editMessageText`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: ctx.chat!.id, message_id: msgId, rich_message: { html: rich.html + suffix } }),
      });
      if (response.ok) return;
    } catch { /* stable formatter below */ }
  }
  await editHtml(ctx, msgId, mdToTelegramHtml(markdown) + suffix);
}

async function downloadTelegramFile(ctx: Context, fileId: string): Promise<{ data: Buffer; path: string }> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path");
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
  return { data: Buffer.from(await res.arrayBuffer()), path: file.file_path };
}

export function audioFormat(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "oga" ? "ogg" : ext || "ogg";
}

function telegramMessageReceivedAt(ctx: Context): number {
  const date = (ctx.message as { date?: unknown } | undefined)?.date;
  return typeof date === "number" && Number.isFinite(date) && date > 0 ? date * 1000 : Date.now();
}

async function handleMedia(ctx: Context, parts: ContentPart[], historyLabel: string, afterAgent?: (selectedModel: string) => Promise<void>): Promise<void> {
  if (!(await guard(ctx))) return;
  if (!(await checkRateLimit(ctx.from!.id))) {
    await ctx.reply(`⏱ Easy there. Max ${config.rateLimit} messages per ${config.rateWindowSeconds}s.`);
    return;
  }
  const userId = ctx.from!.id;
  const controller = new AbortController();
  const lockToken = randomUUID();
  activeRequests.set(userId, controller);
  try {
    await acquireQueuedLock(userId, lockToken, controller.signal);
  } catch (error) {
    if (activeRequests.get(userId) === controller) activeRequests.delete(userId);
    throw error;
  }
  const statusText = historyLabel.startsWith("[Voice message]")
    ? "🎙️ <b>I’m listening to your voice message…</b>"
    : historyLabel.startsWith("[Audio message]")
      ? "🎙️ <b>I’m listening to your audio…</b>"
      : historyLabel.startsWith("[Image attached]")
        ? "👀 <b>I’m looking at your image…</b>"
        : historyLabel.startsWith("[Document attached:")
          ? "📄 <b>I’m reading your document…</b>"
          : historyLabel.startsWith("[Video attached]")
            ? "🎬 <b>I’m reviewing your video…</b>"
            : parts.some((part) => part.type !== "text")
              ? "👀 <b>I’m taking a careful look at that for you…</b>"
              : "📜 <b>I’m reading your message…</b>";
  const status = await ctx.reply(statusText, { parse_mode: "HTML" });
  try {
    const s = await getSession(userId);
    const receivedAt = telegramMessageReceivedAt(ctx);
    const result = await runAgent(userId, parts, await telegramConversationHistory(ctx, s.history), await telegramGroupModel(ctx, s.model), undefined, controller.signal, undefined, undefined, telegramAgentChannelContext(ctx, userId), telegramAgentOptions(ctx, receivedAt));
    await saveTelegramConversation(ctx, userId, historyLabel, result.text, receivedAt);
    if (result.cost) await addUsage(userId, result.cost);
    await editMarkdown(ctx, status.message_id, result.text);
    await sendPrivateBrowserLinks(ctx, result.privateLinks);
    await sendVoiceReply(ctx, result.text, s.voiceReplies === true);
    // Media-originated requests can also create verified Daytona artifacts.
    // ctx.replyWithDocument preserves the current Telegram group/thread, just
    // like a text-originated request, rather than leaving the file undelivered.
    await sendGeneratedArtifacts(ctx, result.generatedFiles);
    for (const image of result.generatedImages ?? []) {
      await ctx.replyWithPhoto(new InputFile(image.data, image.mediaType.includes("jpeg") ? "chusky.jpg" : "chusky.png"));
      if (image.cost) await addUsage(userId, image.cost);
    }
    for (const image of result.retrievedImages ?? []) {
      await ctx.replyWithPhoto(new InputFile(image.data, image.mediaType.includes("jpeg") ? "saved-image.jpg" : "saved-image.png"), { caption: image.name ? `Saved image: ${image.name}` : "Saved image" });
    }
    // Keep enrichment out of the conversational turn so it cannot create a
    // second, description-like experience before the selected model replies.
    if (afterAgent) void afterAgent(s.model).catch((error) => logger.warn({ err: error, userId }, "Background media indexing failed"));
  } catch (e) {
    logger.error({ err: e, userId }, "Chusky media error");
    await ctx.api.editMessageText(ctx.chat!.id, status.message_id, e instanceof DOMException && e.name === "AbortError" ? "🛑 Request cancelled." : `❌ ${String(e).slice(0, 500)}`);
  } finally {
    await releaseUserLock(userId, lockToken);
    activeRequests.delete(userId);
  }
}

// ── Live status bar ───────────────────────────────────────────────────────────
// Edits a single "status" message in-place as Chusky works,
// giving users real-time feedback on every step.

function buildStatusBar(steps: string[]): string {
  if (steps.length === 0) return "⏳ I’m getting started…";

  // Status callbacks can arrive more than once for the same capability (for
  // example, a native tool can report both its family and its delegated work).
  // Keep the message readable instead of rendering an internal event log.
  const unique: string[] = [];
  for (const step of steps) {
    if (!step.trim()) continue;
    const previousIndex = unique.indexOf(step);
    if (previousIndex >= 0) unique.splice(previousIndex, 1);
    unique.push(step);
  }
  if (unique.length === 0) return "⏳ I’m getting started…";

  const current = unique[unique.length - 1]!;
  const completed = unique.slice(0, -1).slice(-2);
  const lines = completed.map((step) => `✓ ${step}`);
  if (unique.length > completed.length + 1) {
    const hidden = unique.length - completed.length - 1;
    lines.unshift(`✓ ${hidden} earlier step${hidden === 1 ? "" : "s"} complete`);
  }
  lines.push(`⟳ ${current}`);
  return lines.join("\n");
}

// ── Register all handlers ─────────────────────────────────────────────────────

export function registerHandlers(bot: Bot): void {

  // Telegram retries a webhook update when a long agent turn has not completed.
  // Claim the update ID durably so a retry cannot execute the same request twice.
  bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    if (!(await claimTelegramUpdate(updateId))) {
      logger.warn({ updateId }, "Ignoring duplicate Telegram update");
      return;
    }
    await next();
  });

  // /start ───────────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    if (!(await guard(ctx))) return;
    const model = await getModel(ctx.from!.id);
    await replyHtml(ctx,
      `⚡ <b>Hey, I'm Chusky — your AI agent.</b>\n\n` +
      `I have access to <b>1,000+ tools</b> across every major platform — GitHub, Gmail, Slack, Notion, Linear, Stripe, and more. Just tell me what you need.\n\n` +
      `<b>Active model:</b> <code>${model}</code>\n\n` +
      `<b>Commands:</b>\n` +
      `  /home — open your Chusky workspace\n` +
      `  /mcp — view and manage third-party MCP servers\n` +
      `  /browser — website playbooks, session health, handoffs, and activity\n` +
      `  /connect <code>[toolkit]</code> — connect an app\n` +
      `  /apps — see connected apps\n` +
      `  /model — switch AI model\n` +
      `  /clear history — clear private conversation history\n` +
      `  /clear group — clear this group's shared history (group admin)\n` +
      `  /clear session — clear history and reset session\n` +
      `  /export — download conversation\n` +
      `  /usage — session stats\n` +
      `  /voice on|off — enable or disable spoken replies\n` +
      `  /video-status — check video generation jobs\n` +
      `  /connect <toolkit> [alias] — connect one or more app accounts\n` +
      `  /accounts [toolkit] — list connected Composio accounts\n` +
      `  /disconnect [account-id] — revoke a connected Composio account\n` +
      `  /api — create and manage project API keys\n` +
      `  /call <code>+number purpose</code> — request a phone call\n` +
      `  /meetings — meeting status, participants, calendar preparations, and contacts\n` +
      `  /missions [pause|resume|cancel] <mission-id> — inspect and control autonomous missions\n` +
      `  /meeting profile|prepare|join|join-prepared|context|leave — meeting controls\n` +
      `  /voice list|set — choose live-call voices\n` +
      `  /channel — choose a private channel or iMessage group to link\n` +
      `  /linkgroup — open the group-link menu\n` +
      `  /group-access owner|all — set iMessage group access (inside the group)\n` +
      `  /group-model <model-id|default> — choose the model for this Telegram group\n` +
      `  /unlink-group — unlink an iMessage group (inside the group)\n` +
      `  /help — show this\n\n` +
      `What do you want to do?`
    );
  });

  // /help ────────────────────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    if (!(await guard(ctx))) return;
    await replyHtml(ctx,
      `<b>Chusky — Commands</b>\n\n` +
      `/home — connected apps, tasks, approvals, triggers, and call voice settings\n` +
      `/mcp — view and manage third-party MCP servers\n` +
      `/browser — saved website playbooks, session health, handoffs, and activity\n` +
      `/connect <code>github</code> — connect GitHub (or any other app)\n` +
      `/apps — list connected apps &amp; their status\n` +
      `/model — switch AI model (per-session)\n` +
      `/clear group — wipe this group's shared history (group admin)\n` +
      `/clear session — wipe history &amp; reset session\n` +
      `/triggers — list your Composio triggers\n` +
      `/trigger create|enable|disable|delete — manage triggers\n` +
      `/export — download conversation as .txt\n` +
      `/usage — messages sent, model, turns\n` +
      `/voice on|off|status — control spoken replies\n` +
      `/voice list|set twilio|meetings|bland — choose a live-call voice\n` +
      `/meetings [meeting id] — meetings, participants, outcomes, and contacts\n` +
      `/missions [pause|resume|cancel] <mission-id> — inspect and control autonomous missions\n` +
      `/meeting profile|prepare|join|join-prepared|context|leave — meeting controls\n` +
      `/video-status [job id] — check video generation status\n` +
      `/agents — list recent worker delegations\n` +
      `/agent-status <code>handoff-id</code> — inspect one worker run\n` +
      `/agent-cancel <code>handoff-id</code> — cancel a queued worker run\n` +
      `/call <code>+number purpose</code> — start a validated phone call\n` +
      `/cancel — cancel the active request\n` +
      `/channel — choose a private channel or iMessage group to link securely\n` +
      `/linkgroup — open the iMessage group-link menu\n` +
      `/connect <toolkit> [alias] — connect an app account, including multiple accounts\n` +
      `/accounts [toolkit] — list connected Composio accounts and aliases\n` +
      `/disconnect [account-id] — revoke a connected Composio account\n` +
      `/api — create, rotate, revoke, or list your private project API keys\n` +
      `/channel list — show linked channel identities\n` +
      `Inside iMessage, send /link-group <code> to activate a generated group code\n` +
      `/group-access owner|all — control group access (send inside iMessage)\n` +
      `/group-model <model-id|default> — choose the model for this Telegram group\n` +
      `/unlink-group — unlink the iMessage group (send inside iMessage)\n` +
      `/image <description> — generate an image\n` +
      `/info — full session details\n` +
      `/help — this message\n\n` +
      `<b>Chusky's built-in capabilities:</b>\n` +
      `• 1,000+ Composio tools (GitHub, Gmail, Slack, Notion…)\n` +
      `• <code>COMPOSIO_MANAGE_CONNECTIONS</code> — surfaces OAuth links inline\n` +
      `• <code>COMPOSIO_REMOTE_BASH_TOOL</code> — runs shell commands\n` +
      `• <code>COMPOSIO_REMOTE_WORKBENCH</code> — persistent remote environment\n` +
      `• <code>COMPOSIO_SEARCH_WEB</code> — searches current web information\n` +
      `• <code>COMPOSIO_SEARCH_FETCH_URL_CONTENT</code> — reads a supplied URL\n` +
      `• <code>COMPOSIO_SEARCH_TOOLS</code> — discovers tools by intent\n\n` +
      `Just describe what you need — Chusky figures out the tools.`
    );
  });

  bot.command("dashboard", async (ctx) => {
    if (!(await guard(ctx))) return;
    const url = config.dashboardUrl || config.webhookUrl;
    if (!url) { await ctx.reply("The dashboard is not configured yet. Set DASHBOARD_URL in the Chusky deployment."); return; }
    await ctx.reply("Open your Chusky workspace:", { reply_markup: new InlineKeyboard().url("Open dashboard", `${url.replace(/\/+$/, "")}/app`) });
  });

  // /home ────────────────────────────────────────────────────────────────────
  bot.command("home", async (ctx) => {
    if (!(await guard(ctx))) return;
    try {
      await showWorkspace(ctx);
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from!.id }, "Could not render Telegram workspace");
      await ctx.reply("❌ I could not load your workspace right now. Please try /home again.");
    }
  });

  bot.command("mcp", async (ctx) => {
    if (!(await guard(ctx))) return;
    try {
      await showMcpWorkspace(ctx);
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from!.id }, "Could not render Telegram MCP workspace");
      await ctx.reply("❌ I could not load MCP connections right now. Please try /mcp again.");
    }
  });

  bot.command("browser", async (ctx) => {
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.reply("For privacy, browser identities and activity are available only in your private chat with Chusky."); return; }
    const uid = ctx.from!.id;
    const [subcommand] = String(ctx.match ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    try {
      if (subcommand === "audit") {
        const entries = await listBrowserAudit(uid, 30);
        await replyHtml(ctx, entries.length ? `<b>Browser activity</b>\n\n${entries.map((entry) => `• <code>${escapeTelegramHtml(entry.status)}</code> · ${escapeTelegramHtml(entry.summary)}\n  ${escapeTelegramHtml(entry.service ?? entry.origin ?? "browser")} · ${escapeTelegramHtml(new Date(entry.createdAt).toLocaleString("en-GB"))}`).join("\n")}` : "No browser activity recorded yet.");
        return;
      }
      if (subcommand === "health") {
        const health = await browserSessionHealth(uid);
        await replyHtml(ctx, health.length ? `<b>Website session health</b>\n\n${health.map((item) => `• <b>${escapeTelegramHtml(item.service)}</b> · ${escapeTelegramHtml(item.status)}\n  ${escapeTelegramHtml(item.origin)} · next: ${escapeTelegramHtml(item.recommendedAction)}`).join("\n")}` : "No saved website sessions.");
        return;
      }
      if (subcommand === "handoffs") {
        const handoffs = await listBrowserHandoffs(uid, 20);
        await replyHtml(ctx, handoffs.length ? `<b>Private browser handoffs</b>\n\n${handoffs.map((item) => `• <code>${escapeTelegramHtml(item.id)}</code> · <b>${escapeTelegramHtml(item.status)}</b>\n  ${escapeTelegramHtml(item.reason.replaceAll("_", " "))} · ${escapeTelegramHtml(item.origin ?? item.service ?? "browser")}\n  expires ${escapeTelegramHtml(new Date(item.expiresAt).toLocaleString("en-GB"))}`).join("\n\n")}` : "No browser handoffs recorded.");
        return;
      }
      if (subcommand === "logout" || subcommand === "revoke") {
        const [, service, alias, origin] = String(ctx.match ?? "").trim().split(/\s+/);
        if (!service) {
          await ctx.reply("Usage: /browser revoke <service> [account-alias] [origin]");
          return;
        }
        const result = await nativeTool(uid, "CHUCK_BROWSER_SESSION_REVOKE", { service, ...(alias ? { accountAlias: alias } : {}), ...(origin ? { origin } : {}) });
        await replyHtml(ctx, `<b>Browser session revoked</b>\n\n${escapeTelegramHtml(String((result as { note?: string })?.note ?? "The session was revoked."))}`);
        return;
      }
      const playbooks = await listBrowserPlaybooks(uid, 30);
      await replyHtml(ctx, playbooks.length ? `<b>Browser playbooks</b>\n\n${playbooks.map((item) => `• <b>${escapeTelegramHtml(item.service)}</b> · ${escapeTelegramHtml(item.accountAlias)}\n  ${escapeTelegramHtml(item.origin)} · ${item.tasks.length} task recipe${item.tasks.length === 1 ? "" : "s"} · ${item.successCount} verified`).join("\n")}` : "No saved browser playbooks yet. Ask Chusky to save one after a verified website flow.\n\nUse /browser health or /browser audit for session and activity controls.");
    } catch (error) {
      await ctx.reply(`❌ ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" });
    }
  });

  // Project API keys are deliberately a private-chat operation. A key sent in
  // a Telegram group would be visible to every group participant and cannot be
  // safely recalled after delivery.
  bot.command("api", async (ctx) => {
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) {
      await ctx.reply("For your security, create and manage API keys in a private chat with Chusky.");
      return;
    }
    const [action, ...nameParts] = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
    if (action?.toLowerCase() === "create") {
      const name = nameParts.join(" ").trim();
      if (!name) {
        await ctx.reply("Usage: /api create <project name>", { reply_markup: apiKeyMenuKeyboard() });
        return;
      }
      try {
        const project = await createTelegramProject(ctx.from!.id, name);
        await ctx.reply(apiKeyDelivery(project), { parse_mode: "HTML", reply_markup: apiKeyMenuKeyboard() });
      } catch (error) {
        await ctx.reply(`❌ ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" });
      }
      return;
    }
    if (action?.toLowerCase() === "list") {
      const projects = await listTelegramProjects(ctx.from!.id);
      await ctx.reply(projects.length
        ? `<b>Your API keys</b>\n\n${projects.map((project) => `• <b>${escapeTelegramHtml(project.name)}</b>\n<code>${escapeTelegramHtml(project.keyPrefix)}…</code> · ${escapeTelegramHtml(project.scopes.join(", "))}`).join("\n\n")}\n\nRotate replaces a key immediately. Revoke permanently disables it.`
        : "<b>Your API keys</b>\n\nYou have no active API keys yet.", { parse_mode: "HTML", reply_markup: projects.length ? apiKeyProjectKeyboard(projects) : apiKeyMenuKeyboard() });
      return;
    }
    await ctx.reply("<b>Chusky API keys</b>\n\nCreate a project key for your backend to embed Chusky in an app or workflow. Each key is isolated from Chusky's root/operator credential and can be revoked at any time.\n\nUse <code>/api create My product</code> to create a full-access project key, or choose a scoped starter key below.", { parse_mode: "HTML", reply_markup: apiKeyMenuKeyboard() });
  });

  bot.command("cancel", async (ctx) => {
    if (!(await guard(ctx))) return;
    const controller = activeRequests.get(ctx.from!.id);
    if (!controller) { await ctx.reply("There is no active request to cancel."); return; }
    controller.abort();
    await ctx.reply("🛑 Cancellation requested.");
  });

  // /meetings and /meeting are the Telegram transport for the same meeting
  // lifecycle exposed by the web dashboard and CLI. Keep this owner-private:
  // participant names, meeting history, briefs, and captured contacts must
  // never be rendered into a shared Telegram group.
  bot.command("meetings", async (ctx) => {
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.reply("For privacy, meeting details are available only in your private chat with Chusky."); return; }
    const requestedId = String(ctx.match ?? "").trim();
    try {
      if (requestedId) {
        const safe = await getRecallMeetingForUser(ctx.from!.id, requestedId);
        const record = safe ? (await listRecallMeetings(ctx.from!.id, 20)).find((item) => item.id === requestedId) : undefined;
        if (!safe || !record) { await ctx.reply("I couldn't find that meeting in your account."); return; }
        const contacts = (await listMeetingContacts(ctx.from!.id, 50, requestedId));
        await replyHtml(ctx, telegramMeetingDetail(record, contacts));
        return;
      }
      const [safeMeetings, records, preparations, contacts] = await Promise.all([
        listRecallMeetingsForUser(ctx.from!.id, 20),
        listRecallMeetings(ctx.from!.id, 20),
        listCalendarMeetingPreparations(ctx.from!.id, 20),
        listMeetingContacts(ctx.from!.id, 50),
      ]);
      const recordsById = new Map(records.map((record) => [record.id, record]));
      const active = safeMeetings.map((safe) => recordsById.get(safe.id) ?? safe).map((meeting) => telegramMeetingLine(meeting as any));
      const prepared = preparations.filter((item) => ["prepared", "auto_scheduled"].includes(item.status)).map(telegramPreparationLine);
      const contactLines = contacts.slice(0, 12).map((contact) => `• <code>${escapeTelegramHtml(contact.id)}</code> · ${escapeTelegramHtml(contact.participantName)} · ${escapeTelegramHtml(contact.email || contact.phone || "no contact")}`);
      const sections = [
        `<b>Meetings</b>\n${active.length ? active.join("\n\n") : "No recent meetings."}`,
        `<b>Prepared calendar meetings</b>\n${prepared.length ? prepared.join("\n\n") : "No prepared calendar meetings."}`,
        `<b>Captured follow-up contacts</b>\n${contactLines.length ? contactLines.join("\n") : "No captured contacts."}`,
        `Open a meeting with <code>/meetings mtg_…</code>. Use <code>/meeting join-prepared cmp_…</code> to join a prepared calendar event.`,
      ];
      await replyHtml(ctx, sections.join("\n\n"));
    } catch (error) {
      await ctx.reply(`❌ Could not load meetings: ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" });
    }
  });

  bot.command("meeting", async (ctx) => {
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.reply("For privacy, meeting controls are available only in your private chat with Chusky."); return; }
    const raw = String(ctx.match ?? "").trim();
    const separator = raw.search(/\s/);
    const action = (separator < 0 ? raw : raw.slice(0, separator)).toLowerCase();
    const rest = separator < 0 ? "" : raw.slice(separator).trim();
    const uid = ctx.from!.id;
    try {
      if (action === "profile") {
        if (!rest) {
          await replyHtml(ctx, `<b>Meeting representative profile</b>\n\n<pre>${escapeTelegramHtml(JSON.stringify(await getMeetingRepresentativeProfile(uid), null, 2))}</pre>\n\nUpdate it with <code>/meeting profile set {"enabled":true,...}</code>.`);
          return;
        }
        if (!rest.toLowerCase().startsWith("set ")) { await ctx.reply("Usage: /meeting profile | /meeting profile set <JSON>"); return; }
        let patch: unknown;
        try { patch = JSON.parse(rest.slice(4).trim()); } catch { await ctx.reply("Profile updates must be valid JSON. Example: /meeting profile set {\"enabled\":true,\"objective\":\"Represent the company clearly and move meetings toward useful next steps\"}"); return; }
        const result = await withTelegramUserLock(uid, async () => {
          const previous = await getMeetingRepresentativeProfile(uid);
          const updated = await updateMeetingRepresentativeProfile(uid, patch);
          const autoJoinReconciliation = previous.autoJoinCalendar && !updated.autoJoinCalendar ? await cancelAutomaticCalendarMeetingJoins(uid) : undefined;
          return { updated, autoJoinReconciliation };
        });
        await replyHtml(ctx, `✅ <b>Meeting representative profile updated.</b>\n\n<pre>${escapeTelegramHtml(JSON.stringify(result.updated, null, 2))}</pre>${result.autoJoinReconciliation ? `\n\nCalendar auto-join cleanup: ${escapeTelegramHtml(JSON.stringify(result.autoJoinReconciliation))}` : ""}`);
        return;
      }
      if (action === "prepare") {
        const fields = rest.split("|").map((field) => field.trim());
        if (!fields[0]) { await ctx.reply("Usage: /meeting prepare <client name> | <objective> | <optional context>"); return; }
        const brief = await prepareRecallMeetingMission(uid, { clientName: fields[0], ...(fields[1] ? { objective: fields[1] } : {}), ...(fields[2] ? { clientContext: fields[2] } : {}) });
        await replyHtml(ctx, `✅ <b>Private meeting brief prepared</b>\n\n<pre>${escapeTelegramHtml(JSON.stringify(brief, null, 2))}</pre>\n\nThis only prepares context; it does not join or contact anyone.`);
        return;
      }
      if (action === "join") {
        if (!(await checkRateLimit(uid))) { await ctx.reply("💳 Easy there. Please wait a moment before starting another meeting action."); return; }
        const fields = telegramMeetingJoinFields(rest);
        if (!fields) { await ctx.reply("Usage: /meeting join <meeting URL> | <client name> | <objective> | <optional context>"); return; }
        const meeting = await withTelegramUserLock(uid, (signal) => joinRecallMeeting(uid, fields, signal));
        await replyHtml(ctx, `✅ <b>Meeting join started.</b>\n\n<pre>${escapeTelegramHtml(JSON.stringify(meeting, null, 2))}</pre>\n\nUse <code>/meetings</code> to see live status and participants.`);
        return;
      }
      if (action === "join-prepared") {
        if (!(await checkRateLimit(uid))) { await ctx.reply("💳 Easy there. Please wait a moment before starting another meeting action."); return; }
        if (!/^cmp_[A-Za-z0-9_-]{1,96}$/.test(rest)) { await ctx.reply("Usage: /meeting join-prepared <calendar preparation id>"); return; }
        const result = await withTelegramUserLock(uid, (signal) => joinPreparedCalendarMeeting(uid, rest, signal));
        await replyHtml(ctx, `✅ <b>Prepared calendar meeting join started.</b>\n\n<pre>${escapeTelegramHtml(JSON.stringify(result, null, 2))}</pre>`);
        return;
      }
      if (action === "context") {
        const [meetingId, ...queryParts] = rest.split(/\s+/).filter(Boolean);
        if (!meetingId || !queryParts.length) { await ctx.reply("Usage: /meeting context <meeting id> <question>"); return; }
        const context = await lookupRecallMeetingContext(uid, meetingId, queryParts.join(" "));
        await replyHtml(ctx, `<b>Meeting context</b>\n\n<pre>${escapeTelegramHtml(JSON.stringify(context, null, 2))}</pre>`);
        return;
      }
      if (action === "leave") {
        if (!/^mtg_[A-Za-z0-9_-]{1,80}$/.test(rest)) { await ctx.reply("Usage: /meeting leave <meeting id>"); return; }
        const meeting = await withTelegramUserLock(uid, (signal) => leaveRecallMeeting(uid, rest, signal));
        await replyHtml(ctx, `✅ Meeting leave requested.\n\n<pre>${escapeTelegramHtml(JSON.stringify(meeting, null, 2))}</pre>`);
        return;
      }
      if (action === "contacts") {
        const contacts = await listMeetingContacts(uid, 50);
        await replyHtml(ctx, contacts.length ? `<b>Captured follow-up contacts</b>\n\n${contacts.map((contact) => `• <code>${escapeTelegramHtml(contact.id)}</code> · ${escapeTelegramHtml(contact.participantName)} · ${escapeTelegramHtml(contact.email || contact.phone || "no contact")}\n  ${escapeTelegramHtml(contact.interest)}${contact.nextStep ? `\n  Next: ${escapeTelegramHtml(contact.nextStep)}` : ""}`).join("\n")}` : "No meeting follow-up contacts have been captured.");
        return;
      }
      if (action === "contact-delete") {
        if (!/^mct_[a-f0-9]{32}$/.test(rest)) { await ctx.reply("Usage: /meeting contact-delete <contact id>"); return; }
        const removed = await deleteMeetingContact(uid, rest);
        await ctx.reply(removed ? "✅ Meeting contact deleted." : "I couldn't find that meeting contact.");
        return;
      }
      await ctx.reply("Usage: /meetings [meeting id] | /meeting profile | prepare <client> | join <url> | join-prepared <cmp_id> | context <id> <question> | leave <id> | contacts | contact-delete <id>");
    } catch (error) {
      logger.warn({ err: error, userId: uid, action }, "Telegram meeting command failed");
      await ctx.reply(`❌ ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" });
    }
  });

  bot.command("voice", async (ctx) => {
    if (!(await guard(ctx))) return;
    const raw = String(ctx.match ?? "").trim();
    const [action, provider, voiceId, ...voiceNameParts] = raw.split(/\s+/).filter(Boolean).map((item) => item.trim());
    const normalizedAction = (action || "status").toLowerCase();
    const currentSession = await getSession(ctx.from!.id);
    const current = currentSession.voiceReplies === true;
    if (normalizedAction === "on" || normalizedAction === "enable") {
      await setVoiceReplies(ctx.from!.id, true);
      await ctx.reply("🔊 Voice replies are on. I’ll send text and an audio reply after each response.");
      return;
    }
    if (normalizedAction === "off" || normalizedAction === "disable") {
      await setVoiceReplies(ctx.from!.id, false);
      await ctx.reply("🔇 Voice replies are off. I’ll continue replying with text.");
      return;
    }
    if (normalizedAction === "status") {
      await replyHtml(ctx, `${current ? "🔊" : "🔇"} <b>Telegram voice replies:</b> ${current ? "on" : "off"}\n\nTwilio: ${escapeTelegramHtml(liveVoiceCurrentLabel(currentSession, "twilio"))}\nBland: ${escapeTelegramHtml(liveVoiceCurrentLabel(currentSession, "bland"))}\nMeetings: ${escapeTelegramHtml(liveVoiceCurrentLabel(currentSession, "meetings"))}`);
      return;
    }
    if (normalizedAction === "list") {
      const flux = FLUX_TTS_VOICES.map((voice) => `<code>${escapeTelegramHtml(voice.id)}</code> — ${escapeTelegramHtml(voice.name)} (${escapeTelegramHtml(voice.accent)} English)`).join("\n");
      let bland = "Bland catalogue unavailable.";
      if (config.blandApiKey) {
        try {
          const voices = await listBlandCuratedVoices(config.blandApiKey);
          bland = voices.length ? voices.map((voice) => `<code>${escapeTelegramHtml(voice.id)}</code> — ${escapeTelegramHtml(voice.name)}`).join("\n") : "No Bland curated voices returned.";
        } catch { bland = "Bland catalogue could not be loaded right now."; }
      }
      await replyHtml(ctx, `<b>Flux voices</b> (Twilio + meetings)\n${flux}\n\n<b>Bland curated voices</b>\n${bland}\n\nSet one with <code>/voice set twilio|meetings &lt;voice-id&gt;</code> or <code>/voice set bland &lt;uuid&gt; &lt;name&gt;</code>.`);
      return;
    }
    if (normalizedAction === "set") {
      if (provider !== "twilio" && provider !== "meetings" && provider !== "bland") { await ctx.reply("Usage: /voice set twilio|meetings <flux-voice-id> | /voice set bland <uuid> <name>"); return; }
      if (!voiceId) { await ctx.reply("Usage: /voice set twilio|meetings <flux-voice-id> | /voice set bland <uuid> <name>"); return; }
      try {
        if (provider === "bland") {
          const name = voiceNameParts.join(" ").trim();
          if (!name || !config.blandApiKey) throw new Error("Bland voice selection needs a voice name and configured Bland catalogue");
          const voices = await listBlandCuratedVoices(config.blandApiKey);
          const selected = voices.find((voice) => voice.id.toLowerCase() === voiceId.toLowerCase());
          if (!selected) throw new Error("That Bland voice is not in the current curated catalogue");
          await setLiveVoicePreference(ctx.from!.id, "bland", { id: selected.id, name: selected.name });
        } else {
          const selected = FLUX_TTS_VOICES.find((voice) => voice.id === voiceId);
          if (!selected) throw new Error("That Flux voice is not available");
          await setLiveVoicePreference(ctx.from!.id, provider, selected.id);
        }
        await ctx.reply(`✅ ${provider} voice set to ${voiceId}.`);
      } catch (error) { await ctx.reply(`❌ ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" }); }
      return;
    }
    await ctx.reply("Usage: /voice list | /voice set twilio|meetings <flux-voice-id> | /voice set bland <uuid> <name> | /voice on | off | status");
  });

  bot.command("call", async (ctx) => {
    if (!(await guard(ctx))) return;
    const raw = (ctx.match?.trim() ?? "");
    const split = raw.search(/\s/);
    const phoneNumber = split < 0 ? raw : raw.slice(0, split);
    const purpose = split < 0 ? "" : raw.slice(split).trim();
    if (!phoneNumber || !purpose) {
      await ctx.reply("Usage: /call +14155550123 <purpose>. I’ll validate the destination and start the call when voice is configured.");
      return;
    }
    try {
      const call = await nativeTool(ctx.from!.id, "CHUCK_START_PHONE_CALL", { phoneNumber, purpose, callProfile: "personal" });
      const callId = call && typeof call === "object" && "id" in call ? String((call as { id?: unknown }).id ?? "") : "";
      await ctx.reply(`📞 Call started${callId ? ` · ${escapeTelegramHtml(callId)}` : ""}. I’m joining the call now.`, { parse_mode: "HTML" });
    } catch (error) {
      await ctx.reply(`❌ ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" });
    }
  });

  bot.command("cli", async (ctx) => {
    if (!(await guard(ctx))) return;
    const uid = ctx.from!.id;
    const [action, ...rest] = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
    if (action === "link") {
      await sendCliLink(ctx);
      return;
    }
    if (action === "devices") {
      const devices = await listCliDevices(uid);
      if (!devices.length) { await ctx.reply("No linked terminals."); return; }
      const lines = devices.map((d) => `<code>${d.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code> — ${d.revokedAt ? "revoked" : "active"}`);
      await replyHtml(ctx, `<b>Linked terminals</b>\n\n${lines.join("\n")}`);
      return;
    }
    if (action === "revoke") {
      const name = rest.join(" ").trim();
      if (!name) { await ctx.reply("Usage: /cli revoke &lt;terminal name&gt;", { parse_mode: "HTML" }); return; }
      const device = (await listCliDevices(uid)).find((d) => d.name === name && !d.revokedAt);
      if (!device) { await ctx.reply("I couldn't find that active terminal."); return; }
      await revokeCliDeviceHash(uid, device.tokenHash);
      await ctx.reply(`✅ Revoked terminal: ${name}`);
      return;
    }
    await ctx.reply("Usage: /cli link | /cli devices | /cli revoke <terminal name>");
  });

  bot.command("channel", async (ctx) => {
    if (!(await guard(ctx))) return;
    const parts = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase();
    const rawProvider = parts[1]?.toLowerCase();
    const provider = rawProvider === "imessage" ? "sendblue" : rawProvider === "x" ? "xchat" : rawProvider;
    if (!action || (action === "link" && !provider)) {
      await ctx.reply("Choose the channel to link:", { reply_markup: channelLinkKeyboard(ctx.from!.id) });
      return;
    }
    if (action === "linkgroup" || (action === "link" && provider === "sendblue-group")) {
      await sendGroupChannelLink(ctx);
      return;
    }
    if (action === "link" && (provider === "slack" || provider === "whatsapp" || provider === "sendblue" || provider === "sms" || provider === "xchat")) {
      await sendPrivateChannelLink(ctx, provider);
      return;
    }
    if (action === "list") {
      const linked = await listLinkedChannels(ctx.from!.id);
      await replyHtml(ctx, linked.length ? `<b>Linked channels</b>\n\n${linked.map((item) => `• ${item.provider} — <code>${item.externalUserId}</code>${item.workspaceId ? ` (${item.workspaceId})` : ""}`).join("\n")}` : "No external channels are linked yet.");
      return;
    }
    if (action === "notify" && (provider === "slack" || provider === "whatsapp" || provider === "sendblue")) {
      const enabled = String((ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean)[2] ?? "").toLowerCase() === "on";
      const count = await setProactivePreference(ctx.from!.id, provider, enabled);
      await ctx.reply(count ? `✅ Proactive ${provider} notifications are ${enabled ? "on" : "off"}.` : `No linked ${provider} channel was found. Link it first with /channel link ${provider}.`);
      return;
    }
    await ctx.reply("Choose a valid channel action:", { reply_markup: channelLinkKeyboard(ctx.from!.id) });
  });

  bot.command("linkgroup", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.reply("Choose the channel group to link:", { reply_markup: channelLinkKeyboard(ctx.from!.id) });
  });

  bot.command("group-model", async (ctx) => {
    if (!(await guard(ctx))) return;
    if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
      await ctx.reply("/group-model can only be used inside a Telegram group.");
      return;
    }
    if (!(await isTelegramGroupAdmin(ctx))) {
      await ctx.reply("Only a Telegram group administrator can change the group model.");
      return;
    }
    const conversationId = telegramConversationId(ctx);
    const requested = ctx.match?.trim() ?? "";
    const current = (await getChannelConversation(conversationId))?.model ?? config.groupDefaultModel;
    if (!requested) {
      await ctx.reply(`This group uses ${current}. Send /group-model default to use ${config.groupDefaultModel}, or /group-model <model-id> to choose a model for this group.`);
      return;
    }
    const isDefault = /^default$/i.test(requested);
    const model = isDefault ? undefined : (requested.length <= 200 && !/\s/.test(requested) ? requested : undefined);
    if (!model && !isDefault) {
      await ctx.reply("That model ID is invalid. Use a provider/model ID without spaces, or send /group-model default.");
      return;
    }
    if (!(await getChannelConversation(conversationId))) {
      await appendChannelConversationMessages({ id: conversationId, accountId: `account_${ctx.from!.id}`, userId: ctx.from!.id, provider: "telegram", scope: "shared", messages: [] });
    }
    await setChannelConversationModel(conversationId, model);
    await ctx.reply(`✅ This Telegram group will now use ${model ?? config.groupDefaultModel}.`);
  });

  // A web account proves possession of its Better Auth session by generating a
  // one-time `web_…` code. Telegram remains the ownership authority: only the
  // verified Telegram user who sends this command can attach that workspace.
  bot.command("link", async (ctx) => {
    if (!(await guard(ctx))) return;
    const code = (ctx.match?.trim() ?? "");
    const result = await redeemWebTelegramLinkCode(code, ctx.from!.id);
    if (result === "linked") {
      await ctx.reply("✅ Your Chusky web dashboard is now linked to this Telegram account. Refresh the dashboard to see the same workspace.");
      return;
    }
    if (result === "already_linked") {
      await ctx.reply("✅ That web dashboard is already linked to this Telegram account.");
      return;
    }
    if (result === "conflict") {
      await ctx.reply("That web dashboard or Telegram account is already linked elsewhere. For safety, Chusky did not change either connection.");
      return;
    }
    await ctx.reply("That web link code is invalid or expired. Create a fresh one from Dashboard → Settings, then send /link <code> here within 10 minutes.");
  });

  bot.command("image", async (ctx) => {
    if (!(await guard(ctx))) return;
    const prompt = ctx.match?.trim();
    if (!prompt) { await ctx.reply("Usage: /image <description>"); return; }
    try {
      const image = await generateImage(prompt);
      await ctx.replyWithPhoto(new InputFile(image.data, image.mediaType.includes("jpeg") ? "chusky.jpg" : "chusky.png"), { caption: "Generated by Chusky" });
      if (image.cost) await addUsage(ctx.from!.id, image.cost);
    } catch (e) { await ctx.reply(`❌ Image generation failed: ${String(e).slice(0, 500)}`); }
  });

  bot.command("video-status", async (ctx) => {
    if (!(await guard(ctx))) return;
    const jobs = await listVideoJobs(ctx.from!.id);
    const requestedId = ctx.match?.trim();
    const selected = requestedId ? jobs.filter((job) => job.id === requestedId) : jobs.slice(0, 5);
    if (!selected.length) { await ctx.reply(requestedId ? `No video job found for <code>${escapeTelegramHtml(requestedId)}</code>.` : "You have no video generation jobs yet.", { parse_mode: "HTML" }); return; }
    const icon: Record<string, string> = { queued: "⏳", running: "🔄", completed: "✅", failed: "❌", cancelled: "🛑" };
    const lines = selected.map((job) => {
      const detail = job.status === "running" ? `Polling attempt ${job.pollCount}` : job.status === "failed" ? job.error ?? "Generation failed" : job.status === "completed" ? job.resultPath ? `Saved to ${job.resultPath}` : "Delivered" : "Waiting to start";
      return `${icon[job.status] ?? "•"} <b>${job.status}</b> — <code>${job.id}</code>\n${escapeTelegramHtml(job.prompt.slice(0, 160))}\n${escapeTelegramHtml(detail)}`;
    });
    await ctx.reply(`<b>Video jobs</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  // /agents ──────────────────────────────────────────────────────────────────
  bot.command("agents", async (ctx) => {
    if (!(await guard(ctx))) return;
    const records = await listHandoffRecords(ctx.from!.id);
    if (!records.length) { await ctx.reply("No worker delegations recorded yet."); return; }
    const icon: Record<string, string> = { success: "✅", failed: "❌", timed_out: "⏱️", max_tool_calls_exceeded: "🔢", requires_approval: "⚠️", requires_tool_request: "🧩", fallback_executed: "🔄", cancelled: "🛑" };
    const lines = records.slice(0, 10).map((r) => {
      const ago = Math.round((Date.now() - r.timestamp) / 60_000);
      return `${icon[r.status] ?? "•"} <b>${escapeTelegramHtml(String(r.to))}</b> — <code>${escapeTelegramHtml(r.id)}</code>\n<i>${escapeTelegramHtml(r.status)}</i> · ${ago}m ago\n${escapeTelegramHtml(r.objective.slice(0, 120))}`;
    });
    await replyHtml(ctx, `<b>Worker agents</b> (${records.length} total)\n\n${lines.join("\n\n")}`);
  });

  // /agent-status ─────────────────────────────────────────────────────────────
  bot.command("agent-status", async (ctx) => {
    if (!(await guard(ctx))) return;
    const handoffId = ctx.match?.trim();
    if (!handoffId) { await ctx.reply("Usage: /agent-status <handoff-id>"); return; }
    const records = await listHandoffRecords(ctx.from!.id);
    const record = records.find((r) => r.id === handoffId);
    if (!record) { await ctx.reply(`Handoff <code>${escapeTelegramHtml(handoffId)}</code> not found.`, { parse_mode: "HTML" }); return; }
    const icon: Record<string, string> = { success: "✅", failed: "❌", timed_out: "⏱️", max_tool_calls_exceeded: "🔢", requires_approval: "⚠️", requires_tool_request: "🧩", fallback_executed: "🔄", cancelled: "🛑" };
    const ago = Math.round((Date.now() - record.timestamp) / 60_000);
    let html = `🤖 <b>Worker: ${escapeTelegramHtml(String(record.to))}</b>\n`;
    html += `ID: <code>${escapeTelegramHtml(record.id)}</code>\n`;
    html += `Status: ${icon[record.status] ?? "•"} <b>${escapeTelegramHtml(record.status)}</b>\n`;
    if (record.taskId) html += `Task: <code>${escapeTelegramHtml(record.taskId)}</code>\n`;
    if (record.toolRequest) html += `Requested capability: <b>${escapeTelegramHtml(record.toolRequest.intent)}</b>\n`;
    html += `Started: ${ago}m ago\n\n`;
    html += `<b>Objective:</b>\n${escapeTelegramHtml(record.objective)}`;
    await replyHtml(ctx, html);
  });

  // /agent-cancel ─────────────────────────────────────────────────────────────
  bot.command("agent-cancel", async (ctx) => {
    if (!(await guard(ctx))) return;
    const handoffId = ctx.match?.trim();
    if (!handoffId) { await ctx.reply("Usage: /agent-cancel <handoff-id>"); return; }
    const records = await listHandoffRecords(ctx.from!.id);
    const record = records.find((r) => r.id === handoffId);
    if (!record) { await ctx.reply(`Handoff <code>${escapeTelegramHtml(handoffId)}</code> not found.`, { parse_mode: "HTML" }); return; }
    if (record.taskId) { await cancelTask(ctx.from!.id, record.taskId); }
    const updated = { ...record, status: "cancelled" as const };
    await saveHandoffRecord(ctx.from!.id, updated);
    await replyHtml(ctx, `✅ Worker <b>${escapeTelegramHtml(String(record.to))}</b> (<code>${escapeTelegramHtml(record.id)}</code>) has been cancelled.\n\n<i>Note: If the worker was mid-execution, it will finish its current turn but will not be retried.</i>`);
  });

  // /connect ─────────────────────────────────────────────────────────────────
  bot.command("connect", async (ctx) => {
    if (!(await guard(ctx))) return;
    const [toolkit, alias] = (ctx.match?.trim() ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!toolkit) {
      await replyHtml(ctx,
        `<b>Connect an app</b>\n\nUsage: <code>/connect gmail work-gmail</code>\n\n` +
        `Run the command again with a different alias to connect another account for the same app.\n\n` +
        `Or just tell Chusky what you need and he'll surface the connection link automatically.`
      );
      return;
    }

    const statusMsg = await ctx.reply(`🔗 Generating connection link for <b>${toolkit}</b>…`, { parse_mode: "HTML" });
    try {
      const url = await getConnectionUrl(ctx.from!.id, toolkit, alias);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `🔗 <b>Connect ${toolkit}${alias ? ` (${alias})` : ""}</b>\n\n` +
        `Click the link below to authorise Chusky to use your <b>${toolkit}</b> account:\n\n` +
        `<a href="${url}">→ Connect ${toolkit}</a>\n\n` +
        `${alias ? `Alias: <code>${escapeTelegramHtml(alias)}</code>\n\n` : ""}` +
        `<i>The link expires after a short time. Run the command again if needed.</i>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      );
    } catch (e) {
      logger.error({ err: e, toolkit }, "Failed to generate connection URL");
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `❌ Failed to generate connection link for <code>${toolkit}</code>.\n\n` +
        `Make sure the toolkit slug is correct. Try: <code>/apps</code> to see available apps.`,
        { parse_mode: "HTML" }
      );
    }
  });

  bot.command("accounts", async (ctx) => {
    if (!(await guard(ctx))) return;
    const toolkit = (ctx.match?.trim() ?? "").toLowerCase() || undefined;
    const status = await ctx.reply("🔌 Loading connected accounts…");
    try {
      const accounts = await listConnectedAccounts(ctx.from!.id, toolkit);
      const lines = accounts.map((account) => {
        const label = account.alias ? `${account.alias} <code>${account.id}</code>` : `<code>${account.id}</code>`;
        return `• <b>${escapeTelegramHtml(account.toolkit)}</b> — ${label} — ${escapeTelegramHtml(account.status)}`;
      });
      const body = lines.length
        ? `<b>Connected accounts${toolkit ? ` for ${escapeTelegramHtml(toolkit)}` : ""}</b>\n\n${lines.join("\n")}`
        : `No connected accounts${toolkit ? ` for ${escapeTelegramHtml(toolkit)}` : ""}.\n\nUse <code>/connect gmail work-gmail</code> to add one.`;
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, body, {
        parse_mode: "HTML",
        ...(accounts.length ? { reply_markup: new InlineKeyboard().text("Disconnect an account", "acct:disconnect:list") } : {}),
      });
    } catch (error) {
      logger.error({ err: error, userId: ctx.from!.id, toolkit }, "Failed to list Composio connected accounts");
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, `❌ Could not load connected accounts: ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" });
    }
  });

  // /disconnect — revoke a connected Composio account from Telegram. This is
  // deliberately a private, owner-checked flow; the agent does not need a
  // separate tool for the owner to manage access directly.
  bot.command("disconnect", async (ctx) => {
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) {
      await ctx.reply("For your security, manage connected app access in your private chat with Chusky.");
      return;
    }
    const target = (ctx.match?.trim() ?? "").toLowerCase();
    try {
      const accounts = await listConnectedAccounts(ctx.from!.id);
      const matches = target
        ? accounts.filter((account) => account.id.toLowerCase() === target || account.alias?.toLowerCase() === target || account.toolkit.toLowerCase() === target)
        : accounts;
      if (target && matches.length === 0) {
        await ctx.reply("That connected account was not found. Use /accounts to see the current account IDs and aliases.");
        return;
      }
      if (matches.length === 1) {
        const confirmation = disconnectConfirmation(matches[0]!);
        await ctx.reply(confirmation.text, { parse_mode: "HTML", reply_markup: confirmation.reply_markup });
        return;
      }
      await ctx.reply(disconnectAccountText(matches), {
        parse_mode: "HTML",
        ...(matches.length ? { reply_markup: disconnectAccountKeyboard(matches) } : {}),
      });
    } catch (error) {
      logger.error({ err: error, userId: ctx.from!.id }, "Failed to load accounts for disconnect");
      await ctx.reply("❌ I could not load your connected accounts right now. Try /disconnect again shortly.");
    }
  });

  bot.callbackQuery(/^acct:disconnect:(list|select|confirm|cancel)(?::([A-Za-z0-9_-]{1,200}))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) {
      await ctx.editMessageText("For your security, manage connected app access in your private chat with Chusky.");
      return;
    }
    const action = ctx.match[1];
    const accountId = ctx.match[2] ?? "";
    try {
      const accounts = await listConnectedAccounts(ctx.from!.id);
      if (action === "list") {
        await ctx.editMessageText(disconnectAccountText(accounts), {
          parse_mode: "HTML",
          ...(accounts.length ? { reply_markup: disconnectAccountKeyboard(accounts) } : {}),
        });
        return;
      }
      const account = accounts.find((item) => item.id === accountId);
      if (!account) {
        await ctx.editMessageText("That connected account is no longer available. Use /disconnect to refresh the list.");
        return;
      }
      if (action === "cancel") {
        await ctx.editMessageText("No connected account was disconnected.");
        return;
      }
      if (action === "select") {
        const confirmation = disconnectConfirmation(account);
        await ctx.editMessageText(confirmation.text, { parse_mode: "HTML", reply_markup: confirmation.reply_markup });
        return;
      }
      const removed = await disconnectConnectedAccount(ctx.from!.id, account.id);
      await ctx.editMessageText(removed
        ? `✅ Disconnected <b>${escapeTelegramHtml(account.toolkit)}${account.alias ? ` (${escapeTelegramHtml(account.alias)})` : ""}</b>.\n\nUse /connect to reconnect it later.`
        : "That connected account was already removed. Use /disconnect to refresh the list.", { parse_mode: "HTML" });
    } catch (error) {
      logger.error({ err: error, userId: ctx.from!.id, action, accountId }, "Telegram connected account disconnect failed");
      await ctx.editMessageText("❌ I could not disconnect that account. Use /disconnect to refresh the list.");
    }
  });

  // /apps ────────────────────────────────────────────────────────────────────
  bot.command("apps", async (ctx) => {
    if (!(await guard(ctx))) return;
    const statusMsg = await ctx.reply("🔌 Loading connected apps…");
    try {
      const states = await getToolkitStates(ctx.from!.id);
      const connected = states.filter((s) => s.connected);
      const page = Math.max(1, parseInt(ctx.match?.trim() || "1", 10) || 1);
      const allDisconnected = states.filter((s) => !s.connected);
      const disconnected = allDisconnected.slice((page - 1) * 15, page * 15);

      let html = `<b>App Connections</b>\n\n`;

      if (connected.length > 0) {
        html += `<b>✅ Connected (${connected.length})</b>\n`;
        html += connected.map((s) => `  • ${s.name} <code>${s.slug.toLowerCase()}</code>${s.accountCount && s.accountCount > 1 ? ` — ${s.accountCount} accounts (${s.aliases?.map((alias) => escapeTelegramHtml(alias)).join(", ")})` : ""}`).join("\n");
        html += "\n\n";
      } else {
        html += `<i>No apps connected yet.</i>\n\n`;
      }

      if (disconnected.length > 0) {
        html += `<b>Available to connect:</b>\n`;
        html += disconnected.map((s) => `  • ${s.name} — <code>/connect ${s.slug.toLowerCase()}</code>`).join("\n");
      }

      const pages = Math.max(1, Math.ceil(allDisconnected.length / 15));
      html += `\n\n<i>Page ${page}/${pages}. Use <code>/apps ${page < pages ? page + 1 : 1}</code> for another page.</i>`;

      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, html, { parse_mode: "HTML" });
    } catch (e) {
      logger.error({ err: e }, "Failed to list apps");
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `❌ Failed to load apps: ${String(e)}`
      );
    }
  });

  bot.command("triggers", async (ctx) => {
    if (!(await guard(ctx))) return;
    if (/^list$/i.test(String(ctx.match ?? "").trim())) {
      try {
        const triggers = await listTriggers(ctx.from!.id);
        await replyHtml(ctx, triggers.length
          ? `<b>Your Composio triggers</b>\n\n${triggers.map((trigger: any) => `• <code>${escapeTelegramHtml(String(trigger.id ?? trigger.trigger_id ?? "unknown"))}</code> · ${escapeTelegramHtml(String(trigger.trigger_slug ?? trigger.slug ?? "trigger"))} · ${escapeTelegramHtml(String(trigger.status ?? (trigger.enabled === false ? "disabled" : "active")))}`).join("\n")}`
          : "You have no Composio triggers yet.");
      } catch (error) { await ctx.reply(`❌ Could not load triggers: ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" }); }
      return;
    }
    await ctx.reply("<b>Composio triggers</b>\n\nChoose an action. Chusky only shows apps connected to your account, and asks which account to use when you have more than one.", { parse_mode: "HTML", reply_markup: triggerMenuKeyboard() });
  });

  bot.command("tools", async (ctx) => {
    if (!(await guard(ctx))) return;
    const raw = String(ctx.match ?? "").trim();
    const query = raw.replace(/^search(?:\s+|$)/i, "").trim();
    if (!query) { await ctx.reply("Usage: /tools search <what you want to do>"); return; }
    const status = await ctx.reply(`🔎 Searching Composio tools for: <b>${query.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</b>…`, { parse_mode: "HTML" });
    try {
      const tools = await searchTools(ctx.from!.id, query);
      const text = tools.slice(0, 10).map((t: any) => `${t.slug || t.name || "tool"}\n${t.description || ""}`).join("\n\n") || "No matching tools found.";
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, `<b>Tool results</b>\n\n<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`, { parse_mode: "HTML" });
    } catch (e) {
      logger.error({ err: e, userId: ctx.from!.id, query }, "Tool search failed");
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, `❌ Tool search failed: ${String(e).slice(0, 400)}`);
    }
  });

  bot.command("trigger", async (ctx) => {
    if (!(await guard(ctx))) return;
    const args = ctx.match?.trim() || "";
    const [action, idOrSlug, ...rest] = args.split(/\s+/);
    try {
      if (!action) {
        await ctx.reply("<b>Composio triggers</b>\n\nChoose an action.", { parse_mode: "HTML", reply_markup: triggerMenuKeyboard() });
        return;
      }
      if (action === "create" && idOrSlug) {
        const body = rest.length ? JSON.parse(rest.join(" ")) : {};
        const result = await createTrigger(ctx.from!.id, idOrSlug, body);
        await ctx.reply(`✅ Trigger created: ${JSON.stringify(result).slice(0, 800)}`);
      } else if ((action === "enable" || action === "disable") && idOrSlug) {
        await setTriggerState(ctx.from!.id, idOrSlug, action === "enable");
        await ctx.reply(`✅ Trigger ${action}d: ${idOrSlug}`);
      } else if (action === "delete" && idOrSlug) {
        await deleteTrigger(ctx.from!.id, idOrSlug);
        await ctx.reply(`✅ Trigger deleted: ${idOrSlug}`);
      } else {
        await ctx.reply("Usage: /triggers | /trigger create <slug> <json> | /trigger enable|disable|delete <id>");
      }
    } catch (e) { await ctx.reply(`❌ Trigger operation failed: ${String(e).slice(0, 500)}`); }
  });

  bot.callbackQuery(/^trg:menu$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    await ctx.editMessageText("<b>Composio triggers</b>\n\nChoose an action. Chusky only shows apps connected to your account.", { parse_mode: "HTML", reply_markup: triggerMenuKeyboard() });
  });

  bot.callbackQuery(/^trg:apps:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    try { await triggerToolkitView(ctx, Number(ctx.match[1])); }
    catch (error) { await ctx.editMessageText(`❌ Could not load trigger apps: ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML", reply_markup: triggerMenuKeyboard() }); }
  });

  bot.callbackQuery(/^trg:(?:types|typepage):([a-zA-Z0-9_-]{1,100}):(\d+)(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const toolkit = ctx.match[1];
    const toolkitPage = Number(ctx.match[2]);
    const page = ctx.match[3] ? Number(ctx.match[3]) : 0;
    try { await triggerTypeView(ctx, toolkit, toolkitPage, page); }
    catch (error) { await ctx.editMessageText(`❌ Could not load trigger types: ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("← Apps", `trg:apps:${toolkitPage}`) }); }
  });

  bot.callbackQuery(/^trg:type:([a-z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const token = ctx.match[1];
    const toolkitPage = Number(ctx.match[2]);
    try {
      const trigger = await getAvailableTriggerType(token);
      if (!trigger) { await ctx.editMessageText("That trigger menu expired. Open /triggers to refresh it.", { reply_markup: triggerMenuKeyboard() }); return; }
      const accounts = (await listConnectedAccounts(ctx.from!.id, trigger.toolkit.slug)).filter((account) => account.status.toUpperCase() === "ACTIVE");
      if (!accounts.length) { await ctx.editMessageText(`Connect ${escapeTelegramHtml(trigger.toolkit.name)} first, then reopen /triggers.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("← Apps", `trg:apps:${toolkitPage}`) }); return; }
      if (accounts.length > 1) {
        const keyboard = new InlineKeyboard();
        accounts.slice(0, 8).forEach((account, index) => keyboard.text((account.alias ?? `Account ${index + 1}`).slice(0, 50), `trg:account:${token}:${index}`).row());
        keyboard.text("← Triggers", `trg:types:${trigger.toolkit.slug}:${toolkitPage}`);
        await ctx.editMessageText(`<b>${escapeTelegramHtml(trigger.name)}</b>\n\nChoose the ${escapeTelegramHtml(trigger.toolkit.name)} account Chusky should watch.`, { parse_mode: "HTML", reply_markup: keyboard });
        return;
      }
      await showTriggerConfirmation(ctx, trigger, accounts[0].id, toolkitPage);
    } catch (error) { await ctx.editMessageText(`❌ Could not prepare this trigger: ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML", reply_markup: triggerMenuKeyboard() }); }
  });

  bot.callbackQuery(/^trg:account:([a-z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const trigger = await getAvailableTriggerType(ctx.match[1]);
    if (!trigger) { await ctx.editMessageText("That trigger menu expired. Open /triggers to refresh it.", { reply_markup: triggerMenuKeyboard() }); return; }
    const accounts = (await listConnectedAccounts(ctx.from!.id, trigger.toolkit.slug)).filter((account) => account.status.toUpperCase() === "ACTIVE");
    const account = accounts[Number(ctx.match[2])];
    if (!account) { await ctx.editMessageText("That account is no longer available. Open /triggers to refresh it.", { reply_markup: triggerMenuKeyboard() }); return; }
    await showTriggerConfirmation(ctx, trigger, account.id, 0);
  });

  bot.callbackQuery(/^trg:create:([a-z0-9]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Creating trigger…" });
    if (!(await guard(ctx))) return;
    const trigger = await getAvailableTriggerType(ctx.match[1]);
    if (!trigger) { await ctx.editMessageText("That trigger menu expired. Open /triggers to refresh it.", { reply_markup: triggerMenuKeyboard() }); return; }
    const accounts = (await listConnectedAccounts(ctx.from!.id, trigger.toolkit.slug)).filter((account) => account.status.toUpperCase() === "ACTIVE");
    const account = accounts[Number(ctx.match[2])];
    if (!account) { await ctx.editMessageText("That account is no longer available. Open /triggers to refresh it.", { reply_markup: triggerMenuKeyboard() }); return; }
    try {
      const result: any = await createTrigger(ctx.from!.id, trigger.slug, { connectedAccountId: account.id, triggerConfig: {} });
      const id = String(result?.triggerId ?? result?.id ?? "created");
      await ctx.editMessageText(`✅ <b>Trigger created</b>\n\n${escapeTelegramHtml(trigger.name)} is now watching ${escapeTelegramHtml(trigger.toolkit.name)}.\n\n<code>${escapeTelegramHtml(id)}</code>`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("📋 My triggers", "trg:my").row().text("➕ Add another", "trg:apps:0") });
    } catch (error) { await ctx.editMessageText(`❌ Could not create this trigger: ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML", reply_markup: triggerMenuKeyboard() }); }
  });

  bot.callbackQuery(/^trg:my$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    try {
      const triggers = await listTriggers(ctx.from!.id);
      const entries = triggers.slice(0, 20).map((item: any) => `• ${escapeTelegramHtml(String(item.triggerName ?? item.trigger_slug ?? item.slug ?? "trigger"))} — ${escapeTelegramHtml(String(item.disabledAt || item.enabled === false ? "disabled" : "active"))}`);
      await ctx.editMessageText(`<b>My triggers</b>\n\n${entries.length ? entries.join("\n") : "No triggers yet."}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("➕ Add a trigger", "trg:apps:0").row().text("← Triggers", "trg:menu") });
    } catch (error) { await ctx.editMessageText(`❌ Could not load triggers: ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML", reply_markup: triggerMenuKeyboard() }); }
  });

  bot.callbackQuery(/^trg:help$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    await ctx.editMessageText("<b>How triggers work</b>\n\n1. Connect an app with <code>/connect &lt;app&gt;</code>.\n2. Choose an event.\n3. Chusky receives the event through the verified Composio webhook.\n\nSome events need filters (for example, a repository or mailbox). Chusky will show the required fields before it creates one.", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("➕ Add a trigger", "trg:apps:0").row().text("← Triggers", "trg:menu") });
  });

  bot.callbackQuery(/^trg:noop$/, async (ctx) => { await ctx.answerCallbackQuery(); });

  // /info ────────────────────────────────────────────────────────────────────
  bot.command("info", async (ctx) => {
    if (!(await guard(ctx))) return;
    const uid = ctx.from!.id;
    const s = await getSession(uid);
    const turns = Math.floor(s.history.length / 2);
    const age = Math.floor((Date.now() - s.createdAt) / 60000);
    await replyHtml(ctx,
      `<b>Chusky Session Info</b>\n\n` +
      `👤 User ID: <code>${uid}</code>\n` +
      `🤖 Model: <code>${s.model}</code>\n` +
      `💬 History: <b>${turns}</b>/${config.maxHistory} turns\n` +
      `📨 Total messages: <b>${s.totalMessages}</b>\n` +
      `⏱ Age: <b>${age}m</b>\n` +
      `🔧 Max tool rounds: <b>${config.maxToolRounds}</b>\n` +
      `🚦 Rate limit: <b>${config.rateLimit}</b>/${config.rateWindowSeconds}s\n` +
      `🧰 Composio session: <code>${s.composioSessionId ?? "pending"}</code>`
    );
  });

  // /usage ───────────────────────────────────────────────────────────────────
  bot.command("usage", async (ctx) => {
    if (!(await guard(ctx))) return;
    const s = await getSession(ctx.from!.id);
    await replyHtml(ctx,
      `<b>Your Usage</b>\n\n` +
      `📨 Messages sent: <b>${s.totalMessages}</b>\n` +
      `💳 Estimated cost: <b>$${(s.totalCost ?? 0).toFixed(5)}</b>\n` +
      `💬 Context turns: <b>${Math.floor(s.history.length / 2)}</b>/${config.maxHistory}\n` +
      `🤖 Model: <code>${s.model}</code>`
    );
  });

  // /clear ───────────────────────────────────────────────────────────────────
  bot.command("clear", async (ctx) => {
    if (!(await guard(ctx))) return;
    const action = ctx.match?.trim().toLowerCase();
    if (action === "group") {
      if (!isTelegramShared(ctx)) {
        await ctx.reply("/clear group can only be used inside a Telegram group.");
        return;
      }
      if (!(await isTelegramGroupAdmin(ctx))) {
        await ctx.reply("Only a Telegram group administrator can clear this group's history.");
        return;
      }
      await clearChannelConversationHistory({
        id: telegramConversationId(ctx), accountId: `account_${ctx.from!.id}`, userId: ctx.from!.id,
        provider: "telegram", scope: "shared",
      });
      await ctx.reply("🗑 This group's Chusky history has been cleared. I will treat the next message as a fresh start.");
    } else if (action === "history") {
      await clearHistory(ctx.from!.id);
      await ctx.reply("🗑 History cleared. Your Composio session was kept.");
    } else if (action === "session") {
      invalidateSession(ctx.from!.id);
      await clearSession(ctx.from!.id);
      await ctx.reply("🗑 Session and history cleared. Fresh start — what's next?");
    } else {
      await ctx.reply("Usage: /clear history, /clear session, or /clear group (inside a group)");
    }
  });

  // /export ──────────────────────────────────────────────────────────────────
  bot.command("export", async (ctx) => {
    if (!(await guard(ctx))) return;
    const uid = ctx.from!.id;
    const s = await getSession(uid);
    if (s.history.length === 0) {
      await ctx.reply("Nothing to export yet — start a conversation first.");
      return;
    }
    const lines = [
      `Chusky AI Agent`,
      `Model: ${s.model}`,
      `Exported: ${new Date().toISOString()}`,
      `Turns: ${Math.floor(s.history.length / 2)}`,
      "─".repeat(50),
      "",
    ];
    for (const m of s.history) {
      lines.push(`[${m.role === "user" ? "You" : "Chusky"}]`);
      lines.push(m.content);
      lines.push("");
    }
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(lines.join("\n"), "utf-8"), `chusky-${uid}-${Date.now()}.txt`),
      { caption: `📄 Conversation export — ${Math.floor(s.history.length / 2)} turns` }
    );
  });

  // /model ───────────────────────────────────────────────────────────────────
  bot.command("model", async (ctx) => {
    if (!(await guard(ctx))) return;
    const model = await getModel(ctx.from!.id);
    await ctx.reply(
      `Active model: <code>${model}</code>\n\nChoose a provider:`,
      { parse_mode: "HTML", reply_markup: modelProviderKeyboard() }
    );
  });

  bot.callbackQuery(/^api:menu$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.editMessageText("For your security, create API keys in a private chat with Chusky."); return; }
    await ctx.editMessageText("<b>Chusky API keys</b>\n\nChoose a key type. Full access covers all public project API endpoints. App embed is limited to agent runs, tasks, tools, skills, and files.", { parse_mode: "HTML", reply_markup: apiKeyMenuKeyboard() });
  });

  bot.callbackQuery(/^api:new:(full|embed)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Creating your API key…" });
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.editMessageText("For your security, create API keys in a private chat with Chusky."); return; }
    const mode = ctx.match[1];
    try {
      const project = await createTelegramProject(
        ctx.from!.id,
        mode === "full" ? `Telegram project ${new Date().toISOString().slice(0, 10)}` : `Telegram app embed ${new Date().toISOString().slice(0, 10)}`,
        mode === "full" ? ["*"] : TELEGRAM_API_EMBED_SCOPES,
      );
      await ctx.editMessageText(apiKeyDelivery(project), { parse_mode: "HTML", reply_markup: apiKeyMenuKeyboard() });
    } catch (error) {
      await ctx.editMessageText(`❌ ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML", reply_markup: apiKeyMenuKeyboard() });
    }
  });

  bot.callbackQuery(/^api:list$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.editMessageText("For your security, manage API keys in a private chat with Chusky."); return; }
    const projects = await listTelegramProjects(ctx.from!.id);
    await ctx.editMessageText(projects.length
      ? `<b>Your API keys</b>\n\n${projects.map((project) => `• <b>${escapeTelegramHtml(project.name)}</b>\n<code>${escapeTelegramHtml(project.keyPrefix)}…</code> · ${escapeTelegramHtml(project.scopes.join(", "))}`).join("\n\n")}\n\nRotate replaces a key immediately. Revoke permanently disables it.`
      : "<b>Your API keys</b>\n\nYou have no active API keys yet.", { parse_mode: "HTML", reply_markup: projects.length ? apiKeyProjectKeyboard(projects) : apiKeyMenuKeyboard() });
  });

  bot.callbackQuery(/^api:rotate:(proj_[0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Rotating API key…" });
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.editMessageText("For your security, manage API keys in a private chat with Chusky."); return; }
    try {
      const project = await rotateTelegramProjectKey(ctx.from!.id, ctx.match[1]);
      await ctx.editMessageText(apiKeyDelivery(project, true), { parse_mode: "HTML", reply_markup: apiKeyMenuKeyboard() });
    } catch (error) {
      await ctx.editMessageText(`❌ ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML", reply_markup: apiKeyMenuKeyboard() });
    }
  });

  bot.callbackQuery(/^api:revoke:(proj_[0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.editMessageText("For your security, manage API keys in a private chat with Chusky."); return; }
    const project = (await listTelegramProjects(ctx.from!.id)).find((item) => item.id === ctx.match[1]);
    if (!project) { await ctx.editMessageText("That API key is no longer active.", { reply_markup: apiKeyMenuKeyboard() }); return; }
    await ctx.editMessageText(`<b>Revoke ${escapeTelegramHtml(project.name)}?</b>\n\nThis disables <code>${escapeTelegramHtml(project.keyPrefix)}…</code> immediately. Existing apps using it will stop working.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🗑 Revoke permanently", `api:revoke-confirm:${project.id}`).text("Cancel", "api:list") });
  });

  bot.callbackQuery(/^api:revoke-confirm:(proj_[0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Revoking API key…" });
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.editMessageText("For your security, manage API keys in a private chat with Chusky."); return; }
    const revoked = await revokeTelegramProject(ctx.from!.id, ctx.match[1]);
    await ctx.editMessageText(revoked ? "✅ API key revoked. Requests using it are now rejected." : "That API key is no longer active.", { reply_markup: apiKeyMenuKeyboard() });
  });

  bot.callbackQuery(/^api:help$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.editMessageText("For your security, create API keys in a private chat with Chusky."); return; }
    const baseUrl = (config.webhookUrl || config.dashboardUrl || "https://your-chusky-host").replace(/\/+$/, "");
    await ctx.editMessageText(`<b>Embed Chusky</b>\n\n1. Create a key here.\n2. Keep it in your server environment, never in frontend code.\n3. Send <code>Authorization: Bearer chsk_…</code> and <code>X-Chusky-User-Id: your-user-id</code> to <code>${escapeTelegramHtml(baseUrl)}/v1</code>.\n\nUse a stable ID from your own product for each customer. Chusky keeps each project/user combination isolated.`, { parse_mode: "HTML", reply_markup: apiKeyMenuKeyboard() });
  });

  bot.callbackQuery(/^mpv:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const provider = ctx.match[1];
    if (provider === "__back") {
      const model = await getModel(ctx.from!.id);
      await ctx.editMessageText(
        `Active model: <code>${model}</code>\n\nChoose a provider:`,
        { parse_mode: "HTML", reply_markup: modelProviderKeyboard() }
      );
      return;
    }
    if (!isModelProvider(provider)) return;
    const msg = await ctx.reply("⏳ Fetching models…");
    try {
      const all = await fetchModels();
      const filtered = modelsForProvider(all, provider);
      if (!filtered.length) {
        await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `No models found for: <code>${escapeTelegramHtml(MODEL_PROVIDER_LABELS[provider])}</code>`, { parse_mode: "HTML" });
        return;
      }
      const page = 0;
      const pageCount = Math.ceil(filtered.length / MODEL_PAGE_SIZE);
      await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `<b>Select model</b>\n${escapeTelegramHtml(MODEL_PROVIDER_LABELS[provider])} · ${filtered.length} available · page 1/${pageCount}\nChoose a model:`, { parse_mode: "HTML", reply_markup: modelListKeyboard(filtered, provider, page) });
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `❌ ${String(e)}`);
    }
  });

  bot.callbackQuery(/^mpg:(.+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const provider = ctx.match[1];
    const page = Number(ctx.match[2]);
    if (!isModelProvider(provider) || !Number.isSafeInteger(page) || page < 0) return;
    try {
      const filtered = modelsForProvider(await fetchModels(), provider);
      const pageCount = Math.max(1, Math.ceil(filtered.length / MODEL_PAGE_SIZE));
      const safePage = Math.min(page, pageCount - 1);
      await ctx.editMessageText(`<b>Select model</b>\n${escapeTelegramHtml(MODEL_PROVIDER_LABELS[provider])} · ${filtered.length} available · page ${safePage + 1}/${pageCount}\nChoose a model:`, { parse_mode: "HTML", reply_markup: modelListKeyboard(filtered, provider, safePage) });
    } catch (e) {
      await ctx.editMessageText(`❌ Could not load models: ${escapeTelegramHtml(String(e))}`, { parse_mode: "HTML" });
    }
  });

  bot.callbackQuery(/^mpg:noop$/, async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^msel:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const modelId = ctx.match[1];
    await setModel(ctx.from.id, modelId);
    await ctx.editMessageText(
      `✅ <b>Model switched to:</b>\n<code>${modelId}</code>\n\n<i>Your history and Composio session were kept.</i>`,
      { parse_mode: "HTML" }
    );
  });

  const handleChannelLinkCallback = async (ctx: Context, kind: "p" | "g" | "t" | "cli", target: string, ownerId: number): Promise<void> => {
    if (ctx.from?.id !== ownerId) {
      await ctx.answerCallbackQuery({ text: "This channel menu belongs to another user.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    try {
      if (kind === "t") {
        await ctx.editMessageText("✅ You are already using Telegram. Choose another channel if you want to link an external account.", { reply_markup: channelLinkKeyboard(ownerId) });
        return;
      }
      if (kind === "cli") {
        await sendCliLink(ctx);
        return;
      }
      if (kind === "p" && (target === "slack" || target === "whatsapp" || target === "sendblue" || target === "sms" || target === "xchat")) {
        await sendPrivateChannelLink(ctx, target);
        return;
      }
      if (kind === "g" && target === "sendblue") {
        await sendGroupChannelLink(ctx);
        return;
      }
      await ctx.editMessageText("That channel option is no longer available. Use /channel to open a fresh menu.");
    } catch (error) {
      await ctx.editMessageText(`❌ ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" });
    }
  };

  // External providers and group links include a target segment. Telegram
  // and CLI are direct channel actions and intentionally carry only the owner
  // ID: chlink:t:<userId> and chlink:cli:<userId>.
  bot.callbackQuery(/^chlink:(p|g):([a-z-]+):(\d+)$/, async (ctx) => {
    await handleChannelLinkCallback(ctx, ctx.match[1] as "p" | "g", ctx.match[2], Number(ctx.match[3]));
  });

  bot.callbackQuery(/^chlink:(t|cli):(\d+)$/, async (ctx) => {
    await handleChannelLinkCallback(ctx, ctx.match[1] as "t" | "cli", ctx.match[1] === "cli" ? "cli" : "telegram", Number(ctx.match[2]));
  });

  // Workspace card actions. They deliberately reuse the existing command
  // handlers' data sources instead of creating a second session model.
  bot.callbackQuery(/^home:(refresh|apps|triggers|approvals|reminders|schedules|tasks|missions|voice|meetings|mcp)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const action = ctx.match[1];
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) return;
    try {
      if (action === "refresh") {
        await showWorkspace(ctx, messageId);
        return;
      }
      if (action === "triggers") {
        await ctx.editMessageText("<b>Composio triggers</b>\n\nChoose an action. Chusky only shows apps connected to your account, and asks which account to use when you have more than one.", { parse_mode: "HTML", reply_markup: triggerMenuKeyboard() });
        return;
      }
      if (action === "apps") {
        const states = await getToolkitStates(ctx.from!.id);
        const connected = states.filter((state) => state.connected);
        const card: TelegramCard = {
          title: "🧩 Connected apps",
          body: connected.length
            ? connected.slice(0, 8).map((state) => `🟢 ${state.name} · ${state.accountCount ?? 1} account${(state.accountCount ?? 1) === 1 ? "" : "s"}`)
            : ["No apps are connected yet."],
          detail: connected.length > 8 ? `${connected.length - 8} more connected app${connected.length - 8 === 1 ? "" : "s"}. Use /apps for the full list.` : "Use /connect gmail work-gmail to add another account safely.",
          buttons: [[{ text: "← Workspace", callbackData: "home:refresh" }, { text: "⚡ Triggers", callbackData: "home:triggers" }]],
        };
        await editCard(ctx, messageId, card);
        return;
      }
      if (action === "reminders") {
        const reminders = (await listReminders(ctx.from!.id)).filter((reminder) => reminder.status === "scheduled" || reminder.status === "waiting").sort((a, b) => a.runAt - b.runAt);
        const card: TelegramCard = {
          title: "⏰ Upcoming reminders",
          body: reminders.length
            ? reminders.slice(0, 8).map((reminder) => `${reminder.status === "waiting" ? "Waiting" : new Date(reminder.runAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · ${reminder.text}`)
            : ["No reminders are scheduled."],
          detail: reminders.length ? "Ask Chusky to change or cancel a reminder, for example: “remind me tomorrow at 9am to follow up with Sam.”" : "Ask Chusky to set one, for example: “remind me tomorrow at 9am to follow up with Sam.”",
          buttons: [[{ text: "← Workspace", callbackData: "home:refresh" }]],
        };
        await editCard(ctx, messageId, card);
        return;
      }
      if (action === "schedules") {
        const jobs = (await listJobs(ctx.from!.id)).filter((job) => job.status === "active");
        const card: TelegramCard = {
          title: "🗓️ Recurring schedules",
          body: jobs.length
            ? jobs.slice(0, 8).map((job) => `${job.text} · ${job.cron}`)
            : ["No recurring schedules are active."],
          detail: jobs.length ? "Ask Chusky to adjust or cancel a schedule. Recurring work is stored durably and delivered to your private Chusky account." : "Ask Chusky to create one, for example: “every weekday at 8am, summarize my priorities.”",
          buttons: [[{ text: "← Workspace", callbackData: "home:refresh" }]],
        };
        await editCard(ctx, messageId, card);
        return;
      }
      if (action === "tasks") {
        const tasks = (await listTasks(ctx.from!.id)).filter((task) => !["completed", "cancelled"].includes(task.status));
        const card: TelegramCard = {
          title: "📋 Active tasks",
          body: tasks.length
            ? tasks.slice(0, 8).map((task) => `${task.status.replaceAll("_", " ")} · ${task.title}`)
            : ["No active tasks."],
          detail: tasks.length ? "Ask Chusky for progress, a retry, a new schedule, or cancellation for a task." : "When work needs to continue beyond this chat, ask Chusky to create a task and it will track the progress here.",
          buttons: [[{ text: "← Workspace", callbackData: "home:refresh" }]],
        };
        await editCard(ctx, messageId, card);
        return;
      }
      if (action === "missions") {
        if (isTelegramShared(ctx)) { await ctx.editMessageText("Mission details are available only in your private chat with Chusky."); return; }
        const missions = await listMissions(ctx.from!.id);
        const visible = missions.slice(0, 12);
        const body = visible.length
          ? visible.map((mission) => {
              const status = mission.status.replaceAll("_", " ");
              const detail = mission.nextAction ?? mission.checkpoint ?? mission.error ?? "No checkpoint yet.";
              return `${status} · ${mission.id}\n${mission.title}\n${detail}`;
            })
          : ["No autonomous missions yet.", "Ask Chusky to start work that should continue across time, survive waits, or be resumed later."];
        const commandHelp = [
          "Mission commands",
          "/missions — list missions",
          "/missions pause <mission-id>",
          "/missions resume <mission-id>",
          "/missions cancel <mission-id>",
        ].join("\n");
        await editCard(ctx, messageId, {
          title: "🚀 Autonomous missions",
          body,
          detail: `${commandHelp}\n\nMission actions are private to your Chusky account. The list above is read from the durable mission store.`,
          buttons: [[{ text: "🔄 Refresh missions", callbackData: "home:missions" }, { text: "← Workspace", callbackData: "home:refresh" }]],
        });
        return;
      }
      if (action === "meetings") {
        if (isTelegramShared(ctx)) { await ctx.editMessageText("Meeting details are available only in your private chat with Chusky."); return; }
        const [meetings, preparations, contacts] = await Promise.all([
          listRecallMeetings(ctx.from!.id, 20),
          listCalendarMeetingPreparations(ctx.from!.id, 20),
          listMeetingContacts(ctx.from!.id, 50),
        ]);
        const active = meetings.filter((meeting) => ["creating", "scheduled", "joining", "waiting_room", "in_call", "leaving"].includes(meeting.status));
        const prepared = preparations.filter((item) => ["prepared", "auto_scheduled"].includes(item.status));
        const body = [
          active.length ? `Live / scheduled\n${active.slice(0, 8).map((meeting) => `${meeting.status} · ${meeting.platform} · ${meeting.title || "Untitled"}${meeting.participantRoster?.length ? ` · ${meeting.participantRoster.filter((person) => person.status !== "left").map((person) => person.name).filter(Boolean).slice(0, 5).join(", ")}` : ""}`).join("\n")}` : "No live or scheduled meetings.",
          prepared.length ? `Prepared calendar events\n${prepared.slice(0, 8).map((item) => `${item.id} · ${item.title || "Untitled"} · ${item.startAt ? new Date(item.startAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "time not supplied"}`).join("\n")}` : "No prepared calendar events.",
          `Captured follow-up contacts: ${contacts.length}`,
        ];
        const buttons: NonNullable<TelegramCard["buttons"]> = [];
        for (const preparation of prepared.slice(0, 6)) buttons.push([{ text: `Join ${preparation.title || preparation.id}`.slice(0, 54), callbackData: `meet:join-prepared:${preparation.id}`, style: "primary" }]);
        for (const meeting of active.filter((item) => item.status !== "ended").slice(0, 4)) buttons.push([{ text: `Leave ${meeting.title || meeting.id}`.slice(0, 54), callbackData: `meet:leave:${meeting.id}`, style: "danger" }]);
        buttons.push([{ text: "Open full meeting list", callbackData: "meet:open" }, { text: "← Workspace", callbackData: "home:refresh" }]);
        await editCard(ctx, messageId, { title: "🤝 Meetings", body, detail: "Participant rosters are live meeting context. Calendar preparation metadata is safe and link-free; use /meeting for briefs, direct joins, context lookup, and contact review.", buttons });
        return;
      }
      if (action === "voice") {
        await editVoiceSettings(ctx, messageId);
        return;
      }
      if (action === "mcp") {
        await showMcpWorkspace(ctx, messageId);
        return;
      }
      const pending = (await listApprovals(ctx.from!.id, 50)).filter((approval) => approval.status === "pending" && approval.expiresAt > Date.now()).slice(0, 8);
      const card: TelegramCard = {
        title: "✅ Pending approvals",
        body: pending.length ? pending.map((approval) => `⚠️ ${approval.toolSlug}`) : ["Nothing is waiting for approval."],
        detail: pending.length ? "Choose an approval below to review it privately." : "Chusky will surface a review card whenever an action needs your confirmation.",
        buttons: pending.length
          ? [...pending.map((approval) => [{ text: `Review ${approval.toolSlug}`.slice(0, 54), callbackData: `appr:review:${approval.id}`, style: "primary" as const }]), [{ text: "← Workspace", callbackData: "home:refresh" }]]
          : [[{ text: "← Workspace", callbackData: "home:refresh" }]],
      };
      await editCard(ctx, messageId, card);
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from!.id, action }, "Telegram workspace action failed");
      await ctx.editMessageText("❌ I could not load that workspace view. Use /home to try again.");
    }
  });

  bot.callbackQuery(/^home:pulse:toggle$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Updating attention pulse…" });
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) {
      await ctx.editMessageText("Attention pulse is available only in your private chat with Chusky.");
      return;
    }
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) return;
    let active = false;
    try {
      active = (await listJobs(ctx.from!.id)).some((job) => job.kind === "attention_pulse" && job.status === "active");
      await nativeTool(ctx.from!.id, "CHUCK_ATTENTION_PULSE", { action: active ? "disable" : "enable" }, {
        deliveryTarget: { provider: "telegram", conversationId: String(ctx.chat?.id ?? ctx.from!.id) },
      });
      await showWorkspace(ctx, messageId);
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from!.id }, "Telegram attention pulse toggle failed");
      const detail = error instanceof Error ? error.message : "Please try again.";
      await ctx.editMessageText(`❌ I could not ${active ? "disable" : "enable"} the attention pulse. ${detail}`.slice(0, 3900));
    }
  });

  bot.callbackQuery(/^home:mcp:(r|c|d|s)(?::([A-Za-z0-9_-]{1,48}))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.editMessageText("MCP connections are available only in your private chat with Chusky."); return; }
    const action = ctx.match[1];
    const serverId = ctx.match[2] ?? "";
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) return;
    try {
      if (action === "r") {
        await showMcpWorkspace(ctx, messageId);
        return;
      }
      const server = listMcpCatalog().servers.find((entry) => entry.id === serverId);
      if (!server) throw new Error("That MCP server is no longer available");
      if (action === "s") {
        await showMcpWorkspace(ctx, messageId);
        return;
      }
      if (server.enabled === false) throw new Error("That MCP server is no longer available");
      if (action === "d") {
        const removed = await disconnectMcpServer(ctx.from!.id, serverId);
        if (!removed) throw new Error("That MCP server is not connected to your account");
        await showMcpWorkspace(ctx, messageId);
        return;
      }
      if (server.auth !== "none") {
        const authMethod = server.auth === "oauth" ? "OAuth" : "an access token";
        await ctx.editMessageText(
          `<b>${escapeTelegramHtml(server.name)}</b> needs ${authMethod}.\n\n` +
          "For your security, do not send credentials in Telegram. Complete the connection through the authenticated Chusky dashboard/API, then return here and tap Refresh status.",
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Refresh status", "home:mcp:r").text("← MCP servers", "home:mcp") },
        );
        return;
      }
      await connectMcpServer(ctx.from!.id, serverId);
      await showMcpWorkspace(ctx, messageId);
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from!.id, action, serverId }, "Telegram MCP action failed");
      await ctx.editMessageText(`❌ ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("← MCP servers", "home:mcp"),
      });
    }
  });

  bot.callbackQuery(/^meet:(open|join-prepared|leave)(?::([A-Za-z0-9_-]+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    if (isTelegramShared(ctx)) { await ctx.editMessageText("Meeting details are available only in your private chat with Chusky."); return; }
    const action = ctx.match[1];
    const id = ctx.match[2] ?? "";
    try {
      if (action === "open") {
        await ctx.editMessageText("Use /meetings to view live participants, meeting outcomes, prepared calendar events, and captured follow-up contacts.");
        return;
      }
      if (action === "join-prepared") {
        if (!/^cmp_[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error("Invalid calendar preparation ID");
        if (!(await checkRateLimit(ctx.from!.id))) throw new Error("Please wait a moment before starting another meeting action");
        const result = await withTelegramUserLock(ctx.from!.id, (signal) => joinPreparedCalendarMeeting(ctx.from!.id, id, signal));
        await ctx.editMessageText(`✅ Prepared calendar meeting join started${(result as any).id ? `: ${(result as any).id}` : "."}`);
        return;
      }
      if (!/^mtg_[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid meeting ID");
      const result = await withTelegramUserLock(ctx.from!.id, (signal) => leaveRecallMeeting(ctx.from!.id, id, signal));
      await ctx.editMessageText(`✅ Meeting leave requested${(result as any).id ? ` for ${(result as any).id}` : "."}`);
    } catch (error) {
      await ctx.editMessageText(`❌ ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" });
    }
  });

  // Read-only collection commands keep Telegram at parity with the CLI while
  // leaving writes to the normal agent/tool path. These are private because
  // memories, scratchpad notes, history, and approvals can be sensitive.
  for (const command of ["history", "memory", "scratchpad", "reminders", "jobs", "tasks", "missions", "approvals"] as const) {
    bot.command(command, async (ctx) => {
      if (!(await guard(ctx))) return;
      if (isTelegramShared(ctx)) { await ctx.reply(`For privacy, /${command} is available only in your private chat with Chusky.`); return; }
        const uid = ctx.from!.id;
        try {
        if (command === "missions") {
          const [action, missionId] = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
          if (action && ["pause", "resume", "cancel"].includes(action) && missionId) {
            let resumedApprovalWait = false;
            let updated: Awaited<ReturnType<typeof getMission>>;
            if (action === "pause") updated = await pauseMission(uid, missionId, "Mission paused from Telegram.");
            else if (action === "cancel") updated = await cancelMission(uid, missionId, "Mission cancelled from Telegram.");
            else {
              const current = await getMission(uid, missionId);
              if (current?.status === "waiting" && current.waiting?.kind === "approval" && current.waiting.key) {
                const resumed = await resumeMissionTaskAfterApproval(uid, current.waiting.key);
                if (resumed.status === "resumed" || resumed.status === "already_queued") {
                  updated = resumed.mission;
                  resumedApprovalWait = true;
                } else {
                  const message = resumed.status === "enqueue_failed"
                    ? "Approval is recorded, but the mission task could not be queued. Its checkpoint is preserved; retry when workflow service is available."
                    : resumed.status === "task_running"
                      ? "The approved mission task is already running. Check its status after the current worker settles."
                      : "That approval no longer matches a resumable task. Inspect the mission state before retrying.";
                  await replyHtml(ctx, escapeTelegramHtml(message));
                  return;
                }
              } else updated = await resumeMission(uid, missionId);
            }
            if (!updated) { await replyHtml(ctx, `Could not ${action} that mission. Check <code>/missions</code> for its current state.`); return; }
            if (action === "pause" || action === "cancel") { if (updated.rootTaskId) await cancelTask(uid, updated.rootTaskId); }
            if (action === "resume" && !resumedApprovalWait && updated.rootTaskId) {
              const task = await retryTask(uid, updated.rootTaskId);
              if (task) await enqueueTaskWithClaim(uid, task.id, task.runAt ?? Date.now());
            }
            await replyHtml(ctx, `<b>Mission ${escapeTelegramHtml(action)}d</b>\n\n<code>${escapeTelegramHtml(updated.id)}</code> · ${escapeTelegramHtml(updated.status)}\n${escapeTelegramHtml(updated.nextAction ?? updated.error ?? "State updated.")}`);
            return;
          }
          const missions = await listMissions(uid);
          const missionList = missions.length
            ? `<b>Autonomous missions</b>\n\n${missions.slice(0, 20).map((mission) => `• <code>${escapeTelegramHtml(mission.id)}</code> · <b>${escapeTelegramHtml(mission.status)}</b>\n  ${escapeTelegramHtml(mission.title)}\n  ${escapeTelegramHtml(mission.nextAction ?? mission.checkpoint ?? "No checkpoint yet.")}`).join("\n")}`
            : "No autonomous missions yet. Ask Chusky to start one for work that should continue across time.";
          await replyHtml(ctx, `${missionList}\n\n<b>Commands</b>\n<code>/missions pause &lt;mission-id&gt;</code>\n<code>/missions resume &lt;mission-id&gt;</code>\n<code>/missions cancel &lt;mission-id&gt;</code>`);
          return;
        }
        if (command === "history") {
          const history = (await getSession(uid)).history.slice(-20);
          await replyHtml(ctx, history.length ? `<b>Recent history</b>\n\n${history.map((message) => `${message.role === "assistant" ? "Chusky" : "You"}: ${escapeTelegramHtml(message.content)}`).join("\n\n")}` : "Your private history is empty.");
          return;
        }
        if (command === "memory") {
          const memories = await searchMemories(uid, String(ctx.match ?? "").trim() || undefined, { limit: 30 });
          await replyHtml(ctx, memories.length ? `<b>Saved memories</b>\n\n${memories.map((memory) => `• <b>${escapeTelegramHtml(memory.key)}</b> · ${escapeTelegramHtml(memory.category)}\n  ${escapeTelegramHtml(memory.value)}`).join("\n")}` : "No matching saved memories.");
          return;
        }
        if (command === "scratchpad") {
          const entries = await readScratchpad(uid, String(ctx.match ?? "").trim() || undefined);
          const lines = Object.entries(entries).map(([key, entry]) => `• <b>${escapeTelegramHtml(key)}</b>\n  ${escapeTelegramHtml(entry.content)}`);
          await replyHtml(ctx, lines.length ? `<b>Scratchpad</b>\n\n${lines.join("\n")}` : "Your scratchpad is empty.");
          return;
        }
        if (command === "reminders") {
          const [action, reminderId] = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
          if (action && ["pause", "resume", "run", "cancel"].includes(action) && reminderId) {
            const slug = action === "pause" ? "CHUCK_PAUSE_REMINDER" : action === "resume" ? "CHUCK_RESUME_REMINDER" : action === "run" ? "CHUCK_RUN_REMINDER_NOW" : "CHUCK_CANCEL_REMINDER";
            validateNativeToolArguments(slug as any, { id: reminderId });
            const result = await nativeTool(uid, slug, { id: reminderId });
            await replyHtml(ctx, `<b>Reminder ${escapeTelegramHtml(action === "run" ? "started" : `${action}d`)}</b>\n\n${escapeTelegramHtml(typeof result === "string" ? result : JSON.stringify(result))}`);
            return;
          }
          const reminders = await listReminders(uid);
          await replyHtml(ctx, reminders.length ? `<b>Upcoming reminders</b>\n\n${reminders.map((reminder) => `• <code>${escapeTelegramHtml(reminder.id)}</code> · <b>${escapeTelegramHtml(reminder.status)}</b> · ${escapeTelegramHtml(new Date(reminder.runAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))}\n  ${escapeTelegramHtml(reminder.text)}`).join("\n")}\n\n<b>Controls</b>\n<code>/reminders pause &lt;reminder-id&gt;</code>\n<code>/reminders resume &lt;reminder-id&gt;</code>\n<code>/reminders run &lt;reminder-id&gt;</code>\n<code>/reminders cancel &lt;reminder-id&gt;</code>` : "No active reminders.");
          return;
        }
        if (command === "jobs") {
          const [action, jobId] = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
          if (action && ["pause", "resume", "run", "cancel"].includes(action) && jobId) {
            const slug = action === "pause" ? "CHUCK_PAUSE_JOB" : action === "resume" ? "CHUCK_RESUME_JOB" : action === "run" ? "CHUCK_RUN_JOB_NOW" : "CHUCK_CANCEL_JOB";
            validateNativeToolArguments(slug as any, { id: jobId });
            const result = await nativeTool(uid, slug, { id: jobId });
            await replyHtml(ctx, `<b>Recurring job ${escapeTelegramHtml(action === "run" ? "started" : `${action}d`)}</b>\n\n${escapeTelegramHtml(typeof result === "string" ? result : JSON.stringify(result))}`);
            return;
          }
          const jobs = await listJobs(uid);
          await replyHtml(ctx, jobs.length ? `<b>Recurring schedules</b>\n\n${jobs.map((job) => `• <code>${escapeTelegramHtml(job.id)}</code> · <b>${escapeTelegramHtml(job.status)}</b> · ${escapeTelegramHtml(job.cron)}\n  ${escapeTelegramHtml(job.text)}`).join("\n")}\n\n<b>Controls</b>\n<code>/jobs pause &lt;job-id&gt;</code>\n<code>/jobs resume &lt;job-id&gt;</code>\n<code>/jobs run &lt;job-id&gt;</code>\n<code>/jobs cancel &lt;job-id&gt;</code>` : "No recurring schedules.");
          return;
        }
        if (command === "tasks") {
          const tasks = (await listTasks(uid)).filter((task) => !["completed", "cancelled"].includes(task.status));
          await replyHtml(ctx, tasks.length ? `<b>Active tasks</b>\n\n${tasks.map((task) => `• <code>${escapeTelegramHtml(task.id)}</code> · <b>${escapeTelegramHtml(task.status)}</b>\n  ${escapeTelegramHtml(task.title)}\n  ${escapeTelegramHtml(task.objective)}`).join("\n")}` : "No active tasks.");
          return;
        }
        const approvals = (await listApprovals(uid, 50)).filter((approval) => approval.status === "pending" && approval.expiresAt > Date.now());
        await replyCard(ctx, {
          title: "✅ Pending approvals",
          body: approvals.length ? approvals.slice(0, 8).map((approval) => `⚠️ ${approval.toolSlug} · ${approval.id}`) : ["Nothing is waiting for approval."],
          detail: "Review an approval before a risky external action runs.",
          buttons: approvals.length ? approvals.slice(0, 8).map((approval) => [{ text: `Review ${approval.toolSlug}`.slice(0, 54), callbackData: `appr:review:${approval.id}`, style: "primary" as const }]) : undefined,
        });
      } catch (error) {
        await ctx.reply(`❌ Could not load /${command}: ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" });
      }
    });
  }

  bot.callbackQuery(/^home:voice:provider:(twilio|bland|meetings)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) return;
    const provider = ctx.match[1] as LiveVoiceProvider;
    try {
      await editVoiceProvider(ctx, messageId, provider);
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from!.id, provider }, "Could not load live voice choices");
      await ctx.editMessageText(error instanceof Error ? `❌ ${error.message}` : "❌ Could not load voice choices. Try again shortly.", {
        reply_markup: new InlineKeyboard().text("← Voice settings", "home:voice"),
      });
    }
  });

  bot.callbackQuery(/^home:voice:page:(twilio|bland|meetings):(\d{1,2})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) return;
    const provider = ctx.match[1] as LiveVoiceProvider;
    try {
      await editVoiceProvider(ctx, messageId, provider, Number(ctx.match[2]));
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from!.id, provider }, "Could not page live voice choices");
      await ctx.editMessageText("❌ Could not load voice choices. Try again shortly.", {
        reply_markup: new InlineKeyboard().text("← Voice settings", "home:voice"),
      });
    }
  });

  bot.callbackQuery(/^home:voice:set:(twilio|meetings):([a-z0-9-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) return;
    const provider = ctx.match[1] as "twilio" | "meetings";
    try {
      await setLiveVoicePreference(ctx.from!.id, provider, ctx.match[2] as (typeof FLUX_TTS_VOICES)[number]["id"]);
      await editVoiceSettings(ctx, messageId);
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from!.id, provider }, "Live voice selection failed");
      await ctx.editMessageText("❌ That voice is not available. Reopen /home → Voice and choose from the current list.", {
        reply_markup: new InlineKeyboard().text("← Voice settings", "home:voice"),
      });
    }
  });

  bot.callbackQuery(/^home:voice:set:bland:([0-9a-f-]{36})$/i, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) return;
    try {
      const voices = await listBlandCuratedVoices(config.blandApiKey);
      const voice = voices.find((item) => item.id.toLowerCase() === ctx.match[1].toLowerCase());
      if (!voice) throw new Error("That voice is no longer available in Bland's curated catalogue.");
      await setLiveVoicePreference(ctx.from!.id, "bland", { id: voice.id, name: voice.name });
      await editVoiceSettings(ctx, messageId);
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from!.id }, "Bland voice selection failed");
      await ctx.editMessageText(error instanceof Error ? `❌ ${error.message}` : "❌ Could not save that Bland voice.", {
        reply_markup: new InlineKeyboard().text("← Voice settings", "home:voice"),
      });
    }
  });

  bot.callbackQuery(/^home:voice:reset:(twilio|bland|meetings)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) return;
    try {
      await setLiveVoicePreference(ctx.from!.id, ctx.match[1] as LiveVoiceProvider, undefined);
      await editVoiceSettings(ctx, messageId);
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from!.id }, "Live voice preference reset failed");
      await ctx.editMessageText("❌ Could not reset that voice preference. Try again.", {
        reply_markup: new InlineKeyboard().text("← Voice settings", "home:voice"),
      });
    }
  });

  bot.callbackQuery(/^home:voice:(on|off)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId) return;
    const enabled = ctx.match[1] === "on";
    try {
      await setVoiceReplies(ctx.from!.id, enabled);
      await editVoiceSettings(ctx, messageId);
    } catch (error) {
      logger.warn({ err: error, userId: ctx.from!.id, enabled }, "Telegram voice reply setting failed");
      await ctx.editMessageText("❌ I could not change voice replies. Use /voice on or /voice off to try again.");
    }
  });

  bot.callbackQuery(/^appr:review:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const approval = await getApproval(ctx.from!.id, ctx.match[1]);
    if (!approval || approval.status !== "pending" || approval.expiresAt <= Date.now()) {
      await ctx.editMessageText("⚠️ This approval has expired or was already handled.");
      return;
    }
    await editCard(ctx, ctx.callbackQuery.message!.message_id, approvalCard(approval.toolSlug, approval.id));
  });

  bot.callbackQuery(/^appr:(approve|deny):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const id = ctx.match[2];
    const approval = await getApproval(ctx.from.id, id);
    if (!approval || approval.status !== "pending" || approval.expiresAt <= Date.now()) {
      await editApprovalOutcome(ctx, "⚠️ This approval has expired or was already handled.");
      return;
    }
    if (ctx.match[1] === "deny") {
      if (!(await setApprovalStatus(ctx.from.id, id, "denied"))) {
        await editApprovalOutcome(ctx, "⚠️ This approval was already handled or has expired.");
        return;
      }
      if (approval.triggerEventId) await notifyTriggerApproval(approval.id, false, approval.triggerEventId).catch((error) => logger.warn({ err: error }, "Trigger approval notification failed"));
      const missionTarget = await findMissionApprovalTarget(ctx.from.id, approval.id);
      if (missionTarget) {
        await updateMission(ctx.from.id, missionTarget.mission.id, { status: "blocked", waiting: undefined, error: `Approval denied for ${approval.toolSlug}.`, nextAction: "Review the mission checkpoint and resume only after revising the action." });
        await editApprovalOutcome(ctx, "🛑 Action denied. The mission is blocked at its checkpoint; revise the action before resuming.");
        return;
      }
      await editApprovalOutcome(ctx, "🛑 Action denied. Nothing was executed.");
      return;
    }
    if (!(await claimApproval(ctx.from.id, id))) {
      await editApprovalOutcome(ctx, "⚠️ This approval was already handled or has expired.");
      return;
    }
    await editApprovalOutcome(ctx, "✅ Approved. Chusky is executing the action…");
    if (approval.handoffId) {
      try {
        const resumed = await resumeApprovedDelegation(ctx.from.id, approval.id);
        const outcome = resumed.status === "success"
          ? `✅ Approved worker action completed.\n\n${resumed.output}`
          : `⚠️ The approved worker action did not complete (${resumed.status}).\n\n${resumed.output}`;
        await editApprovalOutcome(ctx, outcome.slice(0, 3900));
      } catch (error) {
        logger.warn({ err: error, userId: ctx.from.id, approvalId: approval.id, handoffId: approval.handoffId }, "Approved worker action resume failed");
        await editApprovalOutcome(ctx, "⚠️ Approval was recorded, but the worker action could not resume. Inspect the task status before trying again.");
      }
      return;
    }
    if (approval.triggerEventId) {
      try {
        await notifyTriggerApproval(approval.id, true, approval.triggerEventId);
      } catch (error) {
        // The approval is durable, but its waiting workflow may have expired
        // or been cancelled. Keep the callback from bubbling into the generic
        // post-ack Telegram error and give the owner a recoverable explanation.
        logger.warn({ err: error, userId: ctx.from.id, approvalId: approval.id }, "Trigger approval workflow notification failed");
        await editApprovalOutcome(ctx, "⚠️ Approval saved, but the original triggered workflow is no longer active. Please retry the trigger.");
      }
      return;
    }
    if (approval.autonomyResume) {
      try {
        await enqueueAutonomyApprovalResume({ userId: ctx.from.id, ...approval.autonomyResume, approvalId: approval.id });
        await ctx.reply("▶️ Approved. The waiting autonomous run is resuming now; I’ll send its result when this slice completes.");
      } catch (error) {
        logger.warn({ err: error, userId: ctx.from.id, approvalId: approval.id }, "Autonomous approval resume enqueue failed");
        await ctx.reply("⚠️ Approval was saved, but the autonomous run could not be resumed yet. Retry the run from its status controls.");
      }
      return;
    }
    const missionTarget = await findMissionApprovalTarget(ctx.from.id, approval.id);
    if (missionTarget) {
      const lockToken = randomUUID();
      if (!(await acquireUserLock(ctx.from.id, lockToken))) {
        await setApprovalStatus(ctx.from.id, approval.id, "pending");
        await editApprovalOutcome(ctx, "⏳ Another request is still running. This approval remains pending; please approve it again shortly.");
        return;
      }
      try {
        const resumed = await resumeMissionTaskAfterApproval(ctx.from.id, approval.id);
        if (resumed.status === "not_resumable" || resumed.status === "task_running" || resumed.status === "not_mission") {
          await setApprovalStatus(ctx.from.id, approval.id, "pending");
          await editApprovalOutcome(ctx, "⚠️ The mission task is not ready to resume. The approval remains pending; check the mission status before retrying.");
          return;
        }
        if (resumed.status === "enqueue_failed") {
          await editApprovalOutcome(ctx, "✅ Approved, but the mission could not be queued. Its checkpoint is preserved; retry the mission after workflow service recovers.");
          return;
        }
        if (resumed.status === "already_queued") {
          await editApprovalOutcome(ctx, "✅ Approved. The mission task is already being queued; check the mission status for its update.");
          return;
        }
        await editApprovalOutcome(ctx, "✅ Approved. The original mission is resuming from its saved checkpoint.");
      } catch (error) {
        logger.warn({ err: error, userId: ctx.from.id, approvalId: approval.id, missionId: missionTarget.mission.id, taskId: missionTarget.task.id }, "Mission approval resume failed");
        await editApprovalOutcome(ctx, "⚠️ Approval was recorded, but the mission could not be queued. Check its status and retry the mission from the saved checkpoint.");
      } finally {
        await releaseUserLock(ctx.from.id, lockToken);
      }
      return;
    }
    try {
      // Preserve exact execution for any historical phone-call approval that
      // is still pending after the policy change. New calls do not create one.
      if (approval.toolSlug === "CHUCK_START_PHONE_CALL") {
        validateNativeToolArguments(approval.toolSlug, approval.args);
        await nativeTool(ctx.from.id, approval.toolSlug, approval.args);
        await setApprovalStatus(ctx.from.id, approval.id, "consumed");
        const label = "Phone call";
        await appendMessages(ctx.from.id, [{ role: "user", content: approval.request }, { role: "assistant", content: `${label} started. I’m joining the call now.` }]);
        await ctx.reply(`📞 ${label} started. I’m joining the call now.`);
        return;
      }
      const result = await runAgent(ctx.from.id, approval.request, approval.history, approval.model, undefined, undefined, undefined, id);
      await appendMessages(ctx.from.id, [{ role: "user", content: approval.request }, { role: "assistant", content: result.text }]);
      await replyHtml(ctx, mdToTelegramHtml(result.text));
      await sendVoiceReply(ctx, result.text, (await getSession(ctx.from.id)).voiceReplies === true);
      await sendGeneratedArtifacts(ctx, result.generatedFiles);
    } catch (e) {
      if (e instanceof ApprovalRequiredError) {
        await ctx.reply("The resumed request reached another action that needs your review:");
        await replyCard(ctx, approvalCard(e.toolSlug, e.approvalId));
        return;
      }
      await ctx.reply(`❌ Approval execution failed: ${String(e).slice(0, 400)}`);
    }
  });

  // ── Main message handler ───────────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    if (!(await guard(ctx))) return;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const userId = ctx.from.id;

    if (!(await checkRateLimit(userId))) {
      await ctx.reply(`⏱ Easy there. Max ${config.rateLimit} messages per ${config.rateWindowSeconds}s.`);
      return;
    }

    const s = await getSession(userId);
    const model = await telegramGroupModel(ctx, s.model);
    posthog?.capture({ distinctId: String(userId), event: "telegram_message_received", properties: { model, message_length: text.length } });
    if (!(await canSpend(userId))) {
      await ctx.reply("💳 Your usage cap has been reached. Ask an administrator to increase it.");
      return;
    }

    // Keep ordinary greetings conversational. They do not need a model/tool
    // round trip, and showing an internal progress card for "hello" makes the
    // Telegram experience feel mechanical.
    if (isSimpleTelegramGreeting(text)) {
      const receivedAt = telegramMessageReceivedAt(ctx);
      const response = /good\s+(?:morning|afternoon|evening)/i.test(text.trim())
        ? `${text.trim().replace(/[!?.,…]+$/g, "")}! What can I help you with?`
        : "Hey! What can I help you with?";
      await saveTelegramConversation(ctx, userId, text, response, receivedAt);
      await ctx.reply(response);
      await sendVoiceReply(ctx, response, s.voiceReplies === true);
      return;
    }

    const controller = new AbortController();
    const lockToken = randomUUID();
    activeRequests.set(userId, controller);
    try {
      await acquireQueuedLock(userId, lockToken, controller.signal);
    } catch (error) {
      if (activeRequests.get(userId) === controller) activeRequests.delete(userId);
      throw error;
    }

    // Post the live status message
    const statusMsg = await ctx.reply("🐶 <b>I’m on it…</b>", { parse_mode: "HTML" });

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4500);

    // Track steps for the live status bar
    const steps: string[] = [];
    let lastStatus = "";
    let lastStatusEditAt = 0;
    let statusEdit: Promise<void> = Promise.resolve();
    let streamedText = "";
    let lastStreamEdit = 0;

    async function updateStatus(step: string): Promise<void> {
      const normalized = step.replace(/\.{2,}/g, "…").trim();
      if (!normalized || normalized === lastStatus) return;
      lastStatus = normalized;
      steps.push(normalized);
      const bar = buildStatusBar(steps);
      // Serialize edits: concurrent tool callbacks otherwise make Telegram
      // show stale stages out of order. A small client-side cooldown also
      // avoids hammering the Bot API during fast tool chains.
      const wait = Math.max(0, 350 - (Date.now() - lastStatusEditAt));
      statusEdit = statusEdit.then(async () => {
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        try {
          await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, bar);
          lastStatusEditAt = Date.now();
        } catch { /* ignore status-only failures */ }
      });
      await statusEdit;
    }

    try {
      const receivedAt = telegramMessageReceivedAt(ctx);
      const result = await runAgent(
        userId, text, await telegramConversationHistory(ctx, s.history), model, updateStatus, controller.signal,
        async (delta) => {
          streamedText += delta;
          if (Date.now() - lastStreamEdit > 800 && streamedText.trim()) {
            lastStreamEdit = Date.now();
            await editHtml(ctx, statusMsg.message_id, mdToTelegramHtml(streamedText));
          }
        },
        undefined, telegramAgentChannelContext(ctx, userId), telegramAgentOptions(ctx, receivedAt)
      );
      clearInterval(typingInterval);

      await saveTelegramConversation(ctx, userId, text, result.text, receivedAt);
      if (result.cost) await addUsage(userId, result.cost);

      let html = "";

      if (result.toolsUsed.length > 0) {
        const footer = result.toolsUsed.map(toolFooterLabel).filter(Boolean).join("  ");
        const cost = result.cost ? `  ·  <i>$${result.cost.toFixed(5)}</i>` : "";
        if (footer || cost) html += `\n\n<i>${footer}${cost}</i>`;
      }

      await editMarkdown(ctx, statusMsg.message_id, result.text, html);
      await sendPrivateBrowserLinks(ctx, result.privateLinks);
      await sendVoiceReply(ctx, result.text, s.voiceReplies === true);
      await sendGeneratedArtifacts(ctx, result.generatedFiles);
      const generatedImages = result.generatedImages ?? [];
      if (generatedImages.length > 1) {
        await ctx.replyWithMediaGroup(generatedImages.map((image, index) => ({ type: "photo" as const, media: new InputFile(image.data, image.mediaType.includes("jpeg") ? `chusky-${index + 1}.jpg` : `chusky-${index + 1}.png`) })));
      } else for (const image of generatedImages) {
        await ctx.replyWithPhoto(new InputFile(image.data, image.mediaType.includes("jpeg") ? "chusky.jpg" : "chusky.png"));
        if (image.cost) await addUsage(userId, image.cost);
      }
      for (const image of result.retrievedImages ?? []) {
        await ctx.replyWithPhoto(new InputFile(image.data, image.mediaType.includes("jpeg") ? "saved-image.jpg" : "saved-image.png"), { caption: image.name ? `Saved image: ${image.name}` : "Saved image" });
      }

    } catch (e) {
      clearInterval(typingInterval);
      if (e instanceof ApprovalRequiredError) {
        const card = approvalCard(e.toolSlug, e.approvalId);
        if (isTelegramShared(ctx)) {
          // Never expose tool names, arguments, or approval controls to the
          // rest of a group. Delivery is owner-only or safely falls back to
          // the owner's direct Chusky chat.
          await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "⚠️ <b>Approval required</b>\n\nThis action needs its owner's review. I sent the private approval card.", { parse_mode: "HTML" });
          try {
            const route = await deliverGroupApproval(ctx, card);
            logger.info({ userId, chatId: ctx.chat!.id, route, approvalId: e.approvalId }, "Delivered private Telegram group approval");
          } catch (deliveryError) {
            // The durable record remains pending. Never replace the generic
            // group status with an error containing sensitive action details.
            logger.warn({ err: deliveryError, userId, chatId: ctx.chat!.id, approvalId: e.approvalId }, "Could not deliver private group approval");
            await ctx.reply("I could not deliver the owner's private approval card. Open a private chat with me and use /home → Approvals.");
          }
          return;
        }
        await editCard(ctx, statusMsg.message_id, card);
        return;
      }
      logger.error({ err: e, userId, model }, "Chusky error");
      posthog?.captureException(e instanceof Error ? e : new Error(String(e)), String(userId));
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id, statusMsg.message_id,
          e instanceof DOMException && e.name === "AbortError" ? "🛑 <b>Request cancelled.</b>" : `❌ <b>Chusky hit an error</b>\n\n<code>${mdToTelegramHtml(msg).slice(0, 400)}</code>\n\nTry /clear history or /model to retry.`,
          { parse_mode: "HTML" }
        );
      } catch {
        await ctx.reply(`❌ Error: ${msg.slice(0, 200)}`);
      }
    } finally {
      await releaseUserLock(userId, lockToken);
      activeRequests.delete(userId);
    }
  });

function toolFooterLabel(slug: string): string {
  // Native CHUCK_* calls are internal implementation details. Keep the
  // useful provider indicators while hiding the generic "🔧 chuck" label.
  if (slug.startsWith("CHUCK_")) return "";
  const map: Record<string, string> = {
    COMPOSIO_MANAGE_CONNECTIONS: "🔗",
    COMPOSIO_REMOTE_BASH_TOOL: "🖥️",
    COMPOSIO_REMOTE_WORKBENCH: "🛠️",
    COMPOSIO_SEARCH_TOOL: "🔎",
    COMPOSIO_SEARCH_TOOLS: "🔎",
    COMPOSIO_SEARCH_WEB: "🌐",
    COMPOSIO_SEARCH_FETCH_URL_CONTENT: "🔗",
    COMPOSIO_GET_TOOL_SCHEMAS: "🧩",
    COMPOSIO_EXECUTE_TOOL: "⚡",
    COMPOSIO_MULTI_EXECUTE_TOOL: "⚡",
  };
  if (map[slug]) return map[slug];
  const toolkit = slug.split("_")[0]?.toLowerCase() ?? "tool";
  return `🔧 ${toolkit}`;
}

  // ── Photo ──────────────────────────────────────────────────────────────────
  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    try {
      const file = await downloadTelegramFile(ctx, photo.file_id);
      const mime = file.path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      const caption = ctx.message.caption?.trim() || defaultMediaInstruction("image");
      if (r2Configured()) {
        try {
          const r2Key = `telegram/${ctx.from!.id}/images/${photo.file_id}.${mime === "image/png" ? "png" : "jpg"}`;
          await putR2Object(r2Key, file.data, mime);
          await registerImageAsset(ctx.from!.id, { name: `telegram-${photo.file_id}`, purpose: "Image uploaded from Telegram", description: caption, tags: ["telegram", "uploaded-image"], contentType: mime, r2Key, size: file.data.length });
        } catch (error) { logger.warn({ err: error, userId: ctx.from?.id }, "Could not persist Telegram image asset"); }
      }
      await handleMedia(ctx, [
        { type: "text", text: caption },
        { type: "image_url", image_url: { url: `data:${mime};base64,${file.data.toString("base64")}` } },
      ], `[Image attached] ${caption}`, vectorConfigured() ? async (selectedModel) => {
        await indexExtractedDocument({ userId: String(ctx.from!.id), documentId: `telegram_${photo.file_id}`, filename: `telegram-${photo.file_id}.${mime === "image/png" ? "png" : "jpg"}`, contentType: mime, text: await extractMediaText(file.data, `telegram-${photo.file_id}`, mime, selectedModel), sourceType: "telegram_image" });
      } : undefined);
    } catch (e) {
      await ctx.reply(`❌ Could not download the image: ${String(e).slice(0, 300)}`);
    }
  });

  // ── Document ───────────────────────────────────────────────────────────────
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    try {
      const file = await downloadTelegramFile(ctx, doc.file_id);
      const filename = doc.file_name || file.path.split("/").pop() || "document";
      const mime = doc.mime_type || "application/octet-stream";
      const prompt = ctx.message.caption?.trim() || defaultMediaInstruction("document");
      const documentId = `telegram_${doc.file_id}`;
      if (r2Configured()) {
        try { await putR2Object(`telegram/${ctx.from!.id}/${documentId}/${filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)}`, file.data, mime); }
        catch (error) { logger.warn({ err: error, userId: ctx.from?.id, filename }, "Could not persist Telegram document in R2"); }
      }
      const indexDocument = vectorConfigured() && (mime === "text/plain" || mime === "text/markdown" || /\.md$/i.test(filename) || mime === "application/pdf" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        ? async (selectedModel: string) => {
          try {
            const extracted = mime === "application/pdf" || mime.includes("wordprocessingml") ? await extractMediaText(file.data, filename, mime, selectedModel) : file.data.toString("utf8");
            await indexExtractedDocument({ userId: String(ctx.from!.id), documentId, filename, contentType: mime, text: extracted, sourceType: "telegram_upload" });
          } catch (error) {
            logger.warn({ err: error, userId: ctx.from?.id, filename }, "Could not index text document");
          }
        }
        : undefined;
      await handleMedia(ctx, [
        { type: "text", text: prompt },
        { type: "file", file: { filename, file_data: `data:${mime};base64,${file.data.toString("base64")}` } },
      ], `[Document attached: ${filename}] ${prompt}`, indexDocument);
    } catch (e) {
      await ctx.reply(`❌ Could not process the document: ${String(e).slice(0, 300)}`);
    }
  });

  bot.on("message:voice", async (ctx) => {
    const status = await ctx.reply("🎙️ <b>Chusky received your voice message and is transcribing it…</b>", { parse_mode: "HTML" }).catch(() => undefined);
    try {
      logger.info({ userId: ctx.from?.id, duration: ctx.message.voice.duration, fileSize: ctx.message.voice.file_size }, "Voice message received");
      const file = await downloadTelegramFile(ctx, ctx.message.voice.file_id);
      if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, "🧠 <b>Chusky is processing your voice message…</b>", { parse_mode: "HTML" });
      const text = await transcribeAudio(file.data, audioFormat(file.path));
      await handleMedia(ctx, [{ type: "text", text: `The user sent this voice message:\n${text}` }], `[Voice message] ${text}`);
    } catch (e) {
      logger.error({ err: e, userId: ctx.from?.id }, "Voice transcription failed");
      if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, `❌ Could not transcribe the voice message: ${String(e).slice(0, 300)}`).catch(() => undefined);
      else await ctx.reply(`❌ Could not transcribe the voice message: ${String(e).slice(0, 300)}`);
    }
  });

  bot.on("message:audio", async (ctx) => {
    const status = await ctx.reply("🎙️ <b>Chusky received your audio and is transcribing it…</b>", { parse_mode: "HTML" }).catch(() => undefined);
    try {
      logger.info({ userId: ctx.from?.id, duration: ctx.message.audio.duration, fileSize: ctx.message.audio.file_size }, "Audio message received");
      const file = await downloadTelegramFile(ctx, ctx.message.audio.file_id);
      if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, "🧠 <b>Chusky is processing your audio…</b>", { parse_mode: "HTML" });
      const text = await transcribeAudio(file.data, audioFormat(file.path));
      await handleMedia(ctx, [{ type: "text", text: `The user sent this audio:\n${text}` }], `[Audio message] ${text}`);
    } catch (e) {
      logger.error({ err: e, userId: ctx.from?.id }, "Audio transcription failed");
      if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, `❌ Could not transcribe the audio: ${String(e).slice(0, 300)}`).catch(() => undefined);
      else await ctx.reply(`❌ Could not transcribe the audio: ${String(e).slice(0, 300)}`);
    }
  });

  bot.on("message:video", async (ctx) => {
    try {
      const file = await downloadTelegramFile(ctx, ctx.message.video.file_id);
      const caption = ctx.message.caption?.trim() || defaultMediaInstruction("video");
      await handleMedia(ctx, [
        { type: "text", text: caption },
        { type: "video_url", video_url: { url: `data:${ctx.message.video.mime_type || "video/mp4"};base64,${file.data.toString("base64")}` } },
      ], `[Video attached] ${caption}`);
    } catch (e) {
      await ctx.reply(`❌ Could not process the video: ${String(e).slice(0, 300)}`);
    }
  });

  // ── Inline mode ────────────────────────────────────────────────────────────
  bot.on("inline_query", async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    if (!query) { await ctx.answerInlineQuery([]); return; }
    try {
      const model = await getModel(ctx.from.id);
      const result = await runAgent(ctx.from.id, query, [], model);
      const html = mdToTelegramHtml(result.text);
      await ctx.answerInlineQuery([{
        type: "article",
        id: "1",
        title: query.slice(0, 60),
        description: result.text.slice(0, 100),
        input_message_content: { message_text: html, parse_mode: "HTML" },
      }], { cache_time: 30 });
    } catch { await ctx.answerInlineQuery([]); }
  });

  // ── Global error handler ───────────────────────────────────────────────────
  bot.catch((err) => {
    logger.error({ err: err.message, update: err.ctx?.update }, "grammY error");
  });
}
