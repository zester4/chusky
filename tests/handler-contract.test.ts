import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHandlers, telegramAgentChannelContext } from "../src/handlers.js";
import { config } from "../src/config.js";
import { addJob, addReminder, appendChannelConversationMessages, createApproval, createTask, getApproval, getChannelConversation, getSession, initStore, setComposioSessionId, appendMessages } from "../src/store.js";

class FakeBot {
  commands = new Map<string, (ctx: any) => Promise<void>>();
  events = new Map<string, (ctx: any) => Promise<void>>();
  callbacks: { pattern: RegExp; handler: (ctx: any) => Promise<void> }[] = [];
  use() { return this; }
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
    api: { editMessageText: async (_chatId: number, _messageId: number, text: string, options?: unknown) => { sent.push({ method: "edit", text, options }); } },
    sent,
  };
}

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("Telegram agent context marks groups as shared and keeps their conversation identity", () => {
  const group = context(840020);
  group.chat = { id: -100840020, type: "supergroup" };
  const groupContext = telegramAgentChannelContext(group, 840020);
  assert.deepEqual(groupContext, {
    accountId: "account_840020",
    provider: "telegram",
    conversationId: "telegram:-:-100840020:-",
    scope: "shared",
  });

  const privateChat = context(840020);
  const privateContext = telegramAgentChannelContext(privateChat, 840020);
  assert.equal(privateContext.scope, "private");
  assert.equal(privateContext.accountId, "account_840020");
  assert.equal(privateContext.provider, "telegram");
});

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

test("clear group resets only the Telegram group's shared context", async () => {
  const bot = new FakeBot();
  registerHandlers(bot as any);
  const userId = 840010;
  const groupId = -100840010;
  const conversationId = `telegram:-:${groupId}:-`;
  await appendChannelConversationMessages({
    id: conversationId, accountId: `account_${userId}`, userId, provider: "telegram", scope: "shared",
    messages: [{ role: "user", content: "previous group work", createdAt: Date.now() - 1_000 }],
  });
  const groupCtx = context(userId, "group");
  groupCtx.chat = { id: groupId, type: "group" };
  groupCtx.api.getChatMember = async () => ({ status: "administrator" });
  await bot.commands.get("clear")!(groupCtx);
  assert.deepEqual((await getChannelConversation(conversationId))?.history, []);
  assert.match(groupCtx.sent.at(-1).text, /fresh start/i);
  assert.notEqual((await getSession(userId)).history, undefined);
});

