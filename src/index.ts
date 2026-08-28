import { Bot, InputFile, webhookCallback } from "grammy";
import { serve as serveWorkflow } from "@upstash/workflow/hono";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config.js";
import { registerHandlers } from "./handlers.js";
import { initStore } from "./store.js";
import { getTelegramChatId, claimTriggerEvent, getReminder, updateReminder, getJob } from "./store.js";
import { parseTriggerWebhook } from "./agent.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  await initStore();

  const bot = new Bot(config.telegramToken);
  registerHandlers(bot);

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "Chuck shutting down…");
    await bot.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  if (config.webhookUrl) {
    // ── WEBHOOK MODE (production) ────────────────────────────────────
    const app = new Hono();

    app.post("/workflows/video", serveWorkflow(async (workflow) => {
      const payload = workflow.requestPayload as { userId: number; prompt: string };
      const submitted = await workflow.run("submit-video", async () => {
        const res = await fetch("https://openrouter.ai/api/v1/videos", {
          method: "POST",
          headers: { Authorization: `Bearer ${config.openRouterApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: config.videoModel, prompt: payload.prompt }),
        });
        if (!res.ok) throw new Error(`Video submission failed: ${res.status} ${await res.text()}`);
        return await res.json() as any;
      });
      const videoId = submitted.id ?? submitted.video_id ?? submitted.data?.id;
      if (!videoId) throw new Error("Video API returned no job ID");
      for (let attempt = 0; attempt < 30; attempt++) {
        await workflow.sleep(`wait-${attempt}`, 20);
        const status = await workflow.run(`poll-${attempt}`, async () => {
          const res = await fetch(`https://openrouter.ai/api/v1/videos/${encodeURIComponent(videoId)}`, { headers: { Authorization: `Bearer ${config.openRouterApiKey}` } });
          if (!res.ok) throw new Error(`Video status failed: ${res.status}`);
          return await res.json() as any;
        });
        const state = status.status ?? status.data?.status;
        if (state === "completed" || state === "succeeded") {
          const url = status.url ?? status.video_url ?? status.data?.url ?? status.data?.video_url;
          if (!url) throw new Error("Completed video has no download URL");
          const file = await fetch(url);
          if (!file.ok) throw new Error(`Video download failed: ${file.status}`);
          const chatId = await getTelegramChatId(payload.userId);
          if (chatId) await bot.api.sendVideo(chatId, new InputFile(Buffer.from(await file.arrayBuffer()), "chuck.mp4"), { caption: "🎬 Your video is ready." });
          return { delivered: Boolean(chatId) };
        }
        if (state === "failed" || state === "error") throw new Error(status.error?.message ?? "Video generation failed");
      }
      throw new Error("Video generation timed out");
    }));

    app.post("/workflows/reminder", serveWorkflow(async (workflow) => {
      const payload = workflow.requestPayload as { reminderId: string; userId: number };
      await workflow.run("deliver-reminder", async () => {
        const reminder = await getReminder(payload.userId, payload.reminderId);
        if (!reminder || reminder.status !== "scheduled") return { skipped: true };
        const chatId = await getTelegramChatId(payload.userId);
        if (!chatId) { await updateReminder(payload.userId, payload.reminderId, { status: "failed" }); return { delivered: false }; }
        await bot.api.sendMessage(chatId, `⏰ <b>Chuck reminder</b>\n\n${reminder.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`, { parse_mode: "HTML" });
        await updateReminder(payload.userId, payload.reminderId, { status: "sent" });
        return { delivered: true };
      });
    }));

    app.post("/workflows/job", serveWorkflow(async (workflow) => {
      const payload = workflow.requestPayload as { jobId: string; userId: number };
      await workflow.run("deliver-job", async () => {
        const job = await getJob(payload.userId, payload.jobId);
        if (!job || job.status !== "active") return { skipped: true };
        const chatId = await getTelegramChatId(payload.userId);
        if (!chatId) return { delivered: false };
        await bot.api.sendMessage(chatId, `🔁 <b>Chuck scheduled job</b>\n\n${job.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`, { parse_mode: "HTML" });
        return { delivered: true };
      });
    }));

    app.get("/", (c) => c.json({ ok: true, agent: "Chuck", mode: "webhook", ts: Date.now() }));

    // Deep health check — validates bot token live
    app.get("/health", async (c) => {
      try {
        const me = await bot.api.getMe();
        return c.json({ ok: true, bot: me.username, agent: "Chuck" });
      } catch (e) {
        return c.json({ ok: false, error: String(e) }, 503);
      }
    });

    // Telegram updates
    const handleUpdate = webhookCallback(bot, "hono", {
      secretToken: config.webhookSecret || undefined,
    });
    app.post("/webhook", (c) => handleUpdate(c));

    // Composio trigger events
    app.post("/composio/triggers", async (c) => {
      try {
        if (!config.composioWebhookSecret) return c.json({ ok: false, error: "trigger verification is not configured" }, 503);
        const body = Buffer.from(await c.req.arrayBuffer());
        const headers = Object.fromEntries(
          Object.entries(c.req.header()).map(([k, v]) => [k, String(v)])
        );
        const event = await parseTriggerWebhook(body, headers, config.composioWebhookSecret);
        if (event) {
          if (!(await claimTriggerEvent(event.eventId))) return c.json({ ok: true, duplicate: true });
          logger.info({ triggerSlug: event.triggerSlug, userId: event.userId }, "Trigger received");
          const numericUserId = Number(event.userId.replace(/^user_/, ""));
          const chatId = Number.isFinite(numericUserId)
            ? await getTelegramChatId(numericUserId)
            : undefined;
          if (chatId) {
            const summary = JSON.stringify(event.payload, null, 2).slice(0, 3500);
            await bot.api.sendMessage(
              chatId,
              `🔔 <b>Chuck trigger</b>\n\n<b>${event.triggerSlug}</b>\n<pre>${summary.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
              { parse_mode: "HTML" }
            );
          }
        }
        return c.json({ ok: true });
      } catch (e) {
        logger.error({ err: e }, "Trigger webhook error");
        const message = String(e);
        return c.json({ ok: false, error: "invalid trigger webhook" }, config.composioWebhookSecret && /signature|verify|secret|webhook/i.test(message) ? 401 : 400);
      }
    });

    await bot.api.setWebhook(`${config.webhookUrl}/webhook`, {
      secret_token: config.webhookSecret || undefined,
      allowed_updates: ["message", "edited_message", "callback_query", "inline_query"],
      drop_pending_updates: true,
    });

    logger.info({ url: `${config.webhookUrl}/webhook` }, "Chuck webhook registered");

    serve({ fetch: app.fetch, port: config.port }, (info) => {
      logger.info({ port: info.port }, "Chuck listening");
    });

  } else {
    // ── POLLING MODE (local dev) ─────────────────────────────────────
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.start({
      allowed_updates: ["message", "edited_message", "callback_query", "inline_query"],
      drop_pending_updates: true,
      onStart: (info) => {
        logger.info({ username: info.username }, "Chuck started (polling)");
        logger.info({ model: config.defaultModel }, "Default model");
      },
    });
  }
}

main().catch((e) => {
  logger.fatal({ err: e }, "Chuck failed to start");
  process.exit(1);
});
