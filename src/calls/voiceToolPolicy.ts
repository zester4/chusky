/**
 * The connected-app grant for one phone call.
 *
 * This is deliberately a small policy snapshot, not a copy of Composio's
 * catalogue. A call should receive only the app/account metadata needed to
 * route its objective; exact action schemas are still resolved lazily by the
 * normal Composio/JEV path.
 */
export interface VoiceToolPolicy {
  /** False means the call may use native voice context only. */
  enabled: boolean;
  /** Empty means use the existing purpose router without an app restriction. */
  allowedToolkits: string[];
  /** Empty means use the normal account resolver for an allowed toolkit. */
  allowedConnectionIds: string[];
  /** When false, connected-app writes are blocked before provider dispatch. */
  allowExternalWrites: boolean;
  /** Versioned so a persisted call is auditable when the UI policy changes. */
  version: 1;
}

export interface VoiceToolPolicyInput {
  enabled?: unknown;
  allowedToolkits?: unknown;
  allowedConnectionIds?: unknown;
  allowExternalWrites?: unknown;
}

const MAX_TOOLKITS = 24;
const MAX_CONNECTIONS = 48;

function clean(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, "").trim().toLowerCase();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function list(value: unknown, maximum: number, itemMaximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item, itemMaximum)).filter((item): item is string => Boolean(item)))].slice(0, maximum);
}

export function normalizeVoiceToolPolicy(value: unknown): VoiceToolPolicy {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as VoiceToolPolicyInput : {};
  return {
    enabled: input.enabled !== false,
    allowedToolkits: list(input.allowedToolkits, MAX_TOOLKITS, 100),
    allowedConnectionIds: list(input.allowedConnectionIds, MAX_CONNECTIONS, 200),
    allowExternalWrites: input.allowExternalWrites !== false,
    version: 1,
  };
}

export function voiceToolPolicyIsRestricted(policy: VoiceToolPolicy | undefined): boolean {
  return Boolean(policy && (!policy.enabled || policy.allowedToolkits.length || policy.allowedConnectionIds.length || !policy.allowExternalWrites));
}

/** Normalize the common provider/toolkit spelling differences at the policy boundary. */
export function normalizeVoiceToolkit(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const ACTION_PREFIX_ALIASES: Record<string, string> = {
  GOOGLECALENDAR: "googlecalendar",
  GOOGLECALENDARTOOL: "googlecalendar",
  GMAIL: "gmail",
  HUBSPOT: "hubspot",
  ZENDESK: "zendesk",
  STRIPE: "stripe",
  SHOPIFY: "shopify",
  GOOGLESHEETS: "googlesheets",
  GOOGLEDOCS: "googledocs",
  GOOGLEMEET: "googlemeet",
  RECALLAI: "recallai",
  SLACK: "slack",
  DISCORD: "discord",
  TELEGRAM: "telegram",
  TWILIO: "twilio",
};

/** Best-effort mapping for exact Composio action slugs. Provider metadata remains authoritative when available. */
export function voiceToolkitForAction(toolSlug: string): string | undefined {
  const slug = toolSlug.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(slug) || slug.startsWith("CHUCK_") || slug.startsWith("COMPOSIO_") || slug.startsWith("MCP_")) return undefined;
  const prefix = slug.split("_", 1)[0] ?? "";
  return ACTION_PREFIX_ALIASES[prefix] ?? prefix.toLowerCase();
}

export function voiceToolkitAllowed(toolSlug: string, policy: VoiceToolPolicy | undefined): boolean {
  if (!policy || (!policy.allowedToolkits.length && policy.enabled)) return true;
  if (!policy.enabled) return false;
  const toolkit = voiceToolkitForAction(toolSlug);
  if (!toolkit) return true;
  if (!policy.allowedToolkits.length) return true;
  const wanted = new Set(policy.allowedToolkits.map(normalizeVoiceToolkit));
  return wanted.has(normalizeVoiceToolkit(toolkit));
}

