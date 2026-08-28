import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHandlers } from "../src/handlers.js";
import { createApproval, getApproval, getSession, initStore, setComposioSessionId, appendMessages } from "../src/store.js";

class FakeBot {
  commands = new Map<string, (ctx: any) => Promise<void>>();
  events = new Map<string, (ctx: any) => Promise<void>>();
  callbacks: { pattern: RegExp; handler: (ctx: any) => Promise<void> }[] = [];
  catch() { return this; }
  command(name: string, handler: (ctx: any) => Promise<void>) { this.commands.set(name, handler); }
  on(name: string, handler: (ctx: any) => Promise<void>) { this.events.set(name, handler); }
  callbackQuery(pattern: RegExp, handler: (ctx: any) => Promise<void>) { this.callbacks.push({ pattern, handler }); }
}

function context(userId: number, match = "") {
  const sent: any[] = [];
  return {
    from: { id: userId }, chat: { id: userId + 1000 }, match,
    reply: async (text: string, options?: unknown) => { sent.push({ method: "reply", text, options }); return { message_id: 1 }; },
    editMessageText: async (text: string) => { sent.push({ method: "edit", text }); },
    answerCallbackQuery: async () => undefined,
    api: { editMessageText: async (_chatId: number, _messageId: number, text: string) => { sent.push({ method: "edit", text }); } },
    sent,
  };
}

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("clear history preserves the Composio session while clear session removes it", async () => {
  const bot = new FakeBot();
  registerHandlers(bot as any);
  const userId = 840001;
  await setComposioSessionId(userId, "session-1");
  await appendMessages(userId, [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]);
  const historyCtx = context(userId, "history");
  await bot.commands.get("clear")!(historyCtx);
  assert.equal((await getSession(userId)).composioSessionId, "session-1");
  assert.equal((await getSession(userId)).history.length, 0);
  const sessionCtx = context(userId, "session");
  await bot.commands.get("clear")!(sessionCtx);
  assert.equal((await getSession(userId)).composioSessionId, undefined);
  assert.match(sessionCtx.sent.at(-1).text, /Fresh start/);
});

test("approval callback is scoped to the requesting user and deny never executes", async () => {
  const bot = new FakeBot();
  registerHandlers(bot as any);
  const approval = await createApproval({ userId: 840002, toolSlug: "CHUCK_DAYTONA_EXECUTE", args: { command: "rm -rf", purpose: "test" }, request: "remove", history: [], model: "test/model" });
  const callback = bot.callbacks.find((item) => item.pattern.source.includes("appr:"))!;
  const foreign = context(840003);
  foreign.match = ["appr:deny:" + approval.id, "deny", approval.id];
  await callback.handler(foreign);
  assert.equal((await getApproval(840002, approval.id))?.status, "pending");
  const owner = context(840002);
  owner.match = ["appr:deny:" + approval.id, "deny", approval.id];
  await callback.handler(owner);
  assert.equal((await getApproval(840002, approval.id))?.status, "denied");
  assert.match(owner.sent.at(-1).text, /Action denied/);
});
