import { randomUUID } from "node:crypto";
import type { BrowserAdapter, BrowserObservation, BrowserPolicy, ChallengeResult, ProviderId, SessionHandle } from "./contracts.js";

export type ChallengeState =
  | "detected"
  | "solver_waiting"
  | "solved_unverified"
  | "handoff_required"
  | "verified"
  | "failed"
  | "timeout"
  | "abandoned"
  | "blocked";

export type ChallengeOutcome = {
  id: string;
  provider: ProviderId;
  sessionId: string;
  ownerScope: string;
  kind: NonNullable<BrowserObservation["challenge"]>["kind"];
  state: ChallengeState;
  sameSession: true;
  createdAt: number;
  updatedAt: number;
  liveViewUrl?: string;
  expiresAt?: number;
  reason?: string;
};

export type ChallengeEvent = {
  id: string;
  challengeId: string;
  state: ChallengeState;
  provider: ProviderId;
  sessionId: string;
  createdAt: number;
  outcome?: ChallengeResult["status"];
};

export interface ChallengeLedger {
  append(event: ChallengeEvent): void | Promise<void>;
}

export type ChallengeManagerOptions = {
  now?: () => number;
  ledger?: ChallengeLedger;
  maxEvents?: number;
};

export type ChallengeResolution = {
  status: "not-detected" | "verified" | "user-required" | "failed" | "timeout" | "abandoned";
  outcome?: ChallengeOutcome;
  observation?: BrowserObservation;
};

const terminalStates = new Set<ChallengeState>(["verified", "failed", "timeout", "abandoned", "blocked"]);

/**
 * Owns browser-challenge orchestration independently of any provider.
 * Provider adapters may offer a solver and/or a handoff implementation, but
 * the page is re-observed here before a challenge is considered verified.
 */
export class ChallengeManager {
  private readonly now: () => number;
  private readonly ledger?: ChallengeLedger;
  private readonly events: ChallengeEvent[] = [];
  private readonly maxEvents: number;

  constructor(private readonly adapter: BrowserAdapter, options: ChallengeManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ledger = options.ledger;
    this.maxEvents = Math.max(20, Math.min(2_000, Math.floor(options.maxEvents ?? 500)));
  }

