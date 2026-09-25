import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { memoryRouter } from "../src/memory/router.js";
import { CAPABILITY_MEMORY_ACCESS_MATRIX } from "../src/memory/types.js";
import { getSession, initStore, saveSession } from "../src/store.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("saves memory record with pre-classification and initial active status", async () => {
  const userId = 990001;
  const record = await memoryRouter.classifyAndSaveMemory(userId, {
    category: "project",
    key: "Build Target",
    value: "Node.js v22 TypeScript microservice",
    confidence: 0.95,
    sensitivity: "normal",
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
    sensitivity: "normal",
  });

  const updated = await memoryRouter.classifyAndSaveMemory(userId, {
    category: "business",
    key: "Primary Color Preset",
    value: "D946EF",
    sensitivity: "normal",
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
  await memoryRouter.classifyAndSaveMemory(userId, { category: "project", key: "Sprint Goal", value: "Ship delegation v1", sensitivity: "normal" });
  await memoryRouter.classifyAndSaveMemory(userId, { category: "relationship", key: "Client Contact", value: "Alice@acme.com", sensitivity: "normal" });
  await memoryRouter.classifyAndSaveMemory(userId, { category: "asset", key: "Logo Vector", value: "workspace/logo.png", sensitivity: "normal" });

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
    sensitivity: "normal",
  });

  const forgot = await memoryRouter.forgetMemory(userId, record.id);
  assert.equal(forgot, true);

  const activeMemories = await memoryRouter.queryScopedMemories(userId, "chusky", { category: "negative" });
  assert.equal(activeMemories.find((m) => m.id === record.id), undefined);
});

test("specialists receive only explicitly normal, in-date memories", async () => {
  const userId = 990005;
  const now = Date.now();
  await memoryRouter.classifyAndSaveMemory(userId, {
    category: "business", key: "Approved brand voice", value: "Clear and concise",
    sensitivity: "normal",
  });
  await memoryRouter.classifyAndSaveMemory(userId, {
    category: "business", key: "Private negotiation detail", value: "Confidential terms",
    sensitivity: "sensitive",
  });
  await memoryRouter.classifyAndSaveMemory(userId, {
    category: "business", key: "Needs review", value: "Outdated operating detail",
    sensitivity: "normal", reviewAt: now - 1,
  });
  await memoryRouter.classifyAndSaveMemory(userId, {
    category: "business", key: "Expired detail", value: "Old operating detail",
    sensitivity: "normal", expiresAt: now - 1,
  });

  const memories = await memoryRouter.queryScopedMemories(userId, "maya");
  assert.deepEqual(memories.map((memory) => memory.key), ["Approved brand voice"]);
});

test("legacy memories without a sensitivity label are not exposed to specialists", async () => {
  const userId = 990006;
  const legacy = await memoryRouter.classifyAndSaveMemory(userId, {
    category: "business", key: "Legacy fact", value: "Previously unclassified",
    sensitivity: "normal",
  });
  const session = await getSession(userId);
  const record = session.memories.find((memory) => memory.id === legacy.id);
  assert.ok(record);
  delete (record as typeof record & { sensitivity?: "normal" | "sensitive" }).sensitivity;
  await saveSession(userId, session);

  assert.equal((await memoryRouter.queryScopedMemories(userId, "maya")).length, 0);
});

test("unclassified saves default to sensitive and stay private from specialists", async () => {
  const userId = 990007;
  const record = await memoryRouter.classifyAndSaveMemory(userId, {
    category: "business", key: "Unclassified fact", value: "Not explicitly reviewed",
  });

  assert.equal(record.sensitivity, "sensitive");
  assert.equal((await memoryRouter.queryScopedMemories(userId, "maya")).length, 0);
});
