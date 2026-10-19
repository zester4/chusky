import Redis, { type RedisOptions } from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Keep direct Redis clients on one explicit production policy. The channel
 * adapters own their client construction, so this factory is used by Chusky's
 * store, auth, control-plane, and disposable-cache clients.
 */
export type RedisClientPurpose = "durable" | "auth" | "control" | "cache";

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
