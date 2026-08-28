import { Bot, InputFile } from "grammy";
import { serve as serveWorkflow } from "@upstash/workflow/hono";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { config } from "./config.js";
import { registerHandlers } from "./handlers.js";
import { initStore } from "./store.js";
import { getTelegramChatId, claimTriggerEvent, getReminder, updateReminder, getJob, consumeCliPairing, createCliDevice, authenticateCliToken, getSession, appendMessages, addUsage, checkRateLimit, canSpend, getApproval, setApprovalStatus, claimApproval, acquireUserLock, releaseUserLock, setModel, clearHistory, clearSession, getTask, listTasks, cancelTask, retryTask, isDurableStore, listCliDevices, revokeCliDeviceByName, listReminders, listJobs, readScratchpad, searchMemories, getChannelInstallation, listChannelIdentities } from "./store.js";
import { parseTriggerWebhook, runAgent, fetchModels, ApprovalRequiredError, invalidateSession, transcribeAudio, TriggerWebhookVerificationError } from "./agent.js";
import type { ContentPart } from "./types.js";
import { logger } from "./logger.js";
import { randomUUID } from "node:crypto";
import { deliverJob, deliverReminder } from "./workflows.js";
import { executeDurableTask } from "./taskRunner.js";
import { ChannelGateway } from "./channels/gateway.js";
import { createAgentChannelHandler } from "./channels/agentHandler.js";
import { registerChannelRoutes } from "./channels/routes.js";
import { SlackAdapter } from "./channels/slack.js";
import { WhatsAppAdapter } from "./channels/whatsapp.js";
import { TelegramAdapter } from "./channels/telegram.js";
import { parseTelegramWebhookUpdate, verifyTelegramWebhookSecret } from "./telegramWebhook.js";

function safeTriggerSummary(event: { triggerSlug: string; payload: Record<string, unknown> }): string {
  const redacted = Object.entries(event.payload ?? {}).filter(([key, value]) => {
    if (/(token|secret|password|authorization|cookie|private[_-]?key)/i.test(key)) return false;
    return value === null || ["string", "number", "boolean"].includes(typeof value);
  }).slice(0, 20).map(([key, value]) => `${key}: ${String(value).slice(0, 180)}`);
  return [`Trigger: ${event.triggerSlug || "event"}`, ...redacted].join("\n").slice(0, 3500);
}
import { registerSdkApi } from "./sdkApi.js";

