import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { getAuth } from "./auth.js";
import { ApprovalRequiredError, createTrigger, deleteTrigger, disconnectConnectedAccount, fetchModels, getConnectionUrl, getToolkitStates, listConnectedAccounts, listTriggers, listAvailableTriggerToolkits, listAvailableTriggerTypes, runAgent, searchTools, setTriggerState, transcribeAudio, queueVideoWorkflow } from "./agent.js";
import { deleteR2Object, inspectR2Object, r2Configured, readR2Object, signR2Download, signR2Upload } from "./lib/storage/r2.js";
import { isSafeWebhookUrl, sealWebhookSecret } from "./lib/webhooks.js";
import { enqueueSdkWebhook } from "./lib/webhookOutbox.js";
import { extractMediaText, indexExtractedDocument } from "./lib/knowledge/ingest.js";
import { vectorConfigured } from "./lib/knowledge/vector.js";
import { acquireUserLock, addRecallMeeting, appendMessages, appendCompanyAuditEvent, canSpend, cancelTask, checkRateLimit, claimApproval, completeCompanyRunSummary, createTask, createWebTelegramLinkCode, deleteMeetingContact, findCompanyBrandingByDomain, getApproval, getAgentRun, getCalendarMeetingPreparation, getCompanyBranding, getDaytonaWorkspace, getMeetingRepresentativeProfile, getRecallMeeting, getSession, getTask, getTelegramUserIdForWebAuth, getTriggerEvent, isDurableStore, listApprovals, listAgentRuns, listCalendarMeetingPreparations, listChannelIdentities, listCliDevices, listMeetingContacts, listPhoneCalls, listRecallMeetings, listJobs, listOutbox, listReminders, listTasks, listHandoffRecords, getHandoffRecord, listVideoJobs, getVideoJob, listCompanyAuditEvents, listCompanyRunSummaries, listCompanyUsagePeriods, updateOutbox, updateVideoJob, registerImageAsset, releaseUserLock, retryTask, saveCompanyBranding, saveCompanyRunSummary, saveHandoffRecord, saveSession, setApprovalStatus, setLiveVoicePreference, setModel, setTaskWorkflowRunId, setVoiceReplies, updateMeetingRepresentativeProfile, getReminder, updateReminder, getJob, updateJob, readScratchpad, writeScratchpad, clearScratchpad, searchMemories, upsertMemory, forgetMemory, revokeCliDeviceHash, type CompanyBranding, type CompanyRunSummary, type SdkProjectRecord, type SdkRunRecord, type SdkThreadRecord } from "./store.js";
import { monitoringSnapshot } from "./monitoring.js";
import { logger } from "./logger.js";
import { enqueueTaskWorkflow } from "./triggerWorkflow.js";
import type { ContentPart } from "./types.js";
import { requestPhoneCallApproval } from "./calls/phoneApproval.js";
import { FLUX_TTS_VOICES } from "./voiceSettings.js";
import { listBlandCuratedVoices } from "./calls/blandVoices.js";
import { createLinkCode, identityFingerprint, unlinkChannelIdentity, updateLinkedChannelIdentity } from "./channels/identity.js";
import type { ChannelProvider } from "./channels/contracts.js";
import type { VoiceCallProfileInput } from "./calls/voiceProfile.js";
import { isBlandVoiceConfigured } from "./calls/bland.js";
import { isTwilioVoiceConfigured } from "./calls/twilio.js";
import { cancelJob, cancelReminder, nativeTool, scheduleJob, setReminder } from "./nativeTools.js";

import { validateNativeToolArguments } from "./agentTools.js";
import { chuckTools } from "./agentTools.js";
import { listSkillFiles, readSkillFile, searchSkills } from "./skills/catalog.js";
import { daytonaEngine } from "./lib/daytona/engine.js";
import { requestDelegationCancellation } from "./subagents/executor.js";
import { SELF_SERVICE_PROJECT_SCOPES } from "./developerProjects.js";
import { cancelAutomaticCalendarMeetingJoins, getRecallMeetingForUser, joinPreparedCalendarMeeting, joinRecallMeeting, leaveRecallMeeting, lookupRecallMeetingContext, prepareRecallMeetingMission } from "./meetings/service.js";
import { connectMcpServer, disconnectMcpServer, listMcpCatalog, listMcpConnections } from "./mcp/client.js";
import {
  COMPANY_AGENT_TEMPLATES,
  COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION,
  COMPANY_TOOL_STARTER_ALLOWLIST,
  createCompanyAgentProfile,
  effectiveCompanyRunPolicy,
  getCompanyTemplate,
  validateCompanyPolicy,
  type CompanyAgentProfile,
  type CompanyPolicy,
  type CompanyToolPolicy,
} from "./companyPlatform.js";

let sdkTaskWorkflowEnqueuer = enqueueTaskWorkflow;
/** Test-only seam for durable task submission; production uses the configured QStash workflow client. */
export function setSdkTaskWorkflowEnqueuerForTests(enqueuer?: typeof enqueueTaskWorkflow): void {
  sdkTaskWorkflowEnqueuer = enqueuer ?? enqueueTaskWorkflow;
}

const activeRuns = new Map<string, AbortController>();
const event = (type: string, text?: string) => ({ id: `evt_${randomUUID()}`, type, at: Date.now(), ...(text ? { text: text.slice(0, 4000) } : {}) });
const SELF_SERVICE_PROJECT_LIMIT = 10;
const SELF_SERVICE_SCOPES = new Set<string>(SELF_SERVICE_PROJECT_SCOPES);

type WebAuthSession = { user?: { id?: string; emailVerified?: boolean } } | null;
const defaultWebAuthSessionResolver = (headers: Headers): Promise<WebAuthSession> => getAuth().api.getSession({ headers }) as Promise<WebAuthSession>;
let webAuthSessionResolver = defaultWebAuthSessionResolver;
type OrganizationAccess = { id: string; role: string } | undefined;
type OrganizationAccessResolver = (headers: Headers, organizationId: string, userId: string) => Promise<OrganizationAccess>;
const defaultOrganizationAccessResolver: OrganizationAccessResolver = async (headers, organizationId, userId) => {
  const organization = await getAuth().api.getFullOrganization({ headers, query: { organizationId } }) as {
    id?: string;
    members?: Array<{ userId?: string; role?: string }>;
  } | null;
  if (organization?.id !== organizationId) return undefined;
  const member = organization.members?.find((item) => item.userId === userId);
  return member?.role ? { id: organizationId, role: member.role } : undefined;
};
let organizationAccessResolver = defaultOrganizationAccessResolver;

/** Test-only seam; production always validates the Better Auth session cookie. */
export function setWebAuthSessionResolverForTests(resolver?: (headers: Headers) => Promise<WebAuthSession>): void {
  webAuthSessionResolver = resolver ?? defaultWebAuthSessionResolver;
}
/** Test-only seam; production always checks Better Auth's organization membership. */
export function setOrganizationAccessResolverForTests(resolver?: OrganizationAccessResolver): void {
  organizationAccessResolver = resolver ?? defaultOrganizationAccessResolver;
}

function apiError(c: any, status: number, code: string, message: string) {
  const requestId = (c.get("sdkRequestId") as string | undefined) ?? randomUUID();
  c.header("X-Request-Id", requestId);
  return c.json({ error: { code, message, requestId } }, status);
}
async function audit(userId: number, action: string, requestId: string, status: number): Promise<void> { const session = await getSession(userId); session.sdkAudit!.push({ id: `audit_${randomUUID()}`, action: action.slice(0, 120), requestId, status, at: Date.now() }); session.sdkAudit = session.sdkAudit!.slice(-500); await saveSession(userId, session); }
async function companyAudit(projectId: string, action: string, requestId: string, status: number): Promise<void> {
  await appendCompanyAuditEvent(projectId, { id: `audit_${randomUUID()}`, action: action.slice(0, 120), requestId, status, at: Date.now() });
}
async function auditDashboardProjectWrite(c: any, requestId: string): Promise<void> {
  const method = String(c.req.method);
  if (method === "GET" || method === "HEAD" || c.res.status >= 400) return;
  const pathname = new URL(c.req.url).pathname;
  if (!pathname.startsWith("/v1/account/projects")) return;
  let projectId = pathname.match(/^\/v1\/account\/projects\/([^/]+)/)?.[1];
  if (!projectId && pathname === "/v1/account/projects" && method === "POST") {
    const payload = await c.res.clone().json().catch(() => undefined) as { id?: unknown } | undefined;
    if (typeof payload?.id === "string") projectId = payload.id;
  }
  if (!projectId) return;
  let decoded: string;
  try { decoded = decodeURIComponent(projectId); } catch { return; }
  const project = (await getSession(0)).sdkProjects!.find((item) => item.id === decoded && item.organizationId && !item.revokedAt);
  if (project) await companyAudit(project.id, `${method} ${pathname}`, requestId, c.res.status);
}
async function notifyWebhooks(userId: number, hooks: Array<{ id: string; url: string; secretCiphertext: string; disabledAt?: number }>, type: string, data: unknown): Promise<void> { await Promise.all(hooks.filter((hook) => !hook.disabledAt).map((hook) => enqueueSdkWebhook(userId, hook, type, data))); }

function userIdFor(externalId: string, projectId: string): number {
  // Session IDs are internal only; deterministic separation keeps SDK users isolated.
  return Number.parseInt(createHash("sha256").update(`sdk:${projectId}:${externalId}`).digest("hex").slice(0, 12), 16);
}

type SdkPrincipal = { projectId: string; scopes: string[]; root: boolean; organizationId?: string };
function requiredScope(path: string, method: string): string {
  const parts = path.split("/");
  let resource = parts[2] || "unknown";
  if (resource === "account" && parts[3] === "calls") resource = "calls";
  if (resource === "account" && parts[3] === "voice-options") resource = "voice";
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
  return project ? { projectId: project.id, scopes: project.scopes, root: false, ...(project.organizationId ? { organizationId: project.organizationId } : {}) } : undefined;
}

type SdkOwner = { externalId: string; userId: number; projectId: string; organizationId?: string };
function sdkUserFromRequest(c: any): SdkOwner | undefined {
  // Cookie-authenticated dashboard requests must use the authenticated Better
  // Auth subject. Never let a browser-supplied tenant header select another
  // web user's session.
  const webAuthUserId = c.get("webAuthUserId") as string | undefined;
  const externalId = (webAuthUserId ?? c.req.header("X-Chusky-User-Id") ?? "").trim();
  if (!externalId || externalId.length > 200) return undefined;
  const principal = c.get("sdkPrincipal") as SdkPrincipal | undefined;
  return principal ? { externalId, userId: userIdFor(externalId, principal.projectId), projectId: principal.projectId, ...(principal.organizationId ? { organizationId: principal.organizationId } : {}) } : undefined;
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

const COMPANY_PROJECT_DEFAULT_SCOPES = [
  "threads:read", "threads:write", "agents:read", "agents:write",
  "tasks:read", "tasks:write", "approvals:read",
  "webhooks:read", "webhooks:write", "audit-events:read", "usage:read", "company:read",
  "apps:read", "apps:write", "triggers:read", "triggers:write",
  "calls:read", "calls:write", "voice:read", "voice:write", "meetings:read", "meetings:write",
  "channels:read", "channels:write", "devices:read", "devices:write", "reminders:read", "reminders:write",
  "jobs:read", "jobs:write", "memory:read", "memory:write", "scratchpad:read", "scratchpad:write",
  "mcp:read", "mcp:write",
];

function safeProjectPolicy(project: SdkProjectRecord): CompanyPolicy | undefined {
  return project.companyPolicy ? structuredClone(project.companyPolicy) : undefined;
}

function companyAgentView(agent: CompanyAgentProfile) {
  return { ...agent, createdAt: new Date(agent.createdAt).toISOString(), updatedAt: new Date(agent.updatedAt).toISOString() };
}

function projectAgentIdempotency(project: SdkProjectRecord, key: string, fingerprint: string): { replay?: unknown; mismatch?: boolean } {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const entries = Object.entries(project.agentIdempotency ?? {}).filter(([, entry]) => entry.createdAt >= cutoff)
    .sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 200);
  project.agentIdempotency = Object.fromEntries(entries);
  const existing = project.agentIdempotency[key];
  if (!existing) return {};
  return existing.fingerprint === fingerprint ? { replay: existing.response } : { mismatch: true };
}

function saveProjectAgentIdempotency(project: SdkProjectRecord, key: string, fingerprint: string, response: unknown): void {
  project.agentIdempotency ??= {};
  project.agentIdempotency[key] = { fingerprint, response, createdAt: Date.now() };
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const entries = Object.entries(project.agentIdempotency).filter(([, entry]) => entry.createdAt >= cutoff)
    .sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 200);
  project.agentIdempotency = Object.fromEntries(entries);
}

function companyPolicyView(policy: CompanyPolicy | undefined) {
  return policy ?? { tools: {}, budget: {} };
}

function companyBrandingView(record: CompanyBranding | undefined, organizationId: string) {
  return record ? {
    organizationId: record.organizationId,
    displayName: record.displayName,
    logoUrl: record.logoUrl,
    accentColor: record.accentColor,
    backgroundColor: record.backgroundColor,
    customDomain: record.customDomain,
    customDomainStatus: record.customDomainStatus,
    updatedAt: new Date(record.updatedAt).toISOString(),
  } : {
    organizationId,
    displayName: "Chusky",
    logoUrl: undefined,
    accentColor: "#111111",
    backgroundColor: "#f7f7f4",
    customDomain: undefined,
    customDomainStatus: "not_configured" as const,
    updatedAt: undefined,
  };
}

function companyBrandingInput(value: unknown): Pick<CompanyBranding, "displayName" | "logoUrl" | "accentColor" | "backgroundColor" | "customDomain"> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const logoUrl = typeof body.logoUrl === "string" ? body.logoUrl.trim() : undefined;
  const accentColor = typeof body.accentColor === "string" ? body.accentColor.trim() : "";
  const backgroundColor = typeof body.backgroundColor === "string" ? body.backgroundColor.trim() : "";
  const customDomain = typeof body.customDomain === "string" ? body.customDomain.trim().toLowerCase() || undefined : undefined;
  if (!displayName || displayName.length > 120 || !accentColor || !backgroundColor) return undefined;
  return { displayName, ...(logoUrl ? { logoUrl } : {}), accentColor, backgroundColor, ...(customDomain ? { customDomain } : {}) };
}

