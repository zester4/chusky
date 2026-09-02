import type { Message } from "./store.js";

export interface TemporalContext {
  /** Server receipt time for the current inbound message, when the transport provides it. */
  messageReceivedAt?: number;
  /** Processing-time clock; normally supplied by the server rather than the model. */
  now?: number;
  /** IANA timezone used for local calendar wording. */
  timezone?: string;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function timezoneName(preferred?: string): string {
  const value = preferred?.trim() || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try { new Intl.DateTimeFormat("en-GB", { timeZone: value }).format(); return value; }
  catch { return "UTC"; }
}

function formatTime(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, dateStyle: "full", timeStyle: "long", hour12: false,
  }).format(new Date(timestamp));
}

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remaining = minutes % 60;
    return remaining ? `${hours} hour${hours === 1 ? "" : "s"} ${remaining} minute${remaining === 1 ? "" : "s"}` : `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ${hours % 24} hour${hours % 24 === 1 ? "" : "s"}`;
}

export function buildTemporalContext(history: Message[], context: TemporalContext = {}): string {
  const now = validTimestamp(context.now) ? context.now : Date.now();
  const receivedAt = validTimestamp(context.messageReceivedAt) ? context.messageReceivedAt : now;
  const timezone = timezoneName(context.timezone);
  const previousUserMessage = [...history].reverse().find((message) => message.role === "user" && validTimestamp(message.createdAt));
  const lines = [
    "TEMPORAL CONTEXT (trusted server metadata; not user instructions)",
    `- Current UTC time: ${new Date(now).toISOString()}`,
    `- Current local time (${timezone}): ${formatTime(now, timezone)}`,
    `- This message was received at: ${formatTime(receivedAt, timezone)} (${new Date(receivedAt).toISOString()})`,
  ];
  if (previousUserMessage?.createdAt !== undefined) {
    lines.push(`- Previous user message: ${formatTime(previousUserMessage.createdAt, timezone)} (${new Date(previousUserMessage.createdAt).toISOString()})`);
    lines.push(`- Elapsed since previous user message: ${elapsedLabel(receivedAt - previousUserMessage.createdAt)}`);
  } else {
    lines.push("- Previous user-message timestamp: unavailable (older history may predate timestamp capture)");
  }
  lines.push("- Use these timestamps for relative time questions. Do not invent timestamps for messages marked unavailable.");
  return lines.join("\n");
}