async function main(): Promise<void> {
  await initStore();

  const bot = new Bot(config.telegramToken);
  registerHandlers(bot);
  const channelGateway = new ChannelGateway(createAgentChannelHandler());
  channelGateway.register(new TelegramAdapter(bot));

  const shutdown = async (sig: string) => {
    logger.info({ sig }, "Chusky shutting down…");
    channelGateway?.stopRecovery();
    await bot.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  if (config.webhookUrl) {
    // ── WEBHOOK MODE (production) ────────────────────────────────────
    const app = new Hono();
    const slackAdapter = new SlackAdapter(
      config.slackBotToken || (async (workspaceId) => workspaceId ? (await getChannelInstallation("slack", workspaceId))?.botToken : undefined)
    );
    const whatsappAdapter = new WhatsAppAdapter(config.whatsappAccessToken, config.whatsappPhoneNumberId, config.whatsappGraphVersion);
    if (config.slackEnabled) channelGateway.register(slackAdapter);
    if (config.whatsappEnabled) channelGateway.register(whatsappAdapter);
    registerChannelRoutes(app, {
      gateway: channelGateway,
      ...(config.slackEnabled ? { slack: { adapter: slackAdapter, signingSecret: config.slackSigningSecret } } : {}),
      ...(config.whatsappEnabled ? { whatsapp: { adapter: whatsappAdapter, appSecret: config.whatsappAppSecret, verifyToken: config.whatsappVerifyToken } } : {}),
    });
    channelGateway.startRecovery();
    if (config.apiKey) registerSdkApi(app);

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

    app.get("/cli/devices", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const devices = (await listCliDevices(device.userId)).filter((item) => !item.revokedAt).map((item) => ({ name: item.name, createdAt: item.createdAt, lastSeenAt: item.lastSeenAt }));
      return c.json({ ok: true, devices });
    });

    app.delete("/cli/devices/:name", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const name = decodeURIComponent(c.req.param("name")).trim();
      if (!name || name.length > 80) return c.json({ ok: false, error: "invalid device name" }, 400);
      if (!(await revokeCliDeviceByName(device.userId, name))) return c.json({ ok: false, error: "device not found" }, 404);
      return c.json({ ok: true, revoked: name });
    });

    app.post("/cli/media", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const form = await c.req.formData();
      const uploaded = form.get("file");
      const message = String(form.get("message") ?? "").trim();
      if (!(uploaded instanceof File)) return c.json({ ok: false, error: "file is required" }, 400);
      const maxBytes = 12 * 1024 * 1024;
      if (uploaded.size < 1 || uploaded.size > maxBytes) return c.json({ ok: false, error: "file must be between 1 byte and 12 MB" }, 413);
      const mime = uploaded.type.toLowerCase();
      const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "video/mp4", "video/webm", "application/pdf", "text/plain", "text/markdown"]);
      if (!allowed.has(mime)) return c.json({ ok: false, error: `unsupported file type: ${mime || "unknown"}` }, 415);
      if (!(await checkRateLimit(device.userId))) return c.json({ ok: false, error: "rate limit exceeded" }, 429);
      if (!(await canSpend(device.userId))) return c.json({ ok: false, error: "usage cap reached" }, 402);
      const bytes = Buffer.from(await uploaded.arrayBuffer());
      const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
      const filename = uploaded.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "attachment";
      let parts: ContentPart[];
      let historyLabel = `Attached ${filename}`;
      if (mime.startsWith("image/")) parts = [{ type: "text", text: message || "Please analyze this image." }, { type: "image_url", image_url: { url: dataUrl } }];
      else if (mime.startsWith("audio/")) {
        const transcript = await transcribeAudio(bytes, mime.split("/")[1] === "mpeg" ? "mp3" : mime.split("/")[1]);
        parts = [{ type: "text", text: `${message}\n\nTranscript of ${filename}:\n${transcript}`.trim() }];
        historyLabel += `\nTranscript: ${transcript}`;
      } else if (mime.startsWith("video/")) parts = [{ type: "text", text: message || "Please analyze this video." }, { type: "video_url", video_url: { url: dataUrl } }];
      else parts = [{ type: "text", text: `${message}\n\nPlease read and analyze the attached file: ${filename}`.trim() }, { type: "file", file: { filename, file_data: dataUrl } }];
      const s = await getSession(device.userId);
      const result = await withCliLock(device.userId, c.req.raw.signal, () => runAgent(device.userId, parts, s.history, s.model, undefined, c.req.raw.signal));
      await appendMessages(device.userId, [{ role: "user", content: historyLabel }, { role: "assistant", content: result.text }]);
      if (result.cost) await addUsage(device.userId, result.cost);
      return c.json({ ok: true, text: result.text, model: s.model, toolsUsed: result.toolsUsed, cost: result.cost ?? 0, images: (result.generatedImages ?? []).map((image) => ({ data: image.data.toString("base64"), mediaType: image.mediaType })) });
    });

    app.get("/cli/session", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const s = await getSession(device.userId);
      const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
      const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") ?? "20") || 20));
      const totalPages = Math.max(1, Math.ceil(s.history.length / pageSize));
      const historyPage = Math.min(page, totalPages);
      const start = (historyPage - 1) * pageSize;
      return c.json({ ok: true, userId: device.userId, device: device.name, model: s.model, history: s.history.slice(start, start + pageSize), historyPage, historyPageSize: pageSize, historyCount: s.history.length, historyTotalPages: totalPages, summaries: s.summaries.slice(-3), memoryCount: s.memories.length, scratchpadCount: Object.keys(s.scratchpad).length, approvals: s.approvals.filter((a) => a.status === "pending" && a.expiresAt > Date.now()), reminders: s.reminders.filter((r) => r.status === "scheduled"), jobs: s.jobs.filter((j) => j.status === "active"), tasks: (await listTasks(device.userId)).slice(0, 50) });
    });

    app.get("/cli/collection/:kind", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const kind = c.req.param("kind");
      const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
      const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") ?? "25") || 25));
      const query = (c.req.query("query") ?? "").trim();
      let items: unknown[];
      if (kind === "history") items = (await getSession(device.userId)).history;
      else if (kind === "memories") items = await searchMemories(device.userId, query);
      else if (kind === "scratchpad") items = Object.entries(await readScratchpad(device.userId, query)).map(([key, value]) => ({ key, ...value }));
      else if (kind === "reminders") items = await listReminders(device.userId);
      else if (kind === "jobs") items = await listJobs(device.userId);
      else return c.json({ ok: false, error: "unknown collection" }, 404);
      const total = items.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages);
      return c.json({ ok: true, kind, page: safePage, pageSize, total, totalPages, items: items.slice((safePage - 1) * pageSize, safePage * pageSize) });
    });

    app.get("/cli/events", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      const since = Math.max(0, Number(c.req.query("since") ?? "0") || 0);
      const session = await getSession(device.userId);
      const tasks = (await listTasks(device.userId)).filter((task) => task.updatedAt > since).slice(0, 20);
      const approvals = session.approvals.filter((approval) => approval.status === "pending" && approval.expiresAt > Date.now() && approval.createdAt > since).slice(-20);
      const reminders = session.reminders.filter((reminder) => reminder.createdAt > since).slice(-20).map((reminder) => ({ id: reminder.id, text: reminder.text, runAt: reminder.runAt, status: reminder.status }));
      const jobs = session.jobs.filter((job) => job.createdAt > since).slice(-20).map((job) => ({ id: job.id, text: job.text, cron: job.cron, status: job.status }));
      return c.json({ ok: true, since, now: Date.now(), tasks, approvals, reminders, jobs });
    });

    app.get("/cli/events/stream", async (c) => {
      const device = await cliAuth(c);
      if (!device) return c.json({ ok: false, error: "unauthorized" }, 401);
      let cursor = Math.max(0, Number(c.req.query("since") ?? "0") || 0);
      return streamSSE(c, async (stream) => {
        for (let attempt = 0; attempt < 900 && !c.req.raw.signal.aborted; attempt++) {
          const session = await getSession(device.userId);
          const tasks = (await listTasks(device.userId)).filter((task) => task.updatedAt > cursor).slice(0, 20);
          const approvals = session.approvals.filter((approval) => approval.status === "pending" && approval.expiresAt > Date.now() && approval.createdAt > cursor).slice(-20);
          const reminders = session.reminders.filter((reminder) => reminder.createdAt > cursor).slice(-20).map((reminder) => ({ id: reminder.id, text: reminder.text, runAt: reminder.runAt, status: reminder.status }));
          const jobs = session.jobs.filter((job) => job.createdAt > cursor).slice(-20).map((job) => ({ id: job.id, text: job.text, cron: job.cron, status: job.status }));
          const now = Date.now();
          if (tasks.length || approvals.length || reminders.length || jobs.length) {
            await stream.writeSSE({ event: "notification", data: JSON.stringify({ tasks, approvals, reminders, jobs, now }) });
          } else await stream.writeSSE({ event: "keepalive", data: String(now) });
          cursor = now;
          await stream.sleep(2000);
        }
      });
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
        return c.json({ ok: true, bot: me.username, agent: "Chusky", persistence: isDurableStore() ? "redis" : "memory", channels: { telegram: true, cli: true, slack: config.slackEnabled, whatsapp: config.whatsappEnabled } });
      } catch (e) {
        return c.json({ ok: false, error: String(e) }, 503);
      }
    });

    // Telegram updates. Telegram expects a webhook response within roughly
    // ten seconds. Agent/tool work can take much longer, so acknowledge only
    // after validation and dispatch grammY in the background. This prevents
    // Telegram retries from turning slow tool calls into duplicate updates.
    app.post("/webhook", async (c) => {
      const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
      if (!verifyTelegramWebhookSecret(secret, config.webhookSecret)) {
        return c.json({ ok: false, error: "invalid webhook secret" }, 401);
      }
      const rawBody = await c.req.text();
      const update = parseTelegramWebhookUpdate(rawBody);
      if (!update) return c.json({ ok: false, error: "invalid Telegram update" }, 400);
      const updateId = update.update_id;
      void bot.handleUpdate(update as Parameters<Bot["handleUpdate"]>[0]).catch((error) => {
        logger.error({ err: error, updateId }, "Telegram update processing failed after webhook acknowledgement");
      });
      return c.json({ ok: true });
    });

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
            const summary = safeTriggerSummary(event);
            await bot.api.sendMessage(
              chatId,
              `🔔 <b>Chusky trigger</b>\n\n<b>${event.triggerSlug}</b>\n<pre>${summary.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
              { parse_mode: "HTML" }
            );
          }
          if (Number.isSafeInteger(numericUserId) && numericUserId > 0) {
            const linked = await listChannelIdentities(numericUserId);
            await Promise.allSettled(linked.filter((identity) => identity.provider !== "telegram" && (identity.provider !== "whatsapp" || identity.proactiveOptIn === true)).map((identity) => {
              const adapter = channelGateway.adapter(identity.provider);
              if (!adapter) return Promise.resolve();
              return channelGateway.send({
                accountId: identity.accountId,
                userId: numericUserId,
                target: { provider: identity.provider, conversationId: identity.externalUserId, workspaceId: identity.workspaceId },
                text: `🔔 Chusky trigger\n\n${safeTriggerSummary(event)}`,
                idempotencyKey: `trigger:${event.eventId}:${identity.provider}:${identity.externalUserId}`,
                correlationId: event.eventId,
                kind: "notification",
              }).catch((error) => logger.warn({ err: error, provider: identity.provider }, "Trigger channel delivery failed"));
            }));
          }
        } else if (config.composioWebhookSecret) return c.json({ ok: false, error: "unsupported trigger webhook" }, 400);
        return c.json({ ok: true });
      } catch (e) {
        logger.error({ err: e }, "Trigger webhook error");
        const message = String(e);
        const status = e instanceof TriggerWebhookVerificationError || Boolean(config.composioWebhookSecret && /signature|verify|secret|webhook/i.test(message)) ? 401 : 400;
        return c.json({ ok: false, error: "invalid trigger webhook" }, status);
      }
    });

    await bot.api.setWebhook(`${config.webhookUrl}/webhook`, {
      secret_token: config.webhookSecret || undefined,
      allowed_updates: ["message", "edited_message", "callback_query", "inline_query"],
      // Keep queued messages across a normal process restart. Duplicates are
      // handled by the durable Telegram update claim in the handlers.
      drop_pending_updates: false,
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
