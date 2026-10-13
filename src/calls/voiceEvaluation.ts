export type VoiceQaDimension = "role" | "disclosure" | "purpose" | "latency" | "toolAccuracy" | "interruptions" | "resolution";

export interface VoiceEvaluationScenario {
  id: string;
  direction: "inbound" | "outbound";
  purpose: string;
  expectedCapabilityBundles: string[];
  requiresDisclosure: boolean;
  requiresResolution: boolean;
}

export interface VoiceEvaluationTrace {
  direction: "inbound" | "outbound";
  representedPartyCorrect?: boolean;
  purposeStated?: boolean;
  aiDisclosureGiven?: boolean;
  firstResponseMs?: number;
  expectedToolSlugs?: string[];
  toolReceipts?: Array<{ slug: string; succeeded: boolean; expected?: boolean }>;
  interruptionsHandled?: boolean;
  resolved?: boolean;
}

export interface VoiceQaScorecard {
  version: "voice-qa-v1";
  status: "computed";
  score: number;
  dimensions: Record<VoiceQaDimension, number>;
  passed: boolean;
  evidence: string[];
  scoredAt: number;
}

export const DEFAULT_VOICE_EVALUATION_SCENARIOS: VoiceEvaluationScenario[] = [
  { id: "outbound-booking", direction: "outbound", purpose: "Confirm availability and book an appointment", expectedCapabilityBundles: ["calendar", "crm"], requiresDisclosure: true, requiresResolution: true },
  { id: "inbound-support", direction: "inbound", purpose: "Identify a support issue and provide the next step", expectedCapabilityBundles: ["support", "crm"], requiresDisclosure: true, requiresResolution: true },
  { id: "outbound-voicemail", direction: "outbound", purpose: "Deliver a short follow-up message", expectedCapabilityBundles: ["messaging"], requiresDisclosure: true, requiresResolution: false },
  { id: "interrupted-tool-call", direction: "inbound", purpose: "Check availability while handling a caller interruption", expectedCapabilityBundles: ["calendar"], requiresDisclosure: true, requiresResolution: true },
  { id: "human-handoff", direction: "inbound", purpose: "Escalate a request that requires a person", expectedCapabilityBundles: ["support"], requiresDisclosure: true, requiresResolution: true },
];

function scoreBoolean(value: boolean | undefined, evidence: string[], label: string): number {
  if (value === true) { evidence.push(`${label}: passed`); return 100; }
  evidence.push(`${label}: failed or not observed`);
  return 0;
}

export function scoreVoiceTrace(trace: VoiceEvaluationTrace, scenario: VoiceEvaluationScenario): VoiceQaScorecard {
  const evidence: string[] = [];
  const dimensions: Record<VoiceQaDimension, number> = {
    role: scoreBoolean(trace.direction === scenario.direction && trace.representedPartyCorrect !== false, evidence, "role"),
    disclosure: scenario.requiresDisclosure ? scoreBoolean(trace.aiDisclosureGiven, evidence, "disclosure") : 100,
    purpose: scoreBoolean(trace.purposeStated, evidence, "purpose"),
    latency: trace.firstResponseMs === undefined ? 0 : trace.firstResponseMs <= 1_000 ? 100 : trace.firstResponseMs <= 2_000 ? 70 : 30,
    toolAccuracy: 0,
    interruptions: scoreBoolean(trace.interruptionsHandled, evidence, "interruptions"),
    resolution: scenario.requiresResolution ? scoreBoolean(trace.resolved, evidence, "resolution") : 100,
  };
  if (trace.firstResponseMs !== undefined) evidence.push(`latency: ${trace.firstResponseMs}ms first response`);
  const expected = new Set((trace.expectedToolSlugs ?? []).map((slug) => slug.toUpperCase()));
  const receipts = trace.toolReceipts ?? [];
  const relevantReceipts = receipts.filter((receipt) => expected.size === 0 || expected.has(receipt.slug.toUpperCase()));
  dimensions.toolAccuracy = relevantReceipts.length === 0
    ? expected.size === 0 ? 100 : 0
    : Math.round(relevantReceipts.filter((receipt) => receipt.succeeded && receipt.expected !== false).length / relevantReceipts.length * 100);
  evidence.push(`tool accuracy: ${dimensions.toolAccuracy}% verified receipts`);
  const weights: Record<VoiceQaDimension, number> = { role: 1.2, disclosure: 1.2, purpose: 1, latency: 1.1, toolAccuracy: 1.3, interruptions: 1, resolution: 1.2 };
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const score = Math.round(Object.entries(dimensions).reduce((sum, [key, value]) => sum + value * weights[key as VoiceQaDimension], 0) / totalWeight);
  return { version: "voice-qa-v1", status: "computed", score, dimensions, passed: score >= 85 && dimensions.role === 100 && dimensions.disclosure === 100, evidence, scoredAt: Date.now() };
}
