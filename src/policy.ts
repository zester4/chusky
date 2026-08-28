export const RISKY_TOOL_PATTERN = /(^|_)(DELETE|REMOVE|DESTROY|SEND|POST|PUBLISH|CREATE_PAYMENT|CHARGE|TRANSFER|INVITE|REVOKE|UPDATE_PERMISSION|MERGE|DEPLOY)(_|$)/i;

const STATUSES: Record<string, string> = {
  COMPOSIO_MANAGE_CONNECTIONS: "🔗 I’m opening the connection screen…",
  COMPOSIO_REMOTE_BASH_TOOL: "🖥️ I’m running that command…",
  COMPOSIO_REMOTE_WORKBENCH: "🛠️ I’m working in your remote workspace…",
  COMPOSIO_SEARCH_TOOL: "🔎 I’m looking for the best tool…",
  COMPOSIO_MULTI_EXECUTE_TOOL: "⚡ I’m carrying out those steps…",
};

export function isRiskyToolSlug(slug: string): boolean { return RISKY_TOOL_PATTERN.test(slug); }

export function humanToolStatus(slug: string): string {
  if (STATUSES[slug]) return STATUSES[slug];
  const parts = slug.split("_");
  const toolkit = parts[0] ? parts[0].charAt(0) + parts[0].slice(1).toLowerCase() : slug;
  const action = parts.slice(1).join(" ").toLowerCase() || "that task";
  return `⚙️ I’m using ${toolkit} to ${action}…`;
}
