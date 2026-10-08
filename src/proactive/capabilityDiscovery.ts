import { PROACTIVE_CAPABILITIES } from "./catalog.js";

export interface CapabilityDiscoveryAccount {
  toolkit: string;
  status?: string;
}

export interface CapabilityGapSuggestion {
  key: string;
  title: string;
  reason: string;
  proposedAction: string;
  capabilityIds: string[];
  score: number;
  candidateType: "ask";
  expectedToolkits: string[];
}

export interface ConnectedActionMetadata {
  toolkit: string;
  slug: string;
  name?: string;
  description?: string;
}

export interface ConnectedCapabilityGapSuggestion {
  key: string;
  title: string;
  reason: string;
  proposedAction: string;
  score: number;
  candidateType: "ask";
}

type CapabilityGapDefinition = {
  key: string;
  title: string;
  expectedToolkits: string[];
  capabilityIds: string[];
  score: number;
  unlocks: string;
  action: string;
};

const GAP_DEFINITIONS: readonly CapabilityGapDefinition[] = [
  {
    key: "gmail",
    title: "Connect Gmail",
    expectedToolkits: ["gmail", "googlemail", "outlook", "microsoftoutlook", "email"],
    capabilityIds: ["inbox_priority_scan", "unanswered_message", "email_commitment", "invoice_detection"],
    score: 0.95,
    unlocks: "bounded inbox reviews, urgent-message detection, unanswered-reply detection, commitment tracking, and review-ready drafts",
    action: "Connect Gmail from Connected Apps, then choose which read-only inbox watch Elena should enable.",
  },
  {
    key: "calendar",
    title: "Connect your calendar",
    expectedToolkits: ["googlecalendar", "calendar", "outlookcalendar", "microsoftoutlookcalendar"],
    capabilityIds: ["tomorrow_briefing", "meeting_preparation", "calendar_conflict", "deadline_watch"],
    score: 0.94,
    unlocks: "tomorrow briefings, meeting preparation, conflict detection, and early deadline reminders",
    action: "Connect a calendar from Connected Apps, then choose the meetings and schedule signals Elena should monitor.",
  },
  {
    key: "documents",
    title: "Connect Drive or Notion",
    expectedToolkits: ["googledrive", "drive", "notion"],
    capabilityIds: ["meeting_preparation", "post_meeting_follow_through", "project_inactivity", "document_change_monitor"],
    score: 0.82,
    unlocks: "document-change monitoring, meeting context, follow-through tracking, and stalled-project detection",
    action: "Connect Google Drive or Notion from Connected Apps so Elena can use the workspace you choose.",
  },
  {
    key: "sheets",
    title: "Connect Google Sheets",
    expectedToolkits: ["googlesheets", "sheets"],
    capabilityIds: ["expense_organization", "cashflow_warning"],
    score: 0.78,
    unlocks: "reviewable expense summaries, receipt organization, and safe cash-flow signals from your spreadsheets",
    action: "Connect Google Sheets from Connected Apps; Elena will keep spreadsheet work read-only until you approve a change.",
  },
  {
    key: "team-communication",
    title: "Connect Slack, Teams, or Discord",
    expectedToolkits: ["slack", "microsoftteams", "teams", "discord"],
    capabilityIds: ["unanswered_message", "important_person_monitor", "team_communication_summary"],
    score: 0.75,
    unlocks: "meaningful mentions, unanswered requests, decisions, and blocked team work without dumping channel history",
    action: "Connect a team channel from Connected Apps and select the workspace Elena may monitor.",
  },
  {
    key: "engineering",
    title: "Connect GitHub, Linear, or Jira",
    expectedToolkits: ["github", "linear", "jira"],
    capabilityIds: ["project_inactivity", "document_change_monitor", "deadline_watch"],
    score: 0.7,
    unlocks: "stalled-project detection, issue and deadline tracking, and concise engineering change summaries",
    action: "Connect the project system you use from Connected Apps so Elena can surface blocked or quiet work.",
  },
  {
    key: "finance",
    title: "Connect billing or payments",
    expectedToolkits: ["stripe", "quickbooks", "xero", "billing"],
    capabilityIds: ["invoice_detection", "subscription_renewal", "cashflow_warning"],
    score: 0.68,
    unlocks: "invoice and renewal alerts, failed-payment signals, and review-ready financial follow-ups",
    action: "Connect a billing system from Connected Apps; payments and other high-impact actions remain approval-gated.",
  },
  {
    key: "crm",
    title: "Connect your CRM",
    expectedToolkits: ["hubspot", "salesforce", "pipedrive", "crm"],
    capabilityIds: ["crm_follow_up", "post_meeting_follow_through", "subscription_renewal"],
    score: 0.65,
    unlocks: "stale-lead detection, missed follow-ups, onboarding risks, and renewal reminders",
    action: "Connect your CRM from Connected Apps so Elena can surface customer work that needs attention.",
  },
] as const;

