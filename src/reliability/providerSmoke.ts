import { randomUUID } from "node:crypto";
import type { ProviderProof, ProviderSmokeCapability, ProviderSmokeCheck } from "./contracts.js";

export const PROVIDER_SMOKE_CAPABILITIES: ProviderSmokeCapability[] = ["inbound_text", "inbound_image", "outbound_text", "outbound_image"];
const MAX_EVIDENCE_AGE_MS = 15 * 60_000;
const FUTURE_CLOCK_SKEW_MS = 30_000;

export interface ProviderSmokeResult {
  capability: ProviderSmokeCapability;
  observedAt: number;
  /** SHA-256 digest of a real provider event/receipt identifier. */
  evidenceHash: string;
  status: "passed" | "failed";
}

export interface ProviderSmokeProbe {
  surface: string;
  run: (correlationId: string) => Promise<ProviderSmokeResult[]>;
}

/** Validate the four independently observed capabilities used by a signed proof. */
export function normalizeProviderSmokeChecks(value: unknown, now = Date.now(), verifiedAt = now): ProviderSmokeCheck[] | undefined {
  if (!Array.isArray(value) || value.length !== PROVIDER_SMOKE_CAPABILITIES.length) return undefined;
  const seenCapabilities = new Set<string>();
  const seenEvidence = new Set<string>();
  const normalized: ProviderSmokeCheck[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const check = item as Record<string, unknown>;
    const capability = check.capability;
    const observedAt = check.observedAt;
    const evidenceHash = check.evidenceHash;
    if (typeof capability !== "string" || !PROVIDER_SMOKE_CAPABILITIES.includes(capability as ProviderSmokeCapability)) return undefined;
    if (seenCapabilities.has(capability)) return undefined;
    if (check.status !== "passed" || typeof observedAt !== "number" || !Number.isSafeInteger(observedAt) || observedAt < now - MAX_EVIDENCE_AGE_MS || observedAt > now + FUTURE_CLOCK_SKEW_MS || Math.abs(verifiedAt - observedAt) > MAX_EVIDENCE_AGE_MS) return undefined;
    if (typeof evidenceHash !== "string" || !/^[a-f0-9]{64}$/.test(evidenceHash) || seenEvidence.has(evidenceHash)) return undefined;
    seenCapabilities.add(capability);
    seenEvidence.add(evidenceHash);
    normalized.push({ capability: capability as ProviderSmokeCapability, status: "passed", observedAt, evidenceHash });
  }
  return seenCapabilities.size === PROVIDER_SMOKE_CAPABILITIES.length ? normalized : undefined;
}

/** Run only injected provider probes. The module never fabricates a provider
 * call or turns credentials/configuration into proof. */
export async function runProviderSmokeSuite(probes: ProviderSmokeProbe[], now = Date.now(), ttlMs = 24 * 60 * 60_000): Promise<ProviderProof[]> {
  const proofs: ProviderProof[] = [];
  for (const probe of probes.slice(0, 20)) {
    const correlationId = `smoke_${randomUUID()}`;
    let checks: ProviderSmokeResult[];
    try { checks = await probe.run(correlationId); } catch {
      // A failed probe is not evidence. Omit this surface rather than
      // manufacturing a check that could accidentally satisfy certification.
      continue;
    }
    const normalizedChecks = normalizeProviderSmokeChecks(checks, now, now);
    if (!normalizedChecks) continue;
    const capabilities = new Set(normalizedChecks.map((check) => check.capability));
    proofs.push({
      surface: probe.surface,
      inboundText: capabilities.has("inbound_text"),
      inboundImage: capabilities.has("inbound_image"),
      outboundText: capabilities.has("outbound_text"),
      outboundImage: capabilities.has("outbound_image"),
      verifiedAt: now,
      expiresAt: now + Math.max(60_000, Math.min(ttlMs, 7 * 24 * 60 * 60_000)),
      correlationId,
      checks: normalizedChecks,
    });
  }
  return proofs;
}
