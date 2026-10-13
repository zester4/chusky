export type CircuitState = "closed" | "open" | "half-open";

export type CircuitSnapshot = {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt?: number;
  nextProbeAt?: number;
};

export class ProviderCircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | undefined;
  private probeInFlight = false;

  constructor(private readonly failureThreshold = 3, private readonly cooldownMs = 30_000, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new Error("failureThreshold must be a positive integer");
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error("cooldownMs must be non-negative");
  }

  canUse(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open" && this.openedAt !== undefined && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = "half-open";
      this.probeInFlight = false;
    }
    if (this.state === "half-open") {
      if (this.probeInFlight) return false;
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    this.probeInFlight = false;
  }

  recordFailure(): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  snapshot(): CircuitSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.openedAt === undefined ? {} : { openedAt: this.openedAt, nextProbeAt: this.openedAt + this.cooldownMs }),
    };
  }
}
