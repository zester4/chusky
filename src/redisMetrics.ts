import { AsyncLocalStorage } from "node:async_hooks";

export const REDIS_METRIC_FAMILIES = [
  "session",
  "tasks",
  "missions",
  "channels",
  "approvals",
  "scheduling",
  "memory",
  "meetings",
  "runs",
  "assets",
  "coordination",
  "other",
  "mixed",
] as const;

export type RedisMetricFamily = typeof REDIS_METRIC_FAMILIES[number];

export interface RedisMetricCommand {
  name: string;
  args: readonly unknown[];
}

export interface RedisCommandFamilyMetrics {
  commands: number;
  errors: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  maxValueBytes: number;
}

export interface RedisRouteMetricSample extends RedisCommandFamilyMetrics {
  route: string;
  family: RedisMetricFamily;
}

interface RedisMetricContext {
  route: string;
  commands: number;
  responseBytes: number;
  maxCommands?: number;
  maxResponseBytes?: number;
  exceeded: boolean;
  onExceeded?: (context: { route: string; commands: number; responseBytes: number }) => void;
}
const redisMetricRoute = new AsyncLocalStorage<RedisMetricContext>();

/** Attribute Redis traffic to a bounded API/worker surface without retaining owner data. */
export function withRedisMetricRoute<T>(route: string, work: () => Promise<T>, budget: Pick<RedisMetricContext, "maxCommands" | "maxResponseBytes" | "onExceeded"> = {}): Promise<T> {
  const bounded = route.replace(/[^A-Za-z0-9_ ./:-]/g, "").slice(0, 120) || "unknown";
  return redisMetricRoute.run({ route: bounded, commands: 0, responseBytes: 0, exceeded: false, ...budget }, work);
}

export type RedisCommandMetricsSnapshot = Record<RedisMetricFamily, RedisCommandFamilyMetrics>;

const FAMILY_PREFIXES: ReadonlyArray<readonly [string, RedisMetricFamily]> = [
  ["chuck:session", "session"],
  ["chuck:tasks", "tasks"],
  ["chuck:task:", "tasks"],
  ["chuck:mission", "missions"],
  ["chuck:channel", "channels"],
  ["chuck:sendblue", "channels"],
  ["chuck:outbox", "channels"],
  ["chuck:approval", "approvals"],
  ["chuck:reminder", "scheduling"],
  ["chuck:job", "scheduling"],
  ["chuck:memory", "memory"],
  ["chuck:recall", "meetings"],
  ["chuck:meeting", "meetings"],
  ["chuck:run", "runs"],
  ["chuck:sdk", "runs"],
  ["chuck:image", "assets"],
  ["chuck:file", "assets"],
  ["chuck:lock", "coordination"],
  ["chuck:key-lock", "coordination"],
  ["chuck:rate", "coordination"],
  ["chuck:delivery", "coordination"],
];

const EMPTY_METRICS = (): RedisCommandFamilyMetrics => ({
  commands: 0,
  errors: 0,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 0,
  maxValueBytes: 0,
});

const instrumentedClients = new WeakSet<object>();

function bytes(value: unknown): number {
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return Buffer.byteLength(String(value), "utf8");
  return 0;
}

function responseBytes(value: unknown, budget = { remaining: 10_000 }): number {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  let total = 0;

  while (pending.length && budget.remaining > 0) {
    const current = pending.pop();
    budget.remaining -= 1;
    if (current === null || current === undefined) continue;
    if (Buffer.isBuffer(current)) {
      total += current.byteLength;
      continue;
    }
    if (typeof current === "string" || typeof current === "number" || typeof current === "bigint" || typeof current === "boolean") {
      total += bytes(current);
      continue;
    }
    if (typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      const limit = Math.min(current.length, Math.max(0, budget.remaining - pending.length));
      for (let index = limit - 1; index >= 0; index -= 1) pending.push(current[index]);
      continue;
    }

    // Redis hash replies are commonly plain objects. Count their field names
    // and scalar values without serializing or retaining the reply payload.
    let queued = 0;
    for (const key in current) {
      if (queued >= budget.remaining - pending.length) break;
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      total += Buffer.byteLength(key, "utf8");
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        pending.push(descriptor.value);
        queued += 1;
      }
    }
  }

  return total;
}

function keyArguments(command: RedisMetricCommand): unknown[] {
  const name = command.name.toLowerCase();
  const args = [...command.args];
  if (["eval", "evalsha"].includes(name)) {
    const count = Number(args[1]);
    return Number.isSafeInteger(count) && count > 0 ? args.slice(2, 2 + Math.min(count, 32)) : [];
  }
  if (["mget", "del", "unlink", "exists", "touch", "watch"].includes(name)) return args.slice(0, 32);
  if (["mset", "msetnx"].includes(name)) return args.filter((_, index) => index % 2 === 0).slice(0, 32);
  return args.length ? [args[0]] : [];
}

function asKey(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}

export function redisOperationFamily(command: RedisMetricCommand): RedisMetricFamily {
  const candidates = new Set<RedisMetricFamily>();
  for (const rawKey of keyArguments(command)) {
    const key = asKey(rawKey);
    if (!key) continue;
    const match = FAMILY_PREFIXES.find(([prefix]) => key.startsWith(prefix));
    if (match) candidates.add(match[1]);
    else candidates.add("other");
  }
  if (!candidates.size) return "other";
  if (candidates.size > 1) return "mixed";
  return [...candidates][0]!;
}

