import { InlineKeyboard } from "grammy";

/**
 * Telegram-native, progressively enhanced agent cards.
 *
 * The same card has a Rich Message representation (Bot API 10.3) and a
 * standard HTML/inline-keyboard fallback. Keeping the content declarative
 * prevents new Telegram UX from leaking into the provider-neutral agent
 * runtime, while still working for clients that cannot render Rich Messages.
 */
export type TelegramCardButtonStyle = "primary" | "success" | "danger" | "link";

export interface TelegramCardButton {
  text: string;
  callbackData?: string;
  url?: string;
  style?: TelegramCardButtonStyle;
}

export interface TelegramCard {
  title: string;
  body: string[];
  detail?: string;
  buttons?: TelegramCardButton[][];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function buttonHtml(button: TelegramCardButton): string {
  if (!button.callbackData && !button.url) throw new Error("Telegram card button needs callbackData or url");
  if (button.callbackData && button.url) throw new Error("Telegram card button cannot have callbackData and url together");
  const type = button.callbackData ? "callback_data" : "url";
  const target = button.callbackData ? ` data=\"${escapeHtml(button.callbackData)}\"` : ` url=\"${escapeHtml(button.url!)}\"`;
  const style = button.style ? ` style=\"${button.style}\"` : "";
  return `<tg-button type=\"${type}\"${style}${target}>${escapeHtml(button.text)}</tg-button>`;
}

/** Rich Message HTML used by sendRichMessage and editMessageText.rich_message. */
export function telegramCardRichHtml(card: TelegramCard): string {
  const paragraphs = card.body.filter(Boolean).map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  const detail = card.detail ? `<details><summary>Details</summary><p>${escapeHtml(card.detail)}</p></details>` : "";
  const buttons = (card.buttons ?? []).map((row) => `<tg-button-row>${row.map(buttonHtml).join("")}</tg-button-row>`).join("");
  return `<h3>${escapeHtml(card.title)}</h3>${paragraphs}${detail}${buttons}`;
}

/** Legacy HTML used with standard Telegram messages when Rich Messages fail. */
export function telegramCardFallbackHtml(card: TelegramCard): string {
  const paragraphs = card.body.filter(Boolean).map(escapeHtml).join("\n\n");
  const detail = card.detail ? `\n\n<b>Details</b>\n${escapeHtml(card.detail)}` : "";
  return `<b>${escapeHtml(card.title)}</b>${paragraphs ? `\n\n${paragraphs}` : ""}${detail}`;
}

/** Raw Bot API inline keyboard fallback. Callback payloads remain durable IDs. */
export function telegramCardFallbackKeyboard(card: TelegramCard): InlineKeyboard | undefined {
  if (!card.buttons?.length) return undefined;
  const keyboard = new InlineKeyboard();
  card.buttons.forEach((row, rowIndex) => {
    row.forEach((button) => {
      if (!button.callbackData && !button.url) throw new Error("Telegram card button needs callbackData or url");
      if (button.callbackData && button.url) throw new Error("Telegram card button cannot have callbackData and url together");
      if (button.callbackData) keyboard.text(button.text, button.callbackData);
      else keyboard.url(button.text, button.url!);
    });
    if (rowIndex + 1 < card.buttons!.length) keyboard.row();
  });
  return keyboard;
}
