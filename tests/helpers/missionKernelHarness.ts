import { getTask, claimTask } from "../../src/store.js";
import type { MissionTaskEnqueuer } from "../../src/missionScheduler.js";

/** Only the clock boundary is replaced; persistence and leases remain real. */
export class MissionFakeClock {
  private readonly original = Date.now;
  private readonly originalTimers = { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate };
  private readonly timers = new Map<number, { due: number; interval?: number; callback: () => void }>();
  private timerSequence = 0;
  private timersInstalled = false;
  constructor(public now = Date.UTC(2026, 0, 1)) {}
  install(): void { Date.now = () => this.now; }
  /** Opt-in: existing short proofs can keep real timers, long proofs cannot. */
  installTimers(): void {
    this.install();
    if (this.timersInstalled) throw new Error("Fake timers are already installed.");
    this.timersInstalled = true;
    const schedule = (callback: (...args: unknown[]) => void, delay = 0, interval: boolean, args: unknown[]) => {
      if (typeof callback !== "function") throw new TypeError("Timer callback must be callable.");
      const milliseconds = Math.max(1, Math.floor(Number(delay) || 1));
      const id = ++this.timerSequence;
      this.timers.set(id, { due: this.now + milliseconds, ...(interval ? { interval: milliseconds } : {}), callback: () => callback(...args) });
      const handle = { ref: () => handle, unref: () => handle, hasRef: () => false, [Symbol.toPrimitive]: () => id };
      return handle;
    };
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => schedule(callback, delay, false, args)) as unknown as typeof setTimeout;
    globalThis.setInterval = ((callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => schedule(callback, delay, true, args)) as unknown as typeof setInterval;
    const clear = (handle: unknown) => { if (handle != null) this.timers.delete(Number(handle)); };
    globalThis.clearTimeout = clear as typeof clearTimeout;
    globalThis.clearInterval = clear as typeof clearInterval;
  }
  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Clock must advance monotonically.");
    this.now += milliseconds;
  }
  /** Advance through each heartbeat/deadline and drain its async store work. */
  async advanceAsync(milliseconds: number): Promise<void> {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Clock must advance monotonically.");
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.due;
      if (timer.interval) timer.due += timer.interval;
      else this.timers.delete(id);
      timer.callback();
      // Intervals in production intentionally return void while their promise
      // chains mutate the store. One real event-loop turn drains those chains
      // before the next fake heartbeat without waiting real mission time.
      await new Promise<void>((resolve) => this.originalTimers.setImmediate(resolve));
    }
    this.now = target;
    await new Promise<void>((resolve) => this.originalTimers.setImmediate(resolve));
  }
  get pendingTimers(): number { return this.timers.size; }
  restore(): void {
    Date.now = this.original;
    if (this.timersInstalled) {
      Object.assign(globalThis, { setTimeout: this.originalTimers.setTimeout, clearTimeout: this.originalTimers.clearTimeout, setInterval: this.originalTimers.setInterval, clearInterval: this.originalTimers.clearInterval });
      this.timersInstalled = false;
    }
    this.timers.clear();
  }
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
