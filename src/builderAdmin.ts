import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { getAuth } from "./auth.js";
import { config } from "./config.js";
import { durableStorageMetrics, durableStateStatus, isDurableStore } from "./store.js";
import { monitoringSnapshot } from "./monitoring.js";
import { logger } from "./logger.js";
import { builderEnabled, builderRepository, invalidateBuilderControl, newBuilderEvent, type BuilderRepository } from "./builderControl.js";

export interface BuilderSession {
  user: { id: string; name?: string; emailVerified?: boolean; twoFactorEnabled?: boolean };
  session: { token: string; createdAt: Date | string; expiresAt: Date | string; impersonatedBy?: string | null };
}
type BuilderRole = "builder_admin" | "builder_viewer";
export function builderRole(id: string, admins = process.env.CHUSKY_BUILDER_ADMIN_IDS ?? "", viewers = process.env.CHUSKY_BUILDER_VIEWER_IDS ?? ""): BuilderRole | undefined {
  const ids = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);
  if (ids(admins).includes(id)) return "builder_admin";
  if (ids(viewers).includes(id)) return "builder_viewer";
  return undefined;
}
export function freshBuilderSession(session: BuilderSession, now = Date.now()): boolean {
  const created = new Date(session.session.createdAt).getTime();
  return Number.isFinite(created) && created <= now && now - created <= 15 * 60_000;
}

interface BuilderDependencies {
  enabled?: () => boolean;
  session?: (headers: Headers) => Promise<BuilderSession | null>;
  role?: (id: string) => BuilderRole | undefined;
  repository?: () => BuilderRepository;
  verifyTotp?: (headers: Headers, code: string) => Promise<void>;
  snapshot?: () => Promise<unknown>;
}

async function systemSnapshot() {
  const monitoring = monitoringSnapshot();
  const results = await Promise.allSettled([durableStateStatus(), durableStorageMetrics()]);
  return {
    observedAt: Date.now(),
    scope: "Application telemetry; not provider billing or account-wide usage.",
    uptimeSeconds: Math.floor(process.uptime()),
    persistence: isDurableStore() ? "redis" : "memory",
    neon: results[0].status === "fulfilled" ? results[0].value : { enabled: config.durableStateEnabled, reachable: false, schemaReady: false },
    storage: results[1].status === "fulfilled" ? results[1].value : null,
    // Do not return raw error messages, which may contain provider URLs or tokens.
    monitoring: { counters: monitoring.counters, lastFailure: monitoring.lastFailure ? { at: monitoring.lastFailure.at, type: monitoring.lastFailure.type } : null },
    providers: [
      { name: "OpenRouter", configured: Boolean(config.openRouterApiKey) },
      { name: "Composio", configured: Boolean(config.composioApiKey) },
      { name: "Redis", configured: Boolean(config.redisUrl) },
      { name: "Neon", configured: Boolean(config.durableStateDatabaseUrl) },
      { name: "Cloudflare R2", configured: Boolean(config.r2Bucket && config.r2AccessKeyId && config.r2SecretAccessKey) },
      { name: "QStash", configured: Boolean(config.qstashToken) },
      { name: "E2B browser", configured: Boolean(config.e2bEnabled && config.e2bApiKey) },
      { name: "Daytona", configured: Boolean(config.daytonaApiKey) },
    ],
  };
}

