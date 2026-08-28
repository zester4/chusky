import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  addHistorySummary, appendMessages, acquireUserLock, addReminder, claimTriggerEvent, clearHistory, clearSession,
  createApproval, createCliDevice, createCliPairing, getApproval, getDaytonaWorkspace, getSession, initStore,
  listReminders, releaseUserLock, saveDaytonaWorkspace, setApprovalStatus, setComposioSessionId, setModel,
  upsertMemory, searchMemories, forgetMemory, writeScratchpad, readScratchpad, clearScratchpad,
  claimTelegramUpdate,
  type DaytonaWorkspaceRecord,
} from "../src/store.js";

before(async () => { await initStore({ memoryOnly: true }); });

test("normalizes old sessions while preserving new durable defaults", async () => {
  const userId = 810001;
  const session = await getSession(userId);
  session.history = [{ role: "user", content: "hello" }];
  delete (session as any).memories;
  delete (session as any).approvals;
  await import("../src/store.js").then(({ saveSession }) => saveSession(userId, session));
  const restored = await getSession(userId);
  assert.deepEqual(restored.memories, []);
  assert.deepEqual(restored.approvals, []);
  assert.equal(restored.history[0].content, "hello");
});

test("history trimming creates bounded summaries", async () => {
  const userId = 810002;
  const messages = Array.from({ length: 44 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, content: `message-${i}` }));
  await appendMessages(userId, messages);
  const session = await getSession(userId);
  assert.equal(session.history.length, 40);
  assert.equal(session.summaries.length, 1);
  assert.match(session.summaries[0], /message-0/);
});

test("clear history differs from clear session and preserves Daytona mapping", async () => {
  const userId = 810003;
  await setComposioSessionId(userId, "composio-1");
  const workspace: DaytonaWorkspaceRecord = { sandboxId: "sandbox-1", name: "chusky-810003", createdAt: Date.now(), updatedAt: Date.now() };
  await saveDaytonaWorkspace(userId, workspace);
  await appendMessages(userId, [{ role: "user", content: "keep?" }]);
  await clearHistory(userId);
  let session = await getSession(userId);
  assert.equal(session.history.length, 0);
  assert.equal(session.composioSessionId, "composio-1");
  assert.equal((await getDaytonaWorkspace(userId))?.sandboxId, "sandbox-1");
  await setModel(userId, "test/model");
  await clearSession(userId);
  session = await getSession(userId);
  assert.equal(session.composioSessionId, undefined);
  assert.equal((await getDaytonaWorkspace(userId))?.sandboxId, "sandbox-1");
});

test("memory and scratchpad remain private and searchable", async () => {
  const userId = 810004;
  const otherUser = 810005;
  await upsertMemory(userId, { category: "profile", key: "timezone", value: "Europe/London", confidence: 1 });
  await upsertMemory(otherUser, { category: "profile", key: "timezone", value: "America/New_York", confidence: 1 });
  assert.equal((await searchMemories(userId, "London"))[0].value, "Europe/London");
  assert.equal((await searchMemories(userId, "New York")).length, 0);
  await writeScratchpad(userId, "deploy", "use staging");
  assert.equal((await readScratchpad(userId, "staging")).deploy.content, "use staging");
  await clearScratchpad(userId, "deploy");
  assert.deepEqual(await readScratchpad(userId), {});
  assert.equal(await forgetMemory(userId, "timezone"), true);
});

test("reminder ownership and active listing are enforced", async () => {
  const userId = 810006;
  const reminder = { id: "rem-test-1", userId, text: "check", runAt: Date.now() + 60_000, status: "scheduled" as const, createdAt: Date.now() };
  await addReminder(userId, reminder);
  assert.equal((await listReminders(userId)).length, 1);
  assert.equal(await (await import("../src/store.js")).getReminder(810007, reminder.id).then((v) => v === undefined), true);
});

test("approvals require exact ownership, expiry, and one-time state transitions", async () => {
  const userId = 810008;
  const approval = await createApproval({ userId, toolSlug: "CHUCK_DAYTONA_EXECUTE", args: { command: "pwd", purpose: "inspect" }, request: "inspect", history: [], model: "test/model" });
  assert.equal((await getApproval(810009, approval.id)), undefined);
  assert.equal(await setApprovalStatus(userId, approval.id, "approved"), true);
  assert.equal(await setApprovalStatus(userId, approval.id, "approved"), false);
  assert.equal(await setApprovalStatus(userId, approval.id, "denied"), false);
  assert.equal(await setApprovalStatus(userId, approval.id, "consumed"), true);
  assert.equal(await setApprovalStatus(userId, approval.id, "denied"), false);
});

test("locks are exclusive and safely releasable", async () => {
  const userId = 810010;
  assert.equal(await acquireUserLock(userId, "token-a", 5), true);
  assert.equal(await acquireUserLock(userId, "token-b", 5), false);
  await releaseUserLock(userId, "token-b");
  assert.equal(await acquireUserLock(userId, "token-b", 5), false);
  await releaseUserLock(userId, "token-a");
  assert.equal(await acquireUserLock(userId, "token-b", 5), true);
});

test("trigger events are idempotent", async () => {
  const eventId = `event-${Date.now()}-${Math.random()}`;
  assert.equal(await claimTriggerEvent(eventId), true);
  assert.equal(await claimTriggerEvent(eventId), false);
});

test("Telegram update claims deduplicate retries", async () => {
  assert.equal(await claimTelegramUpdate(991001), true);
  assert.equal(await claimTelegramUpdate(991001), false);
  assert.equal(await claimTelegramUpdate(991002), true);
});

test("CLI pairing is one-time and device tokens authenticate by hash", async () => {
  const userId = 810011;
  const code = await createCliPairing(userId);
  const consumed = await import("../src/store.js").then(({ consumeCliPairing }) => consumeCliPairing(code));
  assert.equal(consumed?.userId, userId);
  assert.equal(await import("../src/store.js").then(({ consumeCliPairing }) => consumeCliPairing(code)), undefined);
  const created = await createCliDevice(userId, "test-terminal");
  const auth = await import("../src/store.js").then(({ authenticateCliToken }) => authenticateCliToken(created.token));
  assert.equal(auth?.userId, userId);
  assert.equal(await import("../src/store.js").then(({ authenticateCliToken }) => authenticateCliToken("not-a-token")), undefined);
});
