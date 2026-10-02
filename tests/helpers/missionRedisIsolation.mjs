const PREFIX = /^chusky-proof:\{[0-9a-f-]{36}\}:$/;

export function assertProofRedisCommand(command, prefix) {
  if (!PREFIX.test(prefix ?? "")) throw new Error("A unique mission proof Redis namespace is required.");
  if (["scan", "keys", "flushall", "flushdb", "swapdb", "migrate", "restore", "config", "debug", "shutdown"].includes(command.name.toLowerCase())) throw new Error("Database-wide commands are forbidden in mission proofs.");
  const keys = command.getKeys().map(String);
  if (keys.some((key) => !key.startsWith(prefix))) throw new Error("Mission proof Redis command escaped its namespace.");
  return keys;
}

/** The same real ioredis backend, with test-only physical key isolation. */
export function installProofRedisIsolation(require, prefix, reportKeys) {
  if (!PREFIX.test(prefix ?? "")) throw new Error("A unique mission proof Redis namespace is required.");
  const moduleId = require.resolve("ioredis");
  const Redis = require(moduleId);
  const seen = new Set();
  class IsolatedRedis extends Redis {
    constructor(url, options) { super(url, { ...options, keyPrefix: prefix }); }
    sendCommand(command, stream) {
      for (const key of assertProofRedisCommand(command, prefix)) {
        if (!seen.has(key)) { seen.add(key); reportKeys(key); }
      }
      return super.sendCommand(command, stream);
    }
  }
  // Preserve default/named import shapes and the original SDK static exports.
  const isolated = new Proxy(IsolatedRedis, { get(target, key, receiver) {
    if (key === "default" || key === "Redis") return isolated;
    return Reflect.get(target, key, receiver);
  } });
  require.cache[moduleId].exports = isolated;
}
