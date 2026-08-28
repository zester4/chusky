import { Bot, InputFile, webhookCallback } from "grammy";
import { serve as serveWorkflow } from "@upstash/workflow/hono";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config.js";
import { registerHandlers } from "./handlers.js";
import { initStore } from "./store.js";
import { getTelegramChatId, claimTriggerEvent, getReminder, updateReminder, getJob, consumeCliPairing, createCliDevice, authenticateCliToken, getSession, appendMessages, addUsage, checkRateLimit, canSpend, getApproval, setApprovalStatus, claimApproval, acquireUserLock, releaseUserLock, setModel, clearHistory, clearSession, getTask, listTasks, cancelTask, retryTask, isDurableStore } from "./store.js";
import { parseTriggerWebhook, runAgent, fetchModels, ApprovalRequiredError, invalidateSession } from "./agent.js";
import { logger } from "./logger.js";
import { randomUUID } from "node:crypto";
import { deliverJob, deliverReminder } from "./workflows.js";
import { executeDurableTask } from "./taskRunner.js";

async function main(): Promise<void> {
  await initStore();

  const bot = new Bot(config.telegramToken);
  registerHandlers(bot);

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "Chusky shutting down…");
    await bot.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  if (config.webhookUrl) {
    // ── WEBHOOK MODE (production) ────────────────────────────────────
    const app = new Hono();

    const cliAuth = async (c: any) => {
      const auth = c.req.header("Authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const device = await authenticateCliToken(token);
      if (!device) return undefined;
      return device;
    };

    const withCliLock = async <T>(userId: number, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => {
      const token = randomUUID();
      const deadline = Date.now() + 120000;
      while (!(await acquireUserLock(userId, token))) {
        if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
        if (Date.now() >= deadline) throw new Error("Timed out waiting for another Chusky request to finish");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      try { return await work(); } finally { await releaseUserLock(userId, token); }
    };

    app.post("/cli/pair", async (c) => {
      try {
        const body = await c.req.json() as { code?: string; deviceName?: string };
        const pairing = await consumeCliPairing(String(body.code ?? ""));
        if (!pairing) return c.json({ ok: false, error: "invalid or expired pairing code" }, 401);
        const result = await createCliDevice(pairing.userId, String(body.deviceName ?? "terminal"));
        return c.json({ ok: true, token: result.token, userId: pairing.userId, device: { name: result.device.name, createdAt: result.device.createdAt } });
      } catch { return c.json({ ok: false, error: "invalid pairing request" }, 400); }
    });

    app.get("/cli/session", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const s = await getSession(device.userId);
      return c.json({ ok: true, userId: device.userId, device: device.name, model: s.model, history: s.history.slice(-20), summaries: s.summaries.slice(-3), memories: s.memories.slice(-50), scratchpad: s.scratchpad, approvals: s.approvals.filter((a) => a.status === "pending" && a.expiresAt > Date.now()), reminders: s.reminders.filter((r) => r.status === "scheduled"), jobs: s.jobs.filter((j) => j.status === "active"), tasks: (await listTasks(device.userId)).slice(0, 50) });
    });

    app.get("/cli/tasks", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      return c.json({ ok: true, tasks: await listTasks(device.userId) });
    });

    app.post("/cli/tasks/:id", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const id = c.req.param("id");
      const body = await c.req.json() as { action?: "cancel" | "retry" };
      const task = await withCliLock(device.userId, c.req.raw.signal, () => body.action === "cancel" ? cancelTask(device.userId, id) : body.action === "retry" ? retryTask(device.userId, id) : Promise.resolve(undefined));
      if (!task) return c.json({ ok: false, error: "task action is invalid or cannot be applied" }, 409);
      return c.json({ ok: true, task });
    });

    app.post("/cli/model", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const body = await c.req.json() as { model?: string };
      const model = String(body.model ?? "").trim();
      if (!model || model.length > 200 || !/^[~a-zA-Z0-9._:/-]+$/.test(model)) return c.json({ ok: false, error: "invalid model" }, 400);
      await withCliLock(device.userId, c.req.raw.signal, () => setModel(device.userId, model));
      return c.json({ ok: true, model });
    });

    app.get("/cli/models", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
      const pageSize = Math.min(50, Math.max(1, Number(c.req.query("pageSize") ?? "10") || 10));
      const query = (c.req.query("query") ?? "").trim().toLowerCase();
      const models = (await fetchModels()).filter((m) => !query || `${m.id} ${m.name}`.toLowerCase().includes(query));
      const totalPages = Math.max(1, Math.ceil(models.length / pageSize));
      const safePage = Math.min(page, totalPages);
      return c.json({ ok: true, page: safePage, pageSize, totalPages, total: models.length, models: models.slice((safePage - 1) * pageSize, safePage * pageSize) });
    });

    app.post("/cli/clear", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const body = await c.req.json() as { scope?: "history" | "session" };
      if (body.scope === "session") await withCliLock(device.userId, c.req.raw.signal, async () => { invalidateSession(device.userId); await clearSession(device.userId); });
      else if (body.scope === "history") await withCliLock(device.userId, c.req.raw.signal, () => clearHistory(device.userId));
      else return c.json({ ok: false, error: "scope must be history or session" }, 400);
      return c.json({ ok: true, scope: body.scope });
    });

    app.post("/cli/chat", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const body = await c.req.json() as { message?: string; approvalId?: string };
      const message = String(body.message ?? "").trim();
      if (!message || message.length > 30000) return c.json({ ok: false, error: "message must be between 1 and 30000 characters" }, 400);
      if (!(await checkRateLimit(device.userId))) return c.json({ ok: false, error: "rate limit exceeded" }, 429);
      if (!(await canSpend(device.userId))) return c.json({ ok: false, error: "usage cap reached" }, 402);
      const s = await getSession(device.userId);
      try {
        return c.json(await withCliLock(device.userId, c.req.raw.signal, async () => {
          const result = await runAgent(device.userId, message, s.history, s.model, undefined, c.req.raw.signal, undefined, body.approvalId);
          await appendMessages(device.userId, [{ role: "user", content: message }, { role: "assistant", content: result.text }]);
          if (result.cost) await addUsage(device.userId, result.cost);
          return { ok: true, text: result.text, model: s.model, toolsUsed: result.toolsUsed, cost: result.cost ?? 0, images: (result.generatedImages ?? []).map((image) => ({ data: image.data.toString("base64"), mediaType: image.mediaType })) };
        }));
      } catch (e) {
        if (e instanceof ApprovalRequiredError) return c.json({ ok: false, error: "approval_required", approval: { id: e.approvalId, toolSlug: e.toolSlug, args: e.args } }, 409);
        return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
      }
    });

    app.post("/cli/chat/stream", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const body = await c.req.json() as { message?: string };
      const message = String(body.message ?? "").trim();
      if (!message || message.length > 30000) return c.json({ ok: false, error: "message must be between 1 and 30000 characters" }, 400);
      if (!(await checkRateLimit(device.userId))) return c.json({ ok: false, error: "rate limit exceeded" }, 429);
      if (!(await canSpend(device.userId))) return c.json({ ok: false, error: "usage cap reached" }, 402);
      const s = await getSession(device.userId);
      const lockToken = randomUUID();
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          const started = Date.now();
          try {
            let acquired = false;
            while (!(acquired = await acquireUserLock(device.userId, lockToken))) {
              if (c.req.raw.signal.aborted || Date.now() - started > 120000) throw new Error("Timed out waiting for another Chusky request to finish");
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            send({ type: "start", model: s.model });
            const result = await runAgent(device.userId, message, s.history, s.model, undefined, c.req.raw.signal, (delta) => send({ type: "delta", text: delta }));
            await appendMessages(device.userId, [{ role: "user", content: message }, { role: "assistant", content: result.text }]);
            if (result.cost) await addUsage(device.userId, result.cost);
            send({ type: "done", text: result.text, model: s.model, toolsUsed: result.toolsUsed, cost: result.cost ?? 0, images: (result.generatedImages ?? []).map((image) => ({ data: image.data.toString("base64"), mediaType: image.mediaType })) });
          } catch (e) {
            if (e instanceof ApprovalRequiredError) send({ type: "approval_required", approval: { id: e.approvalId, toolSlug: e.toolSlug, args: e.args } });
            else send({ type: "error", error: e instanceof Error ? e.message : String(e) });
          } finally {
            await releaseUserLock(device.userId, lockToken);
            controller.close();
          }
        },
      });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
    });

    app.post("/cli/approve", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const body = await c.req.json() as { approvalId?: string; decision?: "approve" | "deny" };
      const id = String(body.approvalId ?? "");
      const approval = await getApproval(device.userId, id);
      if (!approval || approval.status !== "pending" || approval.expiresAt <= Date.now()) return c.json({ ok: false, error: "approval expired or not found" }, 404);
      if (body.decision !== "approve") {
        if (!(await setApprovalStatus(device.userId, id, "denied"))) return c.json({ ok: false, error: "approval could not be claimed" }, 409);
        return c.json({ ok: true, denied: true });
      }
      if (!(await claimApproval(device.userId, id))) return c.json({ ok: false, error: "approval could not be claimed" }, 409);
      try {
        return c.json(await withCliLock(device.userId, c.req.raw.signal, async () => {
          const result = await runAgent(device.userId, approval.request, approval.history, approval.model, undefined, c.req.raw.signal, undefined, id);
          await appendMessages(device.userId, [{ role: "user", content: approval.request }, { role: "assistant", content: result.text }]);
          if (result.cost) await addUsage(device.userId, result.cost);
          return { ok: true, text: result.text, toolsUsed: result.toolsUsed, cost: result.cost ?? 0, images: (result.generatedImages ?? []).map((image) => ({ data: image.data.toString("base64"), mediaType: image.mediaType })) };
        }));
      } catch (e) { return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500); }
    });

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
          if (chatId) await bot.api.sendVideo(chatId, new InputFile(Buffer.from(await file.arrayBuffer()), "chusky.mp4"), { caption: "🎬 Your video is ready." });
          return { delivered: Boolean(chatId) };
        }
        if (state === "failed" || state === "error") throw new Error(status.error?.message ?? "Video generation failed");
      }
      throw new Error("Video generation timed out");
    }));

    app.post("/workflows/reminder", serveWorkflow(async (workflow) => {
      const payload = workflow.requestPayload as { reminderId: string; userId: number };
      await workflow.run("deliver-reminder", () => deliverReminder(payload, { getReminder, updateReminder, getJob, getTelegramChatId, sendMessage: (chatId, text, options) => bot.api.sendMessage(chatId, text, options) }));
    }));

    app.post("/workflows/job", serveWorkflow(async (workflow) => {
      const payload = workflow.requestPayload as { jobId: string; userId: number };
      await workflow.run("deliver-job", () => deliverJob(payload, { getReminder, updateReminder, getJob, getTelegramChatId, sendMessage: (chatId, text, options) => bot.api.sendMessage(chatId, text, options) }));
    }));

    app.post("/workflows/task", serveWorkflow(async (workflow) => {
      const payload = workflow.requestPayload as { taskId: string; userId: number };
      const execute = async (attempt: number) => workflow.run(`execute-task-${attempt}`, async () => {
        const run = await executeDurableTask(payload, {
          workerId: `workflow:${workflow.workflowRunId ?? "task"}:${attempt}`,
          execute: async (task) => {
            try {
              const prompt = `Continue durable task ${task.id}: ${task.objective}\n\nLatest checkpoint: ${task.checkpoint ?? "none"}\nNext action: ${task.nextAction ?? "determine the safest next action"}\n\nUse task tools to checkpoint, block, or complete the task. Do not perform risky external actions without the normal approval flow.`;
              const session = await getSession(task.userId);
              const result = await runAgent(task.userId, prompt, session.history, session.model);
              const latest = await getTask(task.userId, task.id);
              const chatId = await getTelegramChatId(task.userId);
              if (chatId && result.text.trim()) await bot.api.sendMessage(chatId, `📌 <b>Task update</b>\n\n${result.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`, { parse_mode: "HTML" });
              if (latest?.status === "completed") return { status: "completed" as const, message: "Task completed by the agent", result: latest.result, checkpoint: latest.checkpoint };
              return { status: "blocked" as const, message: "Task ran and is awaiting review or a next instruction", checkpoint: latest?.checkpoint, nextAction: latest?.nextAction ?? "Review the task update and continue when ready." };
            } catch (error) {
              if (error instanceof ApprovalRequiredError) return { status: "blocked" as const, message: `Approval required for ${error.toolSlug}`, nextAction: "Approve or deny the pending action, then retry the task." };
              throw error;
            }
          },
        });
        return { claimed: run.claimed, status: run.task?.status, runAt: run.task?.runAt };
      });
      // Each execution/retry is a named durable step. Completed steps are not
      // repeated if QStash retries the workflow after a transport interruption.
      for (let attempt = 0; attempt < 10; attempt++) {
        const run = await execute(attempt) as { claimed: boolean; status?: string; runAt?: number };
        if (run.status !== "queued" || !run.runAt || run.runAt <= Date.now()) break;
        await workflow.sleep(`retry-delay-${attempt}`, Math.max(1, Math.ceil((run.runAt - Date.now()) / 1000)));
      }
    }));

    app.get("/", (c) => c.json({ ok: true, agent: "Chusky", mode: "webhook", ts: Date.now() }));

    // Deep health check — validates bot token live
    app.get("/health", async (c) => {
      try {
        const me = await bot.api.getMe();
        return c.json({ ok: true, bot: me.username, agent: "Chusky", persistence: isDurableStore() ? "redis" : "memory" });
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
              `🔔 <b>Chusky trigger</b>\n\n<b>${event.triggerSlug}</b>\n<pre>${summary.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
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

    logger.info({ url: `${config.webhookUrl}/webhook` }, "Chusky webhook registered");

    serve({ fetch: app.fetch, port: config.port }, (info) => {
      logger.info({ port: info.port }, "Chusky listening");
    });

  } else {
    // ── POLLING MODE (local dev) ─────────────────────────────────────
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.start({
      allowed_updates: ["message", "edited_message", "callback_query", "inline_query"],
      drop_pending_updates: true,
      onStart: (info) => {
        logger.info({ username: info.username }, "Chusky started (polling)");
        logger.info({ model: config.defaultModel }, "Default model");
      },
    });
  }
}

main().catch((e) => {
  logger.fatal({ err: e }, "Chusky failed to start");
  process.exit(1);
});
