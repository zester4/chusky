import { config } from "../config.js";
import { composioDecisionContext, routeComposioForTurn, type ComposioAction, type ComposioToolkitInfo } from "../decisions/composioRouter.js";
import { routeSkillsForTurn } from "../decisions/skillRouter.js";
import { createRoutingDeadline, type JevClient } from "../decisions/jev.js";
import type { AutonomyDecisionContext } from "./decisionContext.js";
import { WORKER_CAPABILITIES } from "../subagents/capabilities.js";
import type { CapabilityWorkerName } from "../memory/types.js";

export type ProactiveRoute = {
  worker: CapabilityWorkerName;
  allowedComposioTools: string[];
  approvalPolicy: "auto" | "require_chusky_approval";
  skillNames: string[];
  composioContext: string;
  reason: string;
};

export type ProactiveRouterDeps = {
  accounts: Array<{ toolkit: string; status?: string }>;
  listActions: (toolkit: string, signal?: AbortSignal) => Promise<ComposioAction[]>;
  listToolkits?: (signal?: AbortSignal) => Promise<ComposioToolkitInfo[]>;
  root?: string;
  client?: JevClient;
};

function workerAllows(worker: CapabilityWorkerName, slug: string): boolean {
  const upper = slug.toUpperCase();
  return WORKER_CAPABILITIES[worker].allowedComposioPrefixes.some((prefix) => upper.startsWith(prefix));
}

function actionWorker(slug: string, description: string): CapabilityWorkerName | undefined {
  const upper = slug.toUpperCase();
  const text = `${upper} ${description}`.toLowerCase();
  if (upper.startsWith("GOOGLECALENDAR_")) return "elena";
  if (upper.startsWith("GMAIL_")) return /send|reply|draft|forward/.test(text) ? "ivy" : "nora";
  if (upper.startsWith("SLACK_") || upper.startsWith("DISCORD_") || upper.startsWith("INTERCOM_") || upper.startsWith("ZENDESK_")) return "ivy";
  if (upper.startsWith("HUBSPOT_") || upper.startsWith("SALESFORCE_") || upper.startsWith("PIPEDRIVE_") || upper.startsWith("STRIPE_") || upper.startsWith("SHOPIFY_")) return "quinn";
  if (upper.startsWith("GOOGLESHEETS_") || upper.startsWith("BIGQUERY_") || upper.startsWith("SNOWFLAKE_")) return "kai";
  if (upper.startsWith("TAVILY_") || upper.startsWith("EXA_") || upper.startsWith("FIRECRAWL_")) return "nora";
  if (upper.startsWith("LINKEDIN_") || upper.startsWith("TWITTER_") || upper.startsWith("X_")) return "maya";
  const candidates: CapabilityWorkerName[] = ["ivy", "quinn", "aria", "nora", "elena", "maya", "kai"];
  return candidates.find((worker) => workerAllows(worker, slug));
}

function hasReversibleAuthority(context: AutonomyDecisionContext, toolkit: string, slug: string): boolean {
  const needle = `${toolkit} ${slug}`.toLowerCase();
  const orderMatch = context.standingOrders.some((order) => {
    if (order.authority !== "execute_reversible") return false;
    const scope = order.scope.join(" ").toLowerCase();
    return !scope || scope === "general" || needle.includes(scope) || scope.split(/[,\s]+/).some((term) => term.length > 2 && needle.includes(term));
  });
  const watchMatch = context.watches.some((watch) => watch.authority === "execute_reversible" && `${watch.domain} ${watch.objective}`.toLowerCase().split(/\s+/).some((term) => term.length > 2 && needle.includes(term)));
  return orderMatch || watchMatch;
}

/**
 * Route one proactive slice without granting authority. Jev can select a
 * specialist and an exact connected action, but the worker's allowlist and
 * normal policy still decide whether anything may execute.
 */
export async function routeProactiveWork(objective: string, context: AutonomyDecisionContext, deps: ProactiveRouterDeps): Promise<ProactiveRoute> {
  const deadline = createRoutingDeadline(config.jevTurnBudgetMs);
  const recentContext = JSON.stringify(context).slice(0, 8_000);
  const [skills, composio] = await Promise.all([
    routeSkillsForTurn(objective, { root: deps.root, recentContext, deadline, client: deps.client }).catch(() => undefined),
    routeComposioForTurn(objective, {
      accounts: deps.accounts,
      listActions: deps.listActions,
      listToolkits: deps.listToolkits,
      recentContext,
      deadline,
      client: deps.client,
    }).catch(() => undefined),
  ]);
  const skillNames = [...(skills?.binding.primary ?? []), ...(skills?.binding.supporting ?? [])].slice(0, 6);
  const directNames = new Set((composio?.directTools ?? []).map((tool) => String((tool as { function?: { name?: string } })?.function?.name ?? "")).filter(Boolean));
  const selectedAction = composio?.actions.find((action) => directNames.has(action.id) && action.connected !== false);
  const worker = selectedAction ? actionWorker(selectedAction.id, selectedAction.description) : undefined;
  const allowed = selectedAction && worker && workerAllows(worker, selectedAction.id) ? [selectedAction.id] : [];
  const effectiveWorker = worker && allowed.length ? worker : "elena";
  const approvalPolicy = selectedAction && allowed.length && hasReversibleAuthority(context, selectedAction.toolkit, selectedAction.id)
    ? "auto"
    : "require_chusky_approval";
  const composioContext = composio ? composioDecisionContext(composio) : "";
  return {
    worker: effectiveWorker,
    allowedComposioTools: allowed,
    approvalPolicy,
    skillNames,
    composioContext,
    reason: selectedAction && allowed.length
      ? `Jev selected ${selectedAction.id} for ${effectiveWorker}; execution remains policy-gated.`
      : "No verified direct connected action was selected; Elena remains the attention governor.",
  };
}
