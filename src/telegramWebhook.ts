import { timingSafeEqual } from "node:crypto";

export interface TelegramWebhookUpdate {
  update_id?: number;
  [key: string]: unknown;
}

/**
 * Validate Telegram's secret header before handing an update to grammY.
 * Comparing buffers avoids making the configured secret observable through
 * timing differences. An empty configured secret means Telegram validation is
 * intentionally disabled for local/non-webhook setups.
 */
export function verifyTelegramWebhookSecret(actual: string | undefined, expected: string): boolean {
  if (!expected) return true;
  const received = Buffer.from(actual ?? "", "utf8");
  const configured = Buffer.from(expected, "utf8");
  return received.length === configured.length && timingSafeEqual(received, configured);
}

export function parseTelegramWebhookUpdate(rawBody: string): TelegramWebhookUpdate | undefined {
  try {
    const value: unknown = JSON.parse(rawBody);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const update = value as TelegramWebhookUpdate;
    if (update.update_id !== undefined && !Number.isSafeInteger(update.update_id)) return undefined;
    return update;
  } catch {
    return undefined;
  }
}
