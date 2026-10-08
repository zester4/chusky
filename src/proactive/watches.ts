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

export interface ConnectedWatchAccount {
  id: string;
  toolkit: string;
  alias?: string;
  status?: string;
}

export interface ConnectedWatchSpec extends DefaultWatchSpec {
  connectedAccountId: string;
  accountAlias?: string;
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

/**
 * Bounded read-only starter watches for services that are already connected.
 * These are deliberately separate from the two universal Gmail/calendar
 * starters so a new connection never widens an owner's monitoring scope to a
 * provider they did not connect. One watch is created per connected account.
 */
const CONNECTED_APP_WATCHES: readonly (DefaultWatchSpec & { toolkits: string[] })[] = [
  { key: "slack-attention", name: "Team messages", domain: "slack", toolkit: "slack", toolkits: ["slack"], objective: "Review recent owner-visible team messages for direct requests, mentions, decisions, and blocked work without dumping channel history.", query: "Slack recent mentions and direct messages read only", maxItems: 12, cadenceSeconds: 3600, capabilityIds: ["unanswered_message", "important_person_monitor", "team_communication_summary"] },
  { key: "teams-attention", name: "Teams messages", domain: "teams", toolkit: "microsoftteams", toolkits: ["microsoftteams", "teams"], objective: "Review recent owner-visible Teams messages for direct requests, decisions, and blocked work.", query: "Microsoft Teams recent mentions and direct messages read only", maxItems: 12, cadenceSeconds: 3600, capabilityIds: ["unanswered_message", "important_person_monitor", "team_communication_summary"] },
  { key: "discord-attention", name: "Discord messages", domain: "discord", toolkit: "discord", toolkits: ["discord"], objective: "Review recent owner-visible Discord messages for direct requests, decisions, and blocked work.", query: "Discord recent mentions and direct messages read only", maxItems: 12, cadenceSeconds: 3600, capabilityIds: ["unanswered_message", "important_person_monitor", "team_communication_summary"] },
  { key: "drive-changes", name: "Drive changes", domain: "drive", toolkit: "googledrive", toolkits: ["googledrive", "drive"], objective: "Check recent owner-visible Drive changes that may affect active work, meetings, or documents.", query: "Google Drive recently changed owner-visible files read only", maxItems: 10, cadenceSeconds: 3600, capabilityIds: ["document_change_monitor", "meeting_preparation", "project_inactivity"] },
  { key: "notion-changes", name: "Notion changes", domain: "notion", toolkit: "notion", toolkits: ["notion"], objective: "Check recent owner-visible Notion page changes that may affect active work or follow-through.", query: "Notion recently edited owner-visible pages read only", maxItems: 10, cadenceSeconds: 3600, capabilityIds: ["document_change_monitor", "meeting_preparation", "project_inactivity"] },
  { key: "github-work", name: "GitHub work", domain: "github", toolkit: "github", toolkits: ["github"], objective: "Check recent owner-visible GitHub issues, pull requests, reviews, and failures for work that needs attention.", query: "GitHub recently updated issues pull requests reviews and checks read only", maxItems: 12, cadenceSeconds: 3600, capabilityIds: ["project_inactivity", "deadline_watch", "document_change_monitor"] },
  { key: "linear-work", name: "Linear work", domain: "linear", toolkit: "linear", toolkits: ["linear"], objective: "Check recent owner-visible Linear issues and project changes for blocked or stalled work.", query: "Linear recently updated issues and projects read only", maxItems: 12, cadenceSeconds: 3600, capabilityIds: ["project_inactivity", "deadline_watch", "stalled_task_recovery"] },
  { key: "jira-work", name: "Jira work", domain: "jira", toolkit: "jira", toolkits: ["jira"], objective: "Check recent owner-visible Jira issues and project changes for blocked or stalled work.", query: "Jira recently updated issues and projects read only", maxItems: 12, cadenceSeconds: 3600, capabilityIds: ["project_inactivity", "deadline_watch", "stalled_task_recovery"] },
  { key: "sheets-finance", name: "Sheets signals", domain: "sheets", toolkit: "googlesheets", toolkits: ["googlesheets", "sheets"], objective: "Review recent owner-visible spreadsheet changes for expense, cash-flow, or deadline signals without editing the sheet.", query: "Google Sheets recently changed owner-visible spreadsheets read only", maxItems: 8, cadenceSeconds: 3600, capabilityIds: ["expense_organization", "cashflow_warning", "deadline_watch"] },
  { key: "stripe-billing", name: "Billing signals", domain: "stripe", toolkit: "stripe", toolkits: ["stripe"], objective: "Review recent owner-visible billing changes for failed payments, invoices, renewals, or cash-flow signals without changing billing state.", query: "Stripe recent invoices subscriptions and payment failures read only", maxItems: 10, cadenceSeconds: 3600, capabilityIds: ["invoice_detection", "subscription_renewal", "cashflow_warning"] },
  { key: "hubspot-followups", name: "CRM follow-ups", domain: "hubspot", toolkit: "hubspot", toolkits: ["hubspot"], objective: "Review recent owner-visible CRM changes for stale leads, missed follow-ups, and renewal risk without editing records.", query: "HubSpot recent contacts deals and activities needing follow up read only", maxItems: 10, cadenceSeconds: 3600, capabilityIds: ["crm_follow_up", "post_meeting_follow_through", "subscription_renewal"] },
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

export function connectedWatchSpecs(accounts: readonly ConnectedWatchAccount[]): ConnectedWatchSpec[] {
  const specs: ConnectedWatchSpec[] = [];
  for (const account of accounts) {
    if (!account.id || !account.toolkit || (account.status && !["ACTIVE", "CONNECTED", "ENABLED"].includes(account.status.toUpperCase()))) continue;
    const toolkit = account.toolkit.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const template of CONNECTED_APP_WATCHES) {
      if (!template.toolkits.some((candidate) => candidate.toLowerCase().replace(/[^a-z0-9]/g, "") === toolkit)) continue;
      const { toolkits: _toolkits, ...spec } = template;
      specs.push({ ...spec, connectedAccountId: account.id, ...(account.alias ? { accountAlias: account.alias } : {}) });
    }
  }
  return specs.slice(0, 12);
}

export function connectedWatchInput(spec: ConnectedWatchSpec, now = Date.now()): Record<string, unknown> {
  return { ...defaultWatchInput(spec, now), connectedAccountId: spec.connectedAccountId, ...(spec.accountAlias ? { accountAlias: spec.accountAlias } : {}) };
}

export function watchCapabilityIds(watch: Pick<AutonomyWatchRecord, "capabilityIds" | "domain">): string[] {
  return watch.capabilityIds?.length ? [...new Set(watch.capabilityIds)] : [];
}

export function missingDefaultWatchKeys(existing: readonly AutonomyWatchRecord[]): DefaultWatchSpec[] {
  const names = new Set(existing.filter((watch) => watch.status !== "revoked").map((watch) => `${watch.domain}:${watch.name}`.toLowerCase()));
  return DEFAULT_PROACTIVE_WATCHES.filter((spec) => !names.has(`${spec.domain}:${spec.name}`.toLowerCase()));
}
