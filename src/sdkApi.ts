import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { getAuth } from "./auth.js";
import { ApprovalRequiredError, createTrigger, deleteTrigger, fetchModels, getConnectionUrl, getToolkitStates, listTriggers, runAgent, setTriggerState, transcribeAudio } from "./agent.js";
import { deleteR2Object, inspectR2Object, r2Configured, readR2Object, signR2Download, signR2Upload } from "./lib/storage/r2.js";
import { isSafeWebhookUrl, sealWebhookSecret } from "./lib/webhooks.js";
import { enqueueSdkWebhook } from "./lib/webhookOutbox.js";
import { acquireUserLock, appendMessages, canSpend, cancelTask, checkRateLimit, claimApproval, createWebTelegramLinkCode, getApproval, getDaytonaWorkspace, getSession, getTask, getTelegramUserIdForWebAuth, isDurableStore, listChannelIdentities, listCliDevices, listFaceTimeCalls, listJobs, listOutbox, listReminders, listTasks, releaseUserLock, retryTask, saveSession, setApprovalStatus, setModel, setTaskWorkflowRunId, setVoiceReplies, type SdkProjectRecord, type SdkRunRecord, type SdkThreadRecord } from "./store.js";
import { monitoringSnapshot } from "./monitoring.js";
import { enqueueTaskWorkflow } from "./triggerWorkflow.js";
import type { ContentPart } from "./types.js";
import { requestPhoneCallApproval } from "./calls/phoneApproval.js";
import { nativeTool } from "./nativeTools.js";
import { validateNativeToolArguments } from "./agentTools.js";

const activeRuns = new Map<string, AbortController>();
const event = (type: string, text?: string) => ({ id: `evt_${randomUUID()}`, type, at: Date.now(), ...(text ? { text: text.slice(0, 4000) } : {}) });
const SELF_SERVICE_PROJECT_LIMIT = 10;
const SELF_SERVICE_SCOPES = new Set([
  "*", "threads:read", "threads:write", "tasks:read", "tasks:write",
  "approvals:read", "approvals:write", "files:read", "files:write",
  "webhooks:read", "webhooks:write", "audit-events:read", "usage:read",
]);

type WebAuthSession = { user?: { id?: string; emailVerified?: boolean } } | null;
const defaultWebAuthSessionResolver = (headers: Headers): Promise<WebAuthSession> => getAuth().api.getSession({ headers }) as Promise<WebAuthSession>;
let webAuthSessionResolver = defaultWebAuthSessionResolver;

/** Test-only seam; production always validates the Better Auth session cookie. */
export function setWebAuthSessionResolverForTests(resolver?: (headers: Headers) => Promise<WebAuthSession>): void {
  webAuthSessionResolver = resolver ?? defaultWebAuthSessionResolver;
}

function apiError(c: any, status: number, code: string, message: string) {
  const requestId = (c.get("sdkRequestId") as string | undefined) ?? randomUUID();
  c.header("X-Request-Id", requestId);
  return c.json({ error: { code, message, requestId } }, status);
}
async function audit(userId: number, action: string, requestId: string, status: number): Promise<void> { const session = await getSession(userId); session.sdkAudit!.push({ id: `audit_${randomUUID()}`, action: action.slice(0, 120), requestId, status, at: Date.now() }); session.sdkAudit = session.sdkAudit!.slice(-500); await saveSession(userId, session); }
async function notifyWebhooks(userId: number, hooks: Array<{ id: string; url: string; secretCiphertext: string; disabledAt?: number }>, type: string, data: unknown): Promise<void> { await Promise.all(hooks.filter((hook) => !hook.disabledAt).map((hook) => enqueueSdkWebhook(userId, hook, type, data))); }

function userIdFor(externalId: string, projectId: string): number {
  // Session IDs are internal only; deterministic separation keeps SDK users isolated.
  return Number.parseInt(createHash("sha256").update(`sdk:${projectId}:${externalId}`).digest("hex").slice(0, 12), 16);
}

type SdkPrincipal = { projectId: string; scopes: string[]; root: boolean };
function requiredScope(path: string, method: string): string {
  const resource = path.split("/")[2] || "unknown";
  return `${resource}:${method === "GET" || method === "HEAD" ? "read" : "write"}`;
}
function scopeAllowed(principal: SdkPrincipal, path: string, method: string): boolean {
  const required = requiredScope(path, method);
  return principal.scopes.includes("*") || principal.scopes.includes(required) || principal.scopes.includes(`${required.split(":")[0]}:*`);
}
const digestKey = (value: string) => createHash("sha256").update(value).digest("hex");
async function authorized(token: string): Promise<SdkPrincipal | undefined> {
  if (config.apiKey && token.length === config.apiKey.length && timingSafeEqual(Buffer.from(token), Buffer.from(config.apiKey))) return { projectId: "root", scopes: ["*"], root: true };
  if (!token.startsWith("chsk_")) return undefined;
  const project = (await getSession(0)).sdkProjects!.find((item) => !item.revokedAt && item.keyHash === digestKey(token));
  return project ? { projectId: project.id, scopes: project.scopes, root: false } : undefined;
}

type SdkOwner = { externalId: string; userId: number; projectId: string };
function sdkUserFromRequest(c: any): SdkOwner | undefined {
  const externalId = (c.req.header("X-Chusky-User-Id") ?? c.get("webAuthUserId") ?? "").trim();
  if (!externalId || externalId.length > 200) return undefined;
  const principal = c.get("sdkPrincipal") as SdkPrincipal | undefined;
  return principal ? { externalId, userId: userIdFor(externalId, principal.projectId), projectId: principal.projectId } : undefined;
}
function sdkUser(c: any): SdkOwner | undefined { return c.get("sdkOwner") as SdkOwner | undefined; }
async function resolveSdkUser(c: any): Promise<SdkOwner | undefined> {
  const owner = sdkUserFromRequest(c);
  if (!owner) return undefined;
  const webAuthUserId = c.get("webAuthUserId") as string | undefined;
  const telegramUserId = webAuthUserId ? await getTelegramUserIdForWebAuth(webAuthUserId) : undefined;
  return telegramUserId ? { ...owner, userId: telegramUserId } : owner;
}

function isAdminRequest(c: { req: { path: string; url: string } }): boolean {
  // Use the original request URL as the source of truth. Some adapters/proxies can
  // expose a route-relative `req.path`, which must not downgrade a root-only route
  // into a user-scoped developer request.
  const pathname = new URL(c.req.url).pathname;
  return pathname === "/v1/admin" || pathname.startsWith("/v1/admin/") || c.req.path === "/v1/admin" || c.req.path.startsWith("/v1/admin/");
}