function accountSelector(args: Record<string, unknown>): string | undefined {
  for (const key of ["account", "connectedAccountId", "connected_account_id"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return undefined;
}

export function voicePolicyAllowsAccount(args: Record<string, unknown>, policy: VoiceToolPolicy | undefined, allowedAccounts: Array<{ id: string; alias?: string }> = []): boolean {
  if (!policy || !policy.allowedConnectionIds.length) return true;
  const selected = accountSelector(args);
  if (!selected) return allowedAccounts.length === 1;
  const allowed = new Set(policy.allowedConnectionIds.map((item) => item.toLowerCase()));
  return allowed.has(selected) || allowedAccounts.some((account) => allowed.has(account.id.toLowerCase()) && account.alias?.toLowerCase() === selected);
}

/** Add the only permitted account as the explicit Composio selector. */
export function bindVoicePolicyAccount(args: Record<string, unknown>, policy: VoiceToolPolicy | undefined, allowedAccounts: Array<{ id: string; alias?: string }>): Record<string, unknown> {
  if (!policy?.allowedConnectionIds.length || accountSelector(args) || allowedAccounts.length !== 1) return args;
  return { ...args, account: allowedAccounts[0]!.id };
}

function nestedActions(slug: string, args: Record<string, unknown>): Array<{ slug: string; args: Record<string, unknown> }> {
  if (slug === "COMPOSIO_EXECUTE_TOOL") {
    const target = args.tool_slug ?? args.toolSlug ?? args.slug;
    const nested = args.arguments ?? args.input ?? args.tool_arguments;
    return typeof target === "string" && nested && typeof nested === "object" && !Array.isArray(nested)
      ? [{ slug: target, args: nested as Record<string, unknown> }]
      : [];
  }
  if (slug === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const items = Array.isArray(args.tools) ? args.tools : Array.isArray(args.items) ? args.items : [];
    return items.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const target = row.tool_slug ?? row.toolSlug ?? row.slug;
      const nested = row.arguments ?? row.input;
      return typeof target === "string" && nested && typeof nested === "object" && !Array.isArray(nested)
        ? [{ slug: target, args: nested as Record<string, unknown> }]
        : [];
    });
  }
  return [{ slug, args }];
}

/** Final trusted execution fence; model visibility alone is not an authorization boundary. */
export function voicePolicyAllowsExecution(slug: string, args: Record<string, unknown>, policy: VoiceToolPolicy | undefined, allowedAccounts: Array<{ id: string; alias?: string }> = []): boolean {
  if (!policy || (!policy.allowedToolkits.length && policy.enabled && policy.allowExternalWrites)) return true;
  if (!policy.enabled) return false;
  const targets = nestedActions(slug, args);
  if (targets.length === 0 && ["COMPOSIO_EXECUTE_TOOL", "COMPOSIO_MULTI_EXECUTE_TOOL"].includes(slug)) return false;
  return targets.every((target) => voiceToolkitAllowed(target.slug, policy)
    && (policy.allowExternalWrites || !/^COMPOSIO_|^MCP_/.test(target.slug) && !/^(?:[A-Z][A-Z0-9]*_)(?:CREATE|UPDATE|DELETE|SEND|POST|PATCH|CANCEL|BOOK|REFUND|CHARGE|TRANSFER|UPLOAD|PUBLISH)/.test(target.slug))
    && voicePolicyAllowsAccount(target.args, policy, allowedAccounts));
}

export function voicePolicyInstructions(policy: VoiceToolPolicy | undefined): string {
  const safe = normalizeVoiceToolPolicy(policy);
  if (!voiceToolPolicyIsRestricted(policy)) return "Connected-app policy: use the existing purpose-routed owner connections; exact action schemas and normal approvals remain authoritative.";
  if (!safe.enabled) return "Connected-app policy: disabled for this call. Use native call context only and explain when an external app action is unavailable.";
  const apps = safe.allowedToolkits.length ? safe.allowedToolkits.join(", ") : "the selected owner connections";
  return `Connected-app policy: this call may use only ${apps}. ${safe.allowedConnectionIds.length ? "Use only the selected connected accounts; do not switch accounts based on caller speech." : "Resolve an active owner connection through the normal Composio account resolver."} ${safe.allowExternalWrites ? "Routine writes remain subject to Chusky's existing approval and provider-receipt rules." : "External writes are disabled; read-only lookups only."}`;
}
