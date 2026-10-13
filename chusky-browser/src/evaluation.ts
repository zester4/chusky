import type { BrowserCapability } from "./contracts.js";

export type BrowserBenchmarkCase = {
  id: string;
  description: string;
  requiredCapabilities: readonly BrowserCapability[];
  requiresVerifiedOutcome: boolean;
};

export type BrowserBenchmarkEvidence = {
  caseId: string;
  outcome: "completed" | "blocked" | "failed";
  verified: boolean;
  evidenceCount: number;
  duplicateEffect: boolean;
};

export type BrowserBenchmarkResult = {
  caseId: string;
  status: "pass" | "fail" | "blocked" | "unverified";
  score: number;
  reason: string;
};

export const COMPLEX_BROWSER_CASES: readonly BrowserBenchmarkCase[] = [
  { id: "spa-rerender", description: "Remap controls after a client-side render", requiredCapabilities: ["structured-observation"], requiresVerifiedOutcome: true },
  { id: "frame-target", description: "Act inside a nested frame without stale focus", requiredCapabilities: ["frames"], requiresVerifiedOutcome: true },
  { id: "popup-target", description: "Recover focus after a new tab or popup", requiredCapabilities: ["structured-observation"], requiresVerifiedOutcome: true },
  { id: "visual-widget", description: "Escalate to geometry-aware native input", requiredCapabilities: ["native-input", "screenshots"], requiresVerifiedOutcome: true },
  { id: "challenge-handoff", description: "Wait for a solver or hand off in the same session", requiredCapabilities: ["live-view"], requiresVerifiedOutcome: true },
  { id: "uncertain-mutation", description: "Stop and reconcile an unknown consequential result", requiredCapabilities: [], requiresVerifiedOutcome: true },
];

export function evaluateBenchmarkCase(testCase: BrowserBenchmarkCase, evidence: BrowserBenchmarkEvidence): BrowserBenchmarkResult {
  if (evidence.caseId !== testCase.id) return { caseId: testCase.id, status: "fail", score: 0, reason: "evidence case id does not match" };
  if (evidence.duplicateEffect) return { caseId: testCase.id, status: "fail", score: 0, reason: "duplicate consequential effect detected" };
  if (evidence.outcome === "blocked") return { caseId: testCase.id, status: "blocked", score: 0.5, reason: "workflow stopped at a safety or provider boundary" };
  if (evidence.outcome === "failed") return { caseId: testCase.id, status: "fail", score: 0, reason: "provider or workflow failure" };
  if (testCase.requiresVerifiedOutcome && (!evidence.verified || evidence.evidenceCount < 1)) return { caseId: testCase.id, status: "unverified", score: 0, reason: "completion lacks independent evidence" };
  return { caseId: testCase.id, status: "pass", score: 1, reason: "outcome and evidence verified" };
}

export function scoreBenchmark(results: readonly BrowserBenchmarkResult[]): number {
  if (!results.length) return 0;
  return results.reduce((total, result) => total + result.score, 0) / results.length;
}
