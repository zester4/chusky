import { randomUUID } from "node:crypto";
import type { BrowserTraceEvent } from "../browser-runtime/types.js";

export function browserTraceEvent(input: Omit<BrowserTraceEvent, "id" | "createdAt">): BrowserTraceEvent {
  return { ...input, id: `bt_${randomUUID()}`, createdAt: Date.now() };
}

export function redactBrowserTrace(events: BrowserTraceEvent[], limit = 100): Array<Omit<BrowserTraceEvent, "ownerId">> {
  return events.slice(-Math.max(1, Math.min(100, limit))).map(({ ownerId: _ownerId, ...event }) => event);
}