function accountProjectScopes(value: unknown): string[] | undefined {
  if (value === undefined) return ["*"];
  if (!Array.isArray(value) || !value.length || value.length > SELF_SERVICE_SCOPES.size || !value.every((scope) => typeof scope === "string" && SELF_SERVICE_SCOPES.has(scope))) return undefined;
  const scopes = [...new Set(value)];
  return scopes.includes("*") && scopes.length !== 1 ? undefined : scopes;
}

function accountProjectView(project: SdkProjectRecord) {
  return {
    id: project.id,
    name: project.name,
    keyPrefix: project.keyPrefix,
    scopes: project.scopes,
    createdAt: new Date(project.createdAt).toISOString(),
    rotatedAt: project.rotatedAt ? new Date(project.rotatedAt).toISOString() : undefined,
    revokedAt: project.revokedAt ? new Date(project.revokedAt).toISOString() : undefined,
  };
}

function webProjectOwner(c: any): { id: string; verified: boolean } | undefined {
  const id = c.get("webAuthUserId") as string | undefined;
  return id ? { id, verified: c.get("webAuthEmailVerified") === true } : undefined;
}

async function linkedWebCallOwner(c: any): Promise<{ userId: number } | undefined> {
  const web = webProjectOwner(c);
  if (!web?.verified) return undefined;
  const userId = await getTelegramUserIdForWebAuth(web.id);
  return userId ? { userId } : undefined;
}

function phoneCallingAvailable(): boolean {
  return Boolean(config.twilioVoiceEnabled && config.twilioAccountSid && config.twilioAuthToken && config.twilioCallerId && config.twilioWebhookBaseUrl && config.twilioMediaStreamUrl);
}

function callView(call: { id: string; provider?: string; direction?: string; phoneNumber: string; purpose: string; status: string; error?: string; createdAt: number; updatedAt: number }) {
  const digits = call.phoneNumber.replace(/\D/g, "");
  const phoneNumber = digits.length > 4 ? `${call.phoneNumber.slice(0, Math.max(2, call.phoneNumber.length - 4)).replace(/\d/g, "•")}${digits.slice(-4)}` : "••••";
  return { id: call.id, provider: call.provider ?? "facetime", direction: call.direction ?? "outbound", phoneNumber, purpose: call.purpose, status: call.status, error: call.error ? "The call could not be completed. Check voice diagnostics and try again." : undefined, createdAt: new Date(call.createdAt).toISOString(), updatedAt: new Date(call.updatedAt).toISOString() };
}

function threadView(thread: SdkThreadRecord) { return { id: thread.id, externalId: thread.externalId, metadata: thread.metadata, createdAt: new Date(thread.createdAt).toISOString(), updatedAt: new Date(thread.updatedAt).toISOString() }; }
function runView(threadId: string, run: SdkRunRecord) { return { ...run, threadId, createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString() }; }
type RunBody = { input?: string; attachments?: string[]; model?: string };

async function resolveRunModel(requested: unknown, fallback: string): Promise<string> {
  if (requested === undefined) return fallback;
  if (typeof requested !== "string" || !/^[a-zA-Z0-9._:/~-]{1,200}$/.test(requested)) throw new Error("invalid_model");
  const models = await fetchModels();
  if (!models.some((model) => model.id === requested)) throw new Error("model_unavailable");
  return requested;
}

/**
 * Turn account-owned, verified uploads into model input.  The browser can only
 * submit file IDs; object keys and signed URLs never cross the browser boundary.
 */
async function resolveRunInput(session: Awaited<ReturnType<typeof getSession>>, body: RunBody): Promise<{ input: string; message: string | ContentPart[]; attachments: NonNullable<SdkRunRecord["attachments"]> }> {
  const input = String(body.input ?? "").trim();
  const ids = Array.isArray(body.attachments) ? [...new Set(body.attachments.filter((id): id is string => typeof id === "string" && id.length > 0))] : [];
  if ((!input && !ids.length) || input.length > 30_000 || ids.length > 5) throw new Error("invalid_input");
  const files = ids.map((id) => session.sdkFiles!.find((file) => file.id === id));
  if (files.some((file) => !file || file.status !== "available")) throw new Error("invalid_attachment");
  const verified = files as NonNullable<typeof files[number]>[];
  const parts: ContentPart[] = [{ type: "text", text: input || "Please analyze the attached file(s)." }];
  for (const file of verified) {
    if (file.contentType === "video/mp4") {
      parts.push({ type: "video_url", video_url: { url: await signR2Download(file.key) } });
      continue;
    }
    const data = await readR2Object(file.key);
    if (file.contentType.startsWith("audio/")) {
      const transcript = await transcribeAudio(data, file.contentType.split("/")[1] || "wav");
      parts.push({ type: "text", text: `Transcript of ${file.name}:\n${transcript}` });
    } else if (file.contentType.startsWith("image/")) {
      parts.push({ type: "image_url", image_url: { url: `data:${file.contentType};base64,${data.toString("base64")}` } });
    } else {
      parts.push({ type: "file", file: { filename: file.name, file_data: `data:${file.contentType};base64,${data.toString("base64")}` } });
    }
  }
  return { input, message: parts.length === 1 ? input : parts, attachments: verified.map(({ id, name, contentType, size }) => ({ id, name, contentType, size })) };
}
function page<T extends { id: string; updatedAt: number }>(items: T[], cursor: string | undefined, limit: string | undefined): { data: T[]; nextCursor?: string } { const size = Math.max(1, Math.min(100, Number(limit ?? 20) || 20)); const [at = "", id = ""] = Buffer.from(cursor ?? "", "base64url").toString("utf8").split(":"); const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)); const filtered = at ? sorted.filter((item) => item.updatedAt < Number(at) || (item.updatedAt === Number(at) && item.id < id)) : sorted; const data = filtered.slice(0, size); const last = data.at(-1); return { data, ...(last && filtered.length > data.length ? { nextCursor: Buffer.from(`${last.updatedAt}:${last.id}`).toString("base64url") } : {}) }; }
function idempotency(c: any, session: Awaited<ReturnType<typeof getSession>>, fingerprint: string): { replay?: unknown; key?: string; mismatch?: boolean } {
  const now = Date.now(); const cutoff = now - 24 * 60 * 60 * 1000;
  const entries = Object.entries(session.sdkIdempotency ?? {}).filter(([, record]) => record.createdAt >= cutoff).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 500);
  session.sdkIdempotency = Object.fromEntries(entries);
  const key = (c.req.header("Idempotency-Key") ?? "").trim().slice(0, 255); if (!key) return {};
  const existing = session.sdkIdempotency?.[key]; if (!existing) return { key };
  return existing.fingerprint === fingerprint ? { replay: existing.response } : { mismatch: true };
}

