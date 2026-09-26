import type { ProviderProof } from "./contracts.js";
import { normalizeProviderSmokeChecks } from "./providerSmoke.js";

export type ProviderSurface = "telegram" | "slack" | "whatsapp" | "imessage" | "web" | "cli" | "sdk" | "xchat" | "meetings";
export interface ProviderMatrixEntry { surface: ProviderSurface; inboundText: boolean; inboundImage: boolean; outboundText: boolean; outboundImage: boolean; liveProof: "verified" | "configured_unverified" | "not_configured"; proofExpiresAt?: number; proofCorrelationId?: string; missing?: string; }

export const PROVIDER_SURFACES: ProviderSurface[] = ["telegram", "slack", "whatsapp", "imessage", "web", "cli", "sdk", "xchat", "meetings"];

/** Honest capability matrix: code parity is separate from live credentials/provider proof. */
export function providerMatrix(env: NodeJS.ProcessEnv = process.env): ProviderMatrixEntry[] {
  return PROVIDER_SURFACES.map((surface) => {
    const configured = surface === "web" || surface === "cli" || surface === "sdk" || (surface === "telegram" ? Boolean(env.TELEGRAM_BOT_TOKEN) : surface === "slack" ? Boolean(env.SLACK_BOT_TOKEN) : surface === "whatsapp" ? Boolean(env.WHATSAPP_ACCESS_TOKEN) : surface === "imessage" ? Boolean(env.SENDBLUE_API_KEY) : surface === "xchat" ? Boolean(env.XCHAT_BOT_TOKEN) : surface === "meetings" ? Boolean(env.RECALL_API_KEY) : false);
    return { surface, inboundText: true, inboundImage: true, outboundText: true, outboundImage: true, liveProof: configured ? "configured_unverified" : "not_configured", missing: "A real inbound/outbound smoke test is required before claiming provider proof." };
  });
}

/** Merge real, persisted smoke evidence into the capability matrix. No proof
 * is inferred from configuration: every capability must be exercised and the
 * evidence must still be within its TTL. */
export function providerMatrixWithProofs(env: NodeJS.ProcessEnv = process.env, proofs: ProviderProof[] = [], now = Date.now()): ProviderMatrixEntry[] {
  const base = providerMatrix(env);
  return base.map((entry) => {
    const proof = proofs.find((candidate) => {
      if (candidate.surface !== entry.surface || candidate.expiresAt <= now || candidate.verifiedAt > now + 30_000 || !candidate.inboundText || !candidate.inboundImage || !candidate.outboundText || !candidate.outboundImage) return false;
      const checks = normalizeProviderSmokeChecks(candidate.checks, now, candidate.verifiedAt);
      return checks?.length === 4;
    });
    if (!proof) return entry;
    return { ...entry, liveProof: "verified", proofExpiresAt: proof.expiresAt, proofCorrelationId: proof.correlationId, missing: undefined };
  });
}
