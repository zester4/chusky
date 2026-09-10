import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { config } from "./config.js";
import {
  runAgent, fetchModels, getConnectionUrl, getToolkitStates, listConnectedAccounts, invalidateSession, ApprovalRequiredError,
  transcribeAudio, generateImage, generateSpeech,
  listTriggers, createTrigger, setTriggerState, deleteTrigger, listAvailableTriggerToolkits, listAvailableTriggerTypes, getAvailableTriggerType,
  searchTools
} from "./agent.js";
import { requiredTriggerConfigFields, type TriggerCatalogueItem } from "./triggerCatalog.js";
import type { ContentPart } from "./types.js";
import {
  getSession, appendMessages, addUsage, canSpend, clearHistory, clearSession, setModel, getModel, checkRateLimit,
  getChannelConversation, appendChannelConversationMessages, setChannelConversationModel, clearChannelConversationHistory,
  setTelegramChatId, getApproval, setApprovalStatus, claimApproval, createCliPairing, listCliDevices, revokeCliDeviceHash, setVoiceReplies, listVideoJobs, registerImageAsset,
  claimTelegramUpdate, listHandoffRecords, saveHandoffRecord, cancelTask,
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
import { notifyTriggerApproval } from "./triggerWorkflow.js";
import { nativeTool } from "./nativeTools.js";
import { validateNativeToolArguments } from "./agentTools.js";
import { posthog } from "./posthog.js";
import { requestPhoneCallApproval } from "./calls/phoneApproval.js";
import { conversationIdFor } from "./channels/contracts.js";
import { sharedGroupInstructions } from "./channels/groupInstructions.js";

const activeRequests = new Map<number, AbortController>();
const MODEL_PAGE_SIZE = 8;
const TRIGGER_PAGE_SIZE = 8;

type ModelProvider = "anthropic" | "openai" | "google" | "meta-llama" | "deepseek" | "mistralai" | "minimax" | "all";

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function modelProviderKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🧠 Anthropic Claude", "mpv:anthropic").row()
    .text("⚡ OpenAI", "mpv:openai").row()
    .text("🔮 Google Gemini", "mpv:google").row()
    .text("🦙 Meta Llama", "mpv:meta-llama").row()
    .text("🧬 DeepSeek", "mpv:deepseek").row()
    .text("🤝 Mistral", "mpv:mistralai").row()
    .text("✨ MiniMax", "mpv:minimax").row()
    .text("🌐 Browse all models", "mpv:all");
}

