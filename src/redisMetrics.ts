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
  if (budget.remaining-- <= 0 || value === null || value === undefined) return 0;
  const scalar = bytes(value);
  if (scalar) return scalar;
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, entry) => total + responseBytes(entry, budget), 0);
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
  }

  snapshot(): RedisCommandMetricsSnapshot {
    return Object.fromEntries(REDIS_METRIC_FAMILIES.map((family) => [family, { ...this.values[family] }])) as RedisCommandMetricsSnapshot;
  }

  flatten(): Record<string, number> {
    return Object.fromEntries(REDIS_METRIC_FAMILIES.flatMap((family) =>
      Object.entries(this.values[family]).map(([metric, value]) => [`redis.${family}.${metric}`, value]),
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
