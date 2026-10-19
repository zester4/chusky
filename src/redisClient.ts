import Redis, { type RedisOptions } from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Keep direct Redis clients on one explicit production policy. The channel
 * adapters own their client construction, so this factory is used by Chusky's
 * store, auth, control-plane, and disposable-cache clients.
 */
export type RedisClientPurpose = "durable" | "auth" | "control" | "cache";

/**
 * Wait for a client whose offline queue is disabled to become usable.  This
 * matters for control-plane clients: a command issued during the small
 * connecting/reconnecting window otherwise fails synchronously with
 * ioredis' "Stream isn't writable" error.
 */
export async function waitForRedisReady(client: Redis, timeoutMs = Math.max(1_000, config.redisConnectTimeoutMs)): Promise<void> {
  if (client.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      client.removeListener("ready", onReady);
      client.removeListener("end", onEnd);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onEnd = () => finish(new Error("Redis connection ended before it became ready."));
    client.once("ready", onReady);
    client.once("end", onEnd);
    timer = setTimeout(() => finish(new Error("Redis did not become ready before the timeout.")), timeoutMs);
    if (client.status === "wait") void client.connect().catch(() => undefined);
    if (client.status === "ready") onReady();
  });
}

export function isRedisNotReadyError(error: unknown): boolean {
  return error instanceof Error && /stream\s+isn['’]?t\s+writable|enableOfflineQueue|redis.*not ready|connection ended/i.test(error.message);
}

/** Run a bounded control-plane operation across a Redis reconnect window. */
export async function withRedisReady<T>(client: Redis, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForRedisReady(client);
    try {
      return await operation();
    } catch (error) {
      if (attempt === 0 && isRedisNotReadyError(error)) continue;
      throw error;
    }
  }
  throw new Error("Redis control operation could not be completed.");
}

export function redisOptions(purpose: RedisClientPurpose, overrides: RedisOptions = {}): RedisOptions {
  const disposable = purpose === "cache";
  const controlPlane = purpose === "control";
  const maxRetriesPerRequest = purpose === "durable" ? 3 : purpose === "auth" ? 2 : 1;

  return {
    connectTimeout: config.redisConnectTimeoutMs,
    commandTimeout: config.redisCommandTimeoutMs,
    keepAlive: 10_000,
    enableReadyCheck: true,
    maxRetriesPerRequest,
    lazyConnect: purpose !== "cache",
    // Durable state and auth should fail after bounded retries, but may queue
    // commands during the initial connection. Disposable cache/control-plane
    // operations must fail closed instead of hiding outages in a queue.
    enableOfflineQueue: !disposable && !controlPlane,
    retryStrategy: (attempt: number) => {
      const exponential = Math.min(config.redisRetryMaxDelayMs, 100 * 2 ** Math.min(attempt - 1, 6));
      return exponential + Math.floor(Math.random() * 100);
    },
    ...overrides,
  };
}

export function createRedisClient(url: string, purpose: RedisClientPurpose, overrides: RedisOptions = {}): Redis {
  const client = new Redis(url, redisOptions(purpose, overrides));
  let lastErrorLogAt = 0;
  client.on("error", (error) => {
    const now = Date.now();
    if (now - lastErrorLogAt < 30_000) return;
    lastErrorLogAt = now;
    // Never log the ioredis error object: it can carry command arguments and
    // provider connection details. The purpose is safe operational context.
    logger.error({ client: purpose, errorType: error instanceof Error ? error.name : "RedisError" }, "Redis client error");
  });
  return client;
}