function accountProjectView(project: SdkProjectRecord) {
  return {
    id: project.id,
    name: project.name,
    keyPrefix: project.keyPrefix,
    scopes: project.scopes,
    ...(project.organizationId ? { organizationId: project.organizationId } : {}),
    createdAt: new Date(project.createdAt).toISOString(),
    rotatedAt: project.rotatedAt ? new Date(project.rotatedAt).toISOString() : undefined,
    revokedAt: project.revokedAt ? new Date(project.revokedAt).toISOString() : undefined,
  };
}

function webProjectOwner(c: any): { id: string; verified: boolean } | undefined {
  const id = c.get("webAuthUserId") as string | undefined;
  return id ? { id, verified: c.get("webAuthEmailVerified") === true } : undefined;
}

async function organizationAccessForRequest(c: any, organizationId: string): Promise<OrganizationAccess> {
  const owner = webProjectOwner(c);
  if (!owner?.verified || !organizationId || organizationId.length > 200) return undefined;
  try { return await organizationAccessResolver(c.req.raw.headers, organizationId, owner.id); }
  catch { return undefined; }
}

async function accountCanAccessProject(c: any, project: SdkProjectRecord, manage: boolean): Promise<boolean> {
  const owner = webProjectOwner(c);
  if (!owner?.verified) return false;
  if (project.organizationId) {
    const access = await organizationAccessForRequest(c, project.organizationId);
    if (!access) return false;
    return !manage || access.role === "owner" || access.role === "admin";
  }
  return project.ownerWebAuthUserId === owner.id;
}

async function linkedWebCallOwner(c: any): Promise<{ userId: number } | undefined> {
  const web = webProjectOwner(c);
  if (!web?.verified) return undefined;
  const userId = await getTelegramUserIdForWebAuth(web.id);
  return userId ? { userId } : undefined;
}

async function callOwner(c: any): Promise<{ userId: number } | undefined> {
  const linked = await linkedWebCallOwner(c);
  if (linked) return linked;
  // Preserve the dashboard's existing Telegram-link requirement while allowing
  // server-side SDK callers to use their explicit project/end-user identity.
  return c.get("webAuthUserId") ? undefined : sdkUser(c);
}

function phoneCallingProvider(): "bland" | "twilio" | undefined {
  if (config.blandVoiceEnabled) return isBlandVoiceConfigured() ? "bland" : undefined;
  return isTwilioVoiceConfigured() ? "twilio" : undefined;
}

function callView(call: { id: string; provider?: string; direction?: string; phoneNumber: string; purpose: string; status: string; error?: string; summary?: string; createdAt: number; updatedAt: number }) {
  const digits = call.phoneNumber.replace(/\D/g, "");
  const phoneNumber = digits.length > 4 ? `${call.phoneNumber.slice(0, Math.max(2, call.phoneNumber.length - 4)).replace(/\d/g, "•")}${digits.slice(-4)}` : "••••";
  return { id: call.id, provider: call.provider ?? "twilio", direction: call.direction ?? "outbound", phoneNumber, purpose: call.purpose, status: call.status, summary: call.summary, error: call.error ? "The call could not be completed. Check voice diagnostics and try again." : undefined, createdAt: new Date(call.createdAt).toISOString(), updatedAt: new Date(call.updatedAt).toISOString() };
}
function approvalView(approval: { id: string; status: string; toolSlug: string; args: Record<string, unknown>; request?: string; channelProvider?: string; handoffId?: string; createdAt: number; expiresAt: number }) {
  return { id: approval.id, status: approval.status, toolSlug: approval.toolSlug, args: approval.args, request: approval.request, channelProvider: approval.channelProvider, handoffId: approval.handoffId, createdAt: new Date(approval.createdAt).toISOString(), expiresAt: new Date(approval.expiresAt).toISOString() };
}

function threadView(thread: SdkThreadRecord) { return { id: thread.id, externalId: thread.externalId, metadata: thread.metadata, createdAt: new Date(thread.createdAt).toISOString(), updatedAt: new Date(thread.updatedAt).toISOString() }; }
function runView(threadId: string, run: SdkRunRecord) {
  const { agentInstructions: _privateInstructions, companyProjectId: _privateCompanyProjectId, ...visible } = run;
  return { ...visible, threadId, createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString() };
}
function companyRunRecord(run: SdkRunRecord): CompanyRunSummary {
  return {
    id: run.id, status: run.status,
    ...(run.agentId ? { agentId: run.agentId } : {}),
    ...(run.agentName ? { agentName: run.agentName } : {}),
    ...(typeof run.cost === "number" ? { cost: run.cost } : {}),
    ...(run.error?.code ? { errorCode: run.error.code } : {}),
    createdAt: run.createdAt, updatedAt: run.updatedAt,
  };
}

/** Projects only a minimal, content-free run summary into company telemetry. */
export async function persistSdkCompanyRun(run: SdkRunRecord): Promise<void> {
  if (!run.companyProjectId) return;
  const summary = companyRunRecord(run);
  if (run.status === "completed") await completeCompanyRunSummary(run.companyProjectId, summary, run.updatedAt);
  else await saveCompanyRunSummary(run.companyProjectId, summary);
}

function projectLimit(c: any): number {
  const value = Number(c.req.query("limit") ?? 50);
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(100, value)) : 50;
}

async function companyUsageView(projectId: string) {
  const [periods, runs] = await Promise.all([listCompanyUsagePeriods(projectId, 13), listCompanyRunSummaries(projectId, 100)]);
  return { currentMonth: periods[0] ?? { month: new Date().toISOString().slice(0, 7), completedRuns: 0, costUsd: 0 }, periods, runs: { indexed: runs.length, active: runs.filter((run) => run.status === "queued" || run.status === "running").length } };
}

function companyRunViews(data: CompanyRunSummary[]) {
  return data.map((run) => ({ ...run, createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString() }));
}

function companyAuditViews(data: Awaited<ReturnType<typeof listCompanyAuditEvents>>, after = 0) {
  return data.filter((event) => event.at > after).map((event) => ({ ...event, at: new Date(event.at).toISOString() }));
}

function artifactView(artifact: NonNullable<Awaited<ReturnType<typeof getSession>>["artifacts"]>[number]) { return { ...artifact, createdAt: new Date(artifact.createdAt).toISOString(), updatedAt: new Date(artifact.updatedAt).toISOString() }; }
function videoView(job: Awaited<ReturnType<typeof getVideoJob>>) { return job ? { ...job, createdAt: new Date(job.createdAt).toISOString(), updatedAt: new Date(job.updatedAt).toISOString(), ...(job.completedAt ? { completedAt: new Date(job.completedAt).toISOString() } : {}) } : undefined; }
function workerView(record: Awaited<ReturnType<typeof getHandoffRecord>>) { return record ? { id: record.id, worker: record.to, from: record.from, objective: record.objective, expectedOutput: record.expectedOutput, status: record.status, taskId: record.taskId, workflowRunId: record.workflowRunId, context: record.context, delegation: record.delegation, timestamp: new Date(record.timestamp).toISOString() } : undefined; }
type RunBody = { input?: string; attachments?: string[]; model?: string; agentId?: string; metadata?: Record<string, unknown>; budget?: { duration?: string; maxToolCalls?: number; maxCost?: number }; tools?: CompanyToolPolicy; skills?: string[]; wait?: boolean };

function principalFromContext(c: any): SdkPrincipal {
  return (c.get as (key: string) => unknown)("sdkPrincipal") as SdkPrincipal;
}

async function requestCompanyProject(c: any): Promise<SdkProjectRecord | undefined> {
  const principal = principalFromContext(c);
  if (principal.root || !principal.organizationId) return undefined;
  return (await getSession(0)).sdkProjects!.find((item) => item.id === principal.projectId && item.organizationId === principal.organizationId && !item.revokedAt);
}

async function sdkAgentOptions(body: RunBody, runId?: string, parentRunId?: string, profileInstructions?: string): Promise<{ toolAllow?: string[]; toolDeny?: string[]; toolRequireApproval?: string[]; maxToolCalls?: number; maxCost?: number; instructions?: string; runId?: string; parentRunId?: string }> {
  const allow = Array.isArray(body.tools?.allow) ? body.tools!.allow!.filter((item): item is string => typeof item === "string").slice(0, 100) : undefined;
  const deny = Array.isArray(body.tools?.deny) ? body.tools!.deny!.filter((item): item is string => typeof item === "string").slice(0, 100) : undefined;
  const requireApproval = Array.isArray(body.tools?.requireApproval) ? body.tools!.requireApproval!.filter((item): item is string => typeof item === "string").slice(0, 100) : undefined;
  const skills = Array.isArray(body.skills) ? [...new Set(body.skills.filter((item): item is string => typeof item === "string"))].slice(0, 10) : [];
  const limits = { ...(body.budget?.maxToolCalls !== undefined ? { maxToolCalls: body.budget.maxToolCalls } : {}), ...(body.budget?.maxCost !== undefined ? { maxCost: body.budget.maxCost } : {}) };
  if (!skills.length && !profileInstructions) return { ...(allow ? { toolAllow: allow } : {}), ...(deny ? { toolDeny: deny } : {}), ...(requireApproval ? { toolRequireApproval: requireApproval } : {}), ...limits, ...(runId ? { runId } : {}), ...(parentRunId ? { parentRunId } : {}) };
  const blocks: string[] = profileInstructions ? [`Company agent profile instructions:\n${profileInstructions.slice(0, 6000)}`] : [];
  for (const skill of skills) { try { const file = await readSkillFile(skill, "SKILL.md", 12000); if (file.content) blocks.push(`Trusted skill guidance (${skill}):\n${file.content}`); } catch { /* unknown skills are ignored; the run remains usable */ } }
  return { ...(allow ? { toolAllow: allow } : {}), ...(deny ? { toolDeny: deny } : {}), ...(requireApproval ? { toolRequireApproval: requireApproval } : {}), ...limits, ...(blocks.length ? { instructions: blocks.join("\n\n").slice(0, 24000) } : {}), ...(runId ? { runId } : {}), ...(parentRunId ? { parentRunId } : {}) };
}
function validateRunPolicy(body: RunBody): string | undefined {
  const durations = new Set(["5m", "30m", "1h", "3h", "6h", "3d", "1w"]);
  const toolSlug = /^[A-Za-z][A-Za-z0-9_]{0,119}$/;
  if (body.budget?.duration !== undefined && !durations.has(body.budget.duration)) return "budget.duration must be one of 5m, 30m, 1h, 3h, 6h, 3d, or 1w";
  if (body.budget?.maxToolCalls !== undefined && (!Number.isInteger(body.budget.maxToolCalls) || body.budget.maxToolCalls < 1 || body.budget.maxToolCalls > 100)) return "budget.maxToolCalls must be between 1 and 100";
  if (body.budget?.maxCost !== undefined && (!Number.isFinite(body.budget.maxCost) || body.budget.maxCost < 0)) return "budget.maxCost must be a non-negative number";
  if (body.tools !== undefined && (!body.tools || typeof body.tools !== "object" || Array.isArray(body.tools))) return "tools must be an object containing valid tool-slug arrays";
  for (const field of ["allow", "deny", "requireApproval"] as const) {
    const list = body.tools?.[field];
    if (list !== undefined && (!Array.isArray(list) || list.length > 100 || !list.every((item) => typeof item === "string" && toolSlug.test(item)))) return `tools.${field} must contain at most 100 valid tool slugs`;
  }
  if (body.agentId !== undefined && (typeof body.agentId !== "string" || !/^(?:agt_[A-Za-z0-9_-]{1,100}|[a-z][a-z0-9-]{1,80})$/.test(body.agentId))) return "agentId must be a valid profile ID or template slug";
  return undefined;
}

