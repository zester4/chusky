import { randomUUID } from "node:crypto";

/** Provider-neutral, owner-safe lifecycle events for a phone call. */
export type VoiceCallEventType =
  | "call_started"
  | "call_answered"
  | "voicemail_detected"
  | "handoff_requested"
  | "handoff_started"
  | "handoff_failed"
  | "tool_started"
  | "tool_completed"
  | "tool_failed"
  | "turn_started"
  | "turn_completed"
  | "turn_interrupted"
  | "call_ended"
  | "call_failed";

export interface VoiceCallEvent {
  id: string;
  type: VoiceCallEventType;
  at: number;
  summary: string;
  toolSlug?: string;
  /** Provider receipt reference captured at the trusted execution boundary. */
  receiptId?: string;
  durationMs?: number;
}

export interface VoiceCallEventInput {
  type: VoiceCallEventType;
  summary: string;
  at?: number;
  toolSlug?: string;
  receiptId?: string;
  durationMs?: number;
}

const EVENT_TYPES = new Set<VoiceCallEventType>([
  "call_started", "call_answered", "voicemail_detected", "handoff_requested", "handoff_started", "handoff_failed",
  "tool_started", "tool_completed", "tool_failed", "turn_started", "turn_completed", "turn_interrupted", "call_ended", "call_failed",
]);

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
    : "";
}

export function createVoiceCallEvent(input: VoiceCallEventInput): VoiceCallEvent {
  const summary = boundedText(input.summary, 500);
  if (!EVENT_TYPES.has(input.type) || !summary) throw new Error("A voice call event requires a supported type and summary");
  const at = typeof input.at === "number" && Number.isFinite(input.at) ? Math.max(0, Math.floor(input.at)) : Date.now();
  const toolSlug = boundedText(input.toolSlug, 160).toUpperCase();
  const receiptId = boundedText(input.receiptId, 240);
  const durationMs = typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0
    ? Math.min(Math.floor(input.durationMs), 86_400_000)
    : undefined;
  return { id: `vce_${randomUUID()}`, type: input.type, at, summary, ...(toolSlug ? { toolSlug } : {}), ...(receiptId ? { receiptId } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
}

export function normalizeVoiceCallEvents(value: unknown): VoiceCallEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): VoiceCallEvent[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const type = typeof row.type === "string" && EVENT_TYPES.has(row.type as VoiceCallEventType) ? row.type as VoiceCallEventType : undefined;
    const id = typeof row.id === "string" && /^vce_[A-Za-z0-9_-]{1,96}$/.test(row.id) ? row.id : undefined;
    const at = typeof row.at === "number" && Number.isFinite(row.at) ? Math.max(0, Math.floor(row.at)) : undefined;
    const summary = boundedText(row.summary, 500);
    if (!type || !id || at === undefined || !summary) return [];
    const toolSlug = boundedText(row.toolSlug, 160).toUpperCase();
    const receiptId = boundedText(row.receiptId, 240);
    const durationMs = typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0 ? Math.min(Math.floor(row.durationMs), 86_400_000) : undefined;
    return [{ id, type, at, summary, ...(toolSlug ? { toolSlug } : {}), ...(receiptId ? { receiptId } : {}), ...(durationMs !== undefined ? { durationMs } : {}) }];
  }).slice(-200);
}