const capabilityById = new Map(PROACTIVE_CAPABILITIES.map((capability) => [capability.id, capability]));

function normalizeToolkit(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function activeToolkitSet(accounts: readonly CapabilityDiscoveryAccount[]): Set<string> {
  return new Set(accounts
    .filter((account) => !account.status || ["ACTIVE", "CONNECTED", "ENABLED"].includes(account.status.toUpperCase()))
    .map((account) => normalizeToolkit(account.toolkit))
    .filter(Boolean));
}

function readableCapabilities(ids: readonly string[]): string {
  return ids.map((id) => capabilityById.get(id)?.title ?? id).slice(0, 5).join(", ");
}

export function discoverMissingCapabilityGaps(
  accounts: readonly CapabilityDiscoveryAccount[],
  options: { maxSuggestions?: number; priorityText?: string } = {},
): CapabilityGapSuggestion[] {
  const connected = activeToolkitSet(accounts);
  const maxSuggestions = Math.max(1, Math.min(8, Math.floor(options.maxSuggestions ?? 3)));
  const priorityText = (options.priorityText ?? "").toLowerCase();
  const relevance = (definition: CapabilityGapDefinition) => {
    if (!priorityText) return 0;
    const terms = `${definition.title} ${definition.unlocks} ${definition.capabilityIds.join(" ")}`.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3);
    return Math.min(0.12, terms.filter((term) => priorityText.includes(term)).length * 0.025);
  };
  return GAP_DEFINITIONS
    .filter((definition) => !definition.expectedToolkits.some((toolkit) => connected.has(normalizeToolkit(toolkit))))
    .sort((a, b) => (b.score + relevance(b)) - (a.score + relevance(a)))
    .slice(0, maxSuggestions)
    .map((definition) => ({
      key: definition.key,
      title: definition.title,
      reason: `${definition.title} is not connected. Elena could use it for ${definition.unlocks}. Useful capabilities: ${readableCapabilities(definition.capabilityIds)}.`,
      proposedAction: definition.action,
      capabilityIds: [...definition.capabilityIds],
      score: Math.min(0.99, definition.score + relevance(definition)),
      candidateType: "ask" as const,
      expectedToolkits: [...definition.expectedToolkits],
    }));
}

const ACTION_REQUIREMENTS: readonly { key: string; title: string; toolkitKeys: string[]; terms: string[]; score: number }[] = [
  { key: "gmail-action-gap", title: "Gmail action capability", toolkitKeys: ["gmail", "googlemail", "outlook", "microsoftoutlook", "email"], terms: ["email", "message", "thread", "draft", "reply", "send"], score: 0.9 },
  { key: "calendar-action-gap", title: "Calendar action capability", toolkitKeys: ["googlecalendar", "calendar", "outlookcalendar", "microsoftoutlookcalendar"], terms: ["calendar", "event", "meeting", "schedule", "availability"], score: 0.86 },
  { key: "workspace-action-gap", title: "Workspace action capability", toolkitKeys: ["googledrive", "drive", "notion", "googlesheets", "sheets"], terms: ["file", "document", "page", "spreadsheet", "sheet", "record"], score: 0.76 },
  { key: "team-action-gap", title: "Team communication action capability", toolkitKeys: ["slack", "microsoftteams", "teams", "discord"], terms: ["message", "channel", "thread", "conversation", "reply", "send"], score: 0.72 },
  { key: "project-action-gap", title: "Project action capability", toolkitKeys: ["github", "linear", "jira"], terms: ["issue", "project", "task", "comment", "pull", "ticket"], score: 0.68 },
];

export function discoverConnectedActionGaps(
  accounts: readonly CapabilityDiscoveryAccount[],
  actions: readonly ConnectedActionMetadata[],
  options: { maxSuggestions?: number } = {},
): ConnectedCapabilityGapSuggestion[] {
  const active = activeToolkitSet(accounts);
  const maxSuggestions = Math.max(1, Math.min(3, Math.floor(options.maxSuggestions ?? 3)));
  const normalizedActions = actions.map((action) => `${normalizeToolkit(action.toolkit)} ${action.slug} ${action.name ?? ""} ${action.description ?? ""}`.toLowerCase());
  return ACTION_REQUIREMENTS
    .filter((requirement) => requirement.toolkitKeys.some((toolkit) => active.has(normalizeToolkit(toolkit))))
    .filter((requirement) => !normalizedActions.some((action) => requirement.terms.some((term) => action.includes(term))))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSuggestions)
    .map((requirement) => ({
      key: requirement.key,
      title: requirement.title,
      reason: `${requirement.title} is not currently exposed by the connected toolkit catalogue. Elena can see that the app is connected, but she does not have a verified Composio action for this kind of work yet.`,
      proposedAction: "Review the connected app's available Composio actions or add the required capability before asking Elena to perform this work.",
      score: requirement.score,
      candidateType: "ask" as const,
    }));
}
