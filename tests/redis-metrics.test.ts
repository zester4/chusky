import assert from "node:assert/strict";
import test from "node:test";
import { RedisCommandMetrics, RedisReadBudgetExceededError, instrumentRedisClient, redisOperationFamily, withRedisMetricRoute } from "../src/redisMetrics.js";
import { redisOptions } from "../src/redisClient.js";

test("direct Redis clients use explicit bounded policies by purpose", () => {
  const durable = redisOptions("durable");
  assert.equal(durable.maxRetriesPerRequest, 3);
  assert.equal(durable.enableOfflineQueue, true);
  assert.equal(durable.connectTimeout, 5_000);
  assert.equal(durable.commandTimeout, 5_000);

  const cache = redisOptions("cache");
  assert.equal(cache.maxRetriesPerRequest, 1);
  assert.equal(cache.enableOfflineQueue, false);
  assert.equal(cache.lazyConnect, false);
});

test("Redis telemetry groups key families without retaining owner keys", () => {
  assert.equal(redisOperationFamily({ name: "get", args: ["chuck:session:12345"] }), "session");
  assert.equal(redisOperationFamily({ name: "eval", args: ["return redis.call('GET',KEYS[1])", "1", "chuck:tasks:12345:task_abc", "secret payload"] }), "tasks");
  assert.equal(redisOperationFamily({ name: "mget", args: ["chuck:session:1", "chuck:tasks:1"] }), "mixed");
  assert.equal(redisOperationFamily({ name: "get", args: ["unrecognized-private-key"] }), "other");
});

test("Redis telemetry aggregates bounded command, transfer, latency, value, and error metrics", () => {
  const metrics = new RedisCommandMetrics();
  metrics.record({ name: "set", args: ["chuck:session:12345", "private conversation text"] }, { result: "OK", durationMs: 3 });
  metrics.record({ name: "get", args: ["chuck:session:12345"] }, { result: "x".repeat(40), durationMs: 5 });
  metrics.record({ name: "get", args: ["chuck:session:12345"] }, { error: true, durationMs: 2 });

  assert.deepEqual(metrics.snapshot().session, {
    commands: 3,
    errors: 1,
    requestBytes: 82,
    responseBytes: 42,
    durationMs: 10,
    maxValueBytes: 40,
  });
  assert.equal(JSON.stringify(metrics.snapshot()).includes("12345"), false);
  assert.equal(JSON.stringify(metrics.snapshot()).includes("private conversation text"), false);
});

test("Redis telemetry estimates object replies without retaining payloads and bounds traversal", () => {
  const metrics = new RedisCommandMetrics();
  const cyclic: Record<string, unknown> = { subject: "private subject", count: 42 };
  cyclic.self = cyclic;
  metrics.record({ name: "hgetall", args: ["chuck:memory:12345"] }, { result: cyclic });

  const measured = metrics.snapshot().memory;
  assert.equal(measured.commands, 1);
  assert.equal(measured.responseBytes, Buffer.byteLength("subject", "utf8") + Buffer.byteLength("private subject", "utf8") + Buffer.byteLength("count", "utf8") + Buffer.byteLength("42", "utf8") + Buffer.byteLength("self", "utf8"));
  assert.equal(measured.maxValueBytes, measured.responseBytes);
  assert.equal(JSON.stringify(metrics.snapshot()).includes("private subject"), false);

  const manyFields = Object.fromEntries(Array.from({ length: 12_000 }, (_, index) => [`field-${index}`, "x"]));
  metrics.record({ name: "hgetall", args: ["chuck:memory:12345"] }, { result: manyFields });
  assert.ok(metrics.snapshot().memory.responseBytes < 12_000 * Buffer.byteLength("field-11999x", "utf8"));
});

test("instrumentation observes commands without changing command outcomes", async () => {
  const metrics = new RedisCommandMetrics();
  const client = {
    sendCommand(command: { promise: Promise<unknown> }) { return command.promise; },
  };
  instrumentRedisClient(client, metrics);

  const reply = Promise.resolve("safe reply");
  assert.equal(await client.sendCommand({ name: "get", args: ["chuck:mission:123"], promise: reply } as never), "safe reply");
  const rejection = Promise.reject(new Error("redis unavailable"));
  await assert.rejects(client.sendCommand({ name: "set", args: ["chuck:mission:123", "payload"], promise: rejection } as never), /redis unavailable/);
  await Promise.resolve();

  assert.equal(metrics.snapshot().missions.commands, 2);
  assert.equal(metrics.snapshot().missions.errors, 1);
});

test("enforced route budgets stop subsequent Redis commands after a response limit is exceeded", async () => {
  const metrics = new RedisCommandMetrics();
  let dispatched = 0;
  const client = {
    sendCommand(command: { name: string; args: readonly unknown[]; promise?: Promise<unknown> }) {
      dispatched += 1;
      command.promise = Promise.resolve("oversized");
      return command.promise;
    },
  };
  instrumentRedisClient(client, metrics);

  await withRedisMetricRoute("GET /v1/budget", async () => {
    await client.sendCommand({ name: "get", args: ["chuck:session:owner"] });
    await assert.rejects(
      client.sendCommand({ name: "get", args: ["chuck:session:owner:next"] }),
      (error: unknown) => error instanceof RedisReadBudgetExceededError,
    );
  }, { maxResponseBytes: 1, enforce: true });

  assert.equal(dispatched, 1);
  assert.equal(metrics.snapshot().session.commands, 1);
});

test("Redis telemetry attributes bounded route samples without owner identity", async () => {
  const metrics = new RedisCommandMetrics();
  await withRedisMetricRoute("GET /v1/activity?user=private", async () => {
    metrics.record({ name: "mget", args: ["chuck:tasks:123", "chuck:tasks:123:summary"] }, { result: ["x", "y"], durationMs: 2 });
  });
  const samples = metrics.takeRouteSnapshot();
  assert.deepEqual(samples.map(({ route, family, commands, responseBytes }) => ({ route, family, commands, responseBytes })), [{ route: "GET /v1/activityuserprivate", family: "tasks", commands: 1, responseBytes: 2 }]);
});