function modelListKeyboard(models: Array<{ id: string; name: string }>, provider: ModelProvider, page: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const start = page * MODEL_PAGE_SIZE;
  for (let index = start; index < Math.min(start + MODEL_PAGE_SIZE, models.length); index++) {
    const model = models[index];
    const label = `${model.name || model.id} · ${model.id}`.slice(0, 60);
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

function modelsForProvider(models: Array<{ id: string; name: string }>, provider: ModelProvider): Array<{ id: string; name: string }> {
  return models
    .filter((model) => provider === "all" || model.id.startsWith(`${provider}/`))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id) || a.id.localeCompare(b.id));
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
    .text("💬 SMS", `chlink:p:sms:${userId}`)
    .text("𝕏 XChat", `chlink:p:xchat:${userId}`).row()
    .text("👥 Link an iMessage group", `chlink:g:sendblue:${userId}`);
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
  while (!(await acquireUserLock(userId, token))) {
    if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAllowed(ctx: Context): boolean {
  if (config.allowedUsers.length === 0) return true;
  return config.allowedUsers.includes(String(ctx.from?.id ?? ""));
}

async function guard(ctx: Context): Promise<boolean> {
  if (ctx.from && ctx.chat && isAllowed(ctx)) {
    await setTelegramChatId(ctx.from.id, ctx.chat.id);
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

const SHARED_GROUP_TOOL_DENY = [
  "CHUCK_SAVE_MEMORY", "CHUCK_UPDATE_MEMORY", "CHUCK_SEARCH_MEMORY", "CHUCK_FORGET_MEMORY",
  "CHUCK_SAVE_IMAGE_ASSET", "CHUCK_SEARCH_IMAGE_ASSETS", "CHUCK_GET_IMAGE_ASSET", "CHUCK_FORGET_IMAGE_ASSET",
  // A setup link is a bearer credential and an authenticated identity belongs
  // to one account, never a shared group conversation.
  "CHUCK_VAULT_SAVE", "CHUCK_VAULT_LIST", "CHUCK_VAULT_STATUS", "CHUCK_VAULT_LOGIN", "CHUCK_VAULT_LOGOUT",
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
      await ctx.replyWithDocument(new InputFile(file.data, file.name), { caption: `📦 ${file.name}\nArtifact ID: ${file.artifactId}` });
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

async function handleMedia(ctx: Context, parts: ContentPart[], historyLabel: string, afterAgent?: () => Promise<void>): Promise<void> {
  if (!(await guard(ctx))) return;
  if (!(await checkRateLimit(ctx.from!.id))) {
    await ctx.reply(`⏱ Easy there. Max ${config.rateLimit} messages per ${config.rateWindowSeconds}s.`);
    return;
  }
  const userId = ctx.from!.id;
  const controller = new AbortController();
  const lockToken = randomUUID();
  activeRequests.set(userId, controller);
  await acquireQueuedLock(userId, lockToken, controller.signal);
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
    const result = await runAgent(userId, parts, await telegramConversationHistory(ctx, s.history), await telegramGroupModel(ctx, s.model), undefined, controller.signal, undefined, undefined, undefined, telegramAgentOptions(ctx, receivedAt));
    await saveTelegramConversation(ctx, userId, historyLabel, result.text, receivedAt);
    if (result.cost) await addUsage(userId, result.cost);
    await editMarkdown(ctx, status.message_id, result.text);
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
    if (afterAgent) void afterAgent().catch((error) => logger.warn({ err: error, userId }, "Background media indexing failed"));
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
  if (steps.length === 0) return "⏳ I’m thinking…";
  const lines: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const isLast = i === steps.length - 1;
    const icon = isLast ? "⟳" : "✓";
    lines.push(`${icon} ${steps[i]}`);
  }
  // Show last 4 steps max to keep it tidy
  const visible = lines.slice(-4);
  return visible.join("\n");
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
      `  /call <code>+number purpose</code> — request a phone call\n` +
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
      `/video-status [job id] — check video generation status\n` +
      `/agents — list recent worker delegations\n` +
      `/agent-status <code>handoff-id</code> — inspect one worker run\n` +
      `/agent-cancel <code>handoff-id</code> — cancel a queued worker run\n` +
      `/call <code>+number purpose</code> — request an approval-gated phone call\n` +
      `/cancel — cancel the active request\n` +
      `/channel — choose a private channel or iMessage group to link securely\n` +
      `/linkgroup — open the iMessage group-link menu\n` +
      `/connect <toolkit> [alias] — connect an app account, including multiple accounts\n` +
      `/accounts [toolkit] — list connected Composio accounts and aliases\n` +
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

  bot.command("cancel", async (ctx) => {
    if (!(await guard(ctx))) return;
    const controller = activeRequests.get(ctx.from!.id);
    if (!controller) { await ctx.reply("There is no active request to cancel."); return; }
    controller.abort();
    await ctx.reply("🛑 Cancellation requested.");
  });

  bot.command("voice", async (ctx) => {
    if (!(await guard(ctx))) return;
    const action = (ctx.match?.trim() ?? "status").toLowerCase();
    const current = (await getSession(ctx.from!.id)).voiceReplies === true;
    if (action === "on" || action === "enable") {
      await setVoiceReplies(ctx.from!.id, true);
      await ctx.reply("🔊 Voice replies are on. I’ll send text and an audio reply after each response.");
      return;
    }
    if (action === "off" || action === "disable") {
      await setVoiceReplies(ctx.from!.id, false);
      await ctx.reply("🔇 Voice replies are off. I’ll continue replying with text.");
      return;
    }
    if (action === "status") {
      await ctx.reply(current ? "🔊 Voice replies are on." : "🔇 Voice replies are off.");
      return;
    }
    await ctx.reply("Usage: /voice on, /voice off, or /voice status");
  });

  bot.command("call", async (ctx) => {
    if (!(await guard(ctx))) return;
    const raw = (ctx.match?.trim() ?? "");
    const split = raw.search(/\s/);
    const phoneNumber = split < 0 ? raw : raw.slice(0, split);
    const purpose = split < 0 ? "" : raw.slice(split).trim();
    if (!phoneNumber || !purpose) {
      await ctx.reply("Usage: /call +14155550123 <purpose>. I will always ask for approval before placing the call.");
      return;
    }
    try {
      const approval = await requestPhoneCallApproval(ctx.from!.id, { phoneNumber, purpose }, `/call ${phoneNumber} ${purpose}`);
      const keyboard = new InlineKeyboard().text("✅ Approve", `appr:approve:${approval.id}`).text("🛑 Deny", `appr:deny:${approval.id}`);
      await ctx.reply(
        `⚠️ <b>Approval required</b>\n\nI will call <code>${escapeTelegramHtml(approval.args.phoneNumber as string)}</code> about: ${escapeTelegramHtml(approval.args.purpose as string)}.`,
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch (error) {
      await ctx.reply(`❌ ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" });
    }
  });

  bot.command("cli", async (ctx) => {
    if (!(await guard(ctx))) return;
    const uid = ctx.from!.id;
    const [action, ...rest] = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
    if (action === "link") {
      const code = await createCliPairing(uid);
      await ctx.reply(`🔐 <b>Terminal pairing code</b>\n\n<code>${code}</code>\n\nThis code expires in 10 minutes and can be used once. In your terminal run:\n\n<code>npm run cli -- auth link</code>`, { parse_mode: "HTML" });
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
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, body, { parse_mode: "HTML" });
    } catch (error) {
      logger.error({ err: error, userId: ctx.from!.id, toolkit }, "Failed to list Composio connected accounts");
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, `❌ Could not load connected accounts: ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`, { parse_mode: "HTML" });
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
    if (!["anthropic", "openai", "google", "meta-llama", "deepseek", "mistralai", "minimax", "all"].includes(provider)) return;
    const msg = await ctx.reply("⏳ Fetching models…");
    try {
      const all = await fetchModels();
      const filtered = modelsForProvider(all, provider as ModelProvider);
      if (!filtered.length) {
        await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `No models found for: <code>${provider}</code>`, { parse_mode: "HTML" });
        return;
      }
      const page = 0;
      const pageCount = Math.ceil(filtered.length / MODEL_PAGE_SIZE);
      await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `<b>Select model</b>\n${escapeTelegramHtml(provider)} · ${filtered.length} available · page 1/${pageCount}\nChoose a model by name or ID:`, { parse_mode: "HTML", reply_markup: modelListKeyboard(filtered, provider as ModelProvider, page) });
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `❌ ${String(e)}`);
    }
  });

  bot.callbackQuery(/^mpg:(.+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const provider = ctx.match[1];
    const page = Number(ctx.match[2]);
    if (!["anthropic", "openai", "google", "meta-llama", "deepseek", "mistralai", "minimax", "all"].includes(provider) || !Number.isSafeInteger(page) || page < 0) return;
    try {
      const filtered = modelsForProvider(await fetchModels(), provider as ModelProvider);
      const pageCount = Math.max(1, Math.ceil(filtered.length / MODEL_PAGE_SIZE));
      const safePage = Math.min(page, pageCount - 1);
      await ctx.editMessageText(`<b>Select model</b>\n${escapeTelegramHtml(provider)} · ${filtered.length} available · page ${safePage + 1}/${pageCount}\nChoose a model by name or ID:`, { parse_mode: "HTML", reply_markup: modelListKeyboard(filtered, provider as ModelProvider, safePage) });
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

  bot.callbackQuery(/^chlink:(p|g|t):([a-z-]+):(\d+)$/, async (ctx) => {
    const kind = ctx.match[1];
    const target = ctx.match[2];
    const ownerId = Number(ctx.match[3]);
    if (ctx.from.id !== ownerId) {
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
  });

  bot.callbackQuery(/^appr:(approve|deny):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const id = ctx.match[2];
    const approval = await getApproval(ctx.from.id, id);
    if (!approval || approval.status !== "pending" || approval.expiresAt <= Date.now()) {
      await ctx.editMessageText("⚠️ This approval has expired or was already handled.");
      return;
    }
    if (ctx.match[1] === "deny") {
      if (!(await setApprovalStatus(ctx.from.id, id, "denied"))) {
        await ctx.editMessageText("⚠️ This approval was already handled or has expired.");
        return;
      }
      if (approval.triggerEventId) await notifyTriggerApproval(approval.id, false, approval.triggerEventId).catch((error) => logger.warn({ err: error }, "Trigger approval notification failed"));
      await ctx.editMessageText("🛑 Action denied. Nothing was executed.");
      return;
    }
    if (!(await claimApproval(ctx.from.id, id))) {
      await ctx.editMessageText("⚠️ This approval was already handled or has expired.");
      return;
    }
    await ctx.editMessageText("✅ Approved. Chusky is executing the action…");
    if (approval.triggerEventId) {
      await notifyTriggerApproval(approval.id, true, approval.triggerEventId);
      return;
    }
    try {
      // A FaceTime call is a real external side effect. Re-running the model
      // after approval can produce semantically similar but JSON-different
      // arguments, causing an unnecessary second approval. Execute precisely
      // the reviewed native request instead.
      if (approval.toolSlug === "CHUCK_START_FACETIME_CALL" || approval.toolSlug === "CHUCK_START_PHONE_CALL") {
        validateNativeToolArguments(approval.toolSlug, approval.args);
        await nativeTool(ctx.from.id, approval.toolSlug, approval.args);
        await setApprovalStatus(ctx.from.id, approval.id, "consumed");
        const label = approval.toolSlug === "CHUCK_START_PHONE_CALL" ? "Phone call" : "FaceTime call";
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
    const controller = new AbortController();
    const lockToken = randomUUID();
    activeRequests.set(userId, controller);
    await acquireQueuedLock(userId, lockToken, controller.signal);

    // Post the live status message
    const statusMsg = await ctx.reply("🐶 <b>Alright, just a sec…</b>", { parse_mode: "HTML" });

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4500);

    // Track steps for the live status bar
    const steps: string[] = [];
    let streamedText = "";
    let lastStreamEdit = 0;

    async function updateStatus(step: string): Promise<void> {
      steps.push(step);
      const bar = buildStatusBar(steps);
      try {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, bar);
      } catch { /* ignore */ }
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
        undefined, undefined, telegramAgentOptions(ctx, receivedAt)
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
        const kb = new InlineKeyboard().text("✅ Approve", `appr:approve:${e.approvalId}`).text("🛑 Deny", `appr:deny:${e.approvalId}`);
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `⚠️ <b>Approval required</b>\n\nChusky wants to execute <code>${e.toolSlug}</code>.\n\nReview the requested action and choose:`, { parse_mode: "HTML", reply_markup: kb });
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
      const caption = ctx.message.caption?.trim() || "Describe and analyze this image.";
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
      ], `[Image attached] ${caption}`, vectorConfigured() ? async () => {
        await indexExtractedDocument({ userId: String(ctx.from!.id), documentId: `telegram_${photo.file_id}`, filename: `telegram-${photo.file_id}.${mime === "image/png" ? "png" : "jpg"}`, contentType: mime, text: await extractMediaText(file.data, `telegram-${photo.file_id}`, mime), sourceType: "telegram_image" });
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
      const prompt = ctx.message.caption?.trim() || "Read this document and summarize its key points.";
      const documentId = `telegram_${doc.file_id}`;
      if (r2Configured()) {
        try { await putR2Object(`telegram/${ctx.from!.id}/${documentId}/${filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)}`, file.data, mime); }
        catch (error) { logger.warn({ err: error, userId: ctx.from?.id, filename }, "Could not persist Telegram document in R2"); }
      }
      if (vectorConfigured() && (mime === "text/plain" || mime === "text/markdown" || /\.md$/i.test(filename) || mime === "application/pdf" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")) {
        try {
          const extracted = mime === "application/pdf" || mime.includes("wordprocessingml") ? await extractMediaText(file.data, filename, mime) : file.data.toString("utf8");
          await indexExtractedDocument({ userId: String(ctx.from!.id), documentId, filename, contentType: mime, text: extracted, sourceType: "telegram_upload" });
        } catch (error) {
          logger.warn({ err: error, userId: ctx.from?.id, filename }, "Could not index text document");
        }
      }
      await handleMedia(ctx, [
        { type: "text", text: prompt },
        { type: "file", file: { filename, file_data: `data:${mime};base64,${file.data.toString("base64")}` } },
      ], `[Document attached: ${filename}] ${prompt}`);
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
      const caption = ctx.message.caption?.trim() || "Analyze this video.";
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