async function applyCompanyRunPolicy(c: any, body: RunBody): Promise<{ agent?: CompanyAgentProfile; error?: string }> {
  const principal = principalFromContext(c);
  const control = await getSession(0);
  const project = control.sdkProjects!.find((item) => item.id === principal.projectId && !item.revokedAt);
  let agent: CompanyAgentProfile | undefined;
  if (body.agentId) {
    agent = project?.companyAgents?.find((item) => item.id === body.agentId);
    if (!agent) {
      const template = getCompanyTemplate(body.agentId);
      if (template) agent = createCompanyAgentProfile({ template: template.slug }, template.slug);
    }
    if (!agent) return { error: "The selected agent profile or template is unavailable to this API project." };
  }
  if (!project?.organizationId && !project?.companyPolicy && !agent) return {};
  const requestedAllow = body.tools?.allow;
  const effective = effectiveCompanyRunPolicy(project?.companyPolicy, agent, body);
  const agentGrant = agent?.tools.allow;
  const projectGrant = project?.companyPolicy?.tools?.allow;
  const grant = agentGrant && projectGrant
    ? agentGrant.filter((slug) => projectGrant.includes(slug))
    : agentGrant ?? projectGrant;
  if (requestedAllow && grant && requestedAllow.some((slug) => !grant.includes(slug))) {
    return { error: "This run requested a tool outside the project's or agent profile's allowed tool grant." };
  }
  body.tools = effective.tools;
  body.budget = effective.budget;
  return { agent };
}

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
  // Public and intentionally minimal: this is the safe branding payload used
  // by a customer-owned domain before a dashboard session exists.
  app.get("/public/company-branding", async (c) => {
    const requestedHost = (c.req.query("hostname") ?? c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").split(",")[0].trim().split(":")[0];
    if (!requestedHost) return c.json({ data: null });
    try {
      const branding = await findCompanyBrandingByDomain(requestedHost);
      return c.json({ data: branding ? companyBrandingView(branding, branding.organizationId) : null });
    } catch {
      return c.json({ data: null });
    }
  });

  app.use("/v1/*", cors({ origin: (origin) => origin && config.betterAuthTrustedOrigins.includes(origin) ? origin : "", credentials: true, allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Chusky-User-Id"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));
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
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await audit(owner.userId, `${c.req.method} ${c.req.path}`, requestId, c.res.status);
      if (principal.organizationId) await companyAudit(principal.projectId, `${c.req.method} ${new URL(c.req.url).pathname}`, requestId, c.res.status);
      else if ((c.get as (key: string) => unknown)("webAuthUserId")) await auditDashboardProjectWrite(c, requestId);
    }
  });

  app.get("/v1/ops/health", async (c) => {
    const sendblueConfigured = !config.sendblueEnabled || Boolean(config.sendblueApiKey && config.sendblueApiSecret && config.sendblueNumber && config.sendblueWebhookSecret);
    const twilioConfigured = !config.twilioVoiceEnabled || Boolean(config.twilioAccountSid && config.twilioAuthToken && config.twilioCallerId && config.twilioWebhookBaseUrl && config.twilioMediaStreamUrl && config.twilioMediaBridgeSecret);
    const twilioSmsConfigured = !config.twilioSmsEnabled || Boolean(config.twilioAccountSid && config.twilioAuthToken && (config.twilioPhoneNumber || config.twilioMessagingServiceSid));
    const twilioInboundConfigured = !config.twilioInboundEnabled || Boolean(config.twilioVoiceEnabled && config.twilioInboundOwnerUserId && config.twilioInboundAllowedCallers);
    const xchatConfigured = !config.xchatEnabled || Boolean(config.xchatBotToken && config.xchatConsumerSecret && config.xchatPin);
    const redis = isDurableStore();
    const production = process.env.NODE_ENV === "production";
    const checks = {
      redis: redis ? "ok" : production ? "failed" : "degraded",
      qstash: config.qstashToken ? "configured" : "disabled",
      composioTriggers: config.composioWebhookSecret && (config.composioWebhookUrl || config.webhookUrl) ? "configured" : "disabled",
      sendblue: config.sendblueEnabled ? (sendblueConfigured ? "configured" : "misconfigured") : "disabled",
      twilio: config.twilioVoiceEnabled ? (twilioConfigured ? "configured" : "misconfigured") : "disabled",
      twilioSms: config.twilioSmsEnabled ? (twilioSmsConfigured ? "configured" : "misconfigured") : "disabled",
      twilioInbound: config.twilioInboundEnabled ? (twilioInboundConfigured ? "configured" : "misconfigured") : "disabled",
      xchat: config.xchatEnabled ? (xchatConfigured ? "configured" : "misconfigured") : "disabled",
      telegram: "configured",
    } as const;
    const ok = checks.redis === "ok" && Object.values(checks).every((value) => value !== "misconfigured");
    return c.json({ ok, status: ok ? "operational" : "degraded", persistence: redis ? "redis" : "memory", checks, channels: { telegram: true, cli: true, slack: config.slackEnabled, whatsapp: config.whatsappEnabled, sendblue: config.sendblueEnabled, sms: config.twilioSmsEnabled, xchat: config.xchatEnabled }, monitoring: monitoringSnapshot() });
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
      listOutbox(undefined, 100, owner.userId),
    ]);
    return c.json({
      model: session.model,
      voiceReplies: Boolean(session.voiceReplies),
      voicePreferences: session.voicePreferences ?? {},
      approvals: session.approvals.filter((item) => item.status === "pending" && item.expiresAt > Date.now()).map((item) => ({ id: item.id, toolSlug: item.toolSlug, request: item.request, status: item.status, channelProvider: item.channelProvider, createdAt: new Date(item.createdAt).toISOString(), expiresAt: new Date(item.expiresAt).toISOString() })),
      channels: channels.filter((item) => !item.disabledAt).map((item) => ({ id: identityFingerprint(item), provider: item.provider, externalUserId: item.externalUserId, workspaceId: item.workspaceId, displayName: item.displayName, verifiedAt: new Date(item.verifiedAt).toISOString(), proactiveOptIn: item.proactiveOptIn !== false })),
      reminders: reminders.map((item) => ({ ...item, runAt: new Date(item.runAt).toISOString(), createdAt: new Date(item.createdAt).toISOString() })),
      jobs: jobs.map((item) => ({ ...item, createdAt: new Date(item.createdAt).toISOString() })),
      memory: session.memories.map((item) => ({
        id: item.id,
        category: item.category,
        key: item.key,
        value: item.value,
        confidence: item.confidence,
        source: item.source,
        sensitivity: item.sensitivity,
        projectId: item.projectId,
        personKey: item.personKey,
        reviewAt: item.reviewAt ? new Date(item.reviewAt).toISOString() : undefined,
        expiresAt: item.expiresAt ? new Date(item.expiresAt).toISOString() : undefined,
        createdAt: new Date(item.createdAt).toISOString(),
        updatedAt: new Date(item.updatedAt).toISOString(),
      })),
      scratchpad: Object.entries(session.scratchpad).map(([key, item]) => ({ key, content: item.content, updatedAt: new Date(item.updatedAt).toISOString() })),
      triggers: session.triggerIds,
      devices: devices.filter((item) => !item.revokedAt).map(({ tokenHash, ...item }) => ({ ...item, id: createHash("sha256").update(tokenHash).digest("hex").slice(0, 24), createdAt: new Date(item.createdAt).toISOString(), lastSeenAt: new Date(item.lastSeenAt).toISOString() })),
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

  app.get("/v1/account/organizations/:organizationId/branding", async (c) => {
    const organizationId = c.req.param("organizationId");
    const access = await organizationAccessForRequest(c, organizationId);
    if (!access) return apiError(c, 403, "organization_access_required", "A verified organization membership is required.");
    return c.json({ data: companyBrandingView(await getCompanyBranding(organizationId), organizationId) });
  });

  app.put("/v1/account/organizations/:organizationId/branding", async (c) => {
    const organizationId = c.req.param("organizationId");
    const access = await organizationAccessForRequest(c, organizationId);
    if (!access || !["owner", "admin"].includes(access.role)) return apiError(c, 403, "organization_admin_required", "An organization owner or admin is required.");
    const input = companyBrandingInput(await c.req.json().catch(() => undefined));
    if (!input) return apiError(c, 400, "invalid_branding", "Provide a display name and valid brand colors.");
    if (input.customDomain) {
      const existing = await findCompanyBrandingByDomain(input.customDomain).catch(() => undefined);
      if (existing && existing.organizationId !== organizationId) return apiError(c, 409, "custom_domain_in_use", "That custom domain is already assigned to another workspace.");
    }
    try {
      const record = await saveCompanyBranding({ organizationId, ...input, customDomainStatus: input.customDomain ? "pending_dns" : "not_configured", updatedAt: Date.now() });
      return c.json({ data: companyBrandingView(record, organizationId) });
    } catch {
      return apiError(c, 400, "invalid_branding", "The branding values are invalid. Use HTTPS for logos and hex colors such as #111111.");
    }
  });

  app.get("/v1/account/preferences", async (c) => {
    const session = await getSession(sdkUser(c)!.userId);
    return c.json({ model: session.model, voiceReplies: Boolean(session.voiceReplies), voicePreferences: session.voicePreferences ?? {} });
  });

  app.get("/v1/account/voice-options", async (c) => {
    let blandVoices: Array<{ id: string; name: string; description?: string }> = [];
    let blandCatalogueAvailable = false;
    if (config.blandVoiceEnabled && config.blandApiKey) {
      try { blandVoices = await listBlandCuratedVoices(config.blandApiKey); blandCatalogueAvailable = true; }
      catch { /* Keep Flux options usable when Bland's optional catalogue is unavailable. */ }
    }
    return c.json({ fluxVoices: FLUX_TTS_VOICES, blandVoices, blandAvailable: isBlandVoiceConfigured(), blandCatalogueAvailable });
  });

  app.patch("/v1/account/preferences", async (c) => {
    const owner = sdkUser(c)!;
    const body = await c.req.json().catch(() => ({})) as { model?: unknown; voiceReplies?: unknown; liveVoice?: unknown };
    if (body.model !== undefined && (typeof body.model !== "string" || !/^[a-zA-Z0-9._:/~-]{1,200}$/.test(body.model))) return apiError(c, 400, "invalid_model", "model must be a valid model ID.");
    if (body.voiceReplies !== undefined && typeof body.voiceReplies !== "boolean") return apiError(c, 400, "invalid_voice_setting", "voiceReplies must be a boolean.");
    if (body.liveVoice !== undefined && (!body.liveVoice || typeof body.liveVoice !== "object" || Array.isArray(body.liveVoice))) return apiError(c, 400, "invalid_live_voice", "liveVoice must identify a provider and voice selection.");
    if (body.model === undefined && body.voiceReplies === undefined && body.liveVoice === undefined) return apiError(c, 400, "empty_preferences", "Provide model, voiceReplies, or liveVoice.");
    const currentSession = await getSession(owner.userId);
    if (body.model !== undefined) {
      try { await resolveRunModel(body.model, currentSession.model); }
      catch (error) { return apiError(c, 400, error instanceof Error && error.message === "model_unavailable" ? "model_unavailable" : "invalid_model", error instanceof Error && error.message === "model_unavailable" ? "That model is not available on this Chusky deployment." : "model must be a valid model ID."); }
      await setModel(owner.userId, body.model);
    }
    if (body.voiceReplies !== undefined) await setVoiceReplies(owner.userId, body.voiceReplies);
    if (body.liveVoice !== undefined) {
      const liveVoice = body.liveVoice as Record<string, unknown>;
      const provider = liveVoice.provider;
      if (provider !== "twilio" && provider !== "meetings" && provider !== "bland") return apiError(c, 400, "invalid_live_voice", "provider must be twilio, meetings, or bland.");
      try {
        if (provider === "bland") {
          if (liveVoice.voice === null) await setLiveVoicePreference(owner.userId, provider);
          else if (liveVoice.voice && typeof liveVoice.voice === "object" && !Array.isArray(liveVoice.voice)) {
            const voice = liveVoice.voice as Record<string, unknown>;
            if (typeof voice.id !== "string" || typeof voice.name !== "string") return apiError(c, 400, "invalid_live_voice", "Bland voice must include an available id and name.");
            await setLiveVoicePreference(owner.userId, provider, { id: voice.id, name: voice.name });
          } else return apiError(c, 400, "invalid_live_voice", "Select an available Bland voice or set voice to null to use the service default.");
        } else if (liveVoice.voice === null) await setLiveVoicePreference(owner.userId, provider);
        else if (typeof liveVoice.voice === "string") await setLiveVoicePreference(owner.userId, provider, liveVoice.voice as never);
        else return apiError(c, 400, "invalid_live_voice", "Select an available Flux voice or set voice to null to use the default.");
      } catch (error) { return apiError(c, 400, "invalid_live_voice", error instanceof Error ? error.message : "That voice selection is invalid."); }
    }
    const session = await getSession(owner.userId);
    return c.json({ model: session.model, voiceReplies: Boolean(session.voiceReplies), voicePreferences: session.voicePreferences ?? {} });
  });

  app.get("/v1/meetings/profile", async (c) => c.json(await getMeetingRepresentativeProfile(sdkUser(c)!.userId)));
  app.patch("/v1/meetings/profile", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(c, 400, "invalid_meeting_profile", "Meeting representative profile must be an object.");
    try {
      const userId = sdkUser(c)!.userId;
      const previous = await getMeetingRepresentativeProfile(userId);
      const updated = await updateMeetingRepresentativeProfile(userId, body);
      let autoJoinReconciliation: { cancelled: number; stillInCall: number; failures: number } | undefined;
      if (previous.autoJoinCalendar && !updated.autoJoinCalendar) {
        try { autoJoinReconciliation = await cancelAutomaticCalendarMeetingJoins(userId); }
        catch { autoJoinReconciliation = { cancelled: 0, stillInCall: 0, failures: 1 }; }
      }
      return c.json({ ...updated, ...(autoJoinReconciliation ? { autoJoinReconciliation } : {}) });
    }
    catch (error) { return apiError(c, 400, "invalid_meeting_profile", error instanceof Error ? error.message : "Meeting representative profile is invalid."); }
  });

  app.get("/v1/meetings", async (c) => {
    const owner = sdkUser(c)!;
    const [preparations, records, contacts] = await Promise.all([
      listCalendarMeetingPreparations(owner.userId, 20), listRecallMeetings(owner.userId, 20), listMeetingContacts(owner.userId, 50),
    ]);
    const prepared = await Promise.all(preparations.map(async (item) => {
      const trigger = await getTriggerEvent(item.sourceTriggerEventId);
      return {
        ...item,
        brief: trigger?.userId === owner.userId && trigger.status === "completed" ? trigger.result?.slice(0, 12_000) : undefined,
        briefStatus: trigger?.userId === owner.userId ? trigger.status : undefined,
        createdAt: new Date(item.createdAt).toISOString(), updatedAt: new Date(item.updatedAt).toISOString(),
      };
    }));
    const meetings = records.map((meeting) => ({
      id: meeting.id, platform: meeting.platform, interactionMode: meeting.interactionMode ?? "addressed", status: meeting.status,
      title: meeting.title, joinAt: meeting.joinAt, error: meeting.error ? "The meeting assistant could not complete this step. Check the meeting link and provider status." : undefined,
      providerStatusAt: meeting.providerStatusAt ? new Date(meeting.providerStatusAt).toISOString() : undefined,
      participantRoster: (meeting.participantRoster ?? []).map((person) => ({ ...person, updatedAt: new Date(person.updatedAt).toISOString() })),
      speakerEvents: (meeting.speakerEvents ?? []).map((entry) => ({ ...entry, at: new Date(entry.at).toISOString() })),
      history: meeting.history.filter((message) => (message.role === "user" || message.role === "assistant") && typeof message.content === "string").slice(-20).map((message) => ({ role: message.role, content: String(message.content).slice(0, 3_000), createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : undefined })),
      outcome: meeting.outcome, outcomeFollowThrough: meeting.outcomeFollowThrough, outcomeStatus: meeting.outcomeStatus,
      outcomeNotificationStatus: meeting.outcomeNotificationStatus, createdAt: new Date(meeting.createdAt).toISOString(), updatedAt: new Date(meeting.updatedAt).toISOString(),
    }));
    return c.json({ preparations: prepared, meetings, contacts: contacts.map((contact) => ({ ...contact, userId: undefined, followUpAt: contact.followUpAt ? new Date(contact.followUpAt).toISOString() : undefined, createdAt: new Date(contact.createdAt).toISOString(), updatedAt: new Date(contact.updatedAt).toISOString() })) });
  });

  app.delete("/v1/meetings/contacts/:contactId", async (c) => {
    const removed = await deleteMeetingContact(sdkUser(c)!.userId, c.req.param("contactId"));
    return removed ? c.body(null, 204) : apiError(c, 404, "meeting_contact_not_found", "Meeting follow-up contact not found.");
  });

  app.get("/v1/apps", async (c) => {
    try { return c.json({ data: await getToolkitStates(sdkUser(c)!.userId) }); }
    catch (error) { return apiError(c, 502, "apps_unavailable", error instanceof Error ? error.message : "Connected apps are temporarily unavailable."); }
  });

  app.post("/v1/apps/:toolkit/connect", async (c) => {
    const toolkit = c.req.param("toolkit").trim();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(toolkit)) return apiError(c, 400, "invalid_toolkit", "Invalid toolkit name.");
    const body = await c.req.json().catch(() => ({})) as { alias?: unknown };
    if (body.alias !== undefined && (typeof body.alias !== "string" || !body.alias.trim() || body.alias.trim().length > 160)) return apiError(c, 400, "invalid_connection_alias", "alias must be a non-empty name of 160 characters or fewer.");
    try { return c.json({ toolkit, alias: typeof body.alias === "string" ? body.alias.trim() : undefined, url: await getConnectionUrl(sdkUser(c)!.userId, toolkit, typeof body.alias === "string" ? body.alias.trim() : undefined) }); }
    catch (error) { return apiError(c, 502, "connection_unavailable", error instanceof Error ? error.message : "Could not create an app connection link."); }
  });

  app.get("/v1/apps/connections", async (c) => {
    try { return c.json({ data: await listConnectedAccounts(sdkUser(c)!.userId) }); }
    catch (error) { return apiError(c, 502, "connections_unavailable", error instanceof Error ? error.message : "Connected accounts are temporarily unavailable."); }
  });

  app.delete("/v1/apps/connections/:connectionId", async (c) => {
    const id = c.req.param("connectionId").trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return apiError(c, 400, "invalid_connection_id", "Invalid connected account ID.");
    try {
      if (!(await disconnectConnectedAccount(sdkUser(c)!.userId, id))) return apiError(c, 404, "connection_not_found", "Connected account not found for this Chusky account.");
      return c.body(null, 204);
    } catch (error) { return apiError(c, 502, "connection_disconnect_failed", error instanceof Error ? error.message : "Could not disconnect this account."); }
  });

  app.get("/v1/mcp/catalog", async (c) => {
    const catalog = listMcpCatalog();
    return c.json({ data: catalog.servers, ...(catalog.errors.length ? { errors: catalog.errors } : {}) });
  });

  app.get("/v1/mcp/connections", async (c) => {
    try { return c.json({ data: await listMcpConnections(sdkUser(c)!.userId) }); }
    catch (error) { return apiError(c, 502, "mcp_connections_unavailable", error instanceof Error ? error.message : "MCP connections are temporarily unavailable."); }
  });

  app.post("/v1/mcp/connections", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const serverId = typeof body.serverId === "string" ? body.serverId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(serverId)) return apiError(c, 400, "invalid_mcp_server", "serverId must contain 1-48 letters, numbers, underscores, or hyphens.");
    const accessToken = typeof body.accessToken === "string" ? body.accessToken : undefined;
    const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : undefined;
    const expiresAt = typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt) ? body.expiresAt : undefined;
    try {
      const connection = await connectMcpServer(sdkUser(c)!.userId, serverId, accessToken ? { accessToken, ...(refreshToken ? { refreshToken } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) } : undefined);
      return c.json(connection, 201);
    } catch (error) { return apiError(c, 400, "mcp_connect_failed", error instanceof Error ? error.message : "MCP server could not be connected."); }
  });

  app.delete("/v1/mcp/connections/:serverId", async (c) => {
    const serverId = c.req.param("serverId").trim();
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(serverId)) return apiError(c, 400, "invalid_mcp_server", "Invalid MCP server ID.");
    try {
      if (!(await disconnectMcpServer(sdkUser(c)!.userId, serverId))) return apiError(c, 404, "mcp_connection_not_found", "MCP connection not found for this Chusky account.");
      return c.body(null, 204);
    } catch (error) { return apiError(c, 502, "mcp_disconnect_failed", error instanceof Error ? error.message : "MCP connection could not be removed."); }
  });

  app.get("/v1/triggers", async (c) => {
    try {
      const items = await listTriggers(sdkUser(c)!.userId);
      return c.json({ data: items.map((item: any) => ({ id: String(item.id ?? item.trigger_id ?? item.triggerId ?? ""), slug: String(item.trigger_slug ?? item.slug ?? ""), status: String(item.status ?? (item.enabled === false ? "disabled" : "active")), config: item.config ?? item.triggerConfig ?? {} })).filter((item) => item.id) });
    } catch (error) { return apiError(c, 502, "triggers_unavailable", error instanceof Error ? error.message : "Triggers are temporarily unavailable."); }
  });

  // These read-only catalogue routes power the dashboard's future trigger
  // picker and deliberately share the same Composio-backed source as Telegram.
  app.get("/v1/triggers/catalog/toolkits", async (c) => {
    const connectedOnly = c.req.query("connectedOnly") !== "false";
    try { return c.json({ data: await listAvailableTriggerToolkits(sdkUser(c)!.userId, connectedOnly) }); }
    catch (error) { return apiError(c, 502, "trigger_catalog_unavailable", error instanceof Error ? error.message : "Trigger catalogue is temporarily unavailable."); }
  });

  app.get("/v1/triggers/catalog/toolkits/:toolkit", async (c) => {
    const toolkit = c.req.param("toolkit").trim();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(toolkit)) return apiError(c, 400, "invalid_toolkit", "Invalid toolkit name.");
    const requestedPage = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
    const pageSize = Math.min(50, Math.max(1, Number(c.req.query("pageSize") ?? "8") || 8));
    try {
      const types = await listAvailableTriggerTypes(toolkit);
      const totalPages = Math.max(1, Math.ceil(types.length / pageSize));
      const page = Math.min(requestedPage, totalPages);
      return c.json({ data: types.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: types.length, totalPages });
    } catch (error) { return apiError(c, 502, "trigger_catalog_unavailable", error instanceof Error ? error.message : "Trigger catalogue is temporarily unavailable."); }
  });

  app.post("/v1/triggers", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { slug?: unknown; connectedAccountId?: unknown; triggerConfig?: unknown };
    const slug = String(body.slug ?? "").trim();
    if (!/^[A-Z0-9][A-Z0-9_.-]{1,150}$/.test(slug)) return apiError(c, 400, "invalid_trigger", "Provide a valid trigger slug.");
    if (body.connectedAccountId !== undefined && (typeof body.connectedAccountId !== "string" || body.connectedAccountId.length < 1 || body.connectedAccountId.length > 200)) return apiError(c, 400, "invalid_connected_account", "connectedAccountId must be a valid connected account ID.");
    if (body.triggerConfig !== undefined && (typeof body.triggerConfig !== "object" || body.triggerConfig === null || Array.isArray(body.triggerConfig))) return apiError(c, 400, "invalid_trigger_config", "triggerConfig must be an object.");
    try { return c.json(await createTrigger(sdkUser(c)!.userId, slug, { ...(body.connectedAccountId ? { connectedAccountId: body.connectedAccountId } : {}), triggerConfig: body.triggerConfig ?? {} }), 201); }
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
    const owner = await callOwner(c);
    if (!owner) return apiError(c, 403, "workspace_link_required", "Verify your email and link your Telegram workspace before using calls.");
    const provider = phoneCallingProvider();
    return c.json({ available: Boolean(provider), provider: provider ?? null, data: (await listPhoneCalls(owner.userId)).map(callView) });
  });

  app.post("/v1/account/calls", async (c) => {
    // Dashboard users resolve to their linked Telegram owner; SDK callers use
    // the project/end-user session established by the v1 middleware.
    const owner = await callOwner(c);
    if (!owner) return apiError(c, 403, "workspace_link_required", "Verify your email and link your Telegram workspace before using calls.");
    if (!phoneCallingProvider()) return apiError(c, 503, "phone_calling_unavailable", "The selected phone provider is not configured on this Chusky deployment.");
    const body = await c.req.json().catch(() => ({})) as { phoneNumber?: unknown; purpose?: unknown; profile?: unknown };
    if (body.profile !== undefined && (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile))) return apiError(c, 400, "invalid_call_profile", "profile must be an object.");
    const session = await getSession(owner.userId);
    const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify(body)}`).digest("hex");
    const prior = idempotency(c, session, fingerprint);
    if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request.");
    if (prior.replay) return c.json(prior.replay, 201);
    if (!(await checkRateLimit(owner.userId))) return apiError(c, 429, "rate_limit_exceeded", "Too many requests. Try again shortly.");
    try {
      const phoneNumber = String(body.phoneNumber ?? "").trim();
      const purpose = String(body.purpose ?? "").trim();
      const approval = await requestPhoneCallApproval(owner.userId, { phoneNumber, purpose, ...(body.profile ? { profile: body.profile as VoiceCallProfileInput } : {}) }, `/call ${phoneNumber} ${purpose}`);
      const response = { id: approval.id, toolSlug: approval.toolSlug, args: approval.args, status: approval.status, expiresAt: new Date(approval.expiresAt).toISOString() };
      if (prior.key) {
        session.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() };
        await saveSession(owner.userId, session);
      }
      return c.json(response, 201);
    } catch (error) {
      return apiError(c, 400, "invalid_phone_call", error instanceof Error ? error.message : "Invalid call request.");
    }
  });

  app.post("/v1/meetings/prepare", async (c) => {
    const owner = sdkUser(c)!;
    const body = await c.req.json().catch(() => ({})) as { clientName?: unknown; objective?: unknown; clientContext?: unknown };
    try {
      return c.json(await prepareRecallMeetingMission(owner.userId, {
        clientName: body.clientName,
        ...(body.objective !== undefined ? { objective: body.objective } : {}),
        ...(body.clientContext !== undefined ? { clientContext: body.clientContext } : {}),
      }));
    } catch (error) {
      return apiError(c, 400, "invalid_meeting_brief", error instanceof Error ? error.message : "Could not prepare the meeting brief.");
    }
  });

  app.post("/v1/meetings", async (c) => {
    const owner = sdkUser(c)!;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const session = await getSession(owner.userId);
    const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify(body)}`).digest("hex");
    const prior = idempotency(c, session, fingerprint);
    if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request.");
    if (prior.replay) return c.json(prior.replay, 201);
    try {
      const result = await joinRecallMeeting(owner.userId, body as { meetingUrl: unknown; title?: unknown; joinAt?: unknown; interactionMode?: unknown; analyzeScreenShare?: unknown; transcriptRetentionDays?: unknown; clientName?: unknown; objective?: unknown; clientContext?: unknown; inheritMeetingId?: string; calendarPreparationId?: string });
      if (prior.key) {
        session.sdkIdempotency![prior.key] = { fingerprint, response: result, createdAt: Date.now() };
        await saveSession(owner.userId, session);
      }
      return c.json(result, 201);
    } catch (error) {
      return apiError(c, 400, "meeting_join_failed", error instanceof Error ? error.message : "Could not join the meeting.");
    }
  });

  app.post("/v1/meetings/preparations/:preparationId/join", async (c) => {
    const owner = sdkUser(c)!;
    const session = await getSession(owner.userId);
    const fingerprint = createHash("sha256").update(`POST:${c.req.path}:{}`).digest("hex");
    const prior = idempotency(c, session, fingerprint);
    if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request.");
    if (prior.replay) return c.json(prior.replay, 201);
    try {
      const result = await joinPreparedCalendarMeeting(owner.userId, c.req.param("preparationId"));
      if (prior.key) {
        session.sdkIdempotency![prior.key] = { fingerprint, response: result, createdAt: Date.now() };
        await saveSession(owner.userId, session);
      }
      return c.json(result, 201);
    } catch (error) {
      return apiError(c, 400, "meeting_join_failed", error instanceof Error ? error.message : "Could not join the prepared calendar meeting.");
    }
  });

  app.get("/v1/meetings/:meetingId", async (c) => {
    const meeting = await getRecallMeetingForUser(sdkUser(c)!.userId, c.req.param("meetingId"));
    return meeting ? c.json(meeting) : apiError(c, 404, "meeting_not_found", "Meeting not found.");
  });

  app.post("/v1/meetings/:meetingId/leave", async (c) => {
    const owner = sdkUser(c)!;
    const session = await getSession(owner.userId);
    const fingerprint = createHash("sha256").update(`POST:${c.req.path}:{}`).digest("hex");
    const prior = idempotency(c, session, fingerprint);
    if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request.");
    if (prior.replay) return c.json(prior.replay);
    try {
      const result = await leaveRecallMeeting(owner.userId, c.req.param("meetingId"));
      if (prior.key) {
        session.sdkIdempotency![prior.key] = { fingerprint, response: result, createdAt: Date.now() };
        await saveSession(owner.userId, session);
      }
      return c.json(result);
    } catch (error) {
      return apiError(c, 400, "meeting_leave_failed", error instanceof Error ? error.message : "Could not leave the meeting.");
    }
  });

  app.get("/v1/meetings/:meetingId/context", async (c) => {
    try {
      return c.json(await lookupRecallMeetingContext(sdkUser(c)!.userId, c.req.param("meetingId"), c.req.query("query") ?? ""));
    } catch (error) {
      return apiError(c, 404, "meeting_context_unavailable", error instanceof Error ? error.message : "Meeting context is unavailable.");
    }
  });

  app.get("/v1/account/projects", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before creating or managing API keys.");
    const control = await getSession(0);
    const organizationId = c.req.query("organizationId");
    if (organizationId) {
      if (!(await organizationAccessForRequest(c, organizationId))) return apiError(c, 404, "not_found", "Workspace not found.");
      return c.json({ data: control.sdkProjects!.filter((project) => project.organizationId === organizationId && !project.revokedAt).map(accountProjectView) });
    }
    return c.json({ data: control.sdkProjects!.filter((project) => project.ownerWebAuthUserId === owner.id && !project.organizationId).map(accountProjectView) });
  });

  app.get("/v1/account/projects/:projectId/company/runs", async (c) => {
    const project = (await getSession(0)).sdkProjects!.find((item) => item.id === c.req.param("projectId") && item.organizationId && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, true))) return apiError(c, 404, "not_found", "Company project not found.");
    return c.json({ data: companyRunViews(await listCompanyRunSummaries(project.id, projectLimit(c))) });
  });

  app.get("/v1/account/projects/:projectId/company/audit-events", async (c) => {
    const project = (await getSession(0)).sdkProjects!.find((item) => item.id === c.req.param("projectId") && item.organizationId && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, true))) return apiError(c, 404, "not_found", "Company project not found.");
    const after = Number(c.req.query("after") ?? 0);
    return c.json({ data: companyAuditViews(await listCompanyAuditEvents(project.id, 100), Number.isFinite(after) && after > 0 ? after : 0) });
  });

  app.get("/v1/account/projects/:projectId/company/usage", async (c) => {
    const project = (await getSession(0)).sdkProjects!.find((item) => item.id === c.req.param("projectId") && item.organizationId && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, true))) return apiError(c, 404, "not_found", "Company project not found.");
    return c.json(await companyUsageView(project.id));
  });

  app.post("/v1/account/projects", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before creating an API key.");
    const body = await c.req.json().catch(() => ({})) as { name?: unknown; scopes?: unknown; organizationId?: unknown };
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
    const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : undefined;
    if (organizationId && !(await organizationAccessForRequest(c, organizationId).then((access) => access?.role === "owner" || access?.role === "admin"))) {
      return apiError(c, 403, "workspace_admin_required", "Only workspace owners and admins can create company API projects.");
    }
    const scopes = accountProjectScopes(body.scopes === undefined && organizationId ? COMPANY_PROJECT_DEFAULT_SCOPES : body.scopes);
    if (!name) return apiError(c, 400, "invalid_project", "Project name is required.");
    if (!scopes) return apiError(c, 400, "invalid_scopes", "Choose supported API scopes.");
    const control = await getSession(0);
    const ownedProjects = control.sdkProjects!.filter((project) => organizationId ? project.organizationId === organizationId : project.ownerWebAuthUserId === owner.id && !project.organizationId);
    if (ownedProjects.filter((project) => !project.revokedAt).length >= SELF_SERVICE_PROJECT_LIMIT) return apiError(c, 409, "project_limit_reached", `You can have up to ${SELF_SERVICE_PROJECT_LIMIT} active API projects per workspace.`);
    const id = `proj_${randomUUID()}`;
    const key = `chsk_${id}_${randomBytes(24).toString("base64url")}`;
    const project: SdkProjectRecord = {
      id, name, keyPrefix: key.slice(0, 18), keyHash: digestKey(key), scopes,
      createdAt: Date.now(), ownerWebAuthUserId: owner.id,
      ...(organizationId ? {
        organizationId,
        companyPolicy: {
          tools: { allow: [...COMPANY_TOOL_STARTER_ALLOWLIST], requireApproval: [...COMPANY_APPROVAL_BEFORE_EXTERNAL_ACTION] },
          budget: { duration: "30m" as const, maxToolCalls: 40, maxCost: 5 },
        },
        companyAgents: [],
      } : {}),
    };
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
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, true))) return apiError(c, 404, "not_found", "Active API key not found.");
    project.scopes = scopes;
    await saveSession(0, control);
    return c.json(accountProjectView(project));
  });

  app.post("/v1/account/projects/:projectId/rotate-key", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before managing API keys.");
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, true))) return apiError(c, 404, "not_found", "Active API key not found.");
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
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, true))) return apiError(c, 404, "not_found", "Active API key not found.");
    project.revokedAt = Date.now();
    await saveSession(0, control);
    return c.body(null, 204);
  });

  app.get("/v1/account/projects/:projectId/policy", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    const project = (await getSession(0)).sdkProjects!.find((item) => item.id === c.req.param("projectId") && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, false))) return apiError(c, 404, "not_found", "Active API project not found.");
    return c.json({ data: companyPolicyView(safeProjectPolicy(project)) });
  });

  app.put("/v1/account/projects/:projectId/policy", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before changing project policies.");
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, true))) return apiError(c, 404, "not_found", "Active API project not found.");
    const policy = validateCompanyPolicy(await c.req.json().catch(() => undefined));
    if (!policy) return apiError(c, 400, "invalid_policy", "Choose valid tool scopes and run budgets (up to 100 tool calls and $1,000 per run).");
    project.companyPolicy = policy;
    await saveSession(0, control);
    return c.json({ data: companyPolicyView(safeProjectPolicy(project)) });
  });

  app.get("/v1/account/projects/:projectId/agents", async (c) => {
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, false))) return apiError(c, 404, "not_found", "Active API project not found.");
    return c.json({ data: (project.companyAgents ?? []).map(companyAgentView) });
  });

  app.post("/v1/account/projects/:projectId/agents", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before creating an agent.");
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, true))) return apiError(c, 404, "not_found", "Active API project not found.");
    const body = await c.req.json().catch(() => undefined);
    const fingerprint = createHash("sha256").update(`POST:/account/projects/${project.id}/agents:${JSON.stringify(body)}`).digest("hex");
    const key = (c.req.header("Idempotency-Key") ?? "").trim().slice(0, 255);
    const prior = key ? projectAgentIdempotency(project, key, fingerprint) : {};
    if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request.");
    if (prior.replay !== undefined) return c.json(prior.replay, 201);
    project.companyAgents ??= [];
    if (project.companyAgents.length >= 20) return apiError(c, 409, "agent_limit_reached", "A project can have up to 20 agent profiles.");
    const agent = createCompanyAgentProfile(body, `agt_${randomUUID()}`);
    if (!agent) return apiError(c, 400, "invalid_agent", "Choose a supported template and valid tool permissions.");
    project.companyAgents.push(agent);
    const response = companyAgentView(agent);
    if (key) saveProjectAgentIdempotency(project, key, fingerprint, response);
    await saveSession(0, control);
    return c.json(response, 201);
  });

  app.patch("/v1/account/projects/:projectId/agents/:agentId", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before changing an agent.");
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && !item.revokedAt);
    const index = project?.companyAgents?.findIndex((item) => item.id === c.req.param("agentId")) ?? -1;
    if (!project || index < 0 || !(await accountCanAccessProject(c, project, true))) return apiError(c, 404, "not_found", "Agent profile not found.");
    const existing = project.companyAgents![index]!;
    const body = await c.req.json().catch(() => ({})) as { name?: unknown; instructions?: unknown };
    const agent = createCompanyAgentProfile({
      template: existing.template,
      name: body.name ?? existing.name,
      instructions: body.instructions ?? existing.instructions,
      policy: { tools: existing.tools, budget: existing.budget },
    }, existing.id, existing.createdAt);
    if (!agent) return apiError(c, 400, "invalid_agent", "The profile name or instructions are invalid.");
    agent.updatedAt = Date.now();
    project.companyAgents![index] = agent;
    await saveSession(0, control);
    return c.json(companyAgentView(agent));
  });

  app.delete("/v1/account/projects/:projectId/agents/:agentId", async (c) => {
    const owner = webProjectOwner(c);
    if (!owner) return apiError(c, 403, "web_session_required", "A Chusky dashboard session is required.");
    if (!owner.verified) return apiError(c, 403, "email_verification_required", "Verify your email before removing an agent.");
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && !item.revokedAt);
    const index = project?.companyAgents?.findIndex((item) => item.id === c.req.param("agentId")) ?? -1;
    if (!project || index < 0 || !(await accountCanAccessProject(c, project, true))) return apiError(c, 404, "not_found", "Agent profile not found.");
    project.companyAgents!.splice(index, 1);
    await saveSession(0, control);
    return c.body(null, 204);
  });

  app.get("/v1/agents/templates", async (c) => c.json({
    data: COMPANY_AGENT_TEMPLATES.map(({ slug, name, outcome, allowedTools, requireApproval }) => ({
      slug, name, outcome, allowedTools: [...allowedTools], requireApproval: [...requireApproval],
    })),
  }));

  app.get("/v1/agents", async (c) => {
    const principal = principalFromContext(c);
    const project = (await getSession(0)).sdkProjects!.find((item) => item.id === principal.projectId && !item.revokedAt);
    return c.json({ data: (project?.companyAgents ?? []).map(companyAgentView) });
  });

  app.post("/v1/agents", async (c) => {
    const principal = principalFromContext(c);
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === principal.projectId && !item.revokedAt);
    if (!project) return apiError(c, 400, "project_required", "Agent profiles require a project API key.");
    const body = await c.req.json().catch(() => undefined);
    const fingerprint = createHash("sha256").update(`POST:/agents:${JSON.stringify(body)}`).digest("hex");
    const key = (c.req.header("Idempotency-Key") ?? "").trim().slice(0, 255);
    const prior = key ? projectAgentIdempotency(project, key, fingerprint) : {};
    if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request.");
    if (prior.replay !== undefined) return c.json(prior.replay, 201);
    const agent = createCompanyAgentProfile(body, `agt_${randomUUID()}`);
    if (!agent) return apiError(c, 400, "invalid_agent", "Choose a supported template, valid instructions, and tool permissions within that template's grant.");
    project.companyAgents ??= [];
    if (project.companyAgents.length >= 20) return apiError(c, 409, "agent_limit_reached", "A project can have up to 20 agent profiles.");
    project.companyAgents.push(agent);
    const response = companyAgentView(agent);
    if (key) saveProjectAgentIdempotency(project, key, fingerprint, response);
    await saveSession(0, control);
    return c.json(response, 201);
  });

  app.get("/v1/agents/:agentId", async (c) => {
    const principal = principalFromContext(c);
    const project = (await getSession(0)).sdkProjects!.find((item) => item.id === principal.projectId && !item.revokedAt);
    const agent = project?.companyAgents?.find((item) => item.id === c.req.param("agentId"));
    return agent ? c.json(companyAgentView(agent)) : apiError(c, 404, "not_found", "Agent profile not found.");
  });

  app.patch("/v1/agents/:agentId", async (c) => {
    const principal = principalFromContext(c);
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === principal.projectId && !item.revokedAt);
    const index = project?.companyAgents?.findIndex((item) => item.id === c.req.param("agentId")) ?? -1;
    if (!project || index < 0) return apiError(c, 404, "not_found", "Agent profile not found.");
    const existing = project.companyAgents![index]!;
    const patch = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const agent = createCompanyAgentProfile({
      template: patch.template ?? existing.template,
      name: patch.name ?? existing.name,
      instructions: patch.instructions ?? existing.instructions,
      policy: patch.policy ?? { tools: existing.tools, budget: existing.budget },
    }, existing.id, existing.createdAt);
    if (!agent) return apiError(c, 400, "invalid_agent", "Choose a supported template, valid instructions, and tool permissions within that template's grant.");
    agent.updatedAt = Date.now();
    project.companyAgents![index] = agent;
    await saveSession(0, control);
    return c.json(companyAgentView(agent));
  });

  app.delete("/v1/agents/:agentId", async (c) => {
    const principal = principalFromContext(c);
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === principal.projectId && !item.revokedAt);
    const index = project?.companyAgents?.findIndex((item) => item.id === c.req.param("agentId")) ?? -1;
    if (!project || index < 0) return apiError(c, 404, "not_found", "Agent profile not found.");
    project.companyAgents!.splice(index, 1);
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
    const policyError = validateRunPolicy(body); if (policyError) return apiError(c, 400, "invalid_run_policy", policyError);
    const companyPolicy = await applyCompanyRunPolicy(c, body);
    if (companyPolicy.error) return apiError(c, 403, "agent_policy_denied", companyPolicy.error);
    if (!(await checkRateLimit(owner.userId))) { c.header("Retry-After", "60"); return apiError(c, 429, "rate_limited", "Rate limit exceeded."); }
    if (!(await canSpend(owner.userId))) return apiError(c, 402, "spend_limit", "Usage cap reached.");
    const session = await getSession(owner.userId); const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify(body)}`).digest("hex"); const prior = idempotency(c, session, fingerprint); if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request."); if (prior.replay) return c.json(prior.replay, 201); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); if (!thread) return apiError(c, 404, "not_found", "Thread not found.");
    let resolved: Awaited<ReturnType<typeof resolveRunInput>>; try { resolved = await resolveRunInput(session, body); } catch (error) { return apiError(c, 400, error instanceof Error && error.message === "invalid_attachment" ? "invalid_attachment" : "invalid_input", error instanceof Error && error.message === "invalid_attachment" ? "Each attachment must be a verified upload owned by this account." : "Provide 1–30000 characters or up to five verified attachments."); }
    const lockToken = randomUUID();
    if (!(await acquireUserLock(owner.userId, lockToken))) return apiError(c, 409, "run_in_progress", "Another Chusky request is already running for this user.");
    try {
    const now = Date.now(); const run: SdkRunRecord = { id: `run_${randomUUID()}`, status: body.wait === false ? "queued" : "running", ...(owner.organizationId ? { companyProjectId: owner.projectId } : {}), input: resolved.input, model: body.model ?? session.model, agentId: companyPolicy.agent?.id, agentName: companyPolicy.agent?.name, agentInstructions: companyPolicy.agent?.instructions, attachments: resolved.attachments, metadata: body.metadata, budget: body.budget, tools: body.tools, skills: body.skills, events: [event(body.wait === false ? "run.queued" : "run.started")], createdAt: now, updatedAt: now }; thread.runs.push(run);
    if (body.wait === false) {
      let task: Awaited<ReturnType<typeof createTask>>;
      try {
        task = await createTask(owner.userId, { title: (resolved.input || "SDK agent run").slice(0, 120), objective: resolved.input || "Process the verified attachments.", runAt: Date.now(), maxAttempts: 10, sdkRunId: run.id, sdkThreadId: thread.id, sdkInput: resolved.input, sdkAttachments: resolved.attachments, sdkModel: body.model ?? session.model, sdkTools: body.tools ? { allow: body.tools.allow, deny: body.tools.deny, requireApproval: body.tools.requireApproval } : undefined, sdkBudget: body.budget, sdkStartedAt: Date.now(), sdkSkills: body.skills, sdkInstructions: companyPolicy.agent?.instructions });
        const workflowRunId = await sdkTaskWorkflowEnqueuer(owner.userId, task.id, task.runAt ?? Date.now());
        await setTaskWorkflowRunId(owner.userId, task.id, workflowRunId); run.taskId = task.id; run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; const response = runView(thread.id, run); if (prior.key) session.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() }; await saveSession(owner.userId, session); await persistSdkCompanyRun(run); await notifyWebhooks(owner.userId, session.sdkWebhooks!, "run.queued", { threadId: thread.id, runId: run.id, taskId: task.id, status: run.status }); return c.json(response, 202);
      } catch (error) { if (task!) await cancelTask(owner.userId, task.id); thread.runs = thread.runs.filter((item) => item.id !== run.id); await saveSession(owner.userId, session); return apiError(c, 503, "run_enqueue_failed", error instanceof Error ? error.message : "The durable run could not be queued."); }
    }
    try { const result = await runAgent(owner.userId, resolved.message, thread.history, body.model ?? session.model, undefined, c.req.raw.signal, undefined, undefined, undefined, await sdkAgentOptions(body, run.id, thread.id, companyPolicy.agent?.instructions)); run.status = "completed"; run.output = result.text; run.cost = result.cost; session.totalCost = (session.totalCost ?? 0) + (result.cost ?? 0); run.events.push(event("run.completed")); thread.history.push({ role: "user", content: `${resolved.input || "Attached file(s)"}${resolved.attachments.length ? `\n[Attachments: ${resolved.attachments.map((file) => file.name).join(", ")}]` : ""}` }, { role: "assistant", content: result.text }); }
    catch (error) { if (error instanceof ApprovalRequiredError) { run.status = "requires_approval"; run.approvalId = error.approvalId; run.events.push(event("run.approval_required")); } else { run.status = "failed"; run.error = { code: "agent_error", message: error instanceof Error ? error.message : "Agent failed" }; run.events.push(event("run.failed", run.error.message)); } }
    run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; const response = runView(thread.id, run); if (prior.key) session.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() }; await saveSession(owner.userId, session); await persistSdkCompanyRun(run); await notifyWebhooks(owner.userId, session.sdkWebhooks!, `run.${run.status}`, { threadId: thread.id, runId: run.id, status: run.status }); return c.json(response, 201);
    } finally { await releaseUserLock(owner.userId, lockToken); }
  });
  app.post("/v1/threads/:threadId/runs/stream", async (c) => {
    const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as RunBody;
    const policyError = validateRunPolicy(body); if (policyError) return apiError(c, 400, "invalid_run_policy", policyError);
    const companyPolicy = await applyCompanyRunPolicy(c, body);
    if (companyPolicy.error) return apiError(c, 403, "agent_policy_denied", companyPolicy.error);
    if (!(await checkRateLimit(owner.userId))) { c.header("Retry-After", "60"); return apiError(c, 429, "rate_limited", "Rate limit exceeded."); }
    if (!(await canSpend(owner.userId))) return apiError(c, 402, "spend_limit", "Usage cap reached.");
    const session = await getSession(owner.userId); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); if (!thread) return apiError(c, 404, "not_found", "Thread not found.");
    let resolved: Awaited<ReturnType<typeof resolveRunInput>>; try { resolved = await resolveRunInput(session, body); } catch (error) { return apiError(c, 400, error instanceof Error && error.message === "invalid_attachment" ? "invalid_attachment" : "invalid_input", error instanceof Error && error.message === "invalid_attachment" ? "Each attachment must be a verified upload owned by this account." : "Provide 1–30000 characters or up to five verified attachments."); }
    const lockToken = randomUUID();
    if (!(await acquireUserLock(owner.userId, lockToken))) return apiError(c, 409, "run_in_progress", "Another Chusky request is already running for this user.");
    const now = Date.now(); const run: SdkRunRecord = { id: `run_${randomUUID()}`, status: "running", ...(owner.organizationId ? { companyProjectId: owner.projectId } : {}), input: resolved.input, model: body.model ?? session.model, agentId: companyPolicy.agent?.id, agentName: companyPolicy.agent?.name, agentInstructions: companyPolicy.agent?.instructions, attachments: resolved.attachments, metadata: body.metadata, budget: body.budget, tools: body.tools, skills: body.skills, events: [event("run.started")], createdAt: now, updatedAt: now }; thread.runs.push(run); await persistSdkCompanyRun(run);
    await saveSession(owner.userId, session);
    const abort = new AbortController(); const abortOnDisconnect = () => abort.abort(); c.req.raw.signal.addEventListener("abort", abortOnDisconnect, { once: true }); activeRuns.set(run.id, abort);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start: async (controller) => {
      const send = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      send({ type: "run.started", run: runView(thread.id, run) });
      try {
        const result = await runAgent(owner.userId, resolved.message, thread.history, body.model ?? session.model, undefined, abort.signal, (text) => { run.events.push(event("run.delta", text)); send({ type: "run.delta", runId: run.id, text }); }, undefined, undefined, await sdkAgentOptions(body, run.id, thread.id, companyPolicy.agent?.instructions));
        run.status = "completed"; run.output = result.text; run.cost = result.cost; session.totalCost = (session.totalCost ?? 0) + (result.cost ?? 0); run.events.push(event("run.completed")); thread.history.push({ role: "user", content: `${resolved.input || "Attached file(s)"}${resolved.attachments.length ? `\n[Attachments: ${resolved.attachments.map((file) => file.name).join(", ")}]` : ""}` }, { role: "assistant", content: result.text }); send({ type: "run.completed", run: runView(thread.id, run) });
      } catch (error) {
        if (error instanceof ApprovalRequiredError) { run.status = "requires_approval"; run.approvalId = error.approvalId; run.events.push(event("run.approval_required")); const approval = await getApproval(owner.userId, error.approvalId); send({ type: "run.approval_required", run: runView(thread.id, run), approval }); }
        else if (abort.signal.aborted) { run.status = "cancelled"; run.events.push(event("run.cancelled")); send({ type: "run.cancelled", run: runView(thread.id, run) }); }
        else { run.status = "failed"; run.error = { code: "agent_error", message: error instanceof Error ? error.message : "Agent failed" }; run.events.push(event("run.failed", run.error.message)); send({ type: "run.failed", run: runView(thread.id, run), error: run.error }); }
      } finally { c.req.raw.signal.removeEventListener("abort", abortOnDisconnect); activeRuns.delete(run.id); run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; await saveSession(owner.userId, session); await persistSdkCompanyRun(run); await notifyWebhooks(owner.userId, session.sdkWebhooks!, `run.${run.status}`, { threadId: thread.id, runId: run.id, status: run.status }); await releaseUserLock(owner.userId, lockToken); controller.close(); }
    } });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
  });
  app.get("/v1/threads/:threadId/runs", async (c) => { const thread = (await getSession(sdkUser(c)!.userId)).sdkThreads!.find((item) => item.id === c.req.param("threadId")); if (!thread) return apiError(c, 404, "not_found", "Thread not found."); const result = page(thread.runs, c.req.query("cursor"), c.req.query("limit")); return c.json({ data: result.data.map((run) => runView(thread.id, run)), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }); });
  app.get("/v1/threads/:threadId/runs/:runId", async (c) => { const thread = (await getSession(sdkUser(c)!.userId)).sdkThreads!.find((item) => item.id === c.req.param("threadId")); const run = thread?.runs.find((item) => item.id === c.req.param("runId")); return thread && run ? c.json(runView(thread.id, run)) : apiError(c, 404, "not_found", "Run not found."); });
   app.get("/v1/threads/:threadId/runs/:runId/events", async (c) => { const thread = (await getSession(sdkUser(c)!.userId)).sdkThreads!.find((item) => item.id === c.req.param("threadId")); const run = thread?.runs.find((item) => item.id === c.req.param("runId")); const cursor = Number(c.req.query("after") ?? 0) || 0; return thread && run ? c.json({ data: run.events.filter((item) => item.at > cursor) }) : apiError(c, 404, "not_found", "Run not found."); });
   app.get("/v1/threads/:threadId/runs/:runId/trace", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); const run = thread?.runs.find((item) => item.id === c.req.param("runId")); if (!thread || !run) return apiError(c, 404, "not_found", "Run not found."); const trace = await getAgentRun(owner.userId, run.id); if (!trace) return c.json({ runId: run.id, data: [], state: undefined }); const includeState = c.req.query("include_state") === "true"; return c.json({ runId: run.id, status: trace.status, version: trace.version, createdAt: new Date(trace.createdAt).toISOString(), updatedAt: new Date(trace.updatedAt).toISOString(), events: trace.events, ...(includeState ? { state: trace.state } : {}) }); });
  app.post("/v1/threads/:threadId/runs/:runId/resume", async (c) => {
    const owner = sdkUser(c)!; const session = await getSession(owner.userId); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); const prior = thread?.runs.find((item) => item.id === c.req.param("runId"));
    if (!thread || !prior) return apiError(c, 404, "not_found", "Run not found.");
    if (!["failed", "cancelled", "requires_approval"].includes(prior.status)) return apiError(c, 409, "run_not_resumable", "Only failed, cancelled, or approval-paused runs can be resumed.");
    const run: SdkRunRecord = { id: `run_${randomUUID()}`, status: "running", ...(prior.companyProjectId ? { companyProjectId: prior.companyProjectId } : {}), agentId: prior.agentId, agentName: prior.agentName, agentInstructions: prior.agentInstructions, input: prior.input, model: prior.model ?? session.model, attachments: prior.attachments, metadata: prior.metadata, budget: prior.budget, tools: prior.tools, skills: prior.skills, events: [event("run.started", "Resumed from a previous run")], createdAt: Date.now(), updatedAt: Date.now() }; thread.runs.push(run);
     try { const resolved = await resolveRunInput(session, { input: prior.input, attachments: prior.attachments?.map((file) => file.id) }); const result = await runAgent(owner.userId, resolved.message, thread.history, run.model ?? session.model, undefined, c.req.raw.signal, undefined, undefined, undefined, await sdkAgentOptions({ budget: prior.budget, tools: prior.tools, skills: prior.skills }, run.id, thread.id, prior.agentInstructions)); run.status = "completed"; run.output = result.text; run.cost = result.cost; session.totalCost = (session.totalCost ?? 0) + (result.cost ?? 0); run.events.push(event("run.completed")); thread.history.push({ role: "user", content: `${resolved.input || "Attached file(s)"}${resolved.attachments.length ? `\n[Attachments: ${resolved.attachments.map((file) => file.name).join(", ")}]` : ""}` }, { role: "assistant", content: result.text }); }
    catch (error) { run.status = "failed"; run.error = { code: "agent_error", message: error instanceof Error ? error.message : "Agent failed" }; run.events.push(event("run.failed", run.error.message)); }
    run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; await saveSession(owner.userId, session); await persistSdkCompanyRun(run); return c.json(runView(thread.id, run), 201);
  });
  app.post("/v1/threads/:threadId/runs/:runId/cancel", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); const run = thread?.runs.find((item) => item.id === c.req.param("runId")); if (!thread || !run) return apiError(c, 404, "not_found", "Run not found."); if (!["queued", "running"].includes(run.status)) return apiError(c, 409, "run_not_cancellable", "Only a queued or running run can be cancelled."); if (run.taskId) await cancelTask(owner.userId, run.taskId); activeRuns.get(run.id)?.abort(); run.status = "cancelled"; run.events.push(event("run.cancelled")); run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; await saveSession(owner.userId, session); await persistSdkCompanyRun(run); return c.json(runView(thread.id, run)); });
  app.get("/v1/approvals", async (c) => { const data = (await listApprovals(sdkUser(c)!.userId, 100)).filter((item) => item.status === "pending" && item.expiresAt > Date.now()).map(approvalView); return c.json({ data }); });
  app.get("/v1/tools", async (c) => {
    const query = (c.req.query("query") ?? "").trim(); const source = c.req.query("source"); const toolkit = (c.req.query("toolkit") ?? "").toLowerCase();
    const native = chuckTools.map((item) => ({ slug: item.function.name, description: item.function.description, source: "native" as const })).filter((item) => (!query || `${item.slug} ${item.description}`.toLowerCase().includes(query.toLowerCase())) && source !== "composio");
    let composio: any[] = [];
    if (source !== "native" && query) { try { composio = (await searchTools(sdkUser(c)!.userId, query)).slice(0, 50).map((item: any) => ({ slug: String(item.slug ?? item.name ?? ""), description: String(item.description ?? item.name ?? ""), source: "composio", toolkit: item.toolkit ?? item.appName, connected: Boolean(item.connection?.isActive ?? item.connected) })).filter((item: any) => item.slug); } catch { composio = []; } }
    const data = [...native, ...composio].filter((item: any) => !toolkit || String(item.toolkit ?? "").toLowerCase() === toolkit).slice(0, Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 50) || 50)));
    return c.json({ data });
  });
  app.get("/v1/tools/:slug", async (c) => { const slug = c.req.param("slug"); const native = chuckTools.find((item) => item.function.name === slug); if (native) return c.json({ slug, description: native.function.description, source: "native" }); try { const matches = await searchTools(sdkUser(c)!.userId, slug); const item: any = matches.find((candidate: any) => String(candidate.slug ?? candidate.name) === slug); return item ? c.json({ slug, description: String(item.description ?? item.name ?? ""), source: "composio", toolkit: item.toolkit ?? item.appName, connected: Boolean(item.connection?.isActive ?? item.connected) }) : apiError(c, 404, "not_found", "Tool not found."); } catch { return apiError(c, 502, "tools_unavailable", "Tool catalogue is temporarily unavailable."); } });
  app.get("/v1/skills", async (c) => { try { const data = await searchSkills(c.req.query("query") ?? "", Number(c.req.query("limit") ?? 20)); return c.json({ data }); } catch (error) { return apiError(c, 500, "skills_unavailable", error instanceof Error ? error.message : "Skill catalogue unavailable."); } });
  app.get("/v1/skills/:name/files", async (c) => { try { const data = await listSkillFiles(c.req.param("name"), Number(c.req.query("maxFiles") ?? 100)); return c.json({ data }); } catch (error) { return apiError(c, 404, "skill_not_found", error instanceof Error ? error.message : "Skill not found."); } });
  app.get("/v1/skills/:name/files/read", async (c) => { try { return c.json(await readSkillFile(c.req.param("name"), c.req.query("path") ?? "SKILL.md", Number(c.req.query("maxChars") ?? 12000))); } catch (error) { return apiError(c, 404, "skill_file_not_found", error instanceof Error ? error.message : "Skill file not found."); } });
  app.get("/v1/artifacts", async (c) => { const session = await getSession(sdkUser(c)!.userId); const type = c.req.query("type"); const items = (session.artifacts ?? []).filter((item) => !type || item.type === type); const result = page(items, c.req.query("cursor"), c.req.query("limit")); return c.json({ data: result.data.map(artifactView), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }); });
  app.get("/v1/artifacts/:id", async (c) => { const artifact = (await getSession(sdkUser(c)!.userId)).artifacts?.find((item) => item.id === c.req.param("id")); return artifact ? c.json(artifactView(artifact)) : apiError(c, 404, "not_found", "Artifact not found."); });
  app.delete("/v1/artifacts/:id", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const index = (session.artifacts ?? []).findIndex((item) => item.id === c.req.param("id")); if (index < 0) return apiError(c, 404, "not_found", "Artifact not found."); session.artifacts!.splice(index, 1); await saveSession(owner.userId, session); return c.body(null, 204); });
  app.get("/v1/artifacts/:id/download", async (c) => { try { const delivery = await daytonaEngine.downloadArtifact(sdkUser(c)!.userId, c.req.param("id")); return new Response(delivery.data, { headers: { "Content-Type": delivery.contentType, "Content-Length": String(delivery.size), "Content-Disposition": `attachment; filename="${delivery.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`, "Cache-Control": "private, max-age=300" } }); } catch (error) { return apiError(c, 404, "artifact_unavailable", error instanceof Error ? error.message : "Artifact download unavailable."); } });
  app.get("/v1/videos", async (c) => { const data = (await listVideoJobs(sdkUser(c)!.userId)).map(videoView); return c.json({ data }); });
  app.post("/v1/videos", async (c) => { const body = await c.req.json().catch(() => ({})) as any; const prompt = String(body.prompt ?? "").trim(); const destination = ["telegram", "daytona", "both"].includes(body.destination) ? body.destination : "telegram"; if (!prompt || prompt.length > 4000) return apiError(c, 400, "invalid_video_request", "prompt is required and must be 4000 characters or fewer."); try { const result = await queueVideoWorkflow(sdkUser(c)!.userId, prompt, destination, body.workspacePath, { duration: body.duration, aspectRatio: body.aspectRatio, resolution: body.resolution, generateAudio: body.generateAudio }); const job = await getVideoJob(sdkUser(c)!.userId, result.jobId); return c.json(videoView(job), 202); } catch (error) { return apiError(c, 503, "video_unavailable", error instanceof Error ? error.message : "Video generation is unavailable."); } });
  app.get("/v1/videos/:id", async (c) => { const job = await getVideoJob(sdkUser(c)!.userId, c.req.param("id")); return job ? c.json(videoView(job)) : apiError(c, 404, "not_found", "Video job not found."); });
  app.post("/v1/videos/:id/cancel", async (c) => { const job = await getVideoJob(sdkUser(c)!.userId, c.req.param("id")); if (!job) return apiError(c, 404, "not_found", "Video job not found."); const updated = await updateVideoJob(sdkUser(c)!.userId, job.id, { status: "cancelled" }); return c.json(videoView(updated)); });
  app.post("/v1/workers", async (c) => { const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; const worker = String(body.worker ?? "").trim(); const objective = String(body.objective ?? "").trim(); if (!worker || !objective) return apiError(c, 400, "invalid_worker", "worker and objective are required."); try { const result: any = await nativeTool(sdkUser(c)!.userId, "CHUCK_DELEGATE_SUBAGENT", body); return c.json(result?.handoffRecord ? workerView(result.handoffRecord) : result, 202); } catch (error) { return apiError(c, 400, "worker_create_failed", error instanceof Error ? error.message : "Worker could not be created."); } });
  app.get("/v1/workers", async (c) => { const records = await listHandoffRecords(sdkUser(c)!.userId); const status = c.req.query("status"); const data = records.filter((record) => !status || record.status === status).slice(0, Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 20) || 20))).map(workerView); return c.json({ data }); });
  app.get("/v1/workers/:id", async (c) => { const record = await getHandoffRecord(sdkUser(c)!.userId, c.req.param("id")); return record ? c.json(workerView(record)) : apiError(c, 404, "not_found", "Worker delegation not found."); });
  app.get("/v1/workers/:id/trace", async (c) => { const record = await getHandoffRecord(sdkUser(c)!.userId, c.req.param("id")); if (!record?.delegation?.runId) return apiError(c, 404, "not_found", "Worker trace not found."); const trace = await getAgentRun(sdkUser(c)!.userId, record.delegation.runId); return trace ? c.json({ workerId: record.id, runId: trace.id, status: trace.status, version: trace.version, events: trace.events, state: c.req.query("include_state") === "true" ? trace.state : undefined }) : apiError(c, 404, "not_found", "Worker trace not found."); });
  app.post("/v1/workers/:id/cancel", async (c) => { const owner = sdkUser(c)!; const record = await getHandoffRecord(owner.userId, c.req.param("id")); if (!record) return apiError(c, 404, "not_found", "Worker delegation not found."); const updated = await requestDelegationCancellation(owner.userId, record.id); return updated ? c.json(workerView(updated), 202) : apiError(c, 409, "worker_not_cancellable", "This worker delegation is already finished."); });
  app.get("/v1/channels", async (c) => { const data = (await listChannelIdentities(sdkUser(c)!.userId)).filter((item) => !item.disabledAt).map((item) => ({ id: identityFingerprint(item), provider: item.provider, externalUserId: item.externalUserId, workspaceId: item.workspaceId, displayName: item.displayName, verifiedAt: new Date(item.verifiedAt).toISOString(), proactiveOptIn: item.proactiveOptIn !== false })); return c.json({ data }); });
  app.post("/v1/channels/link-code", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { provider?: unknown };
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    if (provider !== "slack" && provider !== "whatsapp" && provider !== "sendblue") return apiError(c, 400, "invalid_channel_provider", "Channel linking is available for Slack, WhatsApp, and Sendblue.");
    const code = await createLinkCode(sdkUser(c)!.userId, provider);
    if (provider === "slack") {
      let installUrl: string | undefined;
      if (config.webhookUrl) {
        try { const url = new URL("/slack/install", config.webhookUrl); url.searchParams.set("code", code); installUrl = url.toString(); } catch { /* Return the code without manufacturing an invalid URL. */ }
      }
      return c.json({ provider, code, expiresInSeconds: 600, instructions: installUrl ? "Open the secure Slack install link and complete Slack OAuth." : "Open /slack/install?code=<code> on your Chusky server and complete Slack OAuth.", installUrl }, 201);
    }
    return c.json({ provider, code, expiresInSeconds: 600, instructions: `Send /link ${code} from the ${provider} account you want to connect.` }, 201);
  });
  app.patch("/v1/channels/:provider/:identityId", async (c) => {
    const provider = c.req.param("provider") as ChannelProvider;
    const body = await c.req.json().catch(() => ({})) as { proactiveOptIn?: unknown };
    if (typeof body.proactiveOptIn !== "boolean") return apiError(c, 400, "invalid_channel_preference", "proactiveOptIn must be a boolean.");
    const identity = (await listChannelIdentities(sdkUser(c)!.userId)).find((item) => item.provider === provider && identityFingerprint(item) === c.req.param("identityId"));
    if (!identity) return apiError(c, 404, "channel_not_found", "Linked channel not found for this Chusky account.");
    const updated = await updateLinkedChannelIdentity(sdkUser(c)!.userId, c.req.param("identityId"), { proactiveOptIn: body.proactiveOptIn });
    return updated ? c.json({ id: identityFingerprint(updated), provider: updated.provider, proactiveOptIn: updated.proactiveOptIn !== false }) : apiError(c, 404, "channel_not_found", "Linked channel not found for this Chusky account.");
  });
  app.delete("/v1/channels/:provider/:identityId", async (c) => {
    const provider = c.req.param("provider") as ChannelProvider;
    if (provider === "telegram") return apiError(c, 409, "primary_channel_link", "The primary Telegram workspace link is managed from account settings.");
    const identity = (await listChannelIdentities(sdkUser(c)!.userId)).find((item) => item.provider === provider && identityFingerprint(item) === c.req.param("identityId"));
    if (!identity) return apiError(c, 404, "channel_not_found", "Linked channel not found for this Chusky account.");
    return await unlinkChannelIdentity(sdkUser(c)!.userId, c.req.param("identityId")) ? c.body(null, 204) : apiError(c, 404, "channel_not_found", "Linked channel not found for this Chusky account.");
  });
  app.get("/v1/devices", async (c) => {
    const data = (await listCliDevices(sdkUser(c)!.userId)).filter((item) => !item.revokedAt).map(({ tokenHash, ...item }) => ({ id: createHash("sha256").update(tokenHash).digest("hex").slice(0, 24), name: item.name, createdAt: new Date(item.createdAt).toISOString(), lastSeenAt: new Date(item.lastSeenAt).toISOString() }));
    return c.json({ data });
  });
  app.delete("/v1/devices/:deviceId", async (c) => {
    const id = c.req.param("deviceId");
    if (!/^[a-f0-9]{24}$/.test(id)) return apiError(c, 400, "invalid_device_id", "Invalid device ID.");
    const owner = sdkUser(c)!;
    const device = (await listCliDevices(owner.userId)).find((item) => !item.revokedAt && createHash("sha256").update(item.tokenHash).digest("hex").slice(0, 24) === id);
    if (!device || !(await revokeCliDeviceHash(owner.userId, device.tokenHash))) return apiError(c, 404, "device_not_found", "CLI device not found for this Chusky account.");
    return c.body(null, 204);
  });
  app.get("/v1/deliveries", async (c) => { const data = (await listOutbox(undefined, 100, sdkUser(c)!.userId)).filter((item) => !item.webhook).map((item) => ({ id: item.id, provider: item.provider, status: item.status, kind: item.kind, attempts: item.attempts, providerStatus: item.providerStatus, lastError: item.lastError, createdAt: new Date(item.createdAt).toISOString(), updatedAt: new Date(item.updatedAt).toISOString(), deliveredAt: item.deliveredAt ? new Date(item.deliveredAt).toISOString() : undefined })); return c.json({ data }); });
  app.get("/v1/reminders", async (c) => { const data = (await listReminders(sdkUser(c)!.userId)).map((item) => ({ ...item, runAt: new Date(item.runAt).toISOString(), createdAt: new Date(item.createdAt).toISOString() })); return c.json({ data }); });
  app.post("/v1/reminders", async (c) => { const body = await c.req.json().catch(() => ({})) as { text?: string; delaySeconds?: number; runAt?: string }; const text = String(body.text ?? "").trim(); if (!text || text.length > 2000) return apiError(c, 400, "invalid_reminder", "text is required and must be 2000 characters or fewer."); try { const reminder = await setReminder(sdkUser(c)!.userId, { text, ...(body.delaySeconds !== undefined ? { delaySeconds: body.delaySeconds } : {}), ...(body.runAt ? { runAt: body.runAt } : {}) }); return c.json({ ...reminder, runAt: new Date(reminder.runAt).toISOString(), createdAt: new Date(reminder.createdAt).toISOString() }, 201); } catch (error) { return apiError(c, 400, "reminder_create_failed", error instanceof Error ? error.message : "Reminder could not be scheduled."); } });
  app.delete("/v1/reminders/:id", async (c) => { try { await cancelReminder(sdkUser(c)!.userId, c.req.param("id")); return c.body(null, 204); } catch (error) { return apiError(c, 404, "reminder_not_found", error instanceof Error ? error.message : "Reminder not found."); } });
  app.get("/v1/jobs", async (c) => { const data = (await listJobs(sdkUser(c)!.userId)).map((item) => ({ ...item, createdAt: new Date(item.createdAt).toISOString() })); return c.json({ data }); });
  app.post("/v1/jobs", async (c) => { const body = await c.req.json().catch(() => ({})) as { text?: string; cron?: string }; const text = String(body.text ?? "").trim(); const cron = String(body.cron ?? "").trim(); if (!text || !cron) return apiError(c, 400, "invalid_job", "text and cron are required."); try { const job = await scheduleJob(sdkUser(c)!.userId, { text, cron }); return c.json({ ...job, createdAt: new Date(job.createdAt).toISOString() }, 201); } catch (error) { return apiError(c, 400, "job_create_failed", error instanceof Error ? error.message : "Recurring job could not be scheduled."); } });
  app.delete("/v1/jobs/:id", async (c) => { try { await cancelJob(sdkUser(c)!.userId, c.req.param("id")); return c.body(null, 204); } catch (error) { return apiError(c, 404, "job_not_found", error instanceof Error ? error.message : "Recurring job not found."); } });
  app.get("/v1/scratchpad", async (c) => { const data = Object.entries(await readScratchpad(sdkUser(c)!.userId, c.req.query("query"))).map(([key, item]) => ({ key, content: item.content, updatedAt: new Date(item.updatedAt).toISOString() })); return c.json({ data }); });
  app.put("/v1/scratchpad/:key", async (c) => { const key = decodeURIComponent(c.req.param("key")).trim(); const body = await c.req.json().catch(() => ({})) as { content?: string }; const content = String(body.content ?? ""); if (!key || key.length > 120 || content.length > 20_000) return apiError(c, 400, "invalid_scratchpad", "key and content are required; content must be 20000 characters or fewer."); await writeScratchpad(sdkUser(c)!.userId, key, content); return c.json({ key, content, updatedAt: new Date().toISOString() }); });
  app.delete("/v1/scratchpad", async (c) => { await clearScratchpad(sdkUser(c)!.userId, c.req.query("key")); return c.body(null, 204); });
  app.delete("/v1/scratchpad/:key", async (c) => { await clearScratchpad(sdkUser(c)!.userId, decodeURIComponent(c.req.param("key"))); return c.body(null, 204); });
  app.get("/v1/memory", async (c) => { const data = (await searchMemories(sdkUser(c)!.userId, c.req.query("query"), { limit: 20 })).map((item) => ({ ...item, createdAt: new Date(item.createdAt).toISOString(), updatedAt: new Date(item.updatedAt).toISOString(), expiresAt: item.expiresAt ? new Date(item.expiresAt).toISOString() : undefined, reviewAt: item.reviewAt ? new Date(item.reviewAt).toISOString() : undefined })); return c.json({ data }); });
  app.post("/v1/memory", async (c) => { const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; const categories = new Set(["profile", "personal", "preference", "business", "relationship", "project", "procedural", "episodic", "document", "negative", "fact", "instruction", "asset"]); const category = String(body.category ?? "fact"); const key = String(body.key ?? "").trim(); const value = String(body.value ?? "").trim(); const sensitivity = body.sensitivity; if (!categories.has(category) || !key || !value || key.length > 200 || value.length > 20_000 || (sensitivity !== "normal" && sensitivity !== "sensitive")) return apiError(c, 400, "invalid_memory", "category, key, value, and sensitivity (normal or sensitive) are required."); try { const memory = await upsertMemory(sdkUser(c)!.userId, { category: category as any, key, value, confidence: Number(body.confidence ?? 1), source: String(body.source ?? "web_dashboard"), sensitivity, projectId: typeof body.projectId === "string" ? body.projectId : undefined, personKey: typeof body.personKey === "string" ? body.personKey : undefined, reviewAt: typeof body.reviewAt === "number" ? body.reviewAt : undefined, expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : undefined }); return c.json({ ...memory, createdAt: new Date(memory.createdAt).toISOString(), updatedAt: new Date(memory.updatedAt).toISOString() }, 201); } catch (error) { return apiError(c, 400, "memory_save_failed", error instanceof Error ? error.message : "Memory could not be saved."); } });
  app.delete("/v1/memory/:id", async (c) => { const removed = await forgetMemory(sdkUser(c)!.userId, decodeURIComponent(c.req.param("id"))); return removed ? c.body(null, 204) : apiError(c, 404, "memory_not_found", "Memory not found."); });
  app.get("/v1/tasks", async (c) => c.json({ data: await listTasks(sdkUser(c)!.userId) }));
  app.post("/v1/tasks/:taskId/retry", async (c) => { const userId = sdkUser(c)!.userId; const task = await retryTask(userId, c.req.param("taskId")); if (!task) return apiError(c, 409, "task_not_retryable", "Only failed, blocked, or cancelled tasks can be retried."); try { const workflowRunId = await sdkTaskWorkflowEnqueuer(userId, task.id, task.runAt ?? Date.now()); const updated = await setTaskWorkflowRunId(userId, task.id, workflowRunId); return c.json(updated ?? task); } catch (error) { return apiError(c, 503, "task_enqueue_failed", error instanceof Error ? error.message : "Task could not be queued."); } });
  app.post("/v1/tasks/:taskId/cancel", async (c) => { const task = await cancelTask(sdkUser(c)!.userId, c.req.param("taskId")); return task ? c.json(task) : apiError(c, 409, "task_not_cancellable", "This task is already completed or cancelled."); });
  app.get("/v1/company/runs", async (c) => {
    const project = await requestCompanyProject(c);
    if (!project) return apiError(c, 404, "company_project_not_found", "Company telemetry is not available for this API project.");
    return c.json({ data: companyRunViews(await listCompanyRunSummaries(project.id, projectLimit(c))) });
  });
  app.get("/v1/company/audit-events", async (c) => {
    const project = await requestCompanyProject(c);
    if (!project) return apiError(c, 404, "company_project_not_found", "Company telemetry is not available for this API project.");
    const after = Number(c.req.query("after") ?? 0);
    return c.json({ data: companyAuditViews(await listCompanyAuditEvents(project.id, 100), Number.isFinite(after) && after > 0 ? after : 0) });
  });
  app.get("/v1/company/usage", async (c) => {
    const project = await requestCompanyProject(c);
    if (!project) return apiError(c, 404, "company_project_not_found", "Company telemetry is not available for this API project.");
    return c.json(await companyUsageView(project.id));
  });
  app.get("/v1/audit-events", async (c) => { const session = await getSession(sdkUser(c)!.userId); const after = Number(c.req.query("after") ?? 0) || 0; return c.json({ data: session.sdkAudit!.filter((item) => item.at > after) }); });
  app.get("/v1/activity", async (c) => { const userId = sdkUser(c)!.userId; const since = Number(c.req.query("since") ?? 0) || 0; const session = await getSession(userId); return c.json({ now: Date.now(), approvals: session.approvals.filter((item) => item.status === "pending" && item.expiresAt > Date.now()), tasks: (await listTasks(userId)).filter((item) => item.updatedAt > since).slice(0, 50), reminders: (await listReminders(userId)).filter((item) => item.createdAt > since).slice(0, 50), jobs: (await listJobs(userId)).filter((item) => item.createdAt > since).slice(0, 50) }); });
  app.get("/v1/runs", async (c) => { const userId = sdkUser(c)!.userId; const status = c.req.query("status"); const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 50) || 50)); const data = (await listAgentRuns(userId, limit)).filter((run) => !status || run.status === status).map((run) => ({ ...run, createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString() })); return c.json({ data }); });
  app.get("/v1/runs/:id", async (c) => { const run = await getAgentRun(sdkUser(c)!.userId, c.req.param("id")); return run ? c.json({ ...run, createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString() }) : apiError(c, 404, "not_found", "Agent run not found."); });
  app.get("/v1/usage", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const files = session.sdkFiles!; const runs = session.sdkThreads!.flatMap((thread) => thread.runs); return c.json({ messages: session.totalMessages, cost: session.totalCost, files: { count: files.length, declaredBytes: files.reduce((total, file) => total + file.size, 0), available: files.filter((file) => file.status === "available").length }, runs: { count: runs.length, active: runs.filter((run) => run.status === "running").length }, tasks: { count: (await listTasks(owner.userId)).length } }); });
  app.post("/v1/webhooks", async (c) => { const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { url?: string }; let url: URL; try { url = new URL(String(body.url ?? "")); } catch { return apiError(c, 400, "invalid_webhook", "A valid HTTPS webhook URL is required."); } if (!isSafeWebhookUrl(url)) return apiError(c, 400, "invalid_webhook", "Webhook URLs must use public HTTPS endpoints."); const session = await getSession(owner.userId); const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify(body)}`).digest("hex"); const prior = idempotency(c, session, fingerprint); if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request."); if (prior.replay) return c.json(prior.replay, 201); const secret = `whsec_${randomBytes(24).toString("base64url")}`; const hook = { id: `wh_${randomUUID()}`, url: url.toString(), secretCiphertext: sealWebhookSecret(secret), createdAt: Date.now() }; const response = { id: hook.id, url: hook.url, secret, createdAt: new Date(hook.createdAt).toISOString() }; session.sdkWebhooks!.push(hook); if (prior.key) session.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() }; await saveSession(owner.userId, session); return c.json(response, 201); });
  app.get("/v1/webhooks", async (c) => { const hooks = (await getSession(sdkUser(c)!.userId)).sdkWebhooks!.filter((item) => !item.disabledAt).map(({ secretCiphertext: _secretCiphertext, ...item }) => item); return c.json({ data: hooks }); });
  app.get("/v1/webhooks/:webhookId/deliveries", async (c) => { const owner = sdkUser(c)!; const hook = (await getSession(owner.userId)).sdkWebhooks!.find((item) => item.id === c.req.param("webhookId")); if (!hook) return apiError(c, 404, "not_found", "Webhook not found."); const data = (await listOutbox(undefined, 100, owner.userId)).filter((item) => item.webhook?.webhookId === hook.id).map((item) => ({ id: item.id, status: item.status, attempts: item.attempts, lastError: item.lastError, createdAt: new Date(item.createdAt).toISOString(), deliveredAt: item.deliveredAt ? new Date(item.deliveredAt).toISOString() : undefined })); return c.json({ data }); });
  app.patch("/v1/webhooks/:webhookId", async (c) => { const owner = sdkUser(c)!; const enabled = (await c.req.json().catch(() => ({})) as { enabled?: unknown }).enabled; if (typeof enabled !== "boolean") return apiError(c, 400, "invalid_webhook_state", "enabled must be a boolean."); const session = await getSession(owner.userId); const hook = session.sdkWebhooks!.find((item) => item.id === c.req.param("webhookId")); if (!hook) return apiError(c, 404, "not_found", "Webhook not found."); hook.disabledAt = enabled ? undefined : Date.now(); await saveSession(owner.userId, session); return c.json({ id: hook.id, url: hook.url, enabled, createdAt: new Date(hook.createdAt).toISOString() }); });
  app.post("/v1/webhooks/:webhookId/deliveries/:deliveryId/retry", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const hook = session.sdkWebhooks!.find((item) => item.id === c.req.param("webhookId")); if (!hook) return apiError(c, 404, "not_found", "Webhook not found."); const record = (await listOutbox(undefined, 100, owner.userId)).find((item) => item.id === c.req.param("deliveryId") && item.webhook?.webhookId === hook.id); if (!record) return apiError(c, 404, "not_found", "Webhook delivery not found."); const updated = await updateOutbox(record.id, { status: "queued", attempts: 0, lastError: undefined, leaseToken: undefined, leaseExpiresAt: undefined }); return c.json(updated ? { id: updated.id, status: updated.status, attempts: updated.attempts } : { id: record.id, status: "queued", attempts: 0 }); });
  app.delete("/v1/webhooks/:webhookId", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const hook = session.sdkWebhooks!.find((item) => item.id === c.req.param("webhookId")); if (!hook) return apiError(c, 404, "not_found", "Webhook not found."); hook.disabledAt = Date.now(); await saveSession(owner.userId, session); return c.body(null, 204); });
  app.post("/v1/files", async (c) => { const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { name?: string; contentType?: string; size?: number }; const name = String(body.name ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120); const contentType = String(body.contentType ?? "").toLowerCase(); const size = Number(body.size); const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/plain", "text/markdown", "application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "audio/mpeg", "audio/ogg", "audio/wav", "video/mp4", "video/webm"]); if (!name || !allowed.has(contentType) || !Number.isFinite(size) || size < 1 || size > config.sdkMaxFileBytes) return apiError(c, 400, "invalid_file", "File name, type, or size is invalid."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "R2 storage is not configured."); const session = await getSession(owner.userId); const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify(body)}`).digest("hex"); const prior = idempotency(c, session, fingerprint); if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request."); if (prior.replay) return c.json(prior.replay, 201); const file = { id: `file_${randomUUID()}`, key: `sdk/${owner.userId}/${randomUUID()}-${name}`, name, contentType, size, status: "pending" as const, createdAt: Date.now() }; const expiresAt = new Date(Date.now() + 300_000).toISOString(); const response = { ...file, uploadUrl: await signR2Upload(file.key, file.contentType), expiresAt }; session.sdkFiles!.push(file); if (prior.key) session.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() }; await saveSession(owner.userId, session); return c.json(response, 201); });
 app.post("/v1/files/:fileId/complete", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const file = session.sdkFiles!.find((item) => item.id === c.req.param("fileId")); if (!file) return apiError(c, 404, "not_found", "File not found."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "R2 storage is not configured."); try { const remote = await inspectR2Object(file.key); if (remote.size !== file.size || remote.contentType !== file.contentType) { file.status = "rejected"; await saveSession(owner.userId, session); return apiError(c, 409, "file_verification_failed", "R2 object size or content type did not match the upload intent."); } file.status = "available"; await saveSession(owner.userId, session); if (["image/jpeg", "image/png", "image/webp"].includes(file.contentType)) { try { await registerImageAsset(owner.userId, { name: file.name, purpose: "Image uploaded through the Chusky dashboard", description: file.name, tags: ["dashboard", "uploaded-image"], contentType: file.contentType as "image/jpeg" | "image/png" | "image/webp", r2Key: file.key, size: file.size }); } catch (error) { logger.warn({ err: error, userId: owner.userId, fileId: file.id }, "Could not register SDK image asset"); } } if (vectorConfigured() && (file.contentType.startsWith("image/") || file.contentType === "text/plain" || file.contentType === "text/markdown" || file.contentType === "application/pdf" || file.contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")) { try { const bytes = await readR2Object(file.key); const extracted = file.contentType === "text/plain" || file.contentType === "text/markdown" ? bytes.toString("utf8") : await extractMediaText(bytes, file.name, file.contentType); await indexExtractedDocument({ userId: String(owner.userId), documentId: file.id, filename: file.name, contentType: file.contentType, text: extracted, sourceType: "sdk_upload" }); } catch (error) { logger.warn({ err: error, userId: owner.userId, fileId: file.id }, "Could not index SDK file"); } } return c.json(file); } catch { return apiError(c, 409, "file_not_uploaded", "The upload is not available in R2 yet."); } });
  app.get("/v1/files/:fileId", async (c) => { const owner = sdkUser(c)!; const file = (await getSession(owner.userId)).sdkFiles!.find((item) => item.id === c.req.param("fileId")); if (!file) return apiError(c, 404, "not_found", "File not found."); if (file.status !== "available") return apiError(c, 409, "file_not_available", "Only a verified upload can be downloaded."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "R2 storage is not configured."); return c.json({ ...file, downloadUrl: await signR2Download(file.key), expiresAt: new Date(Date.now() + 300_000).toISOString() }); });
  app.delete("/v1/files/:fileId", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const index = session.sdkFiles!.findIndex((item) => item.id === c.req.param("fileId")); if (index < 0) return apiError(c, 404, "not_found", "File not found."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "R2 storage is not configured."); await deleteR2Object(session.sdkFiles![index].key); session.sdkFiles!.splice(index, 1); await saveSession(owner.userId, session); return c.body(null, 204); });
  app.get("/v1/tasks/:taskId", async (c) => { const task = await getTask(sdkUser(c)!.userId, c.req.param("taskId")); return task ? c.json(task) : apiError(c, 404, "not_found", "Task not found."); });
  app.get("/v1/approvals/:approvalId", async (c) => { const approval = await getApproval(sdkUser(c)!.userId, c.req.param("approvalId")); return approval ? c.json(approvalView(approval)) : apiError(c, 404, "not_found", "Approval not found."); });
  app.post("/v1/approvals/:approvalId", async (c) => {
    const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { decision?: string };
    const pending = await getApproval(owner.userId, c.req.param("approvalId"));
    if (!pending || pending.status !== "pending" || pending.expiresAt <= Date.now()) return apiError(c, 404, "not_found", "Pending approval not found.");
    if (body.decision !== "approve" && body.decision !== "deny") return apiError(c, 400, "invalid_decision", "decision must be approve or deny.");
    if (body.decision === "deny") { await setApprovalStatus(owner.userId, pending.id, "denied"); return c.json({ id: pending.id, status: "denied" }); }
    const approval = await claimApproval(owner.userId, pending.id);
    if (!approval) return apiError(c, 409, "approval_unavailable", "Approval was already decided, expired, or consumed.");
    const token = randomUUID();
    if (!(await acquireUserLock(owner.userId, token))) {
      // claimApproval is an atomic state transition. If the user lock is busy,
      // restore the approval so a transient concurrent run cannot strand it.
      await setApprovalStatus(owner.userId, approval.id, "pending");
      return apiError(c, 409, "run_in_progress", "Another Chusky request is already running for this user.");
    }
    try {
      if (approval.toolSlug === "CHUCK_START_PHONE_CALL") {
        try {
          validateNativeToolArguments(approval.toolSlug, approval.args);
          await nativeTool(owner.userId, approval.toolSlug, approval.args);
          await setApprovalStatus(owner.userId, approval.id, "consumed");
          const label = "Phone call";
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
        const result = await runAgent(owner.userId, approval.request, approval.history, approval.model, undefined, c.req.raw.signal, undefined, approval.id, undefined, await sdkAgentOptions({ budget: run.budget, tools: run.tools, skills: run.skills }, run.id, thread.id, run.agentInstructions));
        run.status = "completed"; run.output = result.text; run.cost = result.cost; session.totalCost = (session.totalCost ?? 0) + (result.cost ?? 0); run.error = undefined; thread.history.push({ role: "user", content: approval.request }, { role: "assistant", content: result.text });
      } catch (error) { run.status = "failed"; run.error = { code: "resume_failed", message: error instanceof Error ? error.message : "Approval resume failed" }; }
      run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; await saveSession(owner.userId, session); await persistSdkCompanyRun(run); return c.json(runView(thread.id, run));
    } finally { await releaseUserLock(owner.userId, token); }
  });
}
