import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { config } from "./config.js";
import {
  runAgent, fetchModels, getConnectionUrl, getToolkitStates, invalidateSession, ApprovalRequiredError,
  transcribeAudio, generateImage,
  listTriggers, createTrigger, setTriggerState, deleteTrigger,
  searchTools
} from "./agent.js";
import type { ContentPart } from "./types.js";
import {
  getSession, appendMessages, addUsage, canSpend, clearHistory, clearSession, setModel, getModel, checkRateLimit,
  setTelegramChatId, getApproval, setApprovalStatus, claimApproval, createCliPairing, listCliDevices, revokeCliDeviceHash,
  claimTelegramUpdate,
} from "./store.js";
import { acquireUserLock, releaseUserLock } from "./store.js";
import { mdToTelegramHtml, splitHtml } from "./markdown.js";
import { logger } from "./logger.js";
import { randomUUID } from "node:crypto";

const activeRequests = new Map<number, AbortController>();
async function acquireQueuedLock(userId: number, token: string, signal: AbortSignal): Promise<void> {
  while (!(await acquireUserLock(userId, token))) {
    if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAllowed(ctx: Context): boolean {
  if (config.allowedUsers.length === 0) return true;
  return config.allowedUsers.includes(String(ctx.from?.id ?? ""));
}

async function guard(ctx: Context): Promise<boolean> {
  if (ctx.from && ctx.chat && isAllowed(ctx)) await setTelegramChatId(ctx.from.id, ctx.chat.id);
  if (isAllowed(ctx)) return true;
  await ctx.reply("⛔ You are not authorised to use Chusky.");
  return false;
}

async function replyHtml(ctx: Context, html: string): Promise<void> {
  for (const chunk of splitHtml(html)) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(chunk.replace(/<[^>]+>/g, ""));
    }
  }
}

async function editHtml(ctx: Context, msgId: number, html: string): Promise<void> {
  const chunks = splitHtml(html);
  try {
    await ctx.api.editMessageText(ctx.chat!.id, msgId, chunks[0], { parse_mode: "HTML" });
  } catch { /* ignore */ }
  for (const chunk of chunks.slice(1)) await replyHtml(ctx, chunk);
}

async function downloadTelegramFile(ctx: Context, fileId: string): Promise<{ data: Buffer; path: string }> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path");
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
  return { data: Buffer.from(await res.arrayBuffer()), path: file.file_path };
}

export function audioFormat(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "oga" ? "ogg" : ext || "ogg";
}

async function handleMedia(ctx: Context, parts: ContentPart[], historyLabel: string): Promise<void> {
  if (!(await guard(ctx))) return;
  if (!(await checkRateLimit(ctx.from!.id))) {
    await ctx.reply(`⏱ Easy there. Max ${config.rateLimit} messages per ${config.rateWindowSeconds}s.`);
    return;
  }
  const userId = ctx.from!.id;
  const controller = new AbortController();
  const lockToken = randomUUID();
  activeRequests.set(userId, controller);
  await acquireQueuedLock(userId, lockToken, controller.signal);
  const statusText = historyLabel.startsWith("[Voice message]")
    ? "🎙️ <b>I’m listening to your voice message…</b>"
    : historyLabel.startsWith("[Audio message]")
      ? "🎙️ <b>I’m listening to your audio…</b>"
      : historyLabel.startsWith("[Image attached]")
        ? "👀 <b>I’m looking at your image…</b>"
        : historyLabel.startsWith("[Document attached:")
          ? "📄 <b>I’m reading your document…</b>"
          : historyLabel.startsWith("[Video attached]")
            ? "🎬 <b>I’m reviewing your video…</b>"
            : parts.some((part) => part.type !== "text")
              ? "👀 <b>I’m looking at what you sent…</b>"
              : "👂 <b>I’m listening to your message…</b>";
  const status = await ctx.reply(statusText, { parse_mode: "HTML" });
  try {
    const s = await getSession(userId);
    const result = await runAgent(userId, parts, s.history, s.model, undefined, controller.signal);
    await appendMessages(userId, [
      { role: "user", content: historyLabel },
      { role: "assistant", content: result.text },
    ]);
    if (result.cost) await addUsage(userId, result.cost);
    await editHtml(ctx, status.message_id, mdToTelegramHtml(result.text));
    for (const image of result.generatedImages ?? []) {
      await ctx.replyWithPhoto(new InputFile(image.data, image.mediaType.includes("jpeg") ? "chusky.jpg" : "chusky.png"));
      if (image.cost) await addUsage(userId, image.cost);
    }
  } catch (e) {
    logger.error({ err: e, userId }, "Chusky media error");
    await ctx.api.editMessageText(ctx.chat!.id, status.message_id, e instanceof DOMException && e.name === "AbortError" ? "🛑 Request cancelled." : `❌ ${String(e).slice(0, 500)}`);
  } finally {
    await releaseUserLock(userId, lockToken);
    activeRequests.delete(userId);
  }
}

