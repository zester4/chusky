import type { ProviderProof } from "./contracts.js";
import type { ProviderMatrixEntry } from "./providerMatrix.js";

export interface ReadinessReport {
  status: "ready" | "degraded" | "blocked";
  generatedAt: number;
  durableStore: boolean;
  checks: Array<{ id: string; status: "passed" | "failed" | "warning"; detail: string }>;
  providerMatrix: ProviderMatrixEntry[];
  blocking: string[];
  warnings: string[];
}

export function buildReadinessReport(input: { durableStore: boolean; qstashConfigured: boolean; providerMatrix: ProviderMatrixEntry[]; proofs: ProviderProof[]; now?: number }): ReadinessReport {
  const generatedAt = input.now ?? Date.now();
  const checks: ReadinessReport["checks"] = [];
  const blocking: string[] = [];
  const warnings: string[] = [];
  checks.push(input.durableStore ? { id: "durable_store", status: "passed", detail: "Redis-backed persistence is active." } : { id: "durable_store", status: "failed", detail: "In-memory persistence is not suitable for production workers." });
  if (!input.durableStore) blocking.push("durable_store");
  checks.push(input.qstashConfigured ? { id: "durable_workflows", status: "passed", detail: "QStash workflow configuration is present." } : { id: "durable_workflows", status: "warning", detail: "QStash is not configured in this process; long-running work cannot be certified." });
  if (!input.qstashConfigured) warnings.push("durable_workflows");
  const configured = input.providerMatrix.filter((entry) => entry.liveProof !== "not_configured");
  const unverified = configured.filter((entry) => entry.liveProof !== "verified");
  checks.push(unverified.length === 0 ? { id: "provider_proofs", status: "passed", detail: "Every configured provider has fresh text and image round-trip proof." } : { id: "provider_proofs", status: "warning", detail: `${unverified.length} configured provider(s) still need fresh real-provider smoke proof.` });
  if (unverified.length) warnings.push("provider_proofs");
  const status = blocking.length ? "blocked" : warnings.length ? "degraded" : "ready";
  return { status, generatedAt, durableStore: input.durableStore, checks, providerMatrix: input.providerMatrix, blocking, warnings };
}