test("approval callback is scoped to the requesting user and deny never executes", async () => {
  const bot = new FakeBot();
  registerHandlers(bot as any);
  const approval = await createApproval({ userId: 840002, toolSlug: "CHUCK_DAYTONA_EXECUTE", args: { command: "rm -rf", purpose: "test" }, request: "remove", history: [], model: "test/model" });
  const callback = bot.callbacks.find((item) => item.pattern.source.startsWith("^appr:(approve|deny)"))!;
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

test("home workspace exposes durable reminders, schedules, tasks, and voice controls", async () => {
  const bot = new FakeBot();
  registerHandlers(bot as any);
  const userId = 840004;
  const now = Date.now();
  await addReminder(userId, { id: "reminder_home", userId, text: "Follow up with Ada", runAt: now + 60_000, status: "scheduled", createdAt: now });
  await addJob(userId, { id: "job_home", userId, text: "Send a weekly digest", cron: "0 9 * * 1", scheduleId: "schedule_home", status: "active", createdAt: now });
  await createTask(userId, { title: "Prepare proposal", objective: "Draft the client proposal" });
  const workspace = bot.callbacks.find((item) => item.pattern.source.includes("reminders|schedules|tasks|voice"));
  assert.ok(workspace);
  for (const [action, expected] of [["reminders", /Follow up with Ada/], ["schedules", /Send a weekly digest/], ["tasks", /Prepare proposal/]] as const) {
    const ctx = context(userId);
    ctx.callbackQuery = { message: { message_id: 1 } };
    ctx.match = [`home:${action}`, action];
    await workspace.handler(ctx);
    assert.match(ctx.sent.at(-1).text, expected);
  }
  const voice = bot.callbacks.find((item) => item.pattern.source.startsWith("^home:voice:(on|off)"));
  assert.ok(voice);
  const voiceCtx = context(userId);
  voiceCtx.callbackQuery = { message: { message_id: 1 } };
  voiceCtx.match = ["home:voice:on", "on"];
  await voice.handler(voiceCtx);
  assert.equal((await getSession(userId)).voiceReplies, true);
});

test("home exposes a private third-party MCP status and management view", async () => {
  const bot = new FakeBot();
  registerHandlers(bot as any);
  const userId = 840016;
  const previousMcpEnabled = config.mcpEnabled;
  config.mcpEnabled = true;
  try {
    const workspace = bot.callbacks.find((item) => item.pattern.source.includes("mcp"));
    assert.ok(workspace);
    const ctx = context(userId);
    ctx.callbackQuery = { message: { message_id: 1 } };
    ctx.match = ["home:mcp", "mcp"];
    await workspace.handler(ctx);
    assert.match(ctx.sent.at(-1).text, /No third-party MCP servers/);
    const mcp = bot.callbacks.find((item) => item.pattern.source.startsWith("^home:mcp:"));
    assert.ok(mcp);
    const invalidConnect = context(userId);
    invalidConnect.callbackQuery = { message: { message_id: 1 } };
    invalidConnect.match = ["home:mcp:c:not-in-catalog", "c", "not-in-catalog"];
    await mcp.handler(invalidConnect);
    assert.match(invalidConnect.sent.at(-1).text, /no longer available/i);

    const shared = context(userId);
    shared.chat = { id: -100840016, type: "group" };
    shared.callbackQuery = { message: { message_id: 1 } };
    shared.match = ["home:mcp", "mcp"];
    await workspace.handler(shared);
    assert.match(shared.sent.at(-1).text, /private chat/i);
  } finally {
    config.mcpEnabled = previousMcpEnabled;
  }
});

test("home voice menu saves independent live-call voice choices for the owner", async () => {
  const bot = new FakeBot();
  registerHandlers(bot as any);
  const userId = 840014;
  const selectVoice = bot.callbacks.find((item) => item.pattern.source.startsWith("^home:voice:set:(twilio|meetings)"));
  assert.ok(selectVoice);
  const ctx = context(userId);
  ctx.callbackQuery = { message: { message_id: 1 } };
  ctx.match = ["home:voice:set:twilio:flux-haley-en", "twilio", "flux-haley-en"];
  await selectVoice.handler(ctx);
  assert.equal((await getSession(userId)).voicePreferences?.twilio, "flux-haley-en");
  assert.equal((await getSession(userId + 1)).voicePreferences, undefined);

  const selectMeetingVoice = bot.callbacks.find((item) => item.pattern.source.startsWith("^home:voice:set:(twilio|meetings)"));
  assert.ok(selectMeetingVoice);
  const meetingCtx = context(userId);
  meetingCtx.callbackQuery = { message: { message_id: 2 } };
  meetingCtx.match = ["home:voice:set:meetings:flux-kit-en", "meetings", "flux-kit-en"];
  await selectMeetingVoice.handler(meetingCtx);
  assert.deepEqual((await getSession(userId)).voicePreferences, { twilio: "flux-haley-en", meetings: "flux-kit-en" });
});

test("home Bland voice choices come from its curated catalogue and are revalidated on selection", async () => {
  const bot = new FakeBot();
  registerHandlers(bot as any);
  const userId = 840015;
  const previousKey = config.blandApiKey;
  const previousFetch = globalThis.fetch;
  config.blandApiKey = "test-bland-key";
  const voiceId = "11111111-1111-4111-8111-111111111111";
  globalThis.fetch = async (input) => String(input) === "https://api.bland.ai/v1/voices"
    ? new Response(JSON.stringify({ voices: [{ id: voiceId, name: "Zoe", public: true, tags: ["Bland Curated"], service: "BTTS_V3" }] }), { status: 200 })
    : new Response(JSON.stringify({ ok: false }), { status: 400 });
  try {
    const provider = bot.callbacks.find((item) => item.pattern.source.startsWith("^home:voice:provider:"));
    assert.ok(provider);
    const menuCtx = context(userId);
    menuCtx.callbackQuery = { message: { message_id: 1 } };
    menuCtx.match = ["home:voice:provider:bland", "bland"];
    await provider.handler(menuCtx);
    const voiceButtons = menuCtx.sent.at(-1).options.reply_markup.inline_keyboard.flat();
    assert.ok(voiceButtons.some((button: { text: string; callback_data: string }) => button.text.includes("Zoe") && button.callback_data === `home:voice:set:bland:${voiceId}`));

    const select = bot.callbacks.find((item) => item.pattern.source.startsWith("^home:voice:set:bland:"));
    assert.ok(select);
    const selectCtx = context(userId);
    selectCtx.callbackQuery = { message: { message_id: 1 } };
    selectCtx.match = [`home:voice:set:bland:${voiceId}`, voiceId];
    await select.handler(selectCtx);
    assert.deepEqual((await getSession(userId)).voicePreferences?.bland, { id: voiceId, name: "Zoe" });
  } finally {
    globalThis.fetch = previousFetch;
    config.blandApiKey = previousKey;
  }
});
