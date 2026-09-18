export type ComposioDomain = "ecommerce" | "crm" | "billing" | "support" | "communications" | "scheduling" | "research";

export interface ComposioRoute {
  domain: ComposioDomain;
  preferredToolkits: string[];
  connectedToolkits: string[];
  needsConnection: boolean;
}

const ROUTES: Array<{ domain: ComposioDomain; terms: string[]; toolkits: string[] }> = [
  { domain: "ecommerce", terms: ["shopify", "store", "commerce", "order", "inventory", "product"], toolkits: ["shopify", "woocommerce"] },
  { domain: "crm", terms: ["crm", "lead", "prospect", "pipeline", "deal", "salesforce", "hubspot"], toolkits: ["hubspot", "salesforce", "pipedrive"] },
  { domain: "billing", terms: ["billing", "invoice", "payment", "subscription", "stripe", "collections"], toolkits: ["stripe"] },
  { domain: "support", terms: ["support", "ticket", "zendesk", "intercom", "incident"], toolkits: ["zendesk", "intercom"] },
  { domain: "communications", terms: ["email", "inbox", "slack", "message", "outreach"], toolkits: ["gmail", "slack"] },
  { domain: "scheduling", terms: ["calendar", "schedule", "meeting", "appointment"], toolkits: ["googlecalendar", "calendly"] },
  { domain: "research", terms: ["research", "web search", "competitor", "sources", "evidence"], toolkits: ["tavily", "exa", "firecrawl"] },
];

function normal(value: string): string { return value.toLowerCase().replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(); }

/** Resolve the sold-domain app family before any long-tail Composio search. */
export function resolveComposioRoute(objective: string, connectedToolkits: string[] = []): ComposioRoute | undefined {
  const text = normal(objective);
  const matched = ROUTES.find((route) => route.terms.some((term) => text.includes(term)));
  if (!matched) return undefined;
  const connected = new Set(connectedToolkits.map((toolkit) => normal(toolkit).replace(/[^a-z0-9]/g, "")));
  const active = matched.toolkits.filter((toolkit) => connected.has(toolkit.replace(/[^a-z0-9]/g, "")));
  return { domain: matched.domain, preferredToolkits: matched.toolkits, connectedToolkits: active, needsConnection: active.length === 0 };
}

export function missingComposioConnectionMessage(route: ComposioRoute): string {
  return `The ${route.domain} workflow maps to ${route.preferredToolkits.join(" or ")}, but none is connected. Connect the mapped app in Chusky, then retry this task; no unrelated toolkit will be selected.`;
}