/** Private builder control plane. Customer API keys and organization roles cannot enter. */
export function registerBuilderAdmin(app: Hono, dependencies: BuilderDependencies = {}) {
  const repository = dependencies.repository ?? builderRepository;
  const resolveSession = dependencies.session ?? (async (headers: Headers) => getAuth().api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } }) as Promise<BuilderSession | null>);
  const roles = dependencies.role ?? builderRole;
  const builder = new Hono<{ Variables: { principal: { session: BuilderSession; role: BuilderRole } } }>();
  const error = (code: string, message: string) => ({ error: { code, message } });
  builder.use("*", cors({ origin: (origin) => config.betterAuthTrustedOrigins.includes(origin) ? origin : "", credentials: true, allowMethods: ["GET", "POST", "PATCH", "OPTIONS"], allowHeaders: ["Content-Type"] }));
  builder.use("*", bodyLimit({ maxSize: 2048, onError: (c) => c.json(error("request_too_large", "Administrative requests must be small."), 413) }));
  builder.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (!(dependencies.enabled ?? builderEnabled)()) return c.json(error("admin_disabled", "Builder administration is not enabled."), 503);
    if (c.req.header("Authorization")) return c.json(error("builder_session_required", "Use a builder session."), 403);
    const session = await resolveSession(c.req.raw.headers);
    const expiry = session ? new Date(session.session.expiresAt).getTime() : NaN;
    if (!session || !Number.isFinite(expiry) || expiry <= Date.now()) return c.json(error("sign_in_required", "Sign in to continue."), 401);
    const role = roles(session.user.id);
    if (!role || session.user.emailVerified !== true || session.session.impersonatedBy) return c.json(error("builder_required", "Builder access is required."), 403);
    c.set("principal", { session, role });
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("Origin");
      if (!origin || !config.betterAuthTrustedOrigins.includes(origin) || c.req.header("Sec-Fetch-Site") === "cross-site") return c.json(error("invalid_origin", "This origin cannot change builder settings."), 403);
      if (!c.req.header("Content-Type")?.startsWith("application/json")) return c.json(error("invalid_content_type", "Use JSON for administrative changes."), 415);
      if (!freshBuilderSession(session)) return c.json(error("fresh_session_required", "Sign in again before changing controls."), 403);
    }
    if (!(await repository().admit(session.user.id))) return c.json(error("rate_limited", "Too many administrative requests. Try again in a minute."), 429);
    if (!["/access", "/verify"].includes(c.req.path.replace(/^\/builder\/v1/, ""))) {
      if (session.user.twoFactorEnabled !== true || !(await repository().verified(session.session.token))) return c.json(error("mfa_required", "Verify your authenticator to open the control plane."), 403);
    }
    await next();
  });
  builder.onError((failure, c) => {
    logger.error({ errorName: failure.name }, "Builder control plane request failed");
    return c.json(error("admin_unavailable", "The control plane is unavailable. Refresh and check the saved state before retrying."), 503);
  });
  builder.get("/access", async (c) => {
    const { session, role } = c.get("principal");
    return c.json({ name: session.user.name || "Builder", role, permissions: role === "builder_admin" ? ["view_metrics", "view_users", "manage_users", "manage_flags"] : ["view_metrics"], mfaEnabled: session.user.twoFactorEnabled === true, verified: session.user.twoFactorEnabled === true && await repository().verified(session.session.token), fresh: freshBuilderSession(session) });
  });
  builder.post("/verify", async (c) => {
    const { session } = c.get("principal");
    if (!session.user.twoFactorEnabled) return c.json(error("mfa_enrollment_required", "Enable an authenticator first."), 403);
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || !("code" in body) || typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) return c.json(error("invalid_code", "Enter a six-digit authenticator code."), 400);
    try {
      if (dependencies.verifyTotp) await dependencies.verifyTotp(c.req.raw.headers, body.code);
      else await getAuth().api.verifyTOTP({ headers: c.req.raw.headers, body: { code: body.code, trustDevice: false } });
    } catch { return c.json(error("invalid_code", "The authenticator code could not be verified."), 403); }
    await repository().record(newBuilderEvent(session.user.id, "builder_verified"));
    await repository().verify(session.session.token);
    return c.json({ verified: true, expiresInSeconds: 900 });
  });
  builder.get("/overview", async (c) => c.json({ data: await (dependencies.snapshot ?? systemSnapshot)() }));
  builder.get("/people", async (c) => {
    if (c.get("principal").role !== "builder_admin") return c.json(error("permission_denied", "User directory access is restricted to builder administrators."), 403);
    const result = await getAuth().api.listUsers({
      headers: c.req.raw.headers,
      query: { limit: 100, offset: 0, sortBy: "createdAt", sortDirection: "desc" },
    });
    const users = (result?.users ?? []).map((user: Record<string, unknown>) => ({
      id: typeof user.id === "string" ? user.id : "",
      name: typeof user.name === "string" ? user.name : "",
      email: typeof user.email === "string" ? user.email : "",
      emailVerified: user.emailVerified === true,
      createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : typeof user.createdAt === "string" ? user.createdAt : null,
      role: typeof user.role === "string" ? user.role : "user",
      banned: user.banned === true,
    }));
    return c.json({ data: users, total: typeof result?.total === "number" ? result.total : users.length });
  });
  builder.get("/controls", async (c) => c.json(await repository().read()));
  builder.get("/audit", async (c) => c.json({ data: await repository().events(), retention: "Most recent 1,000 events; returns latest 100." }));
  builder.patch("/controls", async (c) => {
    const { session, role } = c.get("principal");
    if (role !== "builder_admin") return c.json(error("permission_denied", "Manage-flags permission is required."), 403);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).some((key) => !["version", "agentEnabled", "reason"].includes(key)) || !Number.isSafeInteger(body.version) || (body.version as number) < 0 || typeof body.agentEnabled !== "boolean" || !["incident", "maintenance", "release"].includes(String(body.reason))) return c.json(error("invalid_control", "Provide a version, execution setting, and change reason."), 400);
    const event = { ...newBuilderEvent(session.user.id, "agent_execution_changed"), enabled: body.agentEnabled, reason: body.reason as "incident" | "maintenance" | "release" };
    const changed = await repository().change(body.version as number, body.agentEnabled, event);
    if (!changed) return c.json(error("control_conflict", "Another builder changed these controls. Refresh before trying again."), 409);
    invalidateBuilderControl();
    return c.json(changed);
  });
  app.route("/builder/v1", builder);
}
