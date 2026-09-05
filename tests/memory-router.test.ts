import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { memoryRouter } from "../src/memory/router.js";
import { CAPABILITY_MEMORY_ACCESS_MATRIX } from "../src/memory/types.js";
import { initStore } from "../src/store.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("saves memory record with pre-classification and initial active status", async () => {
  const userId = 990001;
  const record = await memoryRouter.classifyAndSaveMemory(userId, {
    category: "project",
    key: "Build Target",
    value: "Node.js v22 TypeScript microservice",
    confidence: 0.95,
  });

  assert.equal(record.ownerId, userId);
  assert.equal(record.category, "project");
  assert.equal(record.key, "Build Target");
  assert.equal(record.value, "Node.js v22 TypeScript microservice");
  assert.equal(record.status, "active");
  assert.equal(record.confidence, 0.95);
});

test("supersedes old memory record when an existing key/category is updated", async () => {
  const userId = 990002;
  const initial = await memoryRouter.classifyAndSaveMemory(userId, {
    category: "business",
    key: "Primary Color Preset",
    value: "123456",
  });

  const updated = await memoryRouter.classifyAndSaveMemory(userId, {
    category: "business",
    key: "Primary Color Preset",
    value: "D946EF",
  });

  assert.equal(updated.status, "active");
  assert.equal(updated.supersedesId, initial.id);

  // Query memory history including superseded records
  const allMemories = await memoryRouter.queryScopedMemories(userId, "chusky", {
    category: "business",
    includeSuperseded: true,
  });

  const oldRec = allMemories.find((m) => m.id === initial.id);
  assert.equal(oldRec?.status, "superseded");
});

test("enforces domain-scoped category filtering for worker capabilities", async () => {
  const userId = 990003;
  await memoryRouter.classifyAndSaveMemory(userId, { category: "project", key: "Sprint Goal", value: "Ship delegation v1" });
  await memoryRouter.classifyAndSaveMemory(userId, { category: "relationship", key: "Client Contact", value: "Alice@acme.com" });
  await memoryRouter.classifyAndSaveMemory(userId, { category: "asset", key: "Logo Vector", value: "workspace/logo.png" });

  // Lucas (Engineering) can read 'project', 'procedural', 'asset' but NOT 'relationship'
  const lucasMemories = await memoryRouter.queryScopedMemories(userId, "lucas");
  const categoriesLucasSeen = lucasMemories.map((m) => m.category);
  assert.ok(!categoriesLucasSeen.includes("relationship"));
  assert.ok(categoriesLucasSeen.includes("project") || categoriesLucasSeen.includes("asset"));

  // Dexter (Computer Use) can read ONLY 'project'
  const dexterMemories = await memoryRouter.queryScopedMemories(userId, "dexter");
  assert.ok(dexterMemories.every((m) => m.category === "project"));

  // Chusky (Supervisor) has full access across all 8 categories
  const chuskyMemories = await memoryRouter.queryScopedMemories(userId, "chusky");
  assert.ok(chuskyMemories.length >= 3);
});

test("marks memory status as deleted when forgetMemory is called", async () => {
  const userId = 990004;
  const record = await memoryRouter.classifyAndSaveMemory(userId, {
    category: "negative",
    key: "Do Not Recommend PHP",
    value: "User explicitly prefers TypeScript",
  });

  const forgot = await memoryRouter.forgetMemory(userId, record.id);
  assert.equal(forgot, true);

  const activeMemories = await memoryRouter.queryScopedMemories(userId, "chusky", { category: "negative" });
  assert.equal(activeMemories.find((m) => m.id === record.id), undefined);
});