/** Public v1 API for a self-hosted instance. Keep CLI and Telegram routes private. */
export function registerSdkApi(app: Hono): void {
  app.use("/v1/*", cors({ origin: (origin) => origin && config.betterAuthTrustedOrigins.includes(origin) ? origin : "", credentials: true, allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Chusky-User-Id"], allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }));
  app.use("/v1/*", async (c, next) => {
    const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    let principal = await authorized(token);
    if (!principal && config.betterAuthEnabled && !token) {
      try {
        const session = await webAuthSessionResolver(c.req.raw.headers);
        if (session?.user?.id) {
          principal = { projectId: "web", scopes: ["*"], root: false };
          (c.set as (key: string, value: unknown) => void)("webAuthUserId", session.user.id);
          (c.set as (key: string, value: unknown) => void)("webAuthEmailVerified", session.user.emailVerified === true);
        }
      } catch { /* Treat an unavailable/invalid auth cookie as unauthenticated. */ }
    }
    if (!principal) return apiError(c, 401, "invalid_api_key", "A valid Chusky SDK API key is required.");
    (c.set as (key: string, value: unknown) => void)("sdkPrincipal", principal);
    if (isAdminRequest(c)) {
      if (!principal.root) return apiError(c, 403, "insufficient_scope", "Root API key required.");
      const requestId = randomUUID(); (c.set as (key: string, value: unknown) => void)("sdkRequestId", requestId); c.header("X-Request-Id", requestId); await next();
      if (c.req.method !== "GET") await audit(0, `${c.req.method} ${c.req.path}`, requestId, c.res.status);
      return;
    }
    if (!scopeAllowed(principal, c.req.path, c.req.method)) return apiError(c, 403, "insufficient_scope", `This API key lacks ${requiredScope(c.req.path, c.req.method)}.`);
    const owner = await resolveSdkUser(c);
    if (!owner) return apiError(c, 400, "missing_user", "X-Chusky-User-Id is required.");
    (c.set as (key: string, value: unknown) => void)("sdkOwner", owner);
    const requestId = randomUUID(); (c.set as (key: string, value: unknown) => void)("sdkRequestId", requestId); c.header("X-Request-Id", requestId); await next();
    if (c.req.method !== "GET") await audit(owner.userId, `${c.req.method} ${c.req.path}`, requestId, c.res.status);
  });

  app.get("/v1/ops/health", async (c) => {
    const sendblueConfigured = !config.sendblueEnabled || Boolean(config.sendblueApiKey && config.sendblueApiSecret && config.sendblueNumber && config.sendblueWebhookSecret);
    const redis = isDurableStore();
    const production = process.env.NODE_ENV === "production";
    const checks = {
      redis: redis ? "ok" : production ? "failed" : "degraded",
      qstash: config.qstashToken ? "configured" : "disabled",
      sendblue: config.sendblueEnabled ? (sendblueConfigured ? "configured" : "misconfigured") : "disabled",
      telegram: "configured",
    } as const;
    const ok = checks.redis === "ok" && checks.sendblue !== "misconfigured";
    return c.json({ ok, status: ok ? "operational" : "degraded", persistence: redis ? "redis" : "memory", checks, channels: { telegram: true, cli: true, slack: config.slackEnabled, whatsapp: config.whatsappEnabled, sendblue: config.sendblueEnabled }, monitoring: monitoringSnapshot() });
  });

  app.get("/v1/account/overview", async (c) => {
    const owner = sdkUser(c)!;
    const webAuthUserId = (c as any).get("webAuthUserId") as string | undefined;
    const session = await getSession(owner.userId);
    const [channels, devices, reminders, jobs, workspace, deliveries] = await Promise.all([
      listChannelIdentities(owner.userId),
      listCliDevices(owner.userId),
      listReminders(owner.userId),
      listJobs(owner.userId),
      getDaytonaWorkspace(owner.userId),
      listOutbox(undefined, 100),
    ]);
    return c.json({
      model: session.model,
      voiceReplies: Boolean(session.voiceReplies),
      approvals: session.approvals.filter((item) => item.status === "pending" && item.expiresAt > Date.now()).map((item) => ({ id: item.id, toolSlug: item.toolSlug, request: item.request, status: item.status, channelProvider: item.channelProvider, createdAt: new Date(item.createdAt).toISOString(), expiresAt: new Date(item.expiresAt).toISOString() })),
      channels: channels.filter((item) => !item.disabledAt).map((item) => ({ provider: item.provider, externalUserId: item.externalUserId, workspaceId: item.workspaceId, displayName: item.displayName, verifiedAt: new Date(item.verifiedAt).toISOString(), proactiveOptIn: item.proactiveOptIn !== false })),
      reminders: reminders.map((item) => ({ ...item, runAt: new Date(item.runAt).toISOString(), createdAt: new Date(item.createdAt).toISOString() })),
      jobs: jobs.map((item) => ({ ...item, createdAt: new Date(item.createdAt).toISOString() })),
      memory: session.memories.map(({ id, category, key, value, confidence, updatedAt }) => ({ id, category, key, value, confidence, updatedAt: new Date(updatedAt).toISOString() })),
      scratchpad: Object.entries(session.scratchpad).map(([key, item]) => ({ key, content: item.content, updatedAt: new Date(item.updatedAt).toISOString() })),
      triggers: session.triggerIds,
      devices: devices.filter((item) => !item.revokedAt).map(({ tokenHash: _tokenHash, ...item }) => ({ ...item, createdAt: new Date(item.createdAt).toISOString(), lastSeenAt: new Date(item.lastSeenAt).toISOString() })),
      workspace: workspace ? { sandboxId: workspace.sandboxId, name: workspace.name, lastKnownState: workspace.lastKnownState, createdAt: new Date(workspace.createdAt).toISOString(), updatedAt: new Date(workspace.updatedAt).toISOString(), ptySessions: workspace.ptySessions?.length ?? 0, lastUrl: workspace.browser?.lastUrl } : null,
      webhooks: (session.sdkWebhooks ?? []).filter((item) => !item.disabledAt).map(({ secretCiphertext: _secret, ...item }) => ({ ...item, createdAt: new Date(item.createdAt).toISOString() })),
      telegramLink: { linked: Boolean(webAuthUserId && await getTelegramUserIdForWebAuth(webAuthUserId)) },
      deliveries: deliveries.filter((item) => item.userId === owner.userId && !item.webhook).slice(0, 20).map((item) => ({ id: item.id, provider: item.provider, status: item.status, kind: item.kind, attempts: item.attempts, providerStatus: item.providerStatus, lastError: item.lastError, createdAt: new Date(item.createdAt).toISOString(), updatedAt: new Date(item.updatedAt).toISOString(), deliveredAt: item.deliveredAt ? new Date(item.deliveredAt).toISOString() : undefined })),
    });
  });

  app.get("/v1/account/models", async (c) => {
    try { return c.json({ data: await fetchModels() }); }
    catch (error) { return apiError(c, 502, "models_unavailable", error instanceof Error ? error.message : "Models are temporarily unavailable."); }
  });

  app.patch("/v1/account/preferences", async (c) => {
    const owner = sdkUser(c)!;
    const body = await c.req.json().catch(() => ({})) as { model?: unknown; voiceReplies?: unknown };
    if (body.model !== undefined && (typeof body.model !== "string" || !/^[a-zA-Z0-9._:/~-]{1,200}$/.test(body.model))) return apiError(c, 400, "invalid_model", "model must be a valid model ID.");
    if (body.voiceReplies !== undefined && typeof body.voiceReplies !== "boolean") return apiError(c, 400, "invalid_voice_setting", "voiceReplies must be a boolean.");
    if (body.model === undefined && body.voiceReplies === undefined) return apiError(c, 400, "empty_preferences", "Provide model or voiceReplies.");
    if (body.model !== undefined) await setModel(owner.userId, body.model);
    if (body.voiceReplies !== undefined) await setVoiceReplies(owner.userId, body.voiceReplies);
    const session = await getSession(owner.userId);
    return c.json({ model: session.model, voiceReplies: Boolean(session.voiceReplies) });
  });

  app.get("/v1/apps", async (c) => {
    try { return c.json({ data: await getToolkitStates(sdkUser(c)!.userId) }); }
    catch (error) { return apiError(c, 502, "apps_unavailable", error instanceof Error ? error.message : "Connected apps are temporarily unavailable."); }
  });

  app.post("/v1/apps/:toolkit/connect", async (c) => {
    const toolkit = c.req.param("toolkit").trim();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(toolkit)) return apiError(c, 400, "invalid_toolkit", "Invalid toolkit name.");
    try { return c.json({ toolkit, url: await getConnectionUrl(sdkUser(c)!.userId, toolkit) }); }
    catch (error) { return apiError(c, 502, "connection_unavailable", error instanceof Error ? error.message : "Could not create an app connection link."); }
  });

  app.get("/v1/triggers", async (c) => {
    try {
      const items = await listTriggers(sdkUser(c)!.userId);
      return c.json({ data: items.map((item: any) => ({ id: String(item.id ?? item.trigger_id ?? item.triggerId ?? ""), slug: String(item.trigger_slug ?? item.slug ?? ""), status: String(item.status ?? (item.enabled === false ? "disabled" : "active")), config: item.config ?? item.triggerConfig ?? {} })).filter((item) => item.id) });
    } catch (error) { return apiError(c, 502, "triggers_unavailable", error instanceof Error ? error.message : "Triggers are temporarily unavailable."); }
  });

  app.post("/v1/triggers", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { slug?: unknown; triggerConfig?: unknown };
    const slug = String(body.slug ?? "").trim();
    if (!/^[A-Z0-9][A-Z0-9_.-]{1,150}$/.test(slug)) return apiError(c, 400, "invalid_trigger", "Provide a valid trigger slug.");
    if (body.triggerConfig !== undefined && (typeof body.triggerConfig !== "object" || body.triggerConfig === null || Array.isArray(body.triggerConfig))) return apiError(c, 400, "invalid_trigger_config", "triggerConfig must be an object.");
    try { return c.json(await createTrigger(sdkUser(c)!.userId, slug, { triggerConfig: body.triggerConfig ?? {} }), 201); }
    catch (error) { return apiError(c, 502, "trigger_create_failed", error instanceof Error ? error.message : "Could not create the trigger."); }
  });

  app.patch("/v1/triggers/:triggerId", async (c) => {
    const enabled = (await c.req.json().catch(() => ({})) as { enabled?: unknown }).enabled;
    if (typeof enabled !== "boolean") return apiError(c, 400, "invalid_trigger_state", "enabled must be a boolean.");
    try { return c.json(await setTriggerState(sdkUser(c)!.userId, c.req.param("triggerId"), enabled)); }
    catch (error) { return apiError(c, 403, "trigger_not_owned", error instanceof Error ? error.message : "You do not own this trigger."); }
  });

  app.delete("/v1/triggers/:triggerId", async (c) => {
    try { await deleteTrigger(sdkUser(c)!.userId, c.req.param("triggerId")); return c.body(null, 204); }
    catch (error) { return apiError(c, 403, "trigger_not_owned", error instanceof Error ? error.message : "You do not own this trigger."); }
  });

  app.post("/v1/account/telegram-link", async (c) => {
    const webAuthUserId = (c as any).get("webAuthUserId") as string | undefined;
    if (!webAuthUserId) return apiError(c, 403, "web_session_required", "Sign in to the Chusky dashboard before linking Telegram.");
    if (await getTelegramUserIdForWebAuth(webAuthUserId)) return apiError(c, 409, "already_linked", "This web account is already linked to Telegram.");
    const link = await createWebTelegramLinkCode(webAuthUserId);
    return c.json({ code: link.code, expiresAt: new Date(link.expiresAt).toISOString() }, 201);
  });

  app.get("/v1/account/calls", async (c) => {
    const owner = await linkedWebCallOwner(c);
    if (!owner) return apiError(c, 403, "workspace_link_required", "Verify your email and link your Telegram workspace before using calls.");
    return c.json({ available: phoneCallingAvailable(), data: (await listFaceTimeCalls(owner.userId)).map(callView) });
  });

  app.post("/v1/account/calls", async (c) => {
    const owner = await linkedWebCallOwner(c);
    if (!owner) return apiError(c, 403, "workspace_link_required", "Verify your email and link your Telegram workspace before using calls.");
    if (!phoneCallingAvailable()) return apiError(c, 503, "phone_calling_unavailable", "Phone calling is not configured on this Chusky deployment.");
    if (!(await checkRateLimit(owner.userId))) return apiError(c, 429, "rate_limit_exceeded", "Too many requests. Try again shortly.");
    const body = await c.req.json().catch(() => ({})) as { phoneNumber?: unknown; purpose?: unknown };
    try {
      const phoneNumber = String(body.phoneNumber ?? "").trim();
      const purpose = String(body.purpose ?? "").trim();
      const approval = await requestPhoneCallApproval(owner.userId, { phoneNumber, purpose }, `/call ${phoneNumber} ${purpose}`);
      return c.json({ id: approval.id, toolSlug: approval.toolSlug, args: approval.args, status: approval.status, expiresAt: new Date(approval.expiresAt).toISOString() }, 201);
    } catch (error) {
      return apiError(c, 400, "invalid_phone_call", error instanceof Error ? error.message : "Invalid call request.");
    }
  });

  app.get("/v1/account/projects", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before creating or managing API keys.");
    const control = await getSession(0);
    return c.json({ data: control.sdkProjects!.filter((project) => project.ownerWebAuthUserId === owner.id).map(accountProjectView) });
  });

  app.post("/v1/account/projects", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before creating an API key.");
    const body = await c.req.json().catch(() => ({})) as { name?: unknown; scopes?: unknown };
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
    const scopes = accountProjectScopes(body.scopes);
    if (!name) return apiError(c, 400, "invalid_project", "Project name is required.");
    if (!scopes) return apiError(c, 400, "invalid_scopes", "Choose supported API scopes.");
    const control = await getSession(0);
    if (control.sdkProjects!.filter((project) => project.ownerWebAuthUserId === owner.id && !project.revokedAt).length >= SELF_SERVICE_PROJECT_LIMIT) return apiError(c, 409, "project_limit_reached", `You can have up to ${SELF_SERVICE_PROJECT_LIMIT} active API keys.`);
    const id = `proj_${randomUUID()}`;
    const key = `chsk_${id}_${randomBytes(24).toString("base64url")}`;
    const project: SdkProjectRecord = { id, name, keyPrefix: key.slice(0, 18), keyHash: digestKey(key), scopes, createdAt: Date.now(), ownerWebAuthUserId: owner.id };
    control.sdkProjects!.push(project);
    await saveSession(0, control);
    return c.json({ ...accountProjectView(project), key }, 201);
  });

  app.patch("/v1/account/projects/:projectId", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before managing API keys.");
    const scopes = accountProjectScopes((await c.req.json().catch(() => ({})) as { scopes?: unknown }).scopes);
    if (!scopes) return apiError(c, 400, "invalid_scopes", "Choose supported API scopes.");
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && item.ownerWebAuthUserId === owner.id && !item.revokedAt);
    if (!project) return apiError(c, 404, "not_found", "Active API key not found.");
    project.scopes = scopes;
    await saveSession(0, control);
    return c.json(accountProjectView(project));
  });

  app.post("/v1/account/projects/:projectId/rotate-key", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before managing API keys.");
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && item.ownerWebAuthUserId === owner.id && !item.revokedAt);
    if (!project) return apiError(c, 404, "not_found", "Active API key not found.");
    const key = `chsk_${project.id}_${randomBytes(24).toString("base64url")}`;
    project.keyHash = digestKey(key);
    project.keyPrefix = key.slice(0, 18);
    project.rotatedAt = Date.now();
    await saveSession(0, control);
    return c.json({ ...accountProjectView(project), key }, 201);
  });

  app.delete("/v1/account/projects/:projectId", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before managing API keys.");
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && item.ownerWebAuthUserId === owner.id && !item.revokedAt);
    if (!project) return apiError(c, 404, "not_found", "Active API key not found.");
    project.revokedAt = Date.now();
    await saveSession(0, control);
    return c.body(null, 204);
  });

  app.post("/v1/admin/projects", async (c) => { const body = await c.req.json().catch(() => ({})) as { name?: string; scopes?: string[] }; const name = String(body.name ?? "").trim().slice(0, 100); const scopes = Array.isArray(body.scopes) && body.scopes.every((item) => typeof item === "string") ? [...new Set(body.scopes)].slice(0, 20) : ["*"]; if (!name) return apiError(c, 400, "invalid_project", "Project name is required."); const control = await getSession(0); const id = `proj_${randomUUID()}`; const secret = `chsk_${id}_${randomBytes(24).toString("base64url")}`; const record: SdkProjectRecord = { id, name, keyPrefix: secret.slice(0, 18), keyHash: digestKey(secret), scopes, createdAt: Date.now() }; control.sdkProjects!.push(record); await saveSession(0, control); return c.json({ id, name, key: secret, keyPrefix: record.keyPrefix, scopes, createdAt: new Date(record.createdAt).toISOString() }, 201); });
  app.get("/v1/admin/projects", async (c) => c.json({ data: (await getSession(0)).sdkProjects!.map(({ keyHash: _keyHash, ...project }) => ({ ...project, createdAt: new Date(project.createdAt).toISOString(), revokedAt: project.revokedAt ? new Date(project.revokedAt).toISOString() : undefined })) }));
  app.get("/v1/admin/audit-events", async (c) => { const after = Number(c.req.query("after") ?? 0) || 0; return c.json({ data: (await getSession(0)).sdkAudit!.filter((item) => item.at > after) }); });
  app.patch("/v1/admin/projects/:projectId", async (c) => { const body = await c.req.json().catch(() => ({})) as { scopes?: string[] }; if (!Array.isArray(body.scopes) || !body.scopes.length || !body.scopes.every((item) => typeof item === "string" && item.length <= 80)) return apiError(c, 400, "invalid_scopes", "scopes must be a non-empty array of short strings."); const control = await getSession(0); const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId")); if (!project || project.revokedAt) return apiError(c, 404, "not_found", "Active project not found."); project.scopes = [...new Set(body.scopes)].slice(0, 20); await saveSession(0, control); return c.json({ id: project.id, name: project.name, keyPrefix: project.keyPrefix, scopes: project.scopes, createdAt: new Date(project.createdAt).toISOString() }); });
  app.post("/v1/admin/projects/:projectId/rotate-key", async (c) => { const control = await getSession(0); const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId")); if (!project || project.revokedAt) return apiError(c, 404, "not_found", "Active project not found."); const key = `chsk_${project.id}_${randomBytes(24).toString("base64url")}`; project.keyHash = digestKey(key); project.keyPrefix = key.slice(0, 18); await saveSession(0, control); return c.json({ id: project.id, key, keyPrefix: project.keyPrefix, rotatedAt: new Date().toISOString() }, 201); });
  app.delete("/v1/admin/projects/:projectId", async (c) => { const control = await getSession(0); const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId")); if (!project) return apiError(c, 404, "not_found", "Project not found."); project.revokedAt = Date.now(); await saveSession(0, control); return c.body(null, 204); });

  app.post("/v1/threads", async (c) => {
    const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { metadata?: Record<string, unknown> };
    const session = await getSession(owner.userId); const fingerprint = createHash("sha256").update(`POST:/threads:${JSON.stringify(body)}`).digest("hex"); const prior = idempotency(c, session, fingerprint); if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request."); if (prior.replay) return c.json(prior.replay, 201); const now = Date.now();
    const thread: SdkThreadRecord = { id: `thr_${randomUUID()}`, externalId: owner.externalId, metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {}, history: [], runs: [], createdAt: now, updatedAt: now };
    const response = threadView(thread); session.sdkThreads!.push(thread); if (prior.key) session.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: now }; await saveSession(owner.userId, session); return c.json(response, 201);
  });
  app.get("/v1/threads", async (c) => {
    const owner = sdkUser(c)!; const includeArchived = c.req.query("includeArchived") === "true"; const threads = (await getSession(owner.userId)).sdkThreads!.filter((item) => includeArchived || item.metadata.archived !== true); const result = page(threads, c.req.query("cursor"), c.req.query("limit")); return c.json({ data: result.data.map(threadView), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
  });
  app.get("/v1/threads/:threadId", async (c) => {
    const thread = (await getSession(sdkUser(c)!.userId)).sdkThreads!.find((item) => item.id === c.req.param("threadId")); return thread ? c.json(threadView(thread)) : apiError(c, 404, "not_found", "Thread not found.");
  });
  app.patch("/v1/threads/:threadId", async (c) => { const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { title?: unknown; archived?: unknown }; const session = await getSession(owner.userId); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); if (!thread) return apiError(c, 404, "not_found", "Thread not found."); if (body.title !== undefined) { const title = String(body.title).trim(); if (title.length > 120) return apiError(c, 400, "invalid_title", "Conversation title must be 120 characters or fewer."); if (title) thread.metadata.title = title; else delete thread.metadata.title; } if (body.archived !== undefined) { if (typeof body.archived !== "boolean") return apiError(c, 400, "invalid_archived", "archived must be a boolean."); thread.metadata.archived = body.archived; } thread.updatedAt = Date.now(); await saveSession(owner.userId, session); return c.json(threadView(thread)); });
  app.delete("/v1/threads/:threadId", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const index = session.sdkThreads!.findIndex((item) => item.id === c.req.param("threadId")); if (index < 0) return apiError(c, 404, "not_found", "Thread not found."); const thread = session.sdkThreads![index]; if (thread.runs.some((run) => run.status === "running")) return apiError(c, 409, "thread_active", "A conversation with a running request cannot be deleted."); session.sdkThreads!.splice(index, 1); await saveSession(owner.userId, session); return c.body(null, 204); });
  app.post("/v1/threads/:threadId/runs", async (c) => {
    const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as RunBody;
    if (!(await checkRateLimit(owner.userId))) { c.header("Retry-After", "60"); return apiError(c, 429, "rate_limited", "Rate limit exceeded."); }
    if (!(await canSpend(owner.userId))) return apiError(c, 402, "spend_limit", "Usage cap reached.");
    const session = await getSession(owner.userId); const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify(body)}`).digest("hex"); const prior = idempotency(c, session, fingerprint); if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request."); if (prior.replay) return c.json(prior.replay, 201); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); if (!thread) return apiError(c, 404, "not_found", "Thread not found.");
    let resolved: Awaited<ReturnType<typeof resolveRunInput>>; try { resolved = await resolveRunInput(session, body); } catch (error) { return apiError(c, 400, error instanceof Error && error.message === "invalid_attachment" ? "invalid_attachment" : "invalid_input", error instanceof Error && error.message === "invalid_attachment" ? "Each attachment must be a verified upload owned by this account." : "Provide 1–30000 characters or up to five verified attachments."); }
    const now = Date.now(); const run: SdkRunRecord = { id: `run_${randomUUID()}`, status: "running", input: resolved.input, attachments: resolved.attachments, events: [event("run.started")], createdAt: now, updatedAt: now }; thread.runs.push(run);
    try { const result = await runAgent(owner.userId, resolved.message, thread.history, body.model ?? session.model, undefined, c.req.raw.signal); run.status = "completed"; run.output = result.text; run.events.push(event("run.completed")); thread.history.push({ role: "user", content: `${resolved.input || "Attached file(s)"}${resolved.attachments.length ? `\n[Attachments: ${resolved.attachments.map((file) => file.name).join(", ")}]` : ""}` }, { role: "assistant", content: result.text }); }
    catch (error) { if (error instanceof ApprovalRequiredError) { run.status = "requires_approval"; run.approvalId = error.approvalId; run.events.push(event("run.approval_required")); } else { run.status = "failed"; run.error = { code: "agent_error", message: error instanceof Error ? error.message : "Agent failed" }; run.events.push(event("run.failed", run.error.message)); } }
    run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; const response = runView(thread.id, run); if (prior.key) session.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() }; await saveSession(owner.userId, session); await notifyWebhooks(owner.userId, session.sdkWebhooks!, `run.${run.status}`, { threadId: thread.id, runId: run.id, status: run.status }); return c.json(response, 201);
  });
  app.post("/v1/threads/:threadId/runs/stream", async (c) => {
    const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as RunBody;
    if (!(await checkRateLimit(owner.userId))) { c.header("Retry-After", "60"); return apiError(c, 429, "rate_limited", "Rate limit exceeded."); }
    if (!(await canSpend(owner.userId))) return apiError(c, 402, "spend_limit", "Usage cap reached.");
    const session = await getSession(owner.userId); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); if (!thread) return apiError(c, 404, "not_found", "Thread not found.");
    let resolved: Awaited<ReturnType<typeof resolveRunInput>>; try { resolved = await resolveRunInput(session, body); } catch (error) { return apiError(c, 400, error instanceof Error && error.message === "invalid_attachment" ? "invalid_attachment" : "invalid_input", error instanceof Error && error.message === "invalid_attachment" ? "Each attachment must be a verified upload owned by this account." : "Provide 1–30000 characters or up to five verified attachments."); }
    const now = Date.now(); const run: SdkRunRecord = { id: `run_${randomUUID()}`, status: "running", input: resolved.input, attachments: resolved.attachments, events: [event("run.started")], createdAt: now, updatedAt: now }; thread.runs.push(run);
    const abort = new AbortController(); const abortOnDisconnect = () => abort.abort(); c.req.raw.signal.addEventListener("abort", abortOnDisconnect, { once: true }); activeRuns.set(run.id, abort);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start: async (controller) => {
      const send = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      send({ type: "run.started", run: runView(thread.id, run) });
      try {
        const result = await runAgent(owner.userId, resolved.message, thread.history, body.model ?? session.model, undefined, abort.signal, (text) => { run.events.push(event("run.delta", text)); send({ type: "run.delta", runId: run.id, text }); });
        run.status = "completed"; run.output = result.text; run.events.push(event("run.completed")); thread.history.push({ role: "user", content: `${resolved.input || "Attached file(s)"}${resolved.attachments.length ? `\n[Attachments: ${resolved.attachments.map((file) => file.name).join(", ")}]` : ""}` }, { role: "assistant", content: result.text }); send({ type: "run.completed", run: runView(thread.id, run) });
      } catch (error) {
        if (error instanceof ApprovalRequiredError) { run.status = "requires_approval"; run.approvalId = error.approvalId; run.events.push(event("run.approval_required")); const approval = await getApproval(owner.userId, error.approvalId); send({ type: "run.approval_required", run: runView(thread.id, run), approval }); }
        else if (abort.signal.aborted) { run.status = "cancelled"; run.events.push(event("run.cancelled")); send({ type: "run.cancelled", run: runView(thread.id, run) }); }
        else { run.status = "failed"; run.error = { code: "agent_error", message: error instanceof Error ? error.message : "Agent failed" }; run.events.push(event("run.failed", run.error.message)); send({ type: "run.failed", run: runView(thread.id, run), error: run.error }); }
      } finally { c.req.raw.signal.removeEventListener("abort", abortOnDisconnect); activeRuns.delete(run.id); run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; await saveSession(owner.userId, session); await notifyWebhooks(owner.userId, session.sdkWebhooks!, `run.${run.status}`, { threadId: thread.id, runId: run.id, status: run.status }); controller.close(); }
    } });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
  });
  app.get("/v1/threads/:threadId/runs", async (c) => { const thread = (await getSession(sdkUser(c)!.userId)).sdkThreads!.find((item) => item.id === c.req.param("threadId")); if (!thread) return apiError(c, 404, "not_found", "Thread not found."); const result = page(thread.runs, c.req.query("cursor"), c.req.query("limit")); return c.json({ data: result.data.map((run) => runView(thread.id, run)), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }); });
  app.get("/v1/threads/:threadId/runs/:runId", async (c) => { const thread = (await getSession(sdkUser(c)!.userId)).sdkThreads!.find((item) => item.id === c.req.param("threadId")); const run = thread?.runs.find((item) => item.id === c.req.param("runId")); return thread && run ? c.json(runView(thread.id, run)) : apiError(c, 404, "not_found", "Run not found."); });
  app.get("/v1/threads/:threadId/runs/:runId/events", async (c) => { const thread = (await getSession(sdkUser(c)!.userId)).sdkThreads!.find((item) => item.id === c.req.param("threadId")); const run = thread?.runs.find((item) => item.id === c.req.param("runId")); const cursor = Number(c.req.query("after") ?? 0) || 0; return thread && run ? c.json({ data: run.events.filter((item) => item.at > cursor) }) : apiError(c, 404, "not_found", "Run not found."); });
  app.post("/v1/threads/:threadId/runs/:runId/cancel", async (c) => { const session = await getSession(sdkUser(c)!.userId); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); const run = thread?.runs.find((item) => item.id === c.req.param("runId")); if (!thread || !run) return apiError(c, 404, "not_found", "Run not found."); if (run.status !== "running") return apiError(c, 409, "run_not_cancellable", "Only a running run can be cancelled."); activeRuns.get(run.id)?.abort(); run.status = "cancelled"; run.events.push(event("run.cancelled")); run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; await saveSession(sdkUser(c)!.userId, session); return c.json(runView(thread.id, run)); });
  app.get("/v1/tasks", async (c) => c.json({ data: await listTasks(sdkUser(c)!.userId) }));
  app.post("/v1/tasks/:taskId/retry", async (c) => { const userId = sdkUser(c)!.userId; const task = await retryTask(userId, c.req.param("taskId")); if (!task) return apiError(c, 409, "task_not_retryable", "Only failed, blocked, or cancelled tasks can be retried."); try { const workflowRunId = await enqueueTaskWorkflow(userId, task.id, task.runAt ?? Date.now()); const updated = await setTaskWorkflowRunId(userId, task.id, workflowRunId); return c.json(updated ?? task); } catch (error) { return apiError(c, 503, "task_enqueue_failed", error instanceof Error ? error.message : "Task could not be queued."); } });
  app.post("/v1/tasks/:taskId/cancel", async (c) => { const task = await cancelTask(sdkUser(c)!.userId, c.req.param("taskId")); return task ? c.json(task) : apiError(c, 409, "task_not_cancellable", "This task is already completed or cancelled."); });
  app.get("/v1/audit-events", async (c) => { const session = await getSession(sdkUser(c)!.userId); const after = Number(c.req.query("after") ?? 0) || 0; return c.json({ data: session.sdkAudit!.filter((item) => item.at > after) }); });
  app.get("/v1/activity", async (c) => { const userId = sdkUser(c)!.userId; const since = Number(c.req.query("since") ?? 0) || 0; const session = await getSession(userId); return c.json({ now: Date.now(), approvals: session.approvals.filter((item) => item.status === "pending" && item.expiresAt > Date.now()), tasks: (await listTasks(userId)).filter((item) => item.updatedAt > since).slice(0, 50), reminders: (await listReminders(userId)).filter((item) => item.createdAt > since).slice(0, 50), jobs: (await listJobs(userId)).filter((item) => item.createdAt > since).slice(0, 50) }); });
  app.get("/v1/usage", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const files = session.sdkFiles!; const runs = session.sdkThreads!.flatMap((thread) => thread.runs); return c.json({ messages: session.totalMessages, cost: session.totalCost, files: { count: files.length, declaredBytes: files.reduce((total, file) => total + file.size, 0), available: files.filter((file) => file.status === "available").length }, runs: { count: runs.length, active: runs.filter((run) => run.status === "running").length }, tasks: { count: (await listTasks(owner.userId)).length } }); });
  app.post("/v1/webhooks", async (c) => { const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { url?: string }; let url: URL; try { url = new URL(String(body.url ?? "")); } catch { return apiError(c, 400, "invalid_webhook", "A valid HTTPS webhook URL is required."); } if (!isSafeWebhookUrl(url)) return apiError(c, 400, "invalid_webhook", "Webhook URLs must use public HTTPS endpoints."); const session = await getSession(owner.userId); const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify(body)}`).digest("hex"); const prior = idempotency(c, session, fingerprint); if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request."); if (prior.replay) return c.json(prior.replay, 201); const secret = `whsec_${randomBytes(24).toString("base64url")}`; const hook = { id: `wh_${randomUUID()}`, url: url.toString(), secretCiphertext: sealWebhookSecret(secret), createdAt: Date.now() }; const response = { id: hook.id, url: hook.url, secret, createdAt: new Date(hook.createdAt).toISOString() }; session.sdkWebhooks!.push(hook); if (prior.key) session.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() }; await saveSession(owner.userId, session); return c.json(response, 201); });
  app.get("/v1/webhooks", async (c) => { const hooks = (await getSession(sdkUser(c)!.userId)).sdkWebhooks!.filter((item) => !item.disabledAt).map(({ secretCiphertext: _secretCiphertext, ...item }) => item); return c.json({ data: hooks }); });
  app.get("/v1/webhooks/:webhookId/deliveries", async (c) => { const owner = sdkUser(c)!; const hook = (await getSession(owner.userId)).sdkWebhooks!.find((item) => item.id === c.req.param("webhookId")); if (!hook) return apiError(c, 404, "not_found", "Webhook not found."); const data = (await listOutbox(undefined, 500)).filter((item) => item.userId === owner.userId && item.webhook?.webhookId === hook.id).map((item) => ({ id: item.id, status: item.status, attempts: item.attempts, lastError: item.lastError, createdAt: new Date(item.createdAt).toISOString(), deliveredAt: item.deliveredAt ? new Date(item.deliveredAt).toISOString() : undefined })); return c.json({ data }); });
  app.delete("/v1/webhooks/:webhookId", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const hook = session.sdkWebhooks!.find((item) => item.id === c.req.param("webhookId")); if (!hook) return apiError(c, 404, "not_found", "Webhook not found."); hook.disabledAt = Date.now(); await saveSession(owner.userId, session); return c.body(null, 204); });
  app.post("/v1/files", async (c) => { const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { name?: string; contentType?: string; size?: number }; const name = String(body.name ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120); const contentType = String(body.contentType ?? "").toLowerCase(); const size = Number(body.size); const allowed = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain", "audio/mpeg", "audio/ogg", "audio/wav", "video/mp4"]); if (!name || !allowed.has(contentType) || !Number.isFinite(size) || size < 1 || size > config.sdkMaxFileBytes) return apiError(c, 400, "invalid_file", "File name, type, or size is invalid."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "R2 storage is not configured."); const session = await getSession(owner.userId); const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify(body)}`).digest("hex"); const prior = idempotency(c, session, fingerprint); if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request."); if (prior.replay) return c.json(prior.replay, 201); const file = { id: `file_${randomUUID()}`, key: `sdk/${owner.userId}/${randomUUID()}-${name}`, name, contentType, size, status: "pending" as const, createdAt: Date.now() }; const expiresAt = new Date(Date.now() + 300_000).toISOString(); const response = { ...file, uploadUrl: await signR2Upload(file.key, file.contentType), expiresAt }; session.sdkFiles!.push(file); if (prior.key) session.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() }; await saveSession(owner.userId, session); return c.json(response, 201); });
  app.post("/v1/files/:fileId/complete", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const file = session.sdkFiles!.find((item) => item.id === c.req.param("fileId")); if (!file) return apiError(c, 404, "not_found", "File not found."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "R2 storage is not configured."); try { const remote = await inspectR2Object(file.key); if (remote.size !== file.size || remote.contentType !== file.contentType) { file.status = "rejected"; await saveSession(owner.userId, session); return apiError(c, 409, "file_verification_failed", "R2 object size or content type did not match the upload intent."); } file.status = "available"; await saveSession(owner.userId, session); return c.json(file); } catch { return apiError(c, 409, "file_not_uploaded", "The upload is not available in R2 yet."); } });
  app.get("/v1/files/:fileId", async (c) => { const owner = sdkUser(c)!; const file = (await getSession(owner.userId)).sdkFiles!.find((item) => item.id === c.req.param("fileId")); if (!file) return apiError(c, 404, "not_found", "File not found."); if (file.status !== "available") return apiError(c, 409, "file_not_available", "Only a verified upload can be downloaded."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "R2 storage is not configured."); return c.json({ ...file, downloadUrl: await signR2Download(file.key), expiresAt: new Date(Date.now() + 300_000).toISOString() }); });
  app.delete("/v1/files/:fileId", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const index = session.sdkFiles!.findIndex((item) => item.id === c.req.param("fileId")); if (index < 0) return apiError(c, 404, "not_found", "File not found."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "R2 storage is not configured."); await deleteR2Object(session.sdkFiles![index].key); session.sdkFiles!.splice(index, 1); await saveSession(owner.userId, session); return c.body(null, 204); });
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
      if (approval.toolSlug === "CHUCK_START_FACETIME_CALL" || approval.toolSlug === "CHUCK_START_PHONE_CALL") {
        try {
          validateNativeToolArguments(approval.toolSlug, approval.args);
          await nativeTool(owner.userId, approval.toolSlug, approval.args);
          await setApprovalStatus(owner.userId, approval.id, "consumed");
          const label = approval.toolSlug === "CHUCK_START_PHONE_CALL" ? "Phone call" : "FaceTime call";
          const text = `${label} started. I’m joining the call now.`;
          await appendMessages(owner.userId, [{ role: "user", content: approval.request }, { role: "assistant", content: text }]);
          return c.json({ id: approval.id, status: "consumed", text });
        } catch (error) {
          await setApprovalStatus(owner.userId, approval.id, "consumed");
          return apiError(c, 502, "call_start_failed", error instanceof Error ? error.message : "Phone call could not be started.");
        }
      }
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
