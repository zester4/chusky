import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { config } from "./config.js";
import { ApprovalRequiredError, runAgent } from "./agent.js";
import { acquireUserLock, canSpend, checkRateLimit, claimApproval, getApproval, getSession, getTask, listTasks, releaseUserLock, saveSession, setApprovalStatus, type SdkRunRecord, type SdkThreadRecord } from "./store.js";

function apiError(c: any, status: number, code: string, message: string) {
  const requestId = randomUUID();
  c.header("X-Request-Id", requestId);
  return c.json({ error: { code, message, requestId } }, status);
}

function userIdFor(externalId: string): number {
  // Session IDs are internal only; deterministic separation keeps SDK users isolated.
  return Number.parseInt(createHash("sha256").update(`sdk:${externalId}`).digest("hex").slice(0, 12), 16);
}

function authorized(c: any): boolean {
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!config.apiKey || token.length !== config.apiKey.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(config.apiKey));
}

function sdkUser(c: any): { externalId: string; userId: number } | undefined {
  const externalId = (c.req.header("X-Chusky-User-Id") ?? "").trim();
  if (!externalId || externalId.length > 200) return undefined;
  return { externalId, userId: userIdFor(externalId) };
}

function threadView(thread: SdkThreadRecord) { return { id: thread.id, externalId: thread.externalId, metadata: thread.metadata, createdAt: new Date(thread.createdAt).toISOString(), updatedAt: new Date(thread.updatedAt).toISOString() }; }
function runView(threadId: string, run: SdkRunRecord) { return { ...run, threadId, createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString() }; }