// ── Live status bar ───────────────────────────────────────────────────────────
// Edits a single "status" message in-place as Chusky works,
// giving users real-time feedback on every step.

function buildStatusBar(steps: string[]): string {
  if (steps.length === 0) return "⏳ I’m thinking…";
  const lines: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const isLast = i === steps.length - 1;
    const icon = isLast ? "⟳" : "✓";
    lines.push(`${icon} ${steps[i]}`);
  }
  // Show last 4 steps max to keep it tidy
  const visible = lines.slice(-4);
  return visible.join("\n");
}

// ── Register all handlers ─────────────────────────────────────────────────────

export function registerHandlers(bot: Bot): void {

  // Telegram retries a webhook update when a long agent turn has not completed.
  // Claim the update ID durably so a retry cannot execute the same request twice.
  bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    if (!(await claimTelegramUpdate(updateId))) {
      logger.warn({ updateId }, "Ignoring duplicate Telegram update");
      return;
    }
    await next();
  });

  // /start ───────────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    if (!(await guard(ctx))) return;
    const model = await getModel(ctx.from!.id);
    await replyHtml(ctx,
      `⚡ <b>Hey, I'm Chusky — your AI agent.</b>\n\n` +
      `I have access to <b>1,000+ tools</b> across every major platform — GitHub, Gmail, Slack, Notion, Linear, Stripe, and more. Just tell me what you need.\n\n` +
      `<b>Active model:</b> <code>${model}</code>\n\n` +
      `<b>Commands:</b>\n` +
      `  /connect <code>[toolkit]</code> — connect an app\n` +
      `  /apps — see connected apps\n` +
      `  /model — switch AI model\n` +
      `  /clear history — clear conversation history\n` +
      `  /clear session — clear history and reset session\n` +
      `  /export — download conversation\n` +
      `  /usage — session stats\n` +
      `  /help — show this\n\n` +
      `What do you want to do?`
    );
  });

  // /help ────────────────────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    if (!(await guard(ctx))) return;
    await replyHtml(ctx,
      `<b>Chusky — Commands</b>\n\n` +
      `/connect <code>github</code> — connect GitHub (or any other app)\n` +
      `/apps — list connected apps &amp; their status\n` +
      `/model — switch AI model (per-session)\n` +
      `/clear history — wipe conversation history\n` +
      `/clear session — wipe history &amp; reset session\n` +
      `/triggers — list your Composio triggers\n` +
      `/trigger create|enable|disable|delete — manage triggers\n` +
      `/export — download conversation as .txt\n` +
      `/usage — messages sent, model, turns\n` +
      `/cancel — cancel the active request\n` +
      `/image <description> — generate an image\n` +
      `/info — full session details\n` +
      `/help — this message\n\n` +
      `<b>Chusky's built-in capabilities:</b>\n` +
      `• 1,000+ Composio tools (GitHub, Gmail, Slack, Notion…)\n` +
      `• <code>COMPOSIO_MANAGE_CONNECTIONS</code> — surfaces OAuth links inline\n` +
      `• <code>COMPOSIO_REMOTE_BASH_TOOL</code> — runs shell commands\n` +
      `• <code>COMPOSIO_REMOTE_WORKBENCH</code> — persistent remote environment\n` +
      `• <code>COMPOSIO_SEARCH_TOOL</code> — discovers tools by intent\n\n` +
      `Just describe what you need — Chusky figures out the tools.`
    );
  });

  bot.command("cancel", async (ctx) => {
    if (!(await guard(ctx))) return;
    const controller = activeRequests.get(ctx.from!.id);
    if (!controller) { await ctx.reply("There is no active request to cancel."); return; }
    controller.abort();
    await ctx.reply("🛑 Cancellation requested.");
  });

  bot.command("cli", async (ctx) => {
    if (!(await guard(ctx))) return;
    const uid = ctx.from!.id;
    const [action, ...rest] = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
    if (action === "link") {
      const code = await createCliPairing(uid);
      await ctx.reply(`🔐 <b>Terminal pairing code</b>\n\n<code>${code}</code>\n\nThis code expires in 10 minutes and can be used once. In your terminal run:\n\n<code>npm run cli -- auth link</code>`, { parse_mode: "HTML" });
      return;
    }
    if (action === "devices") {
      const devices = await listCliDevices(uid);
      if (!devices.length) { await ctx.reply("No linked terminals."); return; }
      const lines = devices.map((d) => `<code>${d.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code> — ${d.revokedAt ? "revoked" : "active"}`);
      await replyHtml(ctx, `<b>Linked terminals</b>\n\n${lines.join("\n")}`);
      return;
    }
    if (action === "revoke") {
      const name = rest.join(" ").trim();
      if (!name) { await ctx.reply("Usage: /cli revoke &lt;terminal name&gt;", { parse_mode: "HTML" }); return; }
      const device = (await listCliDevices(uid)).find((d) => d.name === name && !d.revokedAt);
      if (!device) { await ctx.reply("I couldn't find that active terminal."); return; }
      await revokeCliDeviceHash(uid, device.tokenHash);
      await ctx.reply(`✅ Revoked terminal: ${name}`);
      return;
    }
    await ctx.reply("Usage: /cli link | /cli devices | /cli revoke <terminal name>");
  });

  bot.command("image", async (ctx) => {
    if (!(await guard(ctx))) return;
    const prompt = ctx.match?.trim();
    if (!prompt) { await ctx.reply("Usage: /image <description>"); return; }
    try {
      const image = await generateImage(prompt);
      await ctx.replyWithPhoto(new InputFile(image.data, image.mediaType.includes("jpeg") ? "chusky.jpg" : "chusky.png"), { caption: "Generated by Chusky" });
      if (image.cost) await addUsage(ctx.from!.id, image.cost);
    } catch (e) { await ctx.reply(`❌ Image generation failed: ${String(e).slice(0, 500)}`); }
  });

  // /connect ─────────────────────────────────────────────────────────────────
  bot.command("connect", async (ctx) => {
    if (!(await guard(ctx))) return;
    const toolkit = ctx.match?.trim().toLowerCase();
    if (!toolkit) {
      await replyHtml(ctx,
        `<b>Connect an app</b>\n\nUsage: <code>/connect github</code>\n\n` +
        `Or just tell Chusky what you need and he'll surface the connection link automatically.`
      );
      return;
    }

    const statusMsg = await ctx.reply(`🔗 Generating connection link for <b>${toolkit}</b>…`, { parse_mode: "HTML" });
    try {
      const url = await getConnectionUrl(ctx.from!.id, toolkit);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `🔗 <b>Connect ${toolkit}</b>\n\n` +
        `Click the link below to authorise Chusky to use your <b>${toolkit}</b> account:\n\n` +
        `<a href="${url}">→ Connect ${toolkit}</a>\n\n` +
        `<i>The link expires after a short time. Run the command again if needed.</i>`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      );
    } catch (e) {
      logger.error({ err: e, toolkit }, "Failed to generate connection URL");
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `❌ Failed to generate connection link for <code>${toolkit}</code>.\n\n` +
        `Make sure the toolkit slug is correct. Try: <code>/apps</code> to see available apps.`,
        { parse_mode: "HTML" }
      );
    }
  });

  // /apps ────────────────────────────────────────────────────────────────────
  bot.command("apps", async (ctx) => {
    if (!(await guard(ctx))) return;
    const statusMsg = await ctx.reply("🔌 Loading connected apps…");
    try {
      const states = await getToolkitStates(ctx.from!.id);
      const connected = states.filter((s) => s.connected);
      const page = Math.max(1, parseInt(ctx.match?.trim() || "1", 10) || 1);
      const allDisconnected = states.filter((s) => !s.connected);
      const disconnected = allDisconnected.slice((page - 1) * 15, page * 15);

      let html = `<b>App Connections</b>\n\n`;

      if (connected.length > 0) {
        html += `<b>✅ Connected (${connected.length})</b>\n`;
        html += connected.map((s) => `  • ${s.name} <code>${s.slug.toLowerCase()}</code>`).join("\n");
        html += "\n\n";
      } else {
        html += `<i>No apps connected yet.</i>\n\n`;
      }

      if (disconnected.length > 0) {
        html += `<b>Available to connect:</b>\n`;
        html += disconnected.map((s) => `  • ${s.name} — <code>/connect ${s.slug.toLowerCase()}</code>`).join("\n");
      }

      const pages = Math.max(1, Math.ceil(allDisconnected.length / 15));
      html += `\n\n<i>Page ${page}/${pages}. Use <code>/apps ${page < pages ? page + 1 : 1}</code> for another page.</i>`;

      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, html, { parse_mode: "HTML" });
    } catch (e) {
      logger.error({ err: e }, "Failed to list apps");
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `❌ Failed to load apps: ${String(e)}`
      );
    }
  });

  bot.command("triggers", async (ctx) => {
    if (!(await guard(ctx))) return;
    try {
      const triggers = await listTriggers(ctx.from!.id);
      const text = triggers.length
        ? triggers.map((t: any) => `${t.id || t.trigger_id} — ${t.trigger_slug || t.slug || "trigger"} — ${t.status || (t.enabled === false ? "disabled" : "active")}`).join("\n")
        : "No triggers found.";
      await replyHtml(ctx, `<b>Composio triggers</b>\n\n<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`);
    } catch (e) { await ctx.reply(`❌ Failed to list triggers: ${String(e).slice(0, 300)}`); }
  });

  bot.command("tools", async (ctx) => {
    if (!(await guard(ctx))) return;
    const raw = String(ctx.match ?? "").trim();
    const query = raw.replace(/^search(?:\s+|$)/i, "").trim();
    if (!query) { await ctx.reply("Usage: /tools search <what you want to do>"); return; }
    const status = await ctx.reply(`🔎 Searching Composio tools for: <b>${query.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</b>…`, { parse_mode: "HTML" });
    try {
      const tools = await searchTools(ctx.from!.id, query);
      const text = tools.slice(0, 10).map((t: any) => `${t.slug || t.name || "tool"}\n${t.description || ""}`).join("\n\n") || "No matching tools found.";
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, `<b>Tool results</b>\n\n<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`, { parse_mode: "HTML" });
    } catch (e) {
      logger.error({ err: e, userId: ctx.from!.id, query }, "Tool search failed");
      await ctx.api.editMessageText(ctx.chat!.id, status.message_id, `❌ Tool search failed: ${String(e).slice(0, 400)}`);
    }
  });

  bot.command("trigger", async (ctx) => {
    if (!(await guard(ctx))) return;
    const args = ctx.match?.trim() || "";
    const [action, idOrSlug, ...rest] = args.split(/\s+/);
    try {
      if (action === "create" && idOrSlug) {
        const body = rest.length ? JSON.parse(rest.join(" ")) : {};
        const result = await createTrigger(ctx.from!.id, idOrSlug, body);
        await ctx.reply(`✅ Trigger created: ${JSON.stringify(result).slice(0, 800)}`);
      } else if ((action === "enable" || action === "disable") && idOrSlug) {
        await setTriggerState(ctx.from!.id, idOrSlug, action === "enable");
        await ctx.reply(`✅ Trigger ${action}d: ${idOrSlug}`);
      } else if (action === "delete" && idOrSlug) {
        await deleteTrigger(ctx.from!.id, idOrSlug);
        await ctx.reply(`✅ Trigger deleted: ${idOrSlug}`);
      } else {
        await ctx.reply("Usage: /triggers | /trigger create <slug> <json> | /trigger enable|disable|delete <id>");
      }
    } catch (e) { await ctx.reply(`❌ Trigger operation failed: ${String(e).slice(0, 500)}`); }
  });

  // /info ────────────────────────────────────────────────────────────────────
  bot.command("info", async (ctx) => {
    if (!(await guard(ctx))) return;
    const uid = ctx.from!.id;
    const s = await getSession(uid);
    const turns = Math.floor(s.history.length / 2);
    const age = Math.floor((Date.now() - s.createdAt) / 60000);
    await replyHtml(ctx,
      `<b>Chusky Session Info</b>\n\n` +
      `👤 User ID: <code>${uid}</code>\n` +
      `🤖 Model: <code>${s.model}</code>\n` +
      `💬 History: <b>${turns}</b>/${config.maxHistory} turns\n` +
      `📨 Total messages: <b>${s.totalMessages}</b>\n` +
      `⏱ Age: <b>${age}m</b>\n` +
      `🔧 Max tool rounds: <b>${config.maxToolRounds}</b>\n` +
      `🚦 Rate limit: <b>${config.rateLimit}</b>/${config.rateWindowSeconds}s\n` +
      `🧰 Composio session: <code>${s.composioSessionId ?? "pending"}</code>`
    );
  });

  // /usage ───────────────────────────────────────────────────────────────────
  bot.command("usage", async (ctx) => {
    if (!(await guard(ctx))) return;
    const s = await getSession(ctx.from!.id);
    await replyHtml(ctx,
      `<b>Your Usage</b>\n\n` +
      `📨 Messages sent: <b>${s.totalMessages}</b>\n` +
      `💳 Estimated cost: <b>$${(s.totalCost ?? 0).toFixed(5)}</b>\n` +
      `💬 Context turns: <b>${Math.floor(s.history.length / 2)}</b>/${config.maxHistory}\n` +
      `🤖 Model: <code>${s.model}</code>`
    );
  });

  // /clear ───────────────────────────────────────────────────────────────────
  bot.command("clear", async (ctx) => {
    if (!(await guard(ctx))) return;
    const action = ctx.match?.trim().toLowerCase();
    if (action === "history") {
      await clearHistory(ctx.from!.id);
      await ctx.reply("🗑 History cleared. Your Composio session was kept.");
    } else if (action === "session") {
      invalidateSession(ctx.from!.id);
      await clearSession(ctx.from!.id);
      await ctx.reply("🗑 Session and history cleared. Fresh start — what's next?");
    } else {
      await ctx.reply("Usage: /clear history or /clear session");
    }
  });

  // /export ──────────────────────────────────────────────────────────────────
  bot.command("export", async (ctx) => {
    if (!(await guard(ctx))) return;
    const uid = ctx.from!.id;
    const s = await getSession(uid);
    if (s.history.length === 0) {
      await ctx.reply("Nothing to export yet — start a conversation first.");
      return;
    }
    const lines = [
      `Chusky AI Agent`,
      `Model: ${s.model}`,
      `Exported: ${new Date().toISOString()}`,
      `Turns: ${Math.floor(s.history.length / 2)}`,
      "─".repeat(50),
      "",
    ];
    for (const m of s.history) {
      lines.push(`[${m.role === "user" ? "You" : "Chusky"}]`);
      lines.push(m.content);
      lines.push("");
    }
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(lines.join("\n"), "utf-8"), `chusky-${uid}-${Date.now()}.txt`),
      { caption: `📄 Conversation export — ${Math.floor(s.history.length / 2)} turns` }
    );
  });

  // /model ───────────────────────────────────────────────────────────────────
  bot.command("model", async (ctx) => {
    if (!(await guard(ctx))) return;
    const model = await getModel(ctx.from!.id);
    const kb = new InlineKeyboard()
      .text("🧠 Anthropic Claude", "mpv:anthropic").row()
      .text("⚡ OpenAI", "mpv:openai").row()
      .text("🔮 Google Gemini", "mpv:google").row()
      .text("🦙 Meta Llama", "mpv:meta-llama").row()
      .text("🧬 DeepSeek", "mpv:deepseek").row()
      .text("🤝 Mistral", "mpv:mistralai").row()
      .text("🌐 Browse all", "mpv:all").row();
    await ctx.reply(
      `Active model: <code>${model}</code>\n\nChoose a provider:`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  });

  bot.callbackQuery(/^mpv:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const provider = ctx.match[1];
    if (provider === "__back") {
      const model = await getModel(ctx.from!.id);
      const kb = new InlineKeyboard()
        .text("🧠 Anthropic Claude", "mpv:anthropic").row()
        .text("⚡ OpenAI", "mpv:openai").row()
        .text("🔮 Google Gemini", "mpv:google").row()
        .text("🦙 Meta Llama", "mpv:meta-llama").row()
        .text("🧬 DeepSeek", "mpv:deepseek").row()
        .text("🤝 Mistral", "mpv:mistralai").row()
        .text("🌐 Browse all", "mpv:all").row();
      await ctx.editMessageText(
        `Active model: <code>${model}</code>\n\nChoose a provider:`,
        { parse_mode: "HTML", reply_markup: kb }
      );
      return;
    }
    const msg = await ctx.reply("⏳ Fetching models…");
    try {
      const all = await fetchModels();
      const filtered = (provider === "all" ? all.slice(0, 40) : all.filter((m) => m.id.startsWith(provider)).slice(0, 30));
      if (!filtered.length) {
        await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `No models found for: <code>${provider}</code>`, { parse_mode: "HTML" });
        return;
      }
      const kb = new InlineKeyboard();
      for (const m of filtered) kb.text((m.name || m.id).slice(0, 48), `msel:${m.id}`).row();
      kb.text("← Back", "mpv:__back");
      await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `<b>Select model</b> (${filtered.length} shown):`, { parse_mode: "HTML", reply_markup: kb });
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `❌ ${String(e)}`);
    }
  });

  bot.callbackQuery(/^msel:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const modelId = ctx.match[1];
    await setModel(ctx.from.id, modelId);
    await ctx.editMessageText(
      `✅ <b>Model switched to:</b>\n<code>${modelId}</code>\n\n<i>Your history and Composio session were kept.</i>`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^appr:(approve|deny):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const id = ctx.match[2];
    const approval = await getApproval(ctx.from.id, id);
    if (!approval || approval.status !== "pending" || approval.expiresAt <= Date.now()) {
      await ctx.editMessageText("⚠️ This approval has expired or was already handled.");
      return;
    }
    if (ctx.match[1] === "deny") {
      if (!(await setApprovalStatus(ctx.from.id, id, "denied"))) {
        await ctx.editMessageText("⚠️ This approval was already handled or has expired.");
        return;
      }
      await ctx.editMessageText("🛑 Action denied. Nothing was executed.");
      return;
    }
    if (!(await claimApproval(ctx.from.id, id))) {
      await ctx.editMessageText("⚠️ This approval was already handled or has expired.");
      return;
    }
    await ctx.editMessageText("✅ Approved. Chusky is executing the action…");
    try {
      const result = await runAgent(ctx.from.id, approval.request, approval.history, approval.model, undefined, undefined, undefined, id);
      await appendMessages(ctx.from.id, [{ role: "user", content: approval.request }, { role: "assistant", content: result.text }]);
      await replyHtml(ctx, mdToTelegramHtml(result.text));
    } catch (e) {
      await ctx.reply(`❌ Approval execution failed: ${String(e).slice(0, 400)}`);
    }
  });

  // ── Main message handler ───────────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    if (!(await guard(ctx))) return;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const userId = ctx.from.id;

    if (!(await checkRateLimit(userId))) {
      await ctx.reply(`⏱ Easy there. Max ${config.rateLimit} messages per ${config.rateWindowSeconds}s.`);
      return;
    }

    const s = await getSession(userId);
    const model = s.model;
    if (!(await canSpend(userId))) {
      await ctx.reply("💳 Your usage cap has been reached. Ask an administrator to increase it.");
      return;
    }
    const controller = new AbortController();
    const lockToken = randomUUID();
    activeRequests.set(userId, controller);
    await acquireQueuedLock(userId, lockToken, controller.signal);

    // Post the live status message
    const statusMsg = await ctx.reply("👂 <b>I’m listening to you…</b>", { parse_mode: "HTML" });

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4500);

    // Track steps for the live status bar
    const steps: string[] = [];
    let streamedText = "";
    let lastStreamEdit = 0;

    async function updateStatus(step: string): Promise<void> {
      steps.push(step);
      const bar = buildStatusBar(steps);
      try {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, bar);
      } catch { /* ignore */ }
    }

    try {
      const result = await runAgent(
        userId, text, s.history, model, updateStatus, controller.signal,
        async (delta) => {
          streamedText += delta;
          if (Date.now() - lastStreamEdit > 800 && streamedText.trim()) {
            lastStreamEdit = Date.now();
            await editHtml(ctx, statusMsg.message_id, mdToTelegramHtml(streamedText));
          }
        }
      );
      clearInterval(typingInterval);

      await appendMessages(userId, [
        { role: "user", content: text },
        { role: "assistant", content: result.text },
      ]);
      if (result.cost) await addUsage(userId, result.cost);

      let html = mdToTelegramHtml(result.text);

      if (result.toolsUsed.length > 0) {
        const footer = result.toolsUsed.map(toolFooterLabel).join("  ");
        const cost = result.cost ? `  ·  <i>$${result.cost.toFixed(5)}</i>` : "";
        html += `\n\n<i>${footer}${cost}</i>`;
      }

      await editHtml(ctx, statusMsg.message_id, html);
      for (const image of result.generatedImages ?? []) {
      await ctx.replyWithPhoto(new InputFile(image.data, image.mediaType.includes("jpeg") ? "chusky.jpg" : "chusky.png"));
        if (image.cost) await addUsage(userId, image.cost);
      }

    } catch (e) {
      clearInterval(typingInterval);
      if (e instanceof ApprovalRequiredError) {
        const kb = new InlineKeyboard().text("✅ Approve", `appr:approve:${e.approvalId}`).text("🛑 Deny", `appr:deny:${e.approvalId}`);
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `⚠️ <b>Approval required</b>\n\nChusky wants to execute <code>${e.toolSlug}</code>.\n\nReview the requested action and choose:`, { parse_mode: "HTML", reply_markup: kb });
        return;
      }
      logger.error({ err: e, userId, model }, "Chusky error");
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id, statusMsg.message_id,
          e instanceof DOMException && e.name === "AbortError" ? "🛑 <b>Request cancelled.</b>" : `❌ <b>Chusky hit an error</b>\n\n<code>${mdToTelegramHtml(msg).slice(0, 400)}</code>\n\nTry /clear history or /model to retry.`,
          { parse_mode: "HTML" }
        );
      } catch {
        await ctx.reply(`❌ Error: ${msg.slice(0, 200)}`);
      }
    } finally {
      await releaseUserLock(userId, lockToken);
      activeRequests.delete(userId);
    }
  });

  // ── Photo ──────────────────────────────────────────────────────────────────
  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    try {
      const file = await downloadTelegramFile(ctx, photo.file_id);
      const mime = file.path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      const caption = ctx.message.caption?.trim() || "Describe and analyze this image.";
      await handleMedia(ctx, [
        { type: "text", text: caption },
        { type: "image_url", image_url: { url: `data:${mime};base64,${file.data.toString("base64")}` } },
      ], `[Image attached] ${caption}`);
    } catch (e) {
      await ctx.reply(`❌ Could not download the image: ${String(e).slice(0, 300)}`);
    }
  });

  // ── Document ───────────────────────────────────────────────────────────────
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    try {
      const file = await downloadTelegramFile(ctx, doc.file_id);
      const filename = doc.file_name || file.path.split("/").pop() || "document";
      const mime = doc.mime_type || "application/octet-stream";
      const prompt = ctx.message.caption?.trim() || "Read this document and summarize its key points.";
      await handleMedia(ctx, [
        { type: "text", text: prompt },
        { type: "file", file: { filename, file_data: `data:${mime};base64,${file.data.toString("base64")}` } },
      ], `[Document attached: ${filename}] ${prompt}`);
    } catch (e) {
      await ctx.reply(`❌ Could not process the document: ${String(e).slice(0, 300)}`);
    }
  });

  bot.on("message:voice", async (ctx) => {
    const status = await ctx.reply("🎙️ <b>Chusky received your voice message and is transcribing it…</b>", { parse_mode: "HTML" }).catch(() => undefined);
    try {
      logger.info({ userId: ctx.from?.id, duration: ctx.message.voice.duration, fileSize: ctx.message.voice.file_size }, "Voice message received");
      const file = await downloadTelegramFile(ctx, ctx.message.voice.file_id);
      if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, "🧠 <b>Chusky is processing your voice message…</b>", { parse_mode: "HTML" });
      const text = await transcribeAudio(file.data, audioFormat(file.path));
      await handleMedia(ctx, [{ type: "text", text: `The user sent this voice message:\n${text}` }], `[Voice message] ${text}`);
    } catch (e) {
      logger.error({ err: e, userId: ctx.from?.id }, "Voice transcription failed");
      if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, `❌ Could not transcribe the voice message: ${String(e).slice(0, 300)}`).catch(() => undefined);
      else await ctx.reply(`❌ Could not transcribe the voice message: ${String(e).slice(0, 300)}`);
    }
  });

  bot.on("message:audio", async (ctx) => {
    const status = await ctx.reply("🎙️ <b>Chusky received your audio and is transcribing it…</b>", { parse_mode: "HTML" }).catch(() => undefined);
    try {
      logger.info({ userId: ctx.from?.id, duration: ctx.message.audio.duration, fileSize: ctx.message.audio.file_size }, "Audio message received");
      const file = await downloadTelegramFile(ctx, ctx.message.audio.file_id);
      if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, "🧠 <b>Chusky is processing your audio…</b>", { parse_mode: "HTML" });
      const text = await transcribeAudio(file.data, audioFormat(file.path));
      await handleMedia(ctx, [{ type: "text", text: `The user sent this audio:\n${text}` }], `[Audio message] ${text}`);
    } catch (e) {
      logger.error({ err: e, userId: ctx.from?.id }, "Audio transcription failed");
      if (status) await ctx.api.editMessageText(ctx.chat!.id, status.message_id, `❌ Could not transcribe the audio: ${String(e).slice(0, 300)}`).catch(() => undefined);
      else await ctx.reply(`❌ Could not transcribe the audio: ${String(e).slice(0, 300)}`);
    }
  });

  bot.on("message:video", async (ctx) => {
    try {
      const file = await downloadTelegramFile(ctx, ctx.message.video.file_id);
      const caption = ctx.message.caption?.trim() || "Analyze this video.";
      await handleMedia(ctx, [
        { type: "text", text: caption },
        { type: "video_url", video_url: { url: `data:${ctx.message.video.mime_type || "video/mp4"};base64,${file.data.toString("base64")}` } },
      ], `[Video attached] ${caption}`);
    } catch (e) {
      await ctx.reply(`❌ Could not process the video: ${String(e).slice(0, 300)}`);
    }
  });

  // ── Inline mode ────────────────────────────────────────────────────────────
  bot.on("inline_query", async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    if (!query) { await ctx.answerInlineQuery([]); return; }
    try {
      const model = await getModel(ctx.from.id);
      const result = await runAgent(ctx.from.id, query, [], model);
      const html = mdToTelegramHtml(result.text);
      await ctx.answerInlineQuery([{
        type: "article",
        id: "1",
        title: query.slice(0, 60),
        description: result.text.slice(0, 100),
        input_message_content: { message_text: html, parse_mode: "HTML" },
      }], { cache_time: 30 });
    } catch { await ctx.answerInlineQuery([]); }
  });

  // ── Global error handler ───────────────────────────────────────────────────
  bot.catch((err) => {
    logger.error({ err: err.message, update: err.ctx?.update }, "grammY error");
  });
}

function toolFooterLabel(slug: string): string {
  const map: Record<string, string> = {
    COMPOSIO_MANAGE_CONNECTIONS: "🔗",
    COMPOSIO_REMOTE_BASH_TOOL: "🖥️",
    COMPOSIO_REMOTE_WORKBENCH: "🛠️",
    COMPOSIO_SEARCH_TOOL: "🔎",
    COMPOSIO_MULTI_EXECUTE_TOOL: "⚡",
  };
  if (map[slug]) return map[slug];
  const toolkit = slug.split("_")[0]?.toLowerCase() ?? "tool";
  return `🔧 ${toolkit}`;
}
