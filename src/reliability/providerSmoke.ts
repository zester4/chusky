import { randomUUID } from "node:crypto";
import type { ProviderProof } from "./contracts.js";

export interface ProviderSmokeResult {
  name: string;
  inboundText?: boolean;
  inboundImage?: boolean;
  outboundText?: boolean;
  outboundImage?: boolean;
  status: "passed" | "failed";
  detail?: string;
}

export interface ProviderSmokeProbe {
  surface: string;
  run: (correlationId: string) => Promise<ProviderSmokeResult[]>;
}

/** Run only injected provider probes. The module never fabricates a provider
 * call or turns credentials/configuration into proof. */
export async function runProviderSmokeSuite(probes: ProviderSmokeProbe[], now = Date.now(), ttlMs = 24 * 60 * 60_000): Promise<ProviderProof[]> {
  const proofs: ProviderProof[] = [];
  for (const probe of probes.slice(0, 20)) {
    const correlationId = `smoke_${randomUUID()}`;
    let checks: ProviderSmokeResult[];
    try { checks = await probe.run(correlationId); } catch (error) {
      checks = [{ name: "probe", status: "failed", detail: error instanceof Error ? error.message.slice(0, 500) : "Provider probe failed." }];
    }
    const flags = {
      inboundText: checks.some((check) => check.status === "passed" && check.inboundText === true),
      inboundImage: checks.some((check) => check.status === "passed" && check.inboundImage === true),
      outboundText: checks.some((check) => check.status === "passed" && check.outboundText === true),
      outboundImage: checks.some((check) => check.status === "passed" && check.outboundImage === true),
    };
    if (!flags.inboundText || !flags.inboundImage || !flags.outboundText || !flags.outboundImage) continue;
    proofs.push({ surface: probe.surface, ...flags, verifiedAt: now, expiresAt: now + Math.max(60_000, Math.min(ttlMs, 7 * 24 * 60 * 60_000)), correlationId, checks: checks.slice(0, 20).map((check) => ({ name: check.name.slice(0, 120), status: check.status, ...(check.detail ? { detail: check.detail.slice(0, 500) } : {}) })) });
  }
  return proofs;
}
