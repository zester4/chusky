import { randomUUID } from "node:crypto";
import { normalizeChallengeProvider, normalizeChallengeType, type BrowserChallengeProvider, type BrowserChallengeType } from "../../vault/challengeResolution.js";

export type BrowserSolverOutcome = "solved" | "failed" | "timeout" | "abandoned";

export type DetectedBrowserChallenge = {
  id: string;
  provider: BrowserChallengeProvider;
  type: BrowserChallengeType;
  sessionId?: string;
  observedOrigin?: string;
  solverOutcome?: BrowserSolverOutcome;
  needsOwner: boolean;
};

export type BrowserChallengeHandoff = {
  result: Record<string, unknown>;
  challenge?: DetectedBrowserChallenge;
  handoff?: Record<string, unknown>;
};

/**
 * Host-side challenge coordinator. Provider adapters may solve a challenge
 * before this layer sees it. When a challenge remains, this coordinator turns
 * it into one owner handoff request and preserves the provider session ID as
 * metadata; it never exposes CDP URLs or credentials.
 */
export class BrowserChallengeManager {
  detect(result: unknown): DetectedBrowserChallenge | undefined {
    if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
    const payload = result as Record<string, unknown>;
    const rawChallenge = payload.challenge;
    const challenge = rawChallenge && typeof rawChallenge === "object" && !Array.isArray(rawChallenge) ? rawChallenge as Record<string, unknown> : undefined;
    const detected = payload.needsUserInteraction === true || challenge?.detected === true || challenge?.userRequired === true;
    if (!detected) return undefined;
    const solverOutcome = this.solverOutcome(challenge, payload);
    const observedUrl = typeof payload.observedUrl === "string" ? payload.observedUrl : typeof payload.url === "string" ? payload.url : undefined;
    let observedOrigin: string | undefined;
    if (observedUrl) {
      try {
        const parsed = new URL(observedUrl);
        if (parsed.protocol === "https:") observedOrigin = parsed.origin;
      } catch { /* an invalid page URL is not trusted */ }
    }
    const providerValue = payload.provider === "dedicated" ? "playwright" : payload.provider;
    return {
      id: `bc_${randomUUID()}`,
      provider: normalizeChallengeProvider(providerValue),
      type: normalizeChallengeType(challenge?.type),
      ...(typeof payload.sessionId === "string" && payload.sessionId.trim() ? { sessionId: payload.sessionId.trim().slice(0, 160) } : {}),
      ...(observedOrigin ? { observedOrigin } : {}),
      ...(solverOutcome ? { solverOutcome } : {}),
      needsOwner: detected,
    };
  }

  async handoff(input: {
    result: unknown;
    createHandoff: (challenge: DetectedBrowserChallenge) => Promise<Record<string, unknown>>;
  }): Promise<BrowserChallengeHandoff> {
    if (!input.result || typeof input.result !== "object" || Array.isArray(input.result)) return { result: {} };
    const result = input.result as Record<string, unknown>;
    const challenge = this.detect(result);
    if (!challenge || !challenge.needsOwner) return { result, ...(challenge ? { challenge } : {}) };
    const handoff = await input.createHandoff(challenge);
    return {
      result: {
        ...result,
        challengeResolution: {
          id: challenge.id,
          provider: challenge.provider,
          type: challenge.type,
          state: "handoff_required",
          solverOutcome: challenge.solverOutcome,
          sameSession: true,
        },
        browserHandoff: handoff,
        next: "Open the private browser link, complete the challenge, return and say continue, then complete the handoff and verify the same session.",
      },
      challenge,
      handoff,
    };
  }

  private solverOutcome(challenge: Record<string, unknown> | undefined, result: Record<string, unknown>): BrowserSolverOutcome | undefined {
    const candidate = challenge?.terminalStatus ?? challenge?.solverStatus ?? (challenge?.solver && typeof challenge.solver === "object" ? (challenge.solver as Record<string, unknown>).status : undefined) ?? result.challengeStatus;
    const value = typeof candidate === "string" ? candidate.toLowerCase() : "";
    if (["success", "solved", "cleared"].includes(value)) return "solved";
    if (["failure", "failed"].includes(value)) return "failed";
    if (value === "timeout" || value === "timed_out") return "timeout";
    if (value === "abandoned" || value === "cancelled" || value === "canceled") return "abandoned";
    return undefined;
  }
}

export const browserChallengeManager = new BrowserChallengeManager();
