import { getTask, claimTask } from "../../src/store.js";
import type { MissionTaskEnqueuer } from "../../src/missionScheduler.js";

/** Only the clock boundary is replaced; persistence and leases remain real. */
export class MissionFakeClock {
  private readonly original = Date.now;
  constructor(public now = Date.UTC(2026, 0, 1)) {}
  install(): void { Date.now = () => this.now; }
  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Clock must advance monotonically.");
    this.now += milliseconds;
  }
  restore(): void { Date.now = this.original; }
}

export interface FakeDelivery { id: string; userId: number; taskId: string; runAt: number }

/** Accepted publication is deliberately independent of successful delivery. */
export class MissionFakeQStash {
  readonly deliveries: FakeDelivery[] = [];
  readonly published: FakeDelivery[] = [];
  private sequence = 0;
  readonly enqueue: MissionTaskEnqueuer = async (userId, taskId, runAt) => {
    const delivery = { id: `fake-workflow-${++this.sequence}`, userId, taskId, runAt };
    this.published.push({ ...delivery });
    this.deliveries.push(delivery);
    return delivery.id;
  };
  drop(index = 0): void { this.deliveries.splice(index, 1); }
  duplicate(index = 0): void {
    const delivery = this.deliveries[index];
    if (!delivery) throw new Error("No delivery to duplicate.");
    this.deliveries.push({ ...delivery });
  }
  delay(index: number, milliseconds: number): void {
    const delivery = this.deliveries[index];
    if (!delivery || milliseconds < 0) throw new Error("Invalid delayed delivery.");
    delivery.runAt += milliseconds;
  }
  reverse(): void { this.deliveries.reverse(); }
  async claimNext(now: number, leaseMs = 1000) {
    const index = this.deliveries.findIndex((delivery) => delivery.runAt <= now);
    if (index < 0) return undefined;
    const [delivery] = this.deliveries.splice(index, 1);
    const task = await getTask(delivery.userId, delivery.taskId);
    return { delivery, prior: task, claimed: await claimTask(delivery.userId, delivery.taskId, delivery.id, leaseMs) };
  }
}

/** Crash boundaries are named, reproducible and resumable by a fresh worker. */
export class MissionCrash extends Error {
  constructor(readonly boundary: string) { super(`Injected worker crash at ${boundary}`); }
}

export class MissionCrashInjector {
  readonly visited: string[] = [];
  constructor(private readonly crashAt?: string) {}
  async awaitBoundary<T>(name: string, operation: () => Promise<T>): Promise<T> {
    this.visited.push(`${name}:before`);
    if (this.crashAt === `${name}:before`) throw new MissionCrash(`${name}:before`);
    const result = await operation();
    this.visited.push(`${name}:after`);
    if (this.crashAt === `${name}:after`) throw new MissionCrash(`${name}:after`);
    return result;
  }
}