function valueBytes(command: RedisMetricCommand, result: unknown): number {
  const name = command.name.toLowerCase();
  const args = command.args;
  if (["get", "getex", "getdel", "hget", "lindex", "linsert"].includes(name)) return bytes(result);
  if (["set", "setex", "psetex", "setnx", "getset", "append"].includes(name)) {
    const valueIndex = name === "setex" || name === "psetex" ? 2 : 1;
    return bytes(args[valueIndex]);
  }
  if (["hset", "hmset"].includes(name)) return args.slice(2).reduce<number>((total, value) => total + bytes(value), 0);
  if (["eval", "evalsha"].includes(name)) {
    const count = Number(args[1]);
    return Number.isSafeInteger(count) && count >= 0
      ? args.slice(2 + count).reduce<number>((total, value) => total + bytes(value), 0)
      : 0;
  }
  return responseBytes(result);
}

export class RedisCommandMetrics {
  private readonly values: RedisCommandMetricsSnapshot = Object.fromEntries(
    REDIS_METRIC_FAMILIES.map((family) => [family, EMPTY_METRICS()]),
  ) as RedisCommandMetricsSnapshot;
  private readonly routeValues = new Map<string, RedisCommandFamilyMetrics>();

  record(command: RedisMetricCommand, outcome: { result?: unknown; error?: boolean; durationMs?: number }): void {
    const family = redisOperationFamily(command);
    const current = this.values[family];
    const requestBytes = command.args.reduce<number>((total, value) => total + bytes(value), 0);
    const replyBytes = responseBytes(outcome.result);
    current.commands += 1;
    if (outcome.error) current.errors += 1;
    current.requestBytes += requestBytes;
    current.responseBytes += replyBytes;
    current.durationMs += Math.max(0, Math.floor(outcome.durationMs ?? 0));
    current.maxValueBytes = Math.max(current.maxValueBytes, valueBytes(command, outcome.result));
    const context = redisMetricRoute.getStore();
    if (context) {
      context.commands += 1;
      context.responseBytes += replyBytes;
      if (!context.exceeded && ((context.maxCommands !== undefined && context.commands > context.maxCommands) || (context.maxResponseBytes !== undefined && context.responseBytes > context.maxResponseBytes))) {
        context.exceeded = true;
        try { context.onExceeded?.({ route: context.route, commands: context.commands, responseBytes: context.responseBytes }); } catch { /* Budget telemetry must never alter the request. */ }
      }
      const routeKey = `${context.route}\u0000${family}`;
      let routed = this.routeValues.get(routeKey);
      if (!routed) {
        // Route cardinality is intentionally bounded. Overflow is grouped into
        // one label so a user-controlled path can never grow this map without
        // limit.
        if (this.routeValues.size >= 400) return;
        routed = EMPTY_METRICS();
        this.routeValues.set(routeKey, routed);
      }
      routed.commands += 1;
      if (outcome.error) routed.errors += 1;
      routed.requestBytes += requestBytes;
      routed.responseBytes += replyBytes;
      routed.durationMs += Math.max(0, Math.floor(outcome.durationMs ?? 0));
      routed.maxValueBytes = Math.max(routed.maxValueBytes, valueBytes(command, outcome.result));
    }
  }

  snapshot(): RedisCommandMetricsSnapshot {
    return Object.fromEntries(REDIS_METRIC_FAMILIES.map((family) => [family, { ...this.values[family] }])) as RedisCommandMetricsSnapshot;
  }

  takeSnapshot(): RedisCommandMetricsSnapshot {
    const snapshot = this.snapshot();
    for (const family of REDIS_METRIC_FAMILIES) this.values[family] = EMPTY_METRICS();
    return snapshot;
  }

  takeRouteSnapshot(): RedisRouteMetricSample[] {
    const samples = [...this.routeValues.entries()].map(([key, value]) => {
      const separator = key.lastIndexOf("\u0000");
      return { route: key.slice(0, separator), family: key.slice(separator + 1) as RedisMetricFamily, ...value };
    });
    this.routeValues.clear();
    return samples;
  }

  flatten(snapshot: RedisCommandMetricsSnapshot = this.values): Record<string, number> {
    return Object.fromEntries(REDIS_METRIC_FAMILIES.flatMap((family) =>
      Object.entries(snapshot[family]).map(([metric, value]) => [`redis.${family}.${metric}`, value]),
    ));
  }
}

interface RedisCommandLike extends RedisMetricCommand {
  promise?: Promise<unknown>;
}

interface RedisClientLike {
  sendCommand: (command: RedisCommandLike, ...args: unknown[]) => unknown;
}

/** Observe ioredis commands at its dispatch seam without changing replies/errors. */
export function instrumentRedisClient<T extends RedisClientLike>(client: T, metrics: RedisCommandMetrics): void {
  if (instrumentedClients.has(client)) return;
  const original = client.sendCommand;
  client.sendCommand = function (command: RedisCommandLike, ...args: unknown[]): unknown {
    const startedAt = Date.now();
    let observed = false;
    const observe = (error: boolean, result?: unknown) => {
      if (observed) return;
      observed = true;
      try { metrics.record(command, { error, result, durationMs: Date.now() - startedAt }); }
      catch { /* Telemetry must never alter Redis command behavior. */ }
    };
    try {
      const returned = original.call(this, command, ...args);
      const pending = command.promise ?? (returned && typeof (returned as PromiseLike<unknown>).then === "function" ? returned as PromiseLike<unknown> : undefined);
      if (pending && typeof pending.then === "function") void Promise.resolve(pending).then((result) => observe(false, result), () => observe(true));
      return returned;
    } catch (error) {
      observe(true);
      throw error;
    }
  };
  instrumentedClients.add(client);
}