/** Public v1 API for a self-hosted instance. Keep CLI and Telegram routes private. */
export function registerSdkApi(app: Hono): void {
  app.use("/v1/*", async (c, next) => {
    if (!authorized(c)) return apiError(c, 401, "invalid_api_key", "A valid Chusky SDK API key is required.");
    if (!sdkUser(c)) return apiError(c, 400, "missing_user", "X-Chusky-User-Id is required.");
    await next();
  });

  app.post("/v1/threads", async (c) => {
    const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { metadata?: Record<string, unknown> };
    const session = await getSession(owner.userId); const now = Date.now();
    const thread: SdkThreadRecord = { id: `thr_${randomUUID()}`, externalId: owner.externalId, metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {}, history: [], runs: [], createdAt: now, updatedAt: now };
    session.sdkThreads!.push(thread); await saveSession(owner.userId, session); return c.json(threadView(thread), 201);
  });
  app.get("/v1/threads", async (c) => {
    const owner = sdkUser(c)!; const data = (await getSession(owner.userId)).sdkThreads!.map(threadView); return c.json({ data });
  });
  app.get("/v1/threads/:threadId", async (c) => {
    const thread = (await getSession(sdkUser(c)!.userId)).sdkThreads!.find((item) => item.id === c.req.param("threadId")); return thread ? c.json(threadView(thread)) : apiError(c, 404, "not_found", "Thread not found.");
  });
  app.post("/v1/threads/:threadId/runs", async (c) => {
    const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { input?: string };
    const input = String(body.input ?? "").trim(); if (!input || input.length > 30_000) return apiError(c, 400, "invalid_input", "input must be between 1 and 30000 characters.");
    if (!(await checkRateLimit(owner.userId))) return apiError(c, 429, "rate_limited", "Rate limit exceeded.");
    if (!(await canSpend(owner.userId))) return apiError(c, 402, "spend_limit", "Usage cap reached.");
    const session = await getSession(owner.userId); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); if (!thread) return apiError(c, 404, "not_found", "Thread not found.");
    const now = Date.now(); const run: SdkRunRecord = { id: `run_${randomUUID()}`, status: "running", input, createdAt: now, updatedAt: now }; thread.runs.push(run);
    try { const result = await runAgent(owner.userId, input, thread.history, session.model, undefined, c.req.raw.signal); run.status = "completed"; run.output = result.text; thread.history.push({ role: "user", content: input }, { role: "assistant", content: result.text }); }
    catch (error) { if (error instanceof ApprovalRequiredError) { run.status = "requires_approval"; run.approvalId = error.approvalId; } else { run.status = "failed"; run.error = { code: "agent_error", message: error instanceof Error ? error.message : "Agent failed" }; } }
    run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; await saveSession(owner.userId, session); return c.json(runView(thread.id, run), 201);
  });
  app.post("/v1/threads/:threadId/runs/stream", async (c) => {
    const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { input?: string };
    const input = String(body.input ?? "").trim(); if (!input || input.length > 30_000) return apiError(c, 400, "invalid_input", "input must be between 1 and 30000 characters.");
    if (!(await checkRateLimit(owner.userId))) return apiError(c, 429, "rate_limited", "Rate limit exceeded.");
    if (!(await canSpend(owner.userId))) return apiError(c, 402, "spend_limit", "Usage cap reached.");
    const session = await getSession(owner.userId); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); if (!thread) return apiError(c, 404, "not_found", "Thread not found.");
    const now = Date.now(); const run: SdkRunRecord = { id: `run_${randomUUID()}`, status: "running", input, createdAt: now, updatedAt: now }; thread.runs.push(run);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start: async (controller) => {
      const send = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      send({ type: "run.started", run: runView(thread.id, run) });
      try {
        const result = await runAgent(owner.userId, input, thread.history, session.model, undefined, c.req.raw.signal, (text) => send({ type: "run.delta", runId: run.id, text }));
        run.status = "completed"; run.output = result.text; thread.history.push({ role: "user", content: input }, { role: "assistant", content: result.text }); send({ type: "run.completed", run: runView(thread.id, run) });
      } catch (error) {
        if (error instanceof ApprovalRequiredError) { run.status = "requires_approval"; run.approvalId = error.approvalId; const approval = await getApproval(owner.userId, error.approvalId); send({ type: "run.approval_required", run: runView(thread.id, run), approval }); }
        else { run.status = "failed"; run.error = { code: "agent_error", message: error instanceof Error ? error.message : "Agent failed" }; send({ type: "run.failed", run: runView(thread.id, run), error: run.error }); }
      } finally { run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; await saveSession(owner.userId, session); controller.close(); }
    } });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
  });
  app.get("/v1/threads/:threadId/runs/:runId", async (c) => { const thread = (await getSession(sdkUser(c)!.userId)).sdkThreads!.find((item) => item.id === c.req.param("threadId")); const run = thread?.runs.find((item) => item.id === c.req.param("runId")); return thread && run ? c.json(runView(thread.id, run)) : apiError(c, 404, "not_found", "Run not found."); });
  app.get("/v1/tasks", async (c) => c.json({ data: await listTasks(sdkUser(c)!.userId) }));
  app.get("/v1/tasks/:taskId", async (c) => { const task = await getTask(sdkUser(c)!.userId, c.req.param("taskId")); return task ? c.json(task) : apiError(c, 404, "not_found", "Task not found."); });
  app.get("/v1/approvals/:approvalId", async (c) => { const approval = await getApproval(sdkUser(c)!.userId, c.req.param("approvalId")); return approval ? c.json(approval) : apiError(c, 404, "not_found", "Approval not found."); });
  app.post("/v1/approvals/:approvalId", async (c) => {
    const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { decision?: string };
    const pending = await getApproval(owner.userId, c.req.param("approvalId"));
    if (!pending || pending.status !== "pending" || pending.expiresAt <= Date.now()) return apiError(c, 404, "not_found", "Pending approval not found.");
    if (body.decision !== "approve" && body.decision !== "deny") return apiError(c, 400, "invalid_decision", "decision must be approve or deny.");
    if (body.decision === "deny") { await setApprovalStatus(owner.userId, pending.id, "denied"); return c.json({ id: pending.id, status: "denied" }); }
    const approval = await claimApproval(owner.userId, pending.id);
    if (!approval) return apiError(c, 409, "approval_unavailable", "Approval was already decided, expired, or consumed.");
    const token = randomUUID();
    if (!(await acquireUserLock(owner.userId, token))) return apiError(c, 409, "run_in_progress", "Another Chusky request is already running for this user.");
    try {
      const session = await getSession(owner.userId); const thread = session.sdkThreads!.find((item) => item.runs.some((run) => run.approvalId === approval.id));
      if (!thread) { await setApprovalStatus(owner.userId, approval.id, "denied"); return apiError(c, 409, "run_not_found", "The run that requested this approval no longer exists."); }
      const run = thread.runs.find((item) => item.approvalId === approval.id)!;
      try {
        const result = await runAgent(owner.userId, approval.request, approval.history, approval.model, undefined, c.req.raw.signal, undefined, approval.id);
        run.status = "completed"; run.output = result.text; run.error = undefined; thread.history.push({ role: "user", content: approval.request }, { role: "assistant", content: result.text });
      } catch (error) { run.status = "failed"; run.error = { code: "resume_failed", message: error instanceof Error ? error.message : "Approval resume failed" }; }
      run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; await saveSession(owner.userId, session); return c.json(runView(thread.id, run));
    } finally { await releaseUserLock(owner.userId, token); }
  });
}
