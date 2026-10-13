import type { BrowserCapability, ProviderId } from "./contracts.js";

export type BrowserWorkload =
  | "semantic"
  | "visual"
  | "challenge"
  | "long-running"
  | "auth"
  | "diagnostics"
  | "high-throughput";

export type ControlPlane = "structured" | "native" | "harness" | "handoff";

export type ProviderDescriptor = {
  id: ProviderId;
  capabilities: ReadonlySet<BrowserCapability>;
  healthy?: boolean;
  latencyMs?: number;
  costWeight?: number;
};

export type RouteRequest = {
  workload: BrowserWorkload;
  requiredCapabilities?: readonly BrowserCapability[];
};

export type BrowserRoute = {
  provider: ProviderId;
  controlPlane: ControlPlane;
  score: number;
  reasons: string[];
  capabilities: ReadonlySet<BrowserCapability>;
};

const workloadPreferences: Record<BrowserWorkload, BrowserCapability[]> = {
  semantic: ["structured-observation", "accessibility-tree", "frames"],
  visual: ["native-input", "screenshots", "live-view"],
  challenge: ["live-view", "native-input", "profiles", "managed-auth"],
  "long-running": ["profiles", "replay", "network-events", "live-view"],
  auth: ["profiles", "managed-auth", "live-view"],
  diagnostics: ["network-events", "replay", "screenshots"],
  "high-throughput": ["structured-observation", "cdp", "network-events"],
};

function hasAll(capabilities: ReadonlySet<BrowserCapability>, required: readonly BrowserCapability[]): boolean {
  return required.every((capability) => capabilities.has(capability));
}

function controlPlaneFor(workload: BrowserWorkload, capabilities: ReadonlySet<BrowserCapability>): ControlPlane {
  if (workload === "challenge" && capabilities.has("live-view")) return "handoff";
  if ((workload === "visual" || workload === "challenge") && capabilities.has("native-input")) return "native";
  if (capabilities.has("structured-observation") || capabilities.has("accessibility-tree")) return "structured";
  return "harness";
}

/** Rank healthy capability matches without hard-coding a provider name into the agent loop. */
export function rankRoutes(request: RouteRequest, providers: readonly ProviderDescriptor[]): BrowserRoute[] {
  const required = request.requiredCapabilities ?? [];
  const preferred = workloadPreferences[request.workload];

  return providers
    .filter((provider) => provider.healthy !== false && hasAll(provider.capabilities, required))
    .map((provider) => {
      const matched = preferred.filter((capability) => provider.capabilities.has(capability));
      const latencyPenalty = Math.min(20, Math.max(0, Math.round((provider.latencyMs ?? 0) / 100)));
      const costPenalty = Math.min(15, Math.max(0, Math.round((provider.costWeight ?? 0) * 3)));
      const reasons = matched.map((capability) => `supports ${capability}`);
      if (provider.healthy === true) reasons.push("provider health is confirmed");
      return {
        provider: provider.id,
        controlPlane: controlPlaneFor(request.workload, provider.capabilities),
        score: matched.length * 10 + (provider.healthy === true ? 5 : 0) - latencyPenalty - costPenalty,
        reasons,
        capabilities: provider.capabilities,
      };
    })
    .sort((left, right) => right.score - left.score || left.provider.localeCompare(right.provider));
}
