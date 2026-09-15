/** Company-level agent templates and policies shared by the API and dashboard. */

export const COMPANY_TOOL_STARTER_ALLOWLIST = [
  "COMPOSIO_SEARCH_TOOL",
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_SEARCH_WEB",
  "COMPOSIO_SEARCH_FETCH_URL_CONTENT",
  "COMPOSIO_EXECUTE_TOOL",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "CHUCK_SEARCH_SKILLS",
  "CHUCK_READ_SKILL_FILE",
] as const;

export const COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION = [
  "COMPOSIO_EXECUTE_TOOL",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
] as const;

export type CompanyToolPolicy = {
  allow?: string[];
  deny?: string[];
  requireApproval?: string[];
};

export type CompanyBudget = {
  duration?: "5m" | "30m" | "1h" | "3h" | "6h" | "3d" | "1w";
  maxToolCalls?: number;
  maxCost?: number;
};

export type CompanyPolicy = {
  tools?: CompanyToolPolicy;
  budget?: CompanyBudget;
};

export type CompanyAgentProfile = {
  id: string;
  name: string;
  template: string;
  instructions: string;
  tools: CompanyToolPolicy;
  budget: CompanyBudget;
  createdAt: number;
  updatedAt: number;
};

export const COMPANY_AGENT_TEMPLATES = [
  {
    slug: "sales-development",
    name: "Sales Development Agent",
    outcome: "Research target accounts, qualify fit, prepare personalized outreach, and update the CRM when authorized.",
    instructions: "Work as a careful sales-development specialist. Qualify companies against the supplied ideal-customer criteria, cite evidence and its source, distinguish verified facts from inference, and draft concise personalized outreach. Never claim an email or CRM change happened unless the tool confirms it.",
    allowedTools: [...COMPANY_TOOL_STARTER_ALLOWLIST],
    requireApproval: [...COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION],
  },
  {
    slug: "lead-research",
    name: "Lead Research Agent",
    outcome: "Find and qualify leads against explicit company and role criteria, returning sourced research.",
    instructions: "Research leads against the user's exact criteria. Prefer first-party company sources, include evidence and source URLs, label uncertain or missing fields, and do not invent contact details. Prepare CRM-ready fields but do not write them unless explicitly authorized and approved.",
    allowedTools: [...COMPANY_TOOL_STARTER_ALLOWLIST],
    requireApproval: [...COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION],
  },
  {
    slug: "competitive-intelligence",
    name: "Competitive Intelligence Agent",
    outcome: "Monitor public competitor information and deliver source-backed change reports.",
    instructions: "Monitor and compare public information only. Cite dated sources, separate observed changes from interpretation, and report confidence. Do not access private competitor accounts, bypass access controls, or publish or send findings.",
    allowedTools: ["COMPOSIO_SEARCH_WEB", "COMPOSIO_SEARCH_FETCH_URL_CONTENT", "CHUCK_SEARCH_SKILLS", "CHUCK_READ_SKILL_FILE"],
    requireApproval: [],
  },
  {
    slug: "customer-support",
    name: "Customer Support Agent",
    outcome: "Triage cases, find relevant account context, and prepare accurate responses for review.",
    instructions: "Triage the customer's request using only authorized support context. Be empathetic, concise, and factual; cite internal records used. Draft a response and recommend a next action. Do not send a reply, issue a refund, change entitlements, or close a case without explicit approval.",
    allowedTools: [...COMPANY_TOOL_STARTER_ALLOWLIST],
    requireApproval: [...COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION],
  },
  {
    slug: "executive-assistant",
    name: "Executive Assistant",
    outcome: "Prepare briefs, coordinate schedules, and turn follow-ups into tracked work.",
    instructions: "Act as a discreet executive assistant. Confirm dates, time zones, attendees, and source facts. Prepare briefs and proposed calendar or message changes for review. Never send invitations, messages, or make commitments without explicit approval.",
    allowedTools: [...COMPANY_TOOL_STARTER_ALLOWLIST],
    requireApproval: [...COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION],
  },
  {
    slug: "recruiting",
    name: "Recruiting Agent",
    outcome: "Research candidates against job requirements and prepare structured, evidence-based hiring briefs.",
    instructions: "Assess only job-relevant criteria supplied by the company. Do not infer sensitive personal traits or use protected characteristics. Cite evidence, mark uncertainty, and prepare outreach for review; never contact a candidate or update a hiring decision without approval.",
    allowedTools: [...COMPANY_TOOL_STARTER_ALLOWLIST],
    requireApproval: [...COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION],
  },
  {
    slug: "marketing-operations",
    name: "Marketing Operations Agent",
    outcome: "Prepare campaign research, copy, segmentation plans, and CRM-ready operations.",
    instructions: "Prepare measurable, on-brand campaign plans and CRM-ready changes. Keep audience, consent, and suppression requirements explicit. Draft first; never publish, send, modify subscriptions, or update production records without approval.",
    allowedTools: [...COMPANY_TOOL_STARTER_ALLOWLIST],
    requireApproval: [...COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION],
  },
] as const;

const TEMPLATE_BY_SLUG = new Map<string, (typeof COMPANY_AGENT_TEMPLATES)[number]>(COMPANY_AGENT_TEMPLATES.map((item) => [item.slug, item]));
const TOOL_SLUG = /^[A-Za-z][A-Za-z0-9_]{0,119}$/;
const DURATIONS = ["5m", "30m", "1h", "3h", "6h", "3d", "1w"] as const;

export function getCompanyTemplate(slug: string) {
  return TEMPLATE_BY_SLUG.get(slug);
}

function toolList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100 || !value.every((item) => typeof item === "string" && TOOL_SLUG.test(item))) return undefined;
  return [...new Set(value)];
}

