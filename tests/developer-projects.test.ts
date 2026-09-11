import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { createTelegramProject, listTelegramProjects, revokeTelegramProject, rotateTelegramProjectKey } from "../src/developerProjects.js";
import { getSession, initStore } from "../src/store.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("Telegram project keys are shown once and stored hash-only", async () => {
  const created = await createTelegramProject(810001, "My backend");
  assert.match(created.key, /^chsk_proj_/);
  const stored = (await getSession(0)).sdkProjects!.find((project) => project.id === created.id)!;
  assert.equal(stored.ownerTelegramUserId, 810001);
  assert.notEqual(stored.keyHash, created.key);
  assert.equal(JSON.stringify(stored).includes(created.key), false);
  assert.deepEqual(await listTelegramProjects(810001), [{
    id: created.id,
    name: "My backend",
    keyPrefix: created.keyPrefix,
    scopes: ["*"],
    createdAt: created.createdAt,
  }]);
});

test("Telegram owners cannot rotate or revoke another user's key", async () => {
  const created = await createTelegramProject(810002, "Private app", ["threads:read", "threads:write"]);
  await assert.rejects(() => rotateTelegramProjectKey(810003, created.id), /not found/);
  assert.equal(await revokeTelegramProject(810003, created.id), false);
  const rotated = await rotateTelegramProjectKey(810002, created.id);
  assert.notEqual(rotated.key, created.key);
  assert.equal(await revokeTelegramProject(810002, created.id), true);
  assert.deepEqual(await listTelegramProjects(810002), []);
});