  history(): ChallengeEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  async resolve(input: {
    session: SessionHandle;
    observation: BrowserObservation;
    policy: BrowserPolicy;
    reason?: string;
  }): Promise<ChallengeResolution> {
    const signal = input.observation.challenge;
    if (!signal?.detected) return { status: "not-detected", observation: input.observation };

    const now = this.now();
    const outcome: ChallengeOutcome = {
      id: `challenge_${randomUUID()}`,
      provider: this.adapter.id,
      sessionId: input.session.id,
      ownerScope: input.session.ownerScope,
      kind: signal.kind,
      state: "detected",
      sameSession: true,
      createdAt: now,
      updatedAt: now,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    await this.record(outcome, undefined);

    if (this.adapter.waitForChallenge && this.solverMayRun(signal.kind)) {
      outcome.state = "solver_waiting";
      outcome.updatedAt = this.now();
      await this.record(outcome, undefined);
      const automatic = await this.adapter.waitForChallenge(input.session, Math.min(policyTimeout(input.policy), 30_000));
      const mapped = this.mapProviderStatus(automatic.status);
      if (mapped === "cleared") {
        outcome.state = "solved_unverified";
        outcome.updatedAt = this.now();
        await this.record(outcome, automatic.status);
        const fresh = await this.adapter.observe(input.session, {
          screenshot: input.policy.defaultScreenshot,
          screenshotReason: "challenge",
          includeFrames: true,
        });
        if (!fresh.challenge?.detected) {
          outcome.state = "verified";
          outcome.updatedAt = this.now();
          await this.record(outcome, "cleared");
          return { status: "verified", outcome, observation: fresh };
        }
      } else {
        outcome.state = mapped;
        outcome.updatedAt = this.now();
        await this.record(outcome, automatic.status);
      }
    }

    if (input.policy.requireHandoffForChallenges && this.adapter.handoff) {
      outcome.state = "handoff_required";
      outcome.updatedAt = this.now();
      const handoff = await this.adapter.handoff(input.session, input.reason ?? "A browser challenge requires owner interaction");
      outcome.liveViewUrl = handoff.liveViewUrl;
      outcome.expiresAt = extractExpiry(handoff);
      await this.record(outcome, handoff.status);
      return {
        status: "user-required",
        outcome,
        observation: handoff.observation ?? input.observation,
      };
    }

    outcome.state = "blocked";
    outcome.updatedAt = this.now();
    await this.record(outcome);
    return { status: "user-required", outcome, observation: input.observation };
  }

  /** Rechecks the retained session after the owner completes a handoff. */
  async resume(input: {
    session: SessionHandle;
    outcome: ChallengeOutcome;
    expectedOrigin?: string;
    screenshot?: BrowserPolicy["defaultScreenshot"];
  }): Promise<ChallengeResolution> {
    if (input.outcome.sessionId !== input.session.id || input.outcome.ownerScope !== input.session.ownerScope) {
      return { status: "failed", outcome: { ...input.outcome, state: "blocked", updatedAt: this.now() } };
    }
    if (terminalStates.has(input.outcome.state) && input.outcome.state !== "handoff_required") {
      const status = input.outcome.state === "verified" || input.outcome.state === "failed" || input.outcome.state === "timeout" || input.outcome.state === "abandoned" ? input.outcome.state : "failed";
      return { status, outcome: input.outcome };
    }
    const observation = await this.adapter.observe(input.session, {
      screenshot: input.screenshot ?? "viewport",
      screenshotReason: "challenge",
      includeFrames: true,
    });
    if (input.expectedOrigin && observation.origin !== input.expectedOrigin) {
      const blocked = { ...input.outcome, state: "blocked" as const, updatedAt: this.now(), reason: "origin-changed" };
      await this.record(blocked);
      return { status: "failed", outcome: blocked, observation };
    }
    if (observation.challenge?.detected) {
      const waiting = { ...input.outcome, state: "handoff_required" as const, updatedAt: this.now() };
      await this.record(waiting);
      return { status: "user-required", outcome: waiting, observation };
    }
    const verified = { ...input.outcome, state: "verified" as const, updatedAt: this.now() };
    await this.record(verified, "cleared");
    return { status: "verified", outcome: verified, observation };
  }

  private solverMayRun(kind: NonNullable<BrowserObservation["challenge"]>["kind"]): boolean {
    return kind === "captcha" || kind === "press-and-hold" || kind === "cloudflare" || kind === "unknown";
  }

  private mapProviderStatus(status: ChallengeResult["status"]): ChallengeState | "cleared" {
    if (status === "cleared") return "cleared";
    if (status === "timeout") return "timeout";
    if (status === "failed") return "failed";
    return "abandoned";
  }

  private async record(outcome: ChallengeOutcome, providerStatus?: ChallengeResult["status"]): Promise<void> {
    const event: ChallengeEvent = {
      id: `challenge_event_${randomUUID()}`,
      challengeId: outcome.id,
      state: outcome.state,
      provider: outcome.provider,
      sessionId: outcome.sessionId,
      createdAt: outcome.updatedAt,
      ...(providerStatus ? { outcome: providerStatus } : {}),
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    await this.ledger?.append(event);
  }
}

function policyTimeout(policy: BrowserPolicy): number {
  return Number.isFinite(policy.maxDurationMs) && policy.maxDurationMs > 0 ? policy.maxDurationMs : 30_000;
}

function extractExpiry(result: ChallengeResult): number | undefined {
  const value = (result as ChallengeResult & { expiresAt?: unknown }).expiresAt;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