function budget(value: unknown): CompanyBudget | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.duration !== undefined && !DURATIONS.includes(input.duration as typeof DURATIONS[number])) return undefined;
  if (input.maxToolCalls !== undefined && (!Number.isInteger(input.maxToolCalls) || Number(input.maxToolCalls) < 1 || Number(input.maxToolCalls) > 100)) return undefined;
  if (input.maxCost !== undefined && (!Number.isFinite(input.maxCost) || Number(input.maxCost) < 0 || Number(input.maxCost) > 1000)) return undefined;
  return {
    ...(input.duration ? { duration: input.duration as CompanyBudget["duration"] } : {}),
    ...(input.maxToolCalls !== undefined ? { maxToolCalls: Number(input.maxToolCalls) } : {}),
    ...(input.maxCost !== undefined ? { maxCost: Number(input.maxCost) } : {}),
  };
}

export function validateCompanyPolicy(value: unknown): CompanyPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const rawTools = input.tools === undefined ? {} : input.tools;
  if (!rawTools || typeof rawTools !== "object" || Array.isArray(rawTools)) return undefined;
  const toolInput = rawTools as Record<string, unknown>;
  const allow = toolList(toolInput.allow);
  const deny = toolList(toolInput.deny);
  const requireApproval = toolList(toolInput.requireApproval);
  if ((toolInput.allow !== undefined && !allow) || (toolInput.deny !== undefined && !deny) || (toolInput.requireApproval !== undefined && !requireApproval)) return undefined;
  const limits = budget(input.budget);
  if (!limits) return undefined;
  return {
    tools: {
      ...(allow ? { allow } : {}),
      ...(deny ? { deny } : {}),
      ...(requireApproval ? { requireApproval } : {}),
    },
    budget: limits,
  };
}

export function createCompanyAgentProfile(input: unknown, id: string, now = Date.now()): CompanyAgentProfile | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const template = typeof raw.template === "string" ? getCompanyTemplate(raw.template) : undefined;
  const name = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ").slice(0, 80) : template?.name ?? "";
  const instructions = typeof raw.instructions === "string" ? raw.instructions.trim().slice(0, 6000) : template?.instructions ?? "";
  if (!template || !name || !instructions) return undefined;
  const policy = raw.policy === undefined ? {} : validateCompanyPolicy(raw.policy);
  if (!policy) return undefined;
  const requestedAllow = policy.tools?.allow;
  if (requestedAllow?.some((slug) => !template.allowedTools.includes(slug as never))) return undefined;
  const allowedTools = requestedAllow ?? [...template.allowedTools];
  return {
    id,
    name,
    template: template.slug,
    instructions,
    tools: {
      allow: allowedTools,
      deny: policy.tools?.deny ?? [],
      requireApproval: [...new Set([...template.requireApproval, ...(policy.tools?.requireApproval ?? [])])],
    },
    budget: policy.budget ?? { duration: "30m", maxToolCalls: 40, maxCost: 5 },
    createdAt: now,
    updatedAt: now,
  };
}

function intersect(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
  if (!left) return right ? [...right] : undefined;
  if (!right) return [...left];
  const allowed = new Set(left);
  return right.filter((item) => allowed.has(item));
}

function minimum<T extends number | string>(values: Array<T | undefined>, order?: readonly string[]): T | undefined {
  const present = values.filter((item): item is T => item !== undefined);
  if (!present.length) return undefined;
  if (order) return present.reduce((a, b) => order.indexOf(String(a)) <= order.indexOf(String(b)) ? a : b);
  return present.reduce((a, b) => Number(a) <= Number(b) ? a : b);
}

/** Merge project policy, agent policy, and run requests so run inputs only narrow grants. */
export function effectiveCompanyRunPolicy(
  projectPolicy: CompanyPolicy | undefined,
  agent: CompanyAgentProfile | undefined,
  requested: { tools?: CompanyToolPolicy; budget?: { duration?: string; maxToolCalls?: number; maxCost?: number } },
): { tools?: CompanyToolPolicy; budget?: CompanyBudget; instructions?: string } {
  const projectTools = projectPolicy?.tools;
  const agentTools = agent?.tools;
  const allow = intersect(intersect(projectTools?.allow, agentTools?.allow), requested.tools?.allow);
  const deny = [...new Set([...(projectTools?.deny ?? []), ...(agentTools?.deny ?? []), ...(requested.tools?.deny ?? [])])];
  const requireApproval = [...new Set([
    ...COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION,
    ...(projectTools?.requireApproval ?? []),
    ...(agentTools?.requireApproval ?? []),
    ...(requested.tools?.requireApproval ?? []),
  ])];
  const projectBudget = projectPolicy?.budget;
  const agentBudget = agent?.budget;
  const runBudget = requested.budget;
  const durations = [projectBudget?.duration, agentBudget?.duration, runBudget?.duration]
    .map((value) => DURATIONS.includes(value as typeof DURATIONS[number]) ? value as CompanyBudget["duration"] : undefined);
  const maxDuration = minimum(durations, DURATIONS);
  const maxToolCalls = minimum([projectBudget?.maxToolCalls, agentBudget?.maxToolCalls, runBudget?.maxToolCalls]);
  const maxCost = minimum([projectBudget?.maxCost, agentBudget?.maxCost, runBudget?.maxCost]);
  const budget: CompanyBudget = {
    ...(maxDuration ? { duration: maxDuration } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    ...(maxCost !== undefined ? { maxCost } : {}),
  };
  return {
    tools: { ...(allow !== undefined ? { allow } : {}), ...(deny.length ? { deny } : {}), ...(requireApproval.length ? { requireApproval } : {}) },
    budget,
    ...(agent?.instructions ? { instructions: agent.instructions } : {}),
  };
}
