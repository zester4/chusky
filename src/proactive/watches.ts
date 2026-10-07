import type { AutonomyWatchRecord } from "../store.js";
import { PROACTIVE_CAPABILITIES } from "./catalog.js";

export interface ProactiveWatchDefinition {
  capabilityId: string;
  domain: string;
  toolkit: string;
  readOnly: true;
  suggestedQuery: string;
}

export interface DefaultWatchSpec {
  key: string;
  name: string;
  domain: string;
  toolkit: string;
  objective: string;
  query: string;
  maxItems: number;
  cadenceSeconds: number;
  capabilityIds: string[];
}

/**
 * These are intentionally read-only starter watches. They are created only
 * after the owner explicitly enables Attention Pulse and remain ordinary
 * owner-configured watches thereafter.
 */
export const DEFAULT_PROACTIVE_WATCHES: readonly DefaultWatchSpec[] = [
  { key: "gmail-recent", name: "Recent inbox", domain: "gmail", toolkit: "gmail", objective: "Check the newest owner inbox messages and identify meaningful changes, urgent requests, commitments, invoices, and messages needing a reply.", query: "Gmail newest five inbox messages read only", maxItems: 5, cadenceSeconds: 3600, capabilityIds: ["inbox_priority_scan", "unanswered_message", "important_person_monitor", "email_commitment", "attachment_triage", "invoice_detection"] },
  { key: "calendar-upcoming", name: "Upcoming calendar", domain: "calendar", toolkit: "googlecalendar", objective: "Check the next 24 hours of the owner's calendar for meetings, conflicts, missing links, preparation needs, and deadlines.", query: "Google Calendar upcoming events next 24 hours read only", maxItems: 20, cadenceSeconds: 3600, capabilityIds: ["tomorrow_briefing", "meeting_preparation", "calendar_conflict", "post_meeting_follow_through", "deadline_watch"] },
];

const TOOLKIT_BY_DOMAIN: Record<string, string> = {
  gmail: "gmail", outlook: "outlook", email: "gmail", calendar: "googlecalendar", billing: "stripe", stripe: "stripe",
  crm: "hubspot", hubspot: "hubspot", salesforce: "salesforce", slack: "slack", discord: "discord", teams: "microsoftteams",
  drive: "googledrive", notion: "notion", github: "github", linear: "linear", jira: "jira", tasks: "linear", projects: "linear",
  sheets: "googlesheets", attention: "chusky", all: "chusky",
};

/** Every catalogue behavior has a typed, read-only watch contract. */
export const PROACTIVE_WATCH_DEFINITIONS: readonly ProactiveWatchDefinition[] = PROACTIVE_CAPABILITIES.map((capability) => {
  const domain = capability.domains.find((item) => item !== "all" && item !== "attention") ?? capability.domains[0] ?? "attention";
  return {
    capabilityId: capability.id,
    domain,
    toolkit: TOOLKIT_BY_DOMAIN[domain] ?? domain,
    readOnly: true,
    suggestedQuery: capability.title,
  } satisfies ProactiveWatchDefinition;
});

export function proactiveWatchDefinition(capabilityId: string): ProactiveWatchDefinition | undefined {
  return PROACTIVE_WATCH_DEFINITIONS.find((definition) => definition.capabilityId === capabilityId);
}

export function normalizeProactiveCapabilityIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error("capabilityIds must be an array with at most 20 registered proactive capabilities.");
  const ids = [...new Set(value.map((item) => String(item).trim()))].filter(Boolean);
  const unknown = ids.filter((id) => !proactiveWatchDefinition(id));
  if (unknown.length) throw new Error(`Unknown proactive capability ID(s): ${unknown.join(", ")}`);
  return ids;
}

export function defaultWatchInput(spec: DefaultWatchSpec, now = Date.now()): Record<string, unknown> {
  return {
    name: spec.name,
    domain: spec.domain,
    toolkit: spec.toolkit,
    objective: spec.objective,
    query: spec.query,
    cadenceSeconds: spec.cadenceSeconds,
    authority: "observe",
    mode: "personal",
    status: "active",
    maxItems: spec.maxItems,
    capabilityIds: spec.capabilityIds,
    nextCheckAt: now,
    freshnessMs: 2 * 60 * 60_000,
  };
}

export function watchCapabilityIds(watch: Pick<AutonomyWatchRecord, "capabilityIds" | "domain">): string[] {
  return watch.capabilityIds?.length ? [...new Set(watch.capabilityIds)] : [];
}

export function missingDefaultWatchKeys(existing: readonly AutonomyWatchRecord[]): DefaultWatchSpec[] {
  const names = new Set(existing.filter((watch) => watch.status !== "revoked").map((watch) => `${watch.domain}:${watch.name}`.toLowerCase()));
  return DEFAULT_PROACTIVE_WATCHES.filter((spec) => !names.has(`${spec.domain}:${spec.name}`.toLowerCase()));
}
