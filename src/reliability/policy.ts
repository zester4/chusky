import type { CompiledAutonomyPolicy } from "./contracts.js";
import type { CompanyAutonomyPolicy, CompanyPolicy, CompanyAgentProfile } from "../companyPlatform.js";

const authorityRank = { observe: 0, prepare: 1, execute_reversible: 2 } as const;
const min = (values: Array<number | undefined>, fallback: number): number => Math.min(fallback, ...values.filter((value): value is number => value !== undefined));
const intersect = (left: string[] | undefined, right: string[] | undefined): string[] => {
  if (!left) return right ? [...right] : [];
  if (!right) return [...left];
  const allowed = new Set(left);
  return right.filter((item) => allowed.has(item));
};

export function compileAutonomyPolicy(input: {
  ownerId: number;
  mode: "personal" | "business";
  project?: CompanyPolicy;
  agent?: CompanyAgentProfile;
  requested?: CompanyPolicy;
  now?: number;
}): CompiledAutonomyPolicy {
  const a = input.project?.autonomy;
  const b = input.requested?.autonomy;
  const authorityValues = [a?.defaultAuthority, b?.defaultAuthority].filter((value): value is "observe" | "prepare" | "execute_reversible" => value === "observe" || value === "prepare" || value === "execute_reversible");
  // Missing policy is fail-closed. A caller must explicitly grant prepare or
  // execute_reversible; an absent project/request must never inherit authority.
  const authority: "observe" | "prepare" | "execute_reversible" = authorityValues.reduce((current, candidate) => authorityRank[candidate] < authorityRank[current] ? candidate : current, "observe" as const);
  const tools = input.agent?.tools;
  // Explicit tenant budgets can narrow these values further. The defaults are
  // intentionally bounded so a missing policy cannot create an unbounded
  // polling loop or cost exposure.
  const defaults = input.mode === "business"
    ? { checks: 96, actions: 40, toolCalls: 200, costUsd: 100 }
    : { checks: 24, actions: 20, toolCalls: 100, costUsd: 25 };
  return {
    version: `policy_${input.now ?? Date.now()}`,
    ownerId: input.ownerId,
    mode: input.mode,
    enabled: a?.enabled !== false && b?.enabled !== false,
    authority,
    allowedDomains: intersect(a?.allowedDomains, b?.allowedDomains),
    deniedDomains: [...new Set([...(a?.deniedDomains ?? []), ...(b?.deniedDomains ?? [])])],
    allowedTools: intersect(tools?.allow, input.requested?.tools?.allow),
    deniedTools: [...new Set([...(tools?.deny ?? []), ...(input.requested?.tools?.deny ?? [])])],
    approvalTools: [...new Set([...(tools?.requireApproval ?? []), ...(input.requested?.tools?.requireApproval ?? [])])],
    maxChecksPerDay: min([a?.maxChecksPerDay, b?.maxChecksPerDay], defaults.checks),
    maxActionsPerDay: min([a?.maxAutonomousActionsPerDay, b?.maxAutonomousActionsPerDay], defaults.actions),
    maxToolCalls: min([input.project?.budget?.maxToolCalls, input.agent?.budget?.maxToolCalls, input.requested?.budget?.maxToolCalls], defaults.toolCalls),
    maxCostUsd: min([input.project?.budget?.maxCost, input.agent?.budget?.maxCost, input.requested?.budget?.maxCost], defaults.costUsd),
    compiledAt: input.now ?? Date.now(),
  };
}
