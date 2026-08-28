import type { Bot } from "grammy";
import { CHANNEL_CAPABILITIES } from "./capabilities.js";
import type { ChannelAdapter, DeliveryReceipt, OutboundMessage, ReplyTarget } from "./contracts.js";
import type { InboundMessage } from "./contracts.js";

export function normalizeTelegramUpdate(update: any, receivedAt = Date.now()): InboundMessage | undefined {
  const message = update?.message ?? update?.edited_message;
  if (!message?.from?.id || !message?.chat?.id) return undefined;
  const text = String(message.text ?? message.caption ?? "").trim();
  return {
    provider: "telegram",
    providerEventId: String(update.update_id ?? `${message.chat.id}:${message.message_id}`),
    providerUserId: String(message.from.id),
    providerConversationId: String(message.chat.id),
    providerThreadId: message.message_thread_id ? String(message.message_thread_id) : undefined,
    text: text || undefined,
    attachments: [],
    receivedAt,
    scope: message.chat.type === "private" ? "private" : "shared",
    displayName: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ").slice(0, 200) || undefined,
  };
}

/**
 * Provider edge for Telegram. Existing grammY handlers remain the compatibility
 * path; this adapter gives new cross-channel workflows one uniform sender and
 * can be adopted handler-by-handler without changing Telegram behavior.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly provider = "telegram" as const;
  readonly capabilities = CHANNEL_CAPABILITIES.telegram;

  constructor(private readonly bot: Bot) {}

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const chatId = Number(message.target.conversationId);
    if (!Number.isSafeInteger(chatId)) throw new Error("Telegram reply target is invalid");
    const sent = await this.bot.api.sendMessage(chatId, message.text ?? "", { parse_mode: "HTML" });
    return { providerMessageId: String(sent.message_id), deliveredAt: Date.now() };
  }

  async edit(target: ReplyTarget, providerMessageId: string, text: string): Promise<DeliveryReceipt> {
    const chatId = Number(target.conversationId);
    const messageId = Number(providerMessageId);
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) throw new Error("Telegram edit target is invalid");
    await this.bot.api.editMessageText(chatId, messageId, text, { parse_mode: "HTML" });
    return { providerMessageId, deliveredAt: Date.now() };
  }

  async typing(target: ReplyTarget): Promise<void> {
    const chatId = Number(target.conversationId);
    if (Number.isSafeInteger(chatId)) await this.bot.api.sendChatAction(chatId, "typing");
  }
}
