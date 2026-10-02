import test from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { assertProofRedisCommand } from "./helpers/missionRedisIsolation.mjs";

test("mission Redis proof rejects unprefixed keys and database-wide operations before dispatch", () => {
  const prefix = "chusky-proof:{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}:";
  assert.deepEqual(assertProofRedisCommand(new Redis.Command("get", ["chuck:tasks:1"], { keyPrefix: prefix }), prefix), [`${prefix}chuck:tasks:1`]);
  assert.throws(() => assertProofRedisCommand(new Redis.Command("get", ["chuck:tasks:1"]), prefix), /escaped/);
  assert.throws(() => assertProofRedisCommand(new Redis.Command("flushdb", []), prefix), /forbidden/);
  assert.throws(() => assertProofRedisCommand(new Redis.Command("scan", ["0", "MATCH", "*"]), prefix), /forbidden/);
  assert.throws(() => assertProofRedisCommand(new Redis.Command("ping", []), ""), /namespace/);
});

test("mission Redis proof isolates WATCH and Lua keys using the installed client's real key transformation", () => {
  const prefix = "chusky-proof:{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}:";
  assert.deepEqual(assertProofRedisCommand(new Redis.Command("watch", ["chuck:tasks:1"], { keyPrefix: prefix }), prefix), [`${prefix}chuck:tasks:1`]);
  assert.deepEqual(assertProofRedisCommand(new Redis.Command("eval", ["return redis.call('GET', KEYS[1])", 1, "chuck:tasks:1"], { keyPrefix: prefix }), prefix), [`${prefix}chuck:tasks:1`]);
});
