import { randomUUID } from "node:crypto";
import type { BrowserObservation, BrowserTraceEvent } from "./contracts.js";

export class TraceSink {
  private readonly events: BrowserTraceEvent[] = [];
  constructor(private readonly maxEvents = 500) {}

  add(event: Omit<BrowserTraceEvent, "id" | "createdAt">): BrowserTraceEvent {
    const safe: BrowserTraceEvent = { ...event, id: `br_${randomUUID()}`, createdAt: Date.now() };
    this.events.push(safe);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    return safe;
  }

  observation(event: Omit<BrowserTraceEvent, "id" | "createdAt" | "phase" | "status">, observation: BrowserObservation, status: "started" | "succeeded" | "failed" | "waiting" | "replanned"): BrowserTraceEvent {
    return this.add({ ...event, phase: "observe", status, provider: observation.provider, urlOrigin: observation.origin, pageGeneration: observation.pageGeneration, accessibilityHash: observation.accessibilityHash, screenshotHash: observation.screenshot?.hash });
  }

  list(): BrowserTraceEvent[] { return this.events.map((event) => ({ ...event })); }
}
