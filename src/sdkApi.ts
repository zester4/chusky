import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Readable } from "node:stream";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { getAuth } from "./auth.js";
import { ApprovalRequiredError, createTrigger, deleteTrigger, disconnectConnectedAccount, fetchModels, getConnectionUrl, getToolkitStatesPage, listConnectedAccounts, listMeetingComposioCapabilities, listTriggers, listAvailableTriggerToolkits, listAvailableTriggerTypes, runAgent, searchTools, setTriggerState, transcribeAudio, queueVideoWorkflow, type AgentToolActivity } from "./agent.js";
import { deleteR2Object, inspectR2Object, r2Configured, readR2Object, signR2Download, signR2Upload } from "./lib/storage/r2.js";
import { isSafeWebhookUrl, sealWebhookSecret } from "./lib/webhooks.js";
import { enqueueA2APushNotification, enqueueSdkWebhook } from "./lib/webhookOutbox.js";
import { extractMediaText, indexExtractedDocument } from "./lib/knowledge/ingest.js";
import { vectorConfigured } from "./lib/knowledge/vector.js";
import { acquireUserLock, addRecallMeeting, appendMessages, appendCompanyAuditEvent, canSpend, cancelMission, cancelMissionTasks, cancelTask, checkRateLimit, claimApproval, completeCompanyRunSummary, completeMissionStep, createMeetingRoom, createMission, createTask, createWebTelegramLinkCode, deleteMeetingContact, deleteMeetingRoom, findCompanyBrandingByDomain, getApproval, getAgentRun, getCalendarMeetingPreparation, getCompanyBranding, getDaytonaWorkspace, getMeetingRepresentativeProfile, getMeetingRoom, getMission, getOutbox, getRecallMeeting, getSession, getTask, getTelegramUserIdForWebAuth, getTriggerEvent, isDurableStore, listApprovals, listAgentRuns, listCalendarMeetingPreparations, listChannelIdentities, listCliDevices, listMeetingContacts, listPhoneCalls, listMeetingRooms, listRecallMeetings, listWorkspaceMeetingPointers, listJobs, listOutbox, listReminders, listTasks, listMissions, listHandoffRecords, getHandoffRecord, listVideoJobs, getVideoJob, listCompanyAuditEvents, listCompanyRunSummaries, listCompanyUsagePeriods, missionProof, pauseMission, replanMission, resumeMission, resumeMissionFromProviderEvent, setMissionUpdateNotifier, startMission, updateMission, updateTask, updateMeetingRoom, updateOutbox, updateVideoJob, registerImageAsset, releaseUserLock, renewUserLock, retryTask, saveCompanyBranding, saveCompanyRunSummary, saveHandoffRecord, saveSession, setApprovalStatus, setLiveVoicePreference, setModel, setVoiceReplies, updateMeetingRepresentativeProfile, getReminder, updateReminder, getJob, updateJob, readScratchpad, writeScratchpad, clearScratchpad, searchMemories, upsertMemoryAndContext, forgetMemory, revokeCliDeviceHash, recordMissionEvidence, verifyMission, repairMission, type CompanyBranding, type CompanyRunSummary, type MeetingRoomPolicy, type MeetingRoomRecord, type SdkProjectRecord, type SdkRunArtifact, type SdkRunRecord, type SdkThreadRecord, type MissionA2APushNotificationConfig } from "./store.js";
import { monitoringSnapshot } from "./monitoring.js";
import { listJobOccurrences } from "./store.js";
import { logger } from "./logger.js";
import { enqueueTaskWorkflow } from "./triggerWorkflow.js";
import { enqueueTaskWithClaim } from "./taskEnqueue.js";
import { findMissionApprovalTarget, resumeMissionTaskAfterApproval } from "./missionApproval.js";
import type { ContentPart } from "./types.js";
import { FLUX_TTS_VOICES } from "./voiceSettings.js";
import { listBlandCuratedVoices } from "./calls/blandVoices.js";
import { createLinkCode, identityFingerprint, unlinkChannelIdentity, updateLinkedChannelIdentity } from "./channels/identity.js";
import type { ChannelProvider } from "./channels/contracts.js";
import type { VoiceCallProfileInput } from "./calls/voiceProfile.js";
import { isBlandVoiceConfigured } from "./calls/bland.js";
import { isTwilioVoiceConfigured } from "./calls/twilio.js";
import { cancelJob, cancelReminder, nativeTool, pauseJob, pauseReminder, resumeJob, resumeReminder, runJobNow, runReminderNow, scheduleJob, setReminder } from "./nativeTools.js";
import { defaultMediaInstruction } from "./mediaInput.js";

import { validateNativeToolArguments } from "./agentTools.js";
import { chuckTools } from "./agentTools.js";
import { listSkillFiles, readSkillFile, searchSkills } from "./skills/catalog.js";
import { daytonaEngine } from "./lib/daytona/engine.js";
import { requestDelegationCancellation } from "./subagents/executor.js";
import { SELF_SERVICE_PROJECT_SCOPES } from "./developerProjects.js";
import { cancelAutomaticCalendarMeetingJoins, getRecallMeetingForUser, joinPreparedCalendarMeeting, joinRecallMeeting, leaveRecallMeeting, lookupRecallMeetingContext, prepareRecallMeetingMission } from "./meetings/service.js";
import { MEETING_REPRESENTATIVE_NATIVE_TOOLS } from "./meetings/representative.js";
import { addCustomMcpServer, connectMcpServer, disconnectMcpServer, listMcpCatalogForUser, listMcpConnections } from "./mcp/client.js";
import { beginMcpOAuth, finishMcpOAuth } from "./mcp/oauth.js";
import { createComposerWorkflow, listComposerWorkflows, reconcileComposerWorkflow, rejectComposerApproval, startComposerWorkflow, updateComposerWorkflow, type ComposerStageInput } from "./workflows/composer.js";
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
import { contextPrompt, selectContext, upsertContextNode } from "./contextGraph.js";
import { createDepartmentHandoff, listDepartments, listDepartmentSpaces, provisionDepartment } from "./departments.js";
import { getOutcomePackage, listOutcomePackages, planOutcome } from "./outcomes/catalog.js";
import { scheduleMissionSteps } from "./missionScheduler.js";
import { getAutonomySnapshot } from "./autonomy/queue.js";
import { runDueAutonomyWatches } from "./autonomy/reconciliation.js";

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
function validMissionWebhookSignature(raw: string, headers: Headers): boolean {
  const secret = config.missionWebhookSecret;
  if (!secret) return false;
  const supplied = headers.get("X-Chusky-Mission-Signature") ?? headers.get("X-Chusky-Signature") ?? "";
  if (!supplied) return false;
  const timestamp = headers.get("X-Chusky-Webhook-Timestamp");
  if (timestamp) {
    const parsed = Number(timestamp);
    if (!Number.isFinite(parsed) || Math.abs(Date.now() - parsed * 1000) > 5 * 60 * 1000) return false;
  }
  const payload = timestamp ? `${timestamp}.${raw}` : raw;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function missionA2AStatus(mission: { status: string }): "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled" {
  if (mission.status === "completed") return "completed";
  if (mission.status === "failed" || mission.status === "cancelled") return mission.status === "failed" ? "failed" : "canceled";
  if (mission.status === "waiting" || mission.status === "blocked" || mission.status === "paused") return "input-required";
  if (mission.status === "queued") return "submitted";
  return "working";
}
type A2AOwner = SdkOwner;
type A2AJsonRpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type A2AJsonRpcId = string | number | null;
const A2A_PROTOCOL_VERSION = "1.0";
const A2A_COMPATIBLE_VERSIONS = new Set(["0.3", "1.0"]);
const A2A_CONTENT_TYPE = "application/a2a+json";
function a2aState(mission: { status: string }): string {
  const state = missionA2AStatus(mission);
  return state === "submitted" ? "TASK_STATE_SUBMITTED"
    : state === "working" ? "TASK_STATE_WORKING"
      : state === "input-required" ? "TASK_STATE_INPUT_REQUIRED"
        : state === "completed" ? "TASK_STATE_COMPLETED"
          : state === "failed" ? "TASK_STATE_FAILED" : "TASK_STATE_CANCELED";
}
function a2aContextId(owner: A2AOwner): string { return `ctx_${digestKey(`a2a:${owner.projectId}:${owner.externalId}`).slice(0, 40)}`; }
function normalizeA2AContextId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}
function a2aTaskView(owner: A2AOwner, mission: any) {
  const statusText = typeof mission.nextAction === "string" ? mission.nextAction : undefined;
  return {
    id: mission.id,
    contextId: normalizeA2AContextId(mission.a2aContextId) ?? a2aContextId(owner),
    status: {
      state: a2aState(mission),
      timestamp: new Date(mission.updatedAt).toISOString(),
      ...(statusText ? { message: { role: "ROLE_AGENT", parts: [{ text: statusText.slice(0, 2000) }] } } : {}),
    },
    ...(mission.status === "completed" ? { artifacts: [{ artifactId: `${mission.id}:proof`, name: "Mission proof", parts: [{ data: missionProof(mission) }] }] } : {}),
    ...(mission.status !== "completed" ? { artifacts: [] } : {}),
  };
}
function a2aJsonRpcResult(c: any, id: A2AJsonRpcId, result: unknown, status = 200) { c.header("Content-Type", A2A_CONTENT_TYPE); return c.json({ jsonrpc: "2.0", id, result }, status); }
function a2aJsonRpcError(c: any, id: A2AJsonRpcId, code: number, message: string, status = 400) { c.header("Content-Type", A2A_CONTENT_TYPE); return c.json({ jsonrpc: "2.0", id, error: { code, message } }, status); }
function a2aTextMessage(params: unknown): { text: string; taskId?: string; contextId?: string } | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const value = params as Record<string, unknown>;
  const message = value.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const parts = (message as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return undefined;
  const text = parts.filter((part): part is Record<string, unknown> => Boolean(part && typeof part === "object" && !Array.isArray(part)))
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean).join("\n").trim().slice(0, 32_000);
  if (!text) return undefined;
  const taskId = typeof (message as Record<string, unknown>).taskId === "string" ? String((message as Record<string, unknown>).taskId) : typeof value.taskId === "string" ? value.taskId : undefined;
  const contextId = normalizeA2AContextId((message as Record<string, unknown>).contextId) ?? normalizeA2AContextId(value.contextId);
  return { text, ...(taskId ? { taskId } : {}), ...(contextId ? { contextId } : {}) };
}
type A2APushConfigInput = { taskId?: unknown; id?: unknown; url?: unknown; token?: unknown; authentication?: { scheme?: unknown; schemes?: unknown; credentials?: unknown } };
function a2aPushConfigView(taskId: string, config: MissionA2APushNotificationConfig) {
  return {
    taskId,
    id: config.id,
    url: config.url,
    ...(config.authentication?.schemes.length ? { authentication: { schemes: config.authentication.schemes } } : {}),
  };
}
function a2aPushConfigResult(method: string, taskId: string, config: MissionA2APushNotificationConfig): Record<string, unknown> {
  const view = a2aPushConfigView(taskId, config);
  if (method === "CreateTaskPushNotificationConfig" || method === "GetTaskPushNotificationConfig") return view;
  const { taskId: _taskId, ...legacyView } = view;
  return { taskId, pushNotificationConfig: legacyView };
}
function normalizeA2APushConfig(input: unknown): MissionA2APushNotificationConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A2A pushNotificationConfig is required.");
  const value = input as A2APushConfigInput;
  let url: URL;
  try { url = new URL(String(value.url ?? "")); } catch { throw new Error("A2A pushNotificationConfig.url must be a valid HTTPS URL."); }
  if (!isSafeWebhookUrl(url)) throw new Error("A2A push notification URLs must use a public HTTPS endpoint.");
  const id = typeof value.id === "string" && /^[A-Za-z0-9_.-]{1,160}$/.test(value.id) ? value.id : `a2apush_${randomUUID()}`;
  const auth = value.authentication && typeof value.authentication === "object" ? value.authentication : undefined;
  const schemes = auth ? (Array.isArray(auth.schemes) ? auth.schemes : [auth.scheme]).filter((item): item is string => typeof item === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(item)).slice(0, 8) : [];
  const credentials = auth && typeof auth.credentials === "string" && auth.credentials.length <= 4000 ? auth.credentials : undefined;
  const token = typeof value.token === "string" && value.token.length <= 4000 ? value.token : undefined;
  return {
    id,
    url: url.toString().slice(0, 2000),
    signingSecretCiphertext: sealWebhookSecret(`a2a_${randomBytes(24).toString("base64url")}`),
    ...(token ? { tokenCiphertext: sealWebhookSecret(token) } : {}),
    ...(schemes.length ? { authentication: { schemes, ...(credentials ? { credentialsCiphertext: sealWebhookSecret(credentials) } : {}) } } : {}),
    createdAt: Date.now(),
  };
}
async function attachA2APushConfig(owner: A2AOwner, taskId: string, input: unknown): Promise<MissionA2APushNotificationConfig> {
  const config = normalizeA2APushConfig(input);
  const updated = await updateMission(owner.userId, taskId, (mission) => ({ a2aPushNotifications: [...(mission.a2aPushNotifications ?? []).filter((item) => item.id !== config.id), config].slice(-10) }));
  if (!updated) throw new Error("A2A task not found.");
  return updated.a2aPushNotifications?.find((item) => item.id === config.id) ?? config;
}
async function enqueueA2AMissionUpdate(mission: any): Promise<void> {
  if (!Array.isArray(mission.a2aPushNotifications) || mission.a2aPushNotifications.length === 0) return;
  const payload = {
    statusUpdate: {
      taskId: mission.id,
      contextId: normalizeA2AContextId(mission.a2aContextId) ?? `ctx_${digestKey(`a2a:${mission.userId}:${mission.id}`).slice(0, 40)}`,
      status: { state: a2aState(mission), timestamp: new Date(mission.updatedAt).toISOString() },
      final: ["completed", "failed", "cancelled"].includes(mission.status),
    },
  };
  await Promise.all(mission.a2aPushNotifications.map((item: MissionA2APushNotificationConfig) => enqueueA2APushNotification(mission.userId, mission.id, item, payload, mission.version)));
}
function a2aPageSize(params: unknown): number { const value = params && typeof params === "object" && !Array.isArray(params) ? Number((params as Record<string, unknown>).pageSize ?? 20) : 20; return Number.isFinite(value) ? Math.max(1, Math.min(100, Math.floor(value))) : 20; }
async function createA2ATask(owner: A2AOwner, body: Record<string, unknown>, idempotencyKey?: string) {
  const outcomeSlug = typeof body.outcome === "string" ? body.outcome : undefined;
  const planned = outcomeSlug ? planOutcome(outcomeSlug, body.input && typeof body.input === "object" ? body.input as Record<string, unknown> : {}) : undefined;
  const objective = typeof body.objective === "string" ? body.objective.trim() : planned?.objective ?? "";
  const title = typeof body.title === "string" ? body.title.trim() : planned?.package.name ?? "Chusky delegated outcome";
  const definitionOfDone = typeof body.definitionOfDone === "string" ? body.definitionOfDone.trim() : planned?.definitionOfDone ?? "The requested outcome is verified and evidence is attached.";
  const contextId = normalizeA2AContextId(body.contextId);
  if (!objective || !title || !definitionOfDone) throw new Error("A2A tasks require objective, title, and definitionOfDone (or a valid outcome package).");
  const mission = await createMission(owner.userId, { title, objective, definitionOfDone, requiredEvidence: planned?.package.evidenceRequired, steps: planned?.steps, idempotencyKey, budget: planned?.package.budget, a2aContextId: contextId });
  const started = mission.status === "queued" ? await startMission(owner.userId, mission.id) : mission;
  if (!started) throw new Error("The delegated task is no longer startable.");
  const task = await createTask(owner.userId, { title: `A2A: ${started.title}`, objective: started.objective, missionId: started.id, runAt: Date.now(), maxAttempts: 3 });
  const workflowRunId = await enqueueTaskWithClaim(owner.userId, task.id, task.runAt ?? Date.now(), sdkTaskWorkflowEnqueuer);
  if (!workflowRunId) throw new Error("A task enqueue is already in progress; retry the request shortly.");
  const linked = await updateMission(owner.userId, started.id, (latest) => ({ rootTaskId: latest.rootTaskId ?? task.id, steps: latest.steps.map((step) => ({ ...step, taskId: step.id === latest.currentStepId ? task.id : step.taskId })) }));
  const finalMission = linked ?? started;
  return { mission: finalMission, task: a2aTaskView(owner, finalMission) };
}
function streamA2ATask(c: any, id: A2AJsonRpcId, owner: A2AOwner, taskId: string) {
  return streamSSE(c, async (stream) => {
    let lastVersion = -1;
    for (let attempt = 0; attempt < 120; attempt++) {
      const mission = await getMission(owner.userId, taskId);
      if (!mission) {
        await stream.writeSSE({ data: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message: "Task not found." } }) });
        return;
      }
      if (mission.version !== lastVersion) {
        lastVersion = mission.version;
        const contextId = a2aTaskView(owner, mission).contextId;
        const event = mission.status === "completed" && missionProof(mission)
          ? { statusUpdate: { taskId: mission.id, contextId, status: { state: a2aState(mission), timestamp: new Date(mission.updatedAt).toISOString() }, final: true }, task: a2aTaskView(owner, mission) }
          : { statusUpdate: { taskId: mission.id, contextId, status: { state: a2aState(mission), timestamp: new Date(mission.updatedAt).toISOString() }, final: ["completed", "failed", "cancelled"].includes(mission.status) }, task: a2aTaskView(owner, mission) };
        await stream.writeSSE({ data: JSON.stringify({ jsonrpc: "2.0", id, result: event }) });
        if (["completed", "failed", "cancelled"].includes(mission.status)) return;
      }
      await stream.sleep(1000);
    }
  });
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
  "account:read",
  "threads:read", "threads:write", "agents:read", "agents:write", "workflows:read", "workflows:write",
  "tasks:read", "tasks:write", "approvals:read",
  "webhooks:read", "webhooks:write", "deliveries:read", "deliveries:write", "audit-events:read", "usage:read", "company:read",
  "apps:read", "apps:write", "triggers:read", "triggers:write",
  "calls:read", "calls:write", "voice:read", "voice:write", "meetings:read", "meetings:write",
  "channels:read", "channels:write", "devices:read", "devices:write", "reminders:read", "reminders:write",
  "jobs:read", "jobs:write", "memory:read", "memory:write", "scratchpad:read", "scratchpad:write",
  "mcp:read", "mcp:write",
  "missions:read", "missions:write", "context:read", "context:write", "departments:read", "departments:write", "outcomes:read", "outcomes:write",
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

/**
 * Resolve the organization/team boundary for a workspace meeting request.
 * Better Auth remains the source of truth for membership; the Chusky control
 * session only stores the room policy and safe pointers to owner records.
 */
async function meetingWorkspaceAccessForRequest(c: any, organizationId: string, teamId?: string): Promise<OrganizationAccess> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(organizationId)) return undefined;
  const principal = c.get("sdkPrincipal") as SdkPrincipal | undefined;
  if (principal?.organizationId) {
    // A project key identifies a workspace, but not a Better Auth team member.
    // Do not let it impersonate a team-scoped human membership.
    return principal.organizationId === organizationId && !teamId ? { id: organizationId, role: "api" } : undefined;
  }
  const access = await organizationAccessForRequest(c, organizationId);
  if (!access) return undefined;
  if (!teamId) return access;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(teamId)) return undefined;
  try {
    const teams = await (getAuth().api as any).listUserTeams({ headers: c.req.raw.headers, query: { organizationId } });
    return Array.isArray(teams) && teams.some((team) => team && team.id === teamId && team.organizationId === organizationId) ? access : undefined;
  } catch {
    return undefined;
  }
}

async function meetingRoomAccessForRequest(c: any, room: MeetingRoomRecord, manage = false): Promise<OrganizationAccess> {
  const access = await meetingWorkspaceAccessForRequest(c, room.organizationId, room.teamId);
  if (!access) return undefined;
  const webOwner = webProjectOwner(c);
  if (room.policy.visibility === "private" && access.role !== "api" && room.createdByWebAuthUserId !== webOwner?.id) return undefined;
  if (manage && access.role !== "owner" && access.role !== "admin" && access.role !== "api") return undefined;
  if (manage && room.policy.visibility === "private" && room.createdByWebAuthUserId !== webOwner?.id && access.role !== "api") return undefined;
  return access;
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

function meetingRoomView(room: MeetingRoomRecord) {
  return {
    id: room.id,
    organizationId: room.organizationId,
    ...(room.teamId ? { teamId: room.teamId } : {}),
    ...(room.projectId ? { projectId: room.projectId } : {}),
    name: room.name,
    description: room.description,
    policy: {
      defaultMode: room.policy.defaultMode,
      visibility: room.policy.visibility,
      transcriptRetentionDays: room.policy.transcriptRetentionDays,
      allowScreenUnderstanding: room.policy.allowScreenUnderstanding,
      requireApprovalForExternalActions: room.policy.requireApprovalForExternalActions,
      allowedComposioTools: room.policy.allowedComposioTools,
      allowedNativeTools: room.policy.allowedNativeTools,
    },
    meetingCount: room.meetingPointers?.length ?? 0,
    createdAt: new Date(room.createdAt).toISOString(),
    updatedAt: new Date(room.updatedAt).toISOString(),
  };
}

function meetingView(meeting: any) {
  return {
    id: meeting.id,
    ...(meeting.roomId ? { roomId: meeting.roomId } : {}),
    ...(meeting.organizationId ? { organizationId: meeting.organizationId } : {}),
    ...(meeting.teamId ? { teamId: meeting.teamId } : {}),
    ...(meeting.projectId ? { projectId: meeting.projectId } : {}),
    ...(meeting.visibility ? { visibility: meeting.visibility } : {}),
    platform: meeting.platform,
    interactionMode: meeting.interactionMode ?? "addressed",
    languageMode: meeting.languageMode ?? "english",
    languageHints: meeting.languageHints ?? [],
    keyterms: meeting.keyterms ?? [],
    capabilities: meeting.capabilities,
    runtimeState: meeting.runtimeState ?? (meeting.status === "ended" ? "ended" : "healthy"),
    turnMetrics: meeting.turnMetrics,
    timeline: (meeting.timeline ?? []).map((entry: any) => ({ ...entry, at: new Date(entry.at).toISOString() })),
    status: meeting.status,
    title: meeting.title,
    joinAt: meeting.joinAt,
    error: meeting.error ? "The meeting assistant could not complete this step. Check the meeting link and provider status." : undefined,
    providerStatusAt: meeting.providerStatusAt ? new Date(meeting.providerStatusAt).toISOString() : undefined,
    participantRoster: (meeting.participantRoster ?? []).map((person: any) => ({ ...person, updatedAt: new Date(person.updatedAt).toISOString() })),
    speakerEvents: (meeting.speakerEvents ?? []).map((entry: any) => ({ ...entry, at: new Date(entry.at).toISOString() })),
    history: (meeting.history ?? []).filter((message: any) => (message.role === "user" || message.role === "assistant") && typeof message.content === "string").slice(-20).map((message: any) => ({ role: message.role, content: String(message.content).slice(0, 3_000), createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : undefined })),
    outcome: meeting.outcome,
    outcomeFollowThrough: meeting.outcomeFollowThrough,
    outcomeStatus: meeting.outcomeStatus,
    outcomeNotificationStatus: meeting.outcomeNotificationStatus,
    createdAt: new Date(meeting.createdAt).toISOString(),
    updatedAt: new Date(meeting.updatedAt).toISOString(),
  };
}

function meetingRoomPolicyInput(value: unknown, fallback?: MeetingRoomPolicy): MeetingRoomPolicy | undefined {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) return undefined;
  const body = (value ?? {}) as Record<string, unknown>;
  const current = fallback ?? {
    defaultMode: "addressed" as const,
    visibility: "private" as const,
    allowScreenUnderstanding: false,
    requireApprovalForExternalActions: true,
    allowedComposioTools: [],
    allowedNativeTools: [],
  };
  const defaultMode = body.defaultMode === undefined ? current.defaultMode : body.defaultMode;
  const visibility = body.visibility === undefined ? current.visibility : body.visibility;
  const retention = body.transcriptRetentionDays === undefined ? current.transcriptRetentionDays : body.transcriptRetentionDays;
  if (defaultMode !== "addressed" && defaultMode !== "copilot" && defaultMode !== "representative") return undefined;
  if (visibility !== "private" && visibility !== "team" && visibility !== "organization") return undefined;
  if (retention !== undefined && retention !== 1 && retention !== 7 && retention !== 30) return undefined;
  const list = (input: unknown, previous: string[], max: number) => input === undefined ? previous : Array.isArray(input) && input.every((item) => typeof item === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,150}$/.test(item)) ? [...new Set(input)].slice(0, max) : undefined;
  const allowedComposioTools = list(body.allowedComposioTools, current.allowedComposioTools, 100);
  const allowedNativeTools = list(body.allowedNativeTools, current.allowedNativeTools, 50);
  if (!allowedComposioTools || !allowedNativeTools) return undefined;
  return {
    defaultMode,
    visibility,
    ...(retention !== undefined ? { transcriptRetentionDays: retention } : {}),
    allowScreenUnderstanding: body.allowScreenUnderstanding === undefined ? current.allowScreenUnderstanding : body.allowScreenUnderstanding === true,
    requireApprovalForExternalActions: body.requireApprovalForExternalActions === undefined ? current.requireApprovalForExternalActions : body.requireApprovalForExternalActions !== false,
    allowedComposioTools,
    allowedNativeTools,
  };
}
function memoryView(memory: {
  id: string; category: string; key: string; value: string; confidence: number; source?: string;
  sensitivity: string; projectId?: string; personKey?: string; createdAt: number; updatedAt: number;
  reviewAt?: number; expiresAt?: number;
}) {
  return {
    id: memory.id,
    category: memory.category,
    key: memory.key,
    value: memory.value,
    confidence: memory.confidence,
    source: memory.source,
    sensitivity: memory.sensitivity,
    projectId: memory.projectId,
    personKey: memory.personKey,
    reviewAt: memory.reviewAt ? new Date(memory.reviewAt).toISOString() : undefined,
    expiresAt: memory.expiresAt ? new Date(memory.expiresAt).toISOString() : undefined,
    createdAt: new Date(memory.createdAt).toISOString(),
    updatedAt: new Date(memory.updatedAt).toISOString(),
  };
}
function approvalView(approval: { id: string; status: string; toolSlug: string; args: Record<string, unknown>; request?: string; channelProvider?: string; handoffId?: string; createdAt: number; expiresAt: number }) {
  return { id: approval.id, status: approval.status, toolSlug: approval.toolSlug, args: approval.args, request: approval.request, channelProvider: approval.channelProvider, handoffId: approval.handoffId, createdAt: new Date(approval.createdAt).toISOString(), expiresAt: new Date(approval.expiresAt).toISOString() };
}

function threadView(thread: SdkThreadRecord) { return { id: thread.id, externalId: thread.externalId, metadata: thread.metadata, createdAt: new Date(thread.createdAt).toISOString(), updatedAt: new Date(thread.updatedAt).toISOString() }; }
function runView(threadId: string, run: SdkRunRecord) {
  const { agentInstructions: _privateInstructions, companyProjectId: _privateCompanyProjectId, ...visible } = run;
  return { ...visible, threadId, createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString() };
}

/** Persist a run update against the latest account snapshot so a long-running
 * request does not overwrite unrelated account changes made after it started. */
async function persistSdkRunSnapshot(
  userId: number,
  threadId: string,
  run: SdkRunRecord,
  historyAppend: SdkThreadRecord["history"] = [],
  costIncrement = 0,
): Promise<void> {
  const session = await getSession(userId);
  const thread = session.sdkThreads?.find((item) => item.id === threadId);
  const stored = thread?.runs.find((item) => item.id === run.id);
  if (!thread || !stored) return;

  const mergedEvents = new Map<string, SdkRunRecord["events"][number]>();
  for (const item of [...stored.events, ...run.events]) mergedEvents.set(item.id, item);
  const orderedEvents = [...mergedEvents.values()].sort((left, right) => left.at - right.at);
  const activityEvents = orderedEvents.filter((item) => item.type === "run.tool_activity").slice(-200);
  const otherEvents = orderedEvents.filter((item) => item.type !== "run.tool_activity").slice(-200);
  const events = [...activityEvents, ...otherEvents].sort((left, right) => left.at - right.at);
  const preserveCancellation = stored.status === "cancelled" && run.status !== "cancelled";
  Object.assign(stored, run, { events });
  if (preserveCancellation) {
    stored.status = "cancelled";
    stored.approvalId = undefined;
  }
  if (!preserveCancellation && run.status === "completed" && historyAppend.length) {
    thread.history.push(...historyAppend);
    session.totalCost = (session.totalCost ?? 0) + costIncrement;
  }
  run.events = events;
  run.status = stored.status;
  thread.updatedAt = Math.max(thread.updatedAt, run.updatedAt);
  await saveSession(userId, session);
  await persistSdkCompanyRun(stored);
}

/** Project generated files into an owner-safe run payload. Never expose bytes or workspace paths. */
export function sdkRunArtifacts(generatedFiles: NonNullable<Awaited<ReturnType<typeof runAgent>>["generatedFiles"]> | undefined): SdkRunArtifact[] | undefined {
  if (!generatedFiles?.length) return undefined;
  return generatedFiles.map(({ artifactId, name, contentType, type, data }) => ({
    id: artifactId,
    name,
    type: type as SdkRunArtifact["type"],
    contentType,
    size: data.byteLength,
  }));
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
function reminderView(reminder: Awaited<ReturnType<typeof getReminder>>) { return reminder ? { ...reminder, runAt: new Date(reminder.runAt).toISOString(), createdAt: new Date(reminder.createdAt).toISOString() } : undefined; }
function jobView(job: Awaited<ReturnType<typeof getJob>>) { return job ? { ...job, createdAt: new Date(job.createdAt).toISOString() } : undefined; }
function occurrenceView(occurrence: Awaited<ReturnType<typeof listJobOccurrences>>[number]) { return { ...occurrence, createdAt: new Date(occurrence.createdAt).toISOString(), updatedAt: new Date(occurrence.updatedAt).toISOString(), ...(occurrence.startedAt ? { startedAt: new Date(occurrence.startedAt).toISOString() } : {}), ...(occurrence.completedAt ? { completedAt: new Date(occurrence.completedAt).toISOString() } : {}) }; }
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
  const defaultKind = verified.length === 1
    ? verified[0].contentType.startsWith("image/") ? "image" : verified[0].contentType.startsWith("video/") ? "video" : verified[0].contentType.startsWith("audio/") ? "attachment" : "document"
    : "attachment";
  const parts: ContentPart[] = [{ type: "text", text: input || defaultMediaInstruction(defaultKind) }];
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

type AccountHistoryMessage = { role: "user" | "assistant"; content: string; createdAt?: number };

function dashboardRequest(c: any): boolean {
  return Boolean(c.get("webAuthUserId"));
}

function dashboardAgentHistory(c: any, session: Awaited<ReturnType<typeof getSession>>, threadHistory: AccountHistoryMessage[]): AccountHistoryMessage[] {
  if (!dashboardRequest(c) || !session.history.length) return threadHistory;
  // Keep the SDK thread as a UI projection while the account session remains
  // the canonical private conversation shared with iMessage and other private
  // channel adapters. Remove entries already projected into the thread without
  // collapsing repeated user messages with identical text.
  const remaining = new Map<string, number>();
  for (const message of session.history) {
    const key = `${message.role}\u0000${message.content}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const threadOnly = threadHistory.filter((message) => {
    const key = `${message.role}\u0000${message.content}`;
    const count = remaining.get(key) ?? 0;
    if (!count) return true;
    remaining.set(key, count - 1);
    return false;
  });
  return [...session.history, ...threadOnly];
}

function accountHistoryView(session: Awaited<ReturnType<typeof getSession>>): AccountHistoryMessage[] {
  return session.history.slice(-(config.maxHistory * 2)).map((message) => ({
    role: message.role,
    content: message.content,
    ...(typeof message.createdAt === "number" ? { createdAt: message.createdAt } : {}),
  }));
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

/** Apply an owner-scoped SDK mutation with a durable 24-hour replay record. */
async function sdkMutation(c: any, fingerprint: string, execute: (userId: number) => Promise<unknown>, status = 200): Promise<Response> {
  const userId = sdkUser(c)!.userId;
  const current = await getSession(userId);
  const prior = idempotency(c, current, fingerprint);
  if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request.") as Response;
  if (prior.replay !== undefined) return c.json(prior.replay, status) as Response;
  const response = await execute(userId);
  if (prior.key) {
    // Re-read after the mutation: pause/resume/run update the canonical
    // reminder/job record, and saving the pre-mutation session would clobber it.
    const fresh = await getSession(userId);
    fresh.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() };
    await saveSession(userId, fresh);
  }
  return c.json(response, status) as Response;
}

async function sdkAutonomyMutation(c: any, userId: number, fingerprint: string, execute: () => Promise<unknown>): Promise<Response> {
  const session = await getSession(userId);
  const prior = idempotency(c, session, fingerprint);
  if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request.") as Response;
  if (prior.replay !== undefined) return c.json(prior.replay) as Response;
  const lockToken = randomUUID();
  if (!(await acquireUserLock(userId, lockToken, 300))) return apiError(c, 409, "autonomy_busy", "Another autonomy operation is already running for this owner.") as Response;
  const renewal = setInterval(() => { void renewUserLock(userId, lockToken, 300).catch(() => undefined); }, 60_000);
  try {
    const response = await execute();
    if (prior.key) { const fresh = await getSession(userId); fresh.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() }; await saveSession(userId, fresh); }
    return c.json(response) as Response;
  } finally { clearInterval(renewal); await releaseUserLock(userId, lockToken); }
}

/** Public v1 API for a self-hosted instance. Keep CLI and Telegram routes private. */
export function registerSdkApi(app: Hono): void {
  setMissionUpdateNotifier(enqueueA2AMissionUpdate);
  // A2A is the agent-to-agent boundary. It deliberately reuses API-key-scoped
  // identity and mission ownership instead of creating a second tenant model.
  const a2aAgentCard = (c: any) => {
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    c.header("A2A-Version", A2A_PROTOCOL_VERSION);
    return c.json({
      name: "Chusky Outcome Runtime",
      description: "Persistent, governed business outcomes across tools, departments, meetings, and channels.",
      version: A2A_PROTOCOL_VERSION,
      documentationUrl: `${new URL(c.req.url).origin}/docs`,
      url: new URL(c.req.url).origin,
      protocolVersion: A2A_PROTOCOL_VERSION,
      supportedInterfaces: [{ url: `${new URL(c.req.url).origin}/a2a/rpc`, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION }],
      capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "Chusky API key" } },
      security: [{ bearerAuth: [] }],
      skills: [
        ...listOutcomePackages().map((item) => ({ id: item.slug, name: item.name, description: item.description, tags: [item.department], inputModes: ["text/plain"], outputModes: ["text/plain", "application/json"] })),
        ...(["CHUCK_TOOL_PREFLIGHT", "CHUCK_INTEGRATION_HEALTH", "CHUCK_ARTIFACT_QA", "CHUCK_FILE_BRIDGE", "CHUCK_MEDIA_BRIDGE", "CHUCK_TOOL_RECOVERY"] as const).flatMap((slug) => {
          const tool = chuckTools.find((candidate) => candidate.function.name === slug);
          if (!tool) return [];
          const name: Record<typeof slug, string> = {
            CHUCK_TOOL_PREFLIGHT: "Native tool preflight",
            CHUCK_INTEGRATION_HEALTH: "Connected integration health",
            CHUCK_ARTIFACT_QA: "Document artifact quality assurance",
            CHUCK_FILE_BRIDGE: "Approval-gated artifact transfer",
            CHUCK_MEDIA_BRIDGE: "Approval-gated image transfer",
            CHUCK_TOOL_RECOVERY: "Tool failure recovery inspection",
          };
          return [{ id: slug, name: name[slug], description: tool.function.description, tags: ["tool-reliability", "native-tools"], inputModes: ["text/plain"], outputModes: ["text/plain", "application/json"], examples: [`Use ${slug} through a governed Chusky task; preserve the normal policy and approval requirements.`] }];
        }),
      ],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain", "application/json"],
    });
  };
  // Keep the historical Chusky path and expose the standard root discovery path
  // used by clients that resolve /.well-known directly.
  app.get("/.well-known/agent-card.json", a2aAgentCard);
  app.get("/a2a/.well-known/agent-card.json", a2aAgentCard);
  app.use("/a2a/*", async (c, next) => {
    const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const principal = await authorized(token);
    if (!principal) return apiError(c, 401, "invalid_api_key", "A valid Chusky project API key is required.");
    let requestedScope = c.req.method === "GET" ? "missions:read" : "missions:write";
    // JSON-RPC uses POST for both reads and writes. Inspect a clone so the
    // handler can still consume the original body, while keeping read-only
    // GetTask/ListTasks/SubscribeToTask calls on read scope.
    if (c.req.method === "POST" && (c.req.path === "/a2a/rpc" || c.req.path === "/a2a/v1")) {
      const rpcBody = await c.req.raw.clone().json().catch(() => undefined) as { method?: unknown } | undefined;
      if (["GetTask", "ListTasks", "SubscribeToTask", "GetTaskPushNotificationConfig", "ListTaskPushNotificationConfigs", "tasks/pushNotificationConfig/get", "tasks/pushNotificationConfig/list"].includes(String(rpcBody?.method ?? ""))) requestedScope = "missions:read";
    }
    if (!principal.root && !principal.scopes.includes("*") && !principal.scopes.includes(requestedScope) && !principal.scopes.includes("missions:*")) return apiError(c, 403, "insufficient_scope", `This API key lacks ${requestedScope}.`);
    const requestedVersion = c.req.header("A2A-Version")?.trim() || A2A_PROTOCOL_VERSION;
    if (!A2A_COMPATIBLE_VERSIONS.has(requestedVersion)) return apiError(c, 400, "a2a_version_not_supported", `Supported A2A versions: ${[...A2A_COMPATIBLE_VERSIONS].join(", ")}.`);
    c.header("A2A-Version", requestedVersion === "0.3" ? A2A_PROTOCOL_VERSION : requestedVersion);
    const externalId = (c.req.header("X-Chusky-User-Id") ?? "").trim();
    if (!externalId || externalId.length > 200) return apiError(c, 400, "missing_user", "X-Chusky-User-Id is required for A2A tenant binding.");
    (c.set as (key: string, value: unknown) => void)("a2aOwner", { externalId, userId: userIdFor(externalId, principal.projectId), projectId: principal.projectId, ...(principal.organizationId ? { organizationId: principal.organizationId } : {}) });
    (c.set as (key: string, value: unknown) => void)("a2aPrincipal", principal);
    await next();
  });
  app.post("/a2a/tasks", async (c) => {
    const owner = (c as any).get("a2aOwner") as SdkOwner;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const created = await createA2ATask(owner, body, c.req.header("Idempotency-Key") ?? undefined);
      return c.json({ id: created.mission.id, type: "task", status: missionA2AStatus(created.mission), mission: created.mission, artifacts: [] }, 202);
    } catch (error) { return apiError(c, 400, "task_create_failed", error instanceof Error ? error.message : "A2A task could not be created."); }
  });
  app.get("/a2a/tasks/:taskId", async (c) => { const owner = (c as any).get("a2aOwner") as SdkOwner; const mission = await getMission(owner.userId, c.req.param("taskId")); return mission ? c.json({ id: mission.id, type: "task", status: missionA2AStatus(mission), mission, artifacts: [] }) : apiError(c, 404, "task_not_found", "A2A task not found."); });
  app.post("/a2a/tasks/:taskId/cancel", async (c) => { const owner = (c as any).get("a2aOwner") as SdkOwner; const mission = await cancelMission(owner.userId, c.req.param("taskId"), "Cancelled by the delegating agent."); if (!mission) return apiError(c, 409, "task_not_cancellable", "A2A task is already finished or not owned by this key."); if (mission.rootTaskId) await cancelTask(owner.userId, mission.rootTaskId); return c.json({ id: mission.id, type: "task", status: missionA2AStatus(mission), mission }); });
  app.post("/a2a/tasks/:taskId/send", async (c) => { const owner = (c as any).get("a2aOwner") as SdkOwner; const body = await c.req.json().catch(() => ({})) as { message?: unknown }; const mission = await getMission(owner.userId, c.req.param("taskId")); if (!mission) return apiError(c, 404, "task_not_found", "A2A task not found."); if (typeof body.message !== "string" || !body.message.trim()) return apiError(c, 400, "invalid_message", "message is required."); const updated = await updateMission(owner.userId, mission.id, { checkpoint: body.message.slice(0, 8000), nextAction: "Incorporate the delegating agent's update in the next bounded slice." }); return c.json({ id: mission.id, type: "task", status: missionA2AStatus(updated ?? mission), mission: updated ?? mission }); });
  app.get("/a2a/tasks/:taskId/stream", async (c) => {
    const owner = (c as any).get("a2aOwner") as SdkOwner;
    const taskId = c.req.param("taskId");
    return streamSSE(c, async (stream) => {
      let lastVersion = -1;
      for (let attempt = 0; attempt < 60; attempt++) {
        const mission = await getMission(owner.userId, taskId);
        if (!mission) { await stream.writeSSE({ event: "error", data: JSON.stringify({ code: "task_not_found" }) }); return; }
        if (mission.version !== lastVersion) { lastVersion = mission.version; await stream.writeSSE({ id: String(mission.version), event: "status", data: JSON.stringify({ id: mission.id, status: missionA2AStatus(mission), mission }) }); }
        if (["completed", "failed", "cancelled"].includes(mission.status)) return;
        await stream.sleep(1000);
      }
    });
  });

  // Standards-shaped A2A 1.0 JSON-RPC binding. The existing REST task routes
  // above remain available for Chusky-native clients; interoperable agents
  // use SendMessage/GetTask/ListTasks/CancelTask and the SSE methods here.
  const handleA2ARpc = async (c: any) => {
    const owner = c.get("a2aOwner") as A2AOwner;
    const body = await c.req.json().catch(() => undefined) as A2AJsonRpcRequest | undefined;
    const id: A2AJsonRpcId = body && (typeof body.id === "string" || typeof body.id === "number" || body.id === null) ? body.id : null;
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") return a2aJsonRpcError(c, id, -32600, "A valid JSON-RPC 2.0 request is required.");
    const method = body.method;
    const params = body.params;
    const record = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const taskId = typeof record.id === "string" ? record.id : typeof record.taskId === "string" ? record.taskId : undefined;
    try {
      if (method === "SendMessage" || method === "message/send") {
        const message = a2aTextMessage(params);
        if (!message) return a2aJsonRpcError(c, id, -32602, "message.parts must contain at least one text part.");
        if (message.taskId) {
          const mission = await getMission(owner.userId, message.taskId);
          if (!mission) return a2aJsonRpcError(c, id, -32001, "Task not found.", 404);
          if (message.contextId && normalizeA2AContextId(mission.a2aContextId) && message.contextId !== mission.a2aContextId) return a2aJsonRpcError(c, id, -32003, "The task belongs to a different context.", 409);
          if (["completed", "failed", "cancelled"].includes(mission.status)) return a2aJsonRpcError(c, id, -32002, "A terminal task cannot accept another message.", 409);
          const updated = await updateMission(owner.userId, mission.id, { checkpoint: message.text, nextAction: "Incorporate the delegating agent's message in the next bounded slice." });
          return a2aJsonRpcResult(c, id, { task: a2aTaskView(owner, updated ?? mission) });
        }
        const created = await createA2ATask(owner, {
          objective: message.text,
          title: typeof record.title === "string" ? record.title : "A2A delegated task",
          definitionOfDone: typeof record.definitionOfDone === "string" ? record.definitionOfDone : "The requested task is completed and its result is verified.",
          contextId: message.contextId,
        }, c.req.header("Idempotency-Key") ?? undefined);
        const configuration = record.configuration && typeof record.configuration === "object" && !Array.isArray(record.configuration) ? record.configuration as Record<string, unknown> : undefined;
        const pushInput = configuration?.taskPushNotificationConfig ?? configuration?.pushNotificationConfig;
        if (pushInput) await attachA2APushConfig(owner, created.mission.id, pushInput);
        const current = pushInput ? await getMission(owner.userId, created.mission.id) : created.mission;
        return a2aJsonRpcResult(c, id, { task: a2aTaskView(owner, current ?? created.mission) }, 200);
      }
      if (method === "GetTask" || method === "tasks/get") {
        if (!taskId) return a2aJsonRpcError(c, id, -32602, "id is required.");
        const mission = await getMission(owner.userId, taskId);
        if (!mission) return a2aJsonRpcError(c, id, -32001, "Task not found.", 404);
        const task = a2aTaskView(owner, mission);
        return a2aJsonRpcResult(c, id, method === "GetTask" ? task : { task });
      }
      if (method === "ListTasks" || method === "tasks/list") {
        const missions = await listMissions(owner.userId);
        const result = page(missions, typeof record.pageToken === "string" ? record.pageToken : undefined, String(a2aPageSize(params)));
        return a2aJsonRpcResult(c, id, { tasks: result.data.map((mission) => a2aTaskView(owner, mission)), nextPageToken: result.nextCursor ?? "" });
      }
      if (["CreateTaskPushNotificationConfig", "tasks/pushNotificationConfig/create", "tasks/pushNotificationConfig/set"].includes(method)) {
        if (!taskId) return a2aJsonRpcError(c, id, -32602, "taskId is required.");
        const configInput = method === "CreateTaskPushNotificationConfig" ? record.pushNotificationConfig ?? record.config ?? record : record.pushNotificationConfig ?? record.config;
        const saved = await attachA2APushConfig(owner, taskId, configInput);
        return a2aJsonRpcResult(c, id, a2aPushConfigResult(method, taskId, saved));
      }
      if (["GetTaskPushNotificationConfig", "tasks/pushNotificationConfig/get"].includes(method)) {
        if (!taskId) return a2aJsonRpcError(c, id, -32602, "taskId is required.");
        const mission = await getMission(owner.userId, taskId);
        if (!mission) return a2aJsonRpcError(c, id, -32001, "Task not found.", 404);
        const configId = method === "GetTaskPushNotificationConfig"
          ? (typeof record.id === "string" && record.id !== taskId ? record.id : typeof record.configId === "string" ? record.configId : undefined)
          : (typeof record.pushNotificationConfigId === "string" ? record.pushNotificationConfigId : typeof record.configId === "string" ? record.configId : undefined);
        const saved = mission.a2aPushNotifications?.find((item) => !configId || item.id === configId);
        return saved ? a2aJsonRpcResult(c, id, a2aPushConfigResult(method, taskId, saved)) : a2aJsonRpcError(c, id, -32004, "Push notification configuration not found.", 404);
      }
      if (["ListTaskPushNotificationConfigs", "tasks/pushNotificationConfig/list"].includes(method)) {
        if (!taskId) return a2aJsonRpcError(c, id, -32602, "taskId is required.");
        const mission = await getMission(owner.userId, taskId);
        if (!mission) return a2aJsonRpcError(c, id, -32001, "Task not found.", 404);
        const configs = (mission.a2aPushNotifications ?? []).map((item) => a2aPushConfigView(taskId, item));
        return a2aJsonRpcResult(c, id, method === "ListTaskPushNotificationConfigs" ? { configs, nextPageToken: "" } : { pushNotificationConfigs: configs });
      }
      if (["DeleteTaskPushNotificationConfig", "tasks/pushNotificationConfig/delete"].includes(method)) {
        if (!taskId) return a2aJsonRpcError(c, id, -32602, "taskId is required.");
        const configId = method === "DeleteTaskPushNotificationConfig"
          ? (typeof record.id === "string" && record.id !== taskId ? record.id : typeof record.configId === "string" ? record.configId : undefined)
          : (typeof record.pushNotificationConfigId === "string" ? record.pushNotificationConfigId : typeof record.configId === "string" ? record.configId : undefined);
        if (!configId) return a2aJsonRpcError(c, id, -32602, "configId is required.");
        const mission = await getMission(owner.userId, taskId);
        if (!mission) return a2aJsonRpcError(c, id, -32001, "Task not found.", 404);
        const updated = await updateMission(owner.userId, taskId, (current) => ({ a2aPushNotifications: (current.a2aPushNotifications ?? []).filter((item) => item.id !== configId) }));
        if (!updated) return a2aJsonRpcError(c, id, -32004, "Push notification configuration not found.", 404);
        return a2aJsonRpcResult(c, id, method === "DeleteTaskPushNotificationConfig" ? null : {});
      }
      if (method === "CancelTask" || method === "tasks/cancel") {
        if (!taskId) return a2aJsonRpcError(c, id, -32602, "id is required.");
        const mission = await cancelMission(owner.userId, taskId, "Cancelled by the delegating agent.");
        if (!mission) return a2aJsonRpcError(c, id, -32002, "Task is not cancellable or was not found.", 409);
        if (mission.rootTaskId) await cancelTask(owner.userId, mission.rootTaskId);
        const task = a2aTaskView(owner, mission);
        return a2aJsonRpcResult(c, id, method === "CancelTask" ? task : { task });
      }
      if (method === "SendStreamingMessage" || method === "message/stream") {
        const message = a2aTextMessage(params);
        if (!message) return a2aJsonRpcError(c, id, -32602, "message.parts must contain at least one text part.");
        const created = message.taskId
          ? await getMission(owner.userId, message.taskId).then((mission) => mission ? { mission, task: a2aTaskView(owner, mission) } : undefined)
          : await createA2ATask(owner, { objective: message.text, title: "A2A delegated task", definitionOfDone: "The requested task is completed and its result is verified.", contextId: message.contextId }, c.req.header("Idempotency-Key") ?? undefined);
        if (!created) return a2aJsonRpcError(c, id, -32001, "Task not found.", 404);
        return streamA2ATask(c, id, owner, created.mission.id);
      }
      if (method === "SubscribeToTask" || method === "tasks/subscribe") {
        if (!taskId) return a2aJsonRpcError(c, id, -32602, "id is required.");
        const mission = await getMission(owner.userId, taskId);
        if (!mission) return a2aJsonRpcError(c, id, -32001, "Task not found.", 404);
        return streamA2ATask(c, id, owner, mission.id);
      }
      return a2aJsonRpcError(c, id, -32601, `Unsupported A2A method: ${method}.`);
    } catch (error) {
      return a2aJsonRpcError(c, id, -32000, error instanceof Error ? error.message : "A2A request failed.", 400);
    }
  };
  app.post("/a2a/rpc", handleA2ARpc);
  app.post("/a2a/v1", handleA2ARpc);

  app.get("/mcp/oauth/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const providerError = c.req.query("error");
    if (providerError) return c.html("<!doctype html><title>Chusky connection not completed</title><p>Chusky authorization was not completed. You can close this window and try again.</p>", 400);
    if (!state || !code) return c.html("<!doctype html><title>Chusky connection not completed</title><p>The authorization response was incomplete. You can close this window and try again.</p>", 400);
    try {
      await finishMcpOAuth(state, code);
      return c.html("<!doctype html><title>Chusky connected</title><main><h1>Chusky is connected</h1><p>You can close this window and return to Chusky.</p></main>");
    } catch (error) {
      logger.warn({ err: error }, "MCP OAuth callback failed");
      return c.html("<!doctype html><title>Chusky connection failed</title><main><h1>Chusky could not connect</h1><p>The authorization could not be completed. Return to Chusky and try again.</p></main>", 400);
    }
  });

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
    const monitoring = monitoringSnapshot();
    const vectorCheck = !vectorConfigured() ? "disabled" : monitoring.vector.degraded ? "degraded" : "configured";
    return c.json({ ok: ok && vectorCheck !== "degraded", status: ok && vectorCheck !== "degraded" ? "operational" : "degraded", persistence: redis ? "redis" : "memory", checks: { ...checks, vector: vectorCheck }, channels: { telegram: true, cli: true, slack: config.slackEnabled, whatsapp: config.whatsappEnabled, sendblue: config.sendblueEnabled, sms: config.twilioSmsEnabled, xchat: config.xchatEnabled }, monitoring });
  });

  app.get("/v1/account/overview", async (c) => {
    const owner = sdkUser(c)!;
    const webAuthUserId = (c as any).get("webAuthUserId") as string | undefined;
    const session = await getSession(owner.userId);
    const [channels, devices, reminders, jobs, workspace, deliveries, memory] = await Promise.all([
      listChannelIdentities(owner.userId),
      listCliDevices(owner.userId),
      listReminders(owner.userId),
      listJobs(owner.userId),
      getDaytonaWorkspace(owner.userId),
      listOutbox(undefined, 500, owner.userId),
      // Keep the overview's memory projection identical to /v1/memory:
      // expired facts must not reappear in another dashboard surface.
      searchMemories(owner.userId, undefined, { limit: 20 }),
    ]);
    return c.json({
      model: session.model,
      voiceReplies: Boolean(session.voiceReplies),
      voicePreferences: session.voicePreferences ?? {},
      approvals: session.approvals.filter((item) => item.status === "pending" && item.expiresAt > Date.now()).map((item) => ({ id: item.id, toolSlug: item.toolSlug, request: item.request, status: item.status, channelProvider: item.channelProvider, createdAt: new Date(item.createdAt).toISOString(), expiresAt: new Date(item.expiresAt).toISOString() })),
      channels: channels.filter((item) => !item.disabledAt).map((item) => ({ id: identityFingerprint(item), provider: item.provider, externalUserId: item.externalUserId, workspaceId: item.workspaceId, displayName: item.displayName, verifiedAt: new Date(item.verifiedAt).toISOString(), proactiveOptIn: item.proactiveOptIn !== false })),
      reminders: reminders.map((item) => ({ ...item, runAt: new Date(item.runAt).toISOString(), createdAt: new Date(item.createdAt).toISOString() })),
      jobs: jobs.map((item) => ({ ...item, createdAt: new Date(item.createdAt).toISOString() })),
      memory: memory.map(memoryView),
      scratchpad: Object.entries(session.scratchpad).map(([key, item]) => ({ key, content: item.content, updatedAt: new Date(item.updatedAt).toISOString() })),
      triggers: session.triggerIds,
      devices: devices.filter((item) => !item.revokedAt).map(({ tokenHash, ...item }) => ({ ...item, id: createHash("sha256").update(tokenHash).digest("hex").slice(0, 24), createdAt: new Date(item.createdAt).toISOString(), lastSeenAt: new Date(item.lastSeenAt).toISOString() })),
      workspace: workspace ? { sandboxId: workspace.sandboxId, name: workspace.name, lastKnownState: workspace.lastKnownState, createdAt: new Date(workspace.createdAt).toISOString(), updatedAt: new Date(workspace.updatedAt).toISOString(), ptySessions: workspace.ptySessions?.length ?? 0, lastUrl: workspace.browser?.lastUrl } : null,
      webhooks: (session.sdkWebhooks ?? []).filter((item) => !item.disabledAt).map(({ secretCiphertext: _secret, ...item }) => ({ ...item, createdAt: new Date(item.createdAt).toISOString() })),
      telegramLink: { linked: Boolean(webAuthUserId && await getTelegramUserIdForWebAuth(webAuthUserId)) },
      deliveries: deliveries.filter((item) => item.userId === owner.userId && !item.webhook).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map((item) => ({ id: item.id, provider: item.provider, status: item.status, kind: item.kind, attempts: item.attempts, providerStatus: item.providerStatus, lastError: item.lastError, durationMs: item.deliveredAt ? Math.max(0, item.deliveredAt - item.createdAt) : undefined, createdAt: new Date(item.createdAt).toISOString(), updatedAt: new Date(item.updatedAt).toISOString(), deliveredAt: item.deliveredAt ? new Date(item.deliveredAt).toISOString() : undefined })),
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

  app.get("/v1/account/history", async (c) => {
    const session = await getSession(sdkUser(c)!.userId);
    return c.json({ data: accountHistoryView(session) });
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

  app.get("/v1/meetings/rooms", async (c) => {
    const organizationId = (c.req.query("organizationId") ?? "").trim();
    if (!organizationId) return apiError(c, 400, "organization_required", "organizationId is required to list meeting rooms.");
    if (!(await meetingWorkspaceAccessForRequest(c, organizationId))) return apiError(c, 404, "workspace_not_found", "Workspace not found or you are not a member.");
    const rooms = await listMeetingRooms(organizationId, 100);
    const visible = [] as MeetingRoomRecord[];
    for (const room of rooms) if (await meetingRoomAccessForRequest(c, room)) visible.push(room);
    return c.json({ data: visible.map(meetingRoomView) });
  });

  app.post("/v1/meetings/rooms", async (c) => {
    const owner = sdkUser(c)!;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
    const teamId = typeof body.teamId === "string" ? body.teamId.trim() : undefined;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!organizationId || !name) return apiError(c, 400, "invalid_meeting_room", "organizationId and name are required.");
    const access = await meetingWorkspaceAccessForRequest(c, organizationId, teamId);
    if (!access || (access.role !== "owner" && access.role !== "admin" && access.role !== "api")) return apiError(c, 403, "meeting_room_forbidden", "Only workspace administrators can create meeting rooms.");
    const policy = meetingRoomPolicyInput(body.policy);
    if (!policy) return apiError(c, 400, "invalid_meeting_room_policy", "Meeting room policy is invalid.");
    if (policy.visibility === "team" && !teamId) return apiError(c, 400, "team_required", "A team-scoped room must be assigned to a Better Auth team.");
    if (teamId && !/^[A-Za-z0-9_-]{1,128}$/.test(teamId)) return apiError(c, 400, "invalid_team", "teamId is invalid.");
    try {
      const room = await createMeetingRoom({ id: `room_${randomUUID()}`, organizationId, ...(teamId ? { teamId } : {}), ...(typeof body.projectId === "string" && body.projectId.trim() ? { projectId: body.projectId.trim() } : {}), name, ...(typeof body.description === "string" && body.description.trim() ? { description: body.description.trim() } : {}), createdByWebAuthUserId: webProjectOwner(c)?.id ?? `api:${owner.projectId}`, policy, createdAt: Date.now(), updatedAt: Date.now() });
      return c.json(meetingRoomView(room), 201);
    } catch (error) { return apiError(c, 400, "meeting_room_create_failed", error instanceof Error ? error.message : "Meeting room could not be created."); }
  });

  app.patch("/v1/meetings/rooms/:roomId", async (c) => {
    if (!/^room_[A-Za-z0-9_-]{1,96}$/.test(c.req.param("roomId"))) return apiError(c, 400, "invalid_meeting_room", "Invalid meeting room ID.");
    const room = await getMeetingRoom(c.req.param("roomId"));
    if (!room || !(await meetingRoomAccessForRequest(c, room, true))) return apiError(c, 404, "meeting_room_not_found", "Meeting room not found or you do not have permission to manage it.");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const policy = body.policy === undefined ? undefined : meetingRoomPolicyInput(body.policy, room.policy);
    if (body.policy !== undefined && !policy) return apiError(c, 400, "invalid_meeting_room_policy", "Meeting room policy is invalid.");
    const teamId = body.teamId === null ? undefined : typeof body.teamId === "string" ? body.teamId.trim() : room.teamId;
    if (teamId && !(await meetingWorkspaceAccessForRequest(c, room.organizationId, teamId))) return apiError(c, 403, "team_forbidden", "You are not a member of that workspace team.");
    if (policy?.visibility === "team" && !teamId) return apiError(c, 400, "team_required", "A team-scoped room must be assigned to a Better Auth team.");
    try {
      const updated = await updateMeetingRoom(room.id, {
        ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
        ...(body.description === null ? { description: undefined } : typeof body.description === "string" ? { description: body.description.trim() } : {}),
        ...(teamId ? { teamId } : { teamId: undefined }),
        ...(typeof body.projectId === "string" ? { projectId: body.projectId.trim() || undefined } : {}),
        ...(policy ? { policy } : {}),
      });
      return updated ? c.json(meetingRoomView(updated)) : apiError(c, 404, "meeting_room_not_found", "Meeting room not found.");
    } catch (error) { return apiError(c, 400, "meeting_room_update_failed", error instanceof Error ? error.message : "Meeting room could not be updated."); }
  });

  app.delete("/v1/meetings/rooms/:roomId", async (c) => {
    if (!/^room_[A-Za-z0-9_-]{1,96}$/.test(c.req.param("roomId"))) return apiError(c, 400, "invalid_meeting_room", "Invalid meeting room ID.");
    const room = await getMeetingRoom(c.req.param("roomId"));
    if (!room || !(await meetingRoomAccessForRequest(c, room, true))) return apiError(c, 404, "meeting_room_not_found", "Meeting room not found or you do not have permission to manage it.");
    const activePointers = await Promise.all((room.meetingPointers ?? []).map(async (pointer) => {
      const meeting = await getRecallMeeting(pointer.ownerUserId, pointer.meetingId);
      return meeting && ["creating", "scheduled", "joining", "waiting_room", "in_call"].includes(meeting.status);
    }));
    if (activePointers.some(Boolean)) return apiError(c, 409, "meeting_room_active", "Leave active meetings before deleting this room.");
    return (await deleteMeetingRoom(room.id)) ? c.body(null, 204) : apiError(c, 404, "meeting_room_not_found", "Meeting room not found.");
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
  app.get("/v1/meetings/capabilities", async (c) => {
    const owner = sdkUser(c)!;
    const query = (c.req.query("query") ?? "").trim().slice(0, 120);
    const limit = Math.max(1, Math.min(500, Number(c.req.query("limit") ?? 250) || 250));
    const nativeTools = MEETING_REPRESENTATIVE_NATIVE_TOOLS.map((slug) => {
      const definition = chuckTools.find((tool) => tool.function.name === slug);
      return { slug, description: definition?.function.description ?? slug };
    });
    let connections = [] as Awaited<ReturnType<typeof listConnectedAccounts>>;
    let composioTools = [] as Awaited<ReturnType<typeof listMeetingComposioCapabilities>>;
    let composioAvailable = true;
    try { connections = await listConnectedAccounts(owner.userId); } catch { composioAvailable = false; }
    try { composioTools = await listMeetingComposioCapabilities(owner.userId, { query, limit }); } catch { composioAvailable = false; }
    return c.json({ nativeTools, composioTools, connections, composioAvailable });
  });

  app.get("/v1/meetings", async (c) => {
    const owner = sdkUser(c)!;
    const organizationId = (c.req.query("organizationId") ?? "").trim();
    if (organizationId) {
      if (!(await meetingWorkspaceAccessForRequest(c, organizationId))) return apiError(c, 404, "workspace_not_found", "Workspace not found or you are not a member.");
      const rooms = await listMeetingRooms(organizationId, 100);
      const visibleRooms = [] as MeetingRoomRecord[];
      for (const room of rooms) if (await meetingRoomAccessForRequest(c, room)) visibleRooms.push(room);
      const visibleRoomIds = new Set(visibleRooms.map((room) => room.id));
      const pointers = (await listWorkspaceMeetingPointers(organizationId, 100)).filter((pointer) => visibleRoomIds.has(pointer.roomId));
      const meetings = (await Promise.all(pointers.map(async (pointer) => {
        const meeting = await getRecallMeeting(pointer.ownerUserId, pointer.meetingId);
        return meeting ? meetingView(meeting) : undefined;
      }))).filter(Boolean);
      return c.json({ rooms: visibleRooms.map(meetingRoomView), preparations: [], meetings, contacts: [] });
    }
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
    return c.json({ preparations: prepared, meetings: records.map(meetingView), contacts: contacts.map((contact) => ({ ...contact, userId: undefined, followUpAt: contact.followUpAt ? new Date(contact.followUpAt).toISOString() : undefined, createdAt: new Date(contact.createdAt).toISOString(), updatedAt: new Date(contact.updatedAt).toISOString() })) });
  });

  app.delete("/v1/meetings/contacts/:contactId", async (c) => {
    const removed = await deleteMeetingContact(sdkUser(c)!.userId, c.req.param("contactId"));
    return removed ? c.body(null, 204) : apiError(c, 404, "meeting_contact_not_found", "Meeting follow-up contact not found.");
  });

  app.get("/v1/apps", async (c) => {
    const rawLimit = Number(c.req.query("limit") ?? 30);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.floor(rawLimit))) : 30;
    const cursor = c.req.query("cursor")?.trim();
    const search = c.req.query("search")?.trim().slice(0, 120);
    try {
      const page = await getToolkitStatesPage(sdkUser(c)!.userId, { limit, enrich: true, ...(cursor ? { cursor } : {}), ...(search ? { search } : {}) });
      return c.json({ data: page.items, nextCursor: page.cursor, currentPage: page.currentPage, totalPages: page.totalPages, total: page.totalItems, pageSize: limit });
    }
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
    const catalog = await listMcpCatalogForUser(sdkUser(c)!.userId);
    return c.json({ data: catalog.servers, ...(catalog.errors.length ? { errors: catalog.errors } : {}) });
  });

  app.get("/v1/workflows/composer", async (c) => c.json({ data: await listComposerWorkflows(sdkUser(c)!.userId) }));
  app.post("/v1/workflows/composer", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.name !== "string" || !Array.isArray(body.stages)) return apiError(c, 400, "invalid_workflow", "name and stages are required.");
    try { return c.json(await createComposerWorkflow(sdkUser(c)!.userId, { name: body.name, description: typeof body.description === "string" ? body.description : undefined, stages: body.stages as ComposerStageInput[] }), 201); }
    catch (error) { return apiError(c, 400, "invalid_workflow", error instanceof Error ? error.message : "Workflow could not be created."); }
  });
  app.patch("/v1/workflows/composer/:workflowId", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try { const workflow = await updateComposerWorkflow(sdkUser(c)!.userId, c.req.param("workflowId"), { name: typeof body.name === "string" ? body.name : undefined, description: typeof body.description === "string" ? body.description : undefined, stages: Array.isArray(body.stages) ? body.stages as ComposerStageInput[] : undefined }); return workflow ? c.json(workflow) : apiError(c, 404, "workflow_not_found", "Workflow not found."); }
    catch (error) { return apiError(c, 400, "workflow_update_failed", error instanceof Error ? error.message : "Workflow could not be updated."); }
  });
  app.post("/v1/workflows/composer/:workflowId/start", async (c) => {
    try { const userId = sdkUser(c)!.userId; const started = await startComposerWorkflow(userId, c.req.param("workflowId")); const workflow = await reconcileComposerWorkflow(userId, c.req.param("workflowId"), sdkTaskWorkflowEnqueuer); const firstTask = started.tasks[0]; const workflowRunId = firstTask ? (await getTask(userId, firstTask.id))?.workflowRunId : undefined; return c.json({ ...(workflow ?? started.workflow), ...(firstTask ? { taskId: firstTask.id } : {}), ...(workflowRunId ? { workflowRunId } : {}) }, 202); }
    catch (error) { return apiError(c, 400, "workflow_start_failed", error instanceof Error ? error.message : "Workflow could not be started."); }
  });

  app.post("/v1/mcp/oauth/start", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const serverId = typeof body.serverId === "string" ? body.serverId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(serverId)) return apiError(c, 400, "invalid_mcp_server", "serverId must contain 1-48 letters, numbers, underscores, or hyphens.");
    try { return c.json(await beginMcpOAuth(sdkUser(c)!.userId, serverId)); }
    catch (error) { return apiError(c, 400, "mcp_oauth_start_failed", error instanceof Error ? error.message : "MCP OAuth could not be started."); }
  });

  app.get("/v1/mcp/connections", async (c) => {
    try { return c.json({ data: await listMcpConnections(sdkUser(c)!.userId) }); }
    catch (error) { return apiError(c, 502, "mcp_connections_unavailable", error instanceof Error ? error.message : "MCP connections are temporarily unavailable."); }
  });

  app.post("/v1/mcp/custom-servers", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.name !== "string" || typeof body.url !== "string" || (body.auth !== "none" && body.auth !== "bearer")) return apiError(c, 400, "invalid_custom_mcp_server", "Provide a name, HTTPS MCP endpoint, and authentication type (none or bearer).");
    if (body.allowedTools !== undefined && (!Array.isArray(body.allowedTools) || body.allowedTools.length > config.mcpMaxToolsPerServer || !body.allowedTools.every((tool) => typeof tool === "string"))) return apiError(c, 400, "invalid_custom_mcp_tools", "allowedTools must be a bounded list of tool names.");
    try {
      const connection = await addCustomMcpServer(sdkUser(c)!.userId, { name: body.name, url: body.url, auth: body.auth, ...(Array.isArray(body.allowedTools) ? { allowedTools: body.allowedTools as string[] } : {}), requireApproval: body.requireApproval !== false }, typeof body.accessToken === "string" ? { accessToken: body.accessToken } : undefined);
      return c.json(connection, 201);
    } catch (error) { return apiError(c, 400, "mcp_custom_server_verification_failed", error instanceof Error ? error.message : "Could not verify and add the MCP server."); }
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
      const call = await nativeTool(owner.userId, "CHUCK_START_PHONE_CALL", { phoneNumber, purpose, callProfile: "personal", ...(body.profile ? { profile: body.profile as VoiceCallProfileInput } : {}) });
      if (!call || typeof call !== "object") throw new Error("Phone call did not return a call record");
      const record = call as { id?: unknown; provider?: unknown; direction?: unknown; phoneNumber?: unknown; purpose?: unknown; status?: unknown; error?: unknown; summary?: unknown; createdAt?: unknown; updatedAt?: unknown };
      if (typeof record.id !== "string" || typeof record.phoneNumber !== "string" || typeof record.purpose !== "string" || typeof record.status !== "string" || typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") throw new Error("Phone call returned an invalid record");
      const response = callView({ id: record.id, provider: typeof record.provider === "string" ? record.provider : undefined, direction: typeof record.direction === "string" ? record.direction : undefined, phoneNumber: record.phoneNumber, purpose: record.purpose, status: record.status, error: typeof record.error === "string" ? record.error : undefined, summary: typeof record.summary === "string" ? record.summary : undefined, createdAt: record.createdAt, updatedAt: record.updatedAt });
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
    const roomId = typeof body.roomId === "string" ? body.roomId.trim() : undefined;
    let room: MeetingRoomRecord | undefined;
    if (roomId) {
      room = await getMeetingRoom(roomId);
      if (!room || !(await meetingRoomAccessForRequest(c, room))) return apiError(c, 404, "meeting_room_not_found", "Meeting room not found or you are not a member of its team.");
      if (body.organizationId !== undefined && body.organizationId !== room.organizationId) return apiError(c, 400, "meeting_room_scope_mismatch", "organizationId does not match the selected meeting room.");
    } else if (body.organizationId !== undefined) {
      return apiError(c, 400, "meeting_room_required", "Select a meeting room when starting an organization-scoped meeting.");
    }
    const session = await getSession(owner.userId);
    const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify(body)}`).digest("hex");
    const prior = idempotency(c, session, fingerprint);
    if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request.");
    if (prior.replay) return c.json(prior.replay, 201);
    try {
      const result = await joinRecallMeeting(owner.userId, { ...body, ...(room ? { meetingRoom: { roomId: room.id, organizationId: room.organizationId, ...(room.teamId ? { teamId: room.teamId } : {}), ...(room.projectId ? { projectId: room.projectId } : {}), visibility: room.policy.visibility, policy: room.policy } } : {}) } as { meetingUrl: unknown; title?: unknown; joinAt?: unknown; interactionMode?: unknown; languageMode?: unknown; languageHints?: unknown; keyterms?: unknown; liveCaptions?: unknown; analyzeScreenShare?: unknown; transcriptRetentionDays?: unknown; clientName?: unknown; objective?: unknown; clientContext?: unknown; inheritMeetingId?: string; calendarPreparationId?: string; meetingRoom?: { roomId: string; organizationId: string; teamId?: string; projectId?: string; visibility: "private" | "team" | "organization"; policy: MeetingRoomPolicy } });
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
    const body = await c.req.json().catch(() => ({})) as { clientName?: unknown; objective?: unknown; clientContext?: unknown };
    const session = await getSession(owner.userId);
    const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify(body)}`).digest("hex");
    const prior = idempotency(c, session, fingerprint);
    if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request.");
    if (prior.replay) return c.json(prior.replay, 201);
    try {
      const result = await joinPreparedCalendarMeeting(owner.userId, c.req.param("preparationId"), body);
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

  // One read-only, owner-scoped projection for personal and company clients.
  // The projection never claims work; it lets a dashboard decide what to show
  // and lets an API consumer resume the exact next action from durable state.
  app.get("/v1/account/autonomy/queue", async (c) => {
    const owner = await callOwner(c);
    if (!owner) return apiError(c, 403, "owner_link_required", "Link this account to an owner before reading autonomy state.");
    const mode = c.req.query("mode") === "business" ? "business" : "personal";
    return c.json(await getAutonomySnapshot(owner.userId, mode));
  });

  app.post("/v1/account/autonomy/reconcile", async (c) => {
    const owner = await callOwner(c);
    if (!owner) return apiError(c, 403, "owner_link_required", "Link this account to an owner before running autonomy reconciliation.");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const mode = body.mode === "business" ? "business" : "personal";
    const maxWatches = body.maxWatches === undefined ? 8 : Math.max(1, Math.min(20, Number.isFinite(Number(body.maxWatches)) ? Math.floor(Number(body.maxWatches)) : 8));
    const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify({ mode, maxWatches })}`).digest("hex");
    return sdkAutonomyMutation(c, owner.userId, fingerprint, async () => ({ data: await runDueAutonomyWatches(owner.userId, { mode, maxWatches }) }));
  });

  app.get("/v1/account/projects/:projectId/autonomy/queue", async (c) => {
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && item.organizationId && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, false))) return apiError(c, 404, "not_found", "Company project not found.");
    const owner = (await linkedWebCallOwner(c)) ?? sdkUser(c);
    if (!owner) return apiError(c, 403, "owner_link_required", "Link this company project to an owner before reading autonomy state.");
    const policy = project.companyPolicy?.autonomy;
    return c.json(await getAutonomySnapshot(owner.userId, "business", policy ? {
      ...(policy.enabled !== undefined ? { enabled: policy.enabled } : {}),
      ...(policy.defaultAuthority ? { defaultAuthority: policy.defaultAuthority } : {}),
      ...(policy.allowedDomains ? { allowedDomains: [...policy.allowedDomains] } : {}),
      ...(policy.deniedDomains ? { deniedDomains: [...policy.deniedDomains] } : {}),
      ...(policy.maxChecksPerDay !== undefined ? { maxChecksPerDay: policy.maxChecksPerDay } : {}),
      ...(policy.maxAutonomousActionsPerDay !== undefined ? { maxAutonomousActionsPerDay: policy.maxAutonomousActionsPerDay } : {}),
      ...(policy.notifyOn ? { notifyOn: policy.notifyOn } : {}),
    } : {}));
  });

  app.post("/v1/account/projects/:projectId/autonomy/reconcile", async (c) => {
    const control = await getSession(0);
    const project = control.sdkProjects!.find((item) => item.id === c.req.param("projectId") && item.organizationId && !item.revokedAt);
    if (!project || !(await accountCanAccessProject(c, project, false))) return apiError(c, 404, "not_found", "Company project not found.");
    const owner = (await linkedWebCallOwner(c)) ?? sdkUser(c);
    if (!owner) return apiError(c, 403, "owner_link_required", "Link this company project to an owner before running autonomy reconciliation.");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const policy = project.companyPolicy?.autonomy;
    if (policy?.enabled === false) return apiError(c, 409, "autonomy_disabled", "Autonomy is disabled for this company project.");
    const maxWatches = body.maxWatches === undefined ? 8 : Math.max(1, Math.min(20, Number.isFinite(Number(body.maxWatches)) ? Math.floor(Number(body.maxWatches)) : 8));
    const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify({ maxWatches, projectId: project.id })}`).digest("hex");
    return sdkAutonomyMutation(c, owner.userId, fingerprint, async () => ({ data: await runDueAutonomyWatches(owner.userId, { mode: "business", maxWatches, profileOverrides: policy ? {
      ...(policy.enabled !== undefined ? { enabled: policy.enabled } : {}),
      ...(policy.allowedDomains ? { allowedDomains: [...policy.allowedDomains] } : {}),
      ...(policy.deniedDomains ? { deniedDomains: [...policy.deniedDomains] } : {}),
      ...(policy.maxChecksPerDay !== undefined ? { maxChecksPerDay: policy.maxChecksPerDay } : {}),
      ...(policy.maxAutonomousActionsPerDay !== undefined ? { maxAutonomousActionsPerDay: policy.maxAutonomousActionsPerDay } : {}),
    } : undefined }) }));
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
    if (dashboardRequest(c)) {
      const sharedHistory = dashboardAgentHistory(c, session, thread.history);
      thread.history = sharedHistory;
      session.history = sharedHistory;
    }
    const lockToken = randomUUID();
    if (!(await acquireUserLock(owner.userId, lockToken))) return apiError(c, 409, "run_in_progress", "Another Chusky request is already running for this user.");
    try {
    const now = Date.now(); const run: SdkRunRecord = { id: `run_${randomUUID()}`, status: body.wait === false ? "queued" : "running", ...(owner.organizationId ? { companyProjectId: owner.projectId } : {}), input: resolved.input, model: body.model ?? session.model, agentId: companyPolicy.agent?.id, agentName: companyPolicy.agent?.name, agentInstructions: companyPolicy.agent?.instructions, attachments: resolved.attachments, metadata: body.metadata, budget: body.budget, tools: body.tools, skills: body.skills, events: [event(body.wait === false ? "run.queued" : "run.started")], createdAt: now, updatedAt: now }; thread.runs.push(run);
    if (body.wait === false) {
      let task: Awaited<ReturnType<typeof createTask>>;
      try {
        task = await createTask(owner.userId, { title: (resolved.input || "SDK agent run").slice(0, 120), objective: resolved.input || "Process the verified attachments.", runAt: Date.now(), maxAttempts: 10, sdkRunId: run.id, sdkThreadId: thread.id, sdkInput: resolved.input, sdkAttachments: resolved.attachments, sdkModel: body.model ?? session.model, sdkTools: body.tools ? { allow: body.tools.allow, deny: body.tools.deny, requireApproval: body.tools.requireApproval } : undefined, sdkBudget: body.budget, sdkStartedAt: Date.now(), sdkSkills: body.skills, sdkInstructions: companyPolicy.agent?.instructions });
        const workflowRunId = await enqueueTaskWithClaim(owner.userId, task.id, task.runAt ?? Date.now(), sdkTaskWorkflowEnqueuer);
        if (!workflowRunId) throw new Error("A task enqueue is already in progress; retry the request shortly."); run.taskId = task.id; run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; const response = runView(thread.id, run); if (prior.key) session.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() }; await saveSession(owner.userId, session); await persistSdkCompanyRun(run); await notifyWebhooks(owner.userId, session.sdkWebhooks!, "run.queued", { threadId: thread.id, runId: run.id, taskId: task.id, status: run.status }); return c.json(response, 202);
      } catch (error) { if (task!) await cancelTask(owner.userId, task.id); thread.runs = thread.runs.filter((item) => item.id !== run.id); await saveSession(owner.userId, session); return apiError(c, 503, "run_enqueue_failed", error instanceof Error ? error.message : "The durable run could not be queued."); }
    }
    try { const result = await runAgent(owner.userId, resolved.message, thread.history, body.model ?? session.model, undefined, c.req.raw.signal, undefined, undefined, undefined, await sdkAgentOptions(body, run.id, thread.id, companyPolicy.agent?.instructions)); run.status = "completed"; run.output = result.text; run.artifacts = sdkRunArtifacts(result.generatedFiles); run.cost = result.cost; session.totalCost = (session.totalCost ?? 0) + (result.cost ?? 0); run.events.push(event("run.completed")); thread.history.push({ role: "user", content: `${resolved.input || "Attached file(s)"}${resolved.attachments.length ? `\n[Attachments: ${resolved.attachments.map((file) => file.name).join(", ")}]` : ""}` }, { role: "assistant", content: result.text }); }
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
    if (dashboardRequest(c)) {
      const sharedHistory = dashboardAgentHistory(c, session, thread.history);
      thread.history = sharedHistory;
      session.history = sharedHistory;
    }
    const lockToken = randomUUID();
    if (!(await acquireUserLock(owner.userId, lockToken))) return apiError(c, 409, "run_in_progress", "Another Chusky request is already running for this user.");
    const now = Date.now(); const run: SdkRunRecord = { id: `run_${randomUUID()}`, status: "running", ...(owner.organizationId ? { companyProjectId: owner.projectId } : {}), input: resolved.input, model: body.model ?? session.model, agentId: companyPolicy.agent?.id, agentName: companyPolicy.agent?.name, agentInstructions: companyPolicy.agent?.instructions, attachments: resolved.attachments, metadata: body.metadata, budget: body.budget, tools: body.tools, skills: body.skills, events: [event("run.started")], createdAt: now, updatedAt: now }; thread.runs.push(run); await persistSdkCompanyRun(run);
    await saveSession(owner.userId, session);
    const abort = new AbortController(); let clientDisconnected = false; const markClientDisconnected = () => { clientDisconnected = true; }; c.req.raw.signal.addEventListener("abort", markClientDisconnected, { once: true }); activeRuns.set(run.id, abort);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start: async (controller) => {
      const send = (event: unknown) => {
        if (clientDisconnected) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); }
        catch { clientDisconnected = true; }
      };
      const historyStart = thread.history.length;
      let costIncrement = 0;
      send({ type: "run.started", run: runView(thread.id, run) });
      try {
        const result = await runAgent(owner.userId, resolved.message, thread.history, body.model ?? session.model, (text) => {
          // Reuse the policy-owned status vocabulary that Telegram already
          // presents. Web and SDK consumers should not have to infer meaning
          // from internal CHUCK_/COMPOSIO_ tool slugs.
          send({ type: "run.status", runId: run.id, text: text.slice(0, 4000) });
        }, abort.signal, (text) => { run.events.push(event("run.delta", text)); send({ type: "run.delta", runId: run.id, text }); }, undefined, undefined, {
          ...await sdkAgentOptions(body, run.id, thread.id, companyPolicy.agent?.instructions),
          onToolActivity: (activity: AgentToolActivity) => {
            const activityEvent = { id: `evt_${randomUUID()}`, type: "run.tool_activity", at: Date.now(), ...activity };
            run.events.push(activityEvent);
            run.updatedAt = activityEvent.at;
            thread.updatedAt = activityEvent.at;
            return persistSdkRunSnapshot(owner.userId, thread.id, run).then(() => send({ runId: run.id, ...activityEvent }));
          },
        });
        if (abort.signal.aborted) {
          run.status = "cancelled";
          run.events.push(event("run.cancelled", "Run cancelled. Completed steps are preserved."));
          send({ type: "run.cancelled", run: runView(thread.id, run) });
        } else {
          run.status = "completed"; run.output = result.text; run.artifacts = sdkRunArtifacts(result.generatedFiles); run.cost = result.cost; costIncrement = result.cost ?? 0; run.events.push(event("run.completed")); thread.history.push({ role: "user", content: `${resolved.input || "Attached file(s)"}${resolved.attachments.length ? `\n[Attachments: ${resolved.attachments.map((file) => file.name).join(", ")}]` : ""}` }, { role: "assistant", content: result.text }); send({ type: "run.completed", run: runView(thread.id, run) });
        }
      } catch (error) {
        if (error instanceof ApprovalRequiredError) { run.status = "requires_approval"; run.approvalId = error.approvalId; run.events.push(event("run.approval_required")); const approval = await getApproval(owner.userId, error.approvalId); send({ type: "run.approval_required", run: runView(thread.id, run), approval }); }
        else if (abort.signal.aborted) { run.status = "cancelled"; run.events.push(event("run.cancelled")); send({ type: "run.cancelled", run: runView(thread.id, run) }); }
        else { run.status = "failed"; run.error = { code: "agent_error", message: error instanceof Error ? error.message : "Agent failed" }; run.events.push(event("run.failed", run.error.message)); send({ type: "run.failed", run: runView(thread.id, run), error: run.error }); }
      } finally {
        c.req.raw.signal.removeEventListener("abort", markClientDisconnected);
        activeRuns.delete(run.id);
        run.updatedAt = Date.now();
        thread.updatedAt = run.updatedAt;
        try {
          await persistSdkRunSnapshot(owner.userId, thread.id, run, run.status === "completed" ? thread.history.slice(historyStart) : [], costIncrement);
          const latestSession = await getSession(owner.userId);
          await notifyWebhooks(owner.userId, latestSession.sdkWebhooks!, `run.${run.status}`, { threadId: thread.id, runId: run.id, status: run.status });
        } catch (error) {
          logger.error({ err: error, runId: run.id }, "Could not persist or notify the final SDK run state");
        } finally {
          await releaseUserLock(owner.userId, lockToken);
          try { controller.close(); } catch { /* The browser may have left; the durable run is already settled. */ }
        }
      }
    }, cancel: () => { clientDisconnected = true; } });
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
     try { const resolved = await resolveRunInput(session, { input: prior.input, attachments: prior.attachments?.map((file) => file.id) }); const result = await runAgent(owner.userId, resolved.message, thread.history, run.model ?? session.model, undefined, c.req.raw.signal, undefined, undefined, undefined, await sdkAgentOptions({ budget: prior.budget, tools: prior.tools, skills: prior.skills }, run.id, thread.id, prior.agentInstructions)); run.status = "completed"; run.output = result.text; run.artifacts = sdkRunArtifacts(result.generatedFiles); run.cost = result.cost; session.totalCost = (session.totalCost ?? 0) + (result.cost ?? 0); run.events.push(event("run.completed")); thread.history.push({ role: "user", content: `${resolved.input || "Attached file(s)"}${resolved.attachments.length ? `\n[Attachments: ${resolved.attachments.map((file) => file.name).join(", ")}]` : ""}` }, { role: "assistant", content: result.text }); }
    catch (error) { run.status = "failed"; run.error = { code: "agent_error", message: error instanceof Error ? error.message : "Agent failed" }; run.events.push(event("run.failed", run.error.message)); }
    run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; await saveSession(owner.userId, session); await persistSdkCompanyRun(run); return c.json(runView(thread.id, run), 201);
  });
  app.post("/v1/threads/:threadId/runs/:runId/cancel", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const thread = session.sdkThreads!.find((item) => item.id === c.req.param("threadId")); const run = thread?.runs.find((item) => item.id === c.req.param("runId")); if (!thread || !run) return apiError(c, 404, "not_found", "Run not found."); if (!["queued", "running"].includes(run.status)) return apiError(c, 409, "run_not_cancellable", "Only a queued or running run can be cancelled."); if (run.taskId) await cancelTask(owner.userId, run.taskId); activeRuns.get(run.id)?.abort(); run.status = "cancelled"; run.events.push(event("run.cancelled")); run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt; await saveSession(owner.userId, session); await persistSdkCompanyRun(run); return c.json(runView(thread.id, run)); });
  app.get("/v1/approvals", async (c) => { const data = (await listApprovals(sdkUser(c)!.userId, 100)).filter((item) => item.status === "pending" && item.expiresAt > Date.now()).map(approvalView); return c.json({ data }); });
  app.get("/v1/tools", async (c) => {
    const query = (c.req.query("query") ?? "").trim(); const source = c.req.query("source"); const toolkit = (c.req.query("toolkit") ?? "").toLowerCase();
    const native = chuckTools.map((item) => ({ slug: item.function.name, description: item.function.description, source: "native" as const, parameters: item.function.parameters as Record<string, unknown>, execution: "durable_run" as const })).filter((item) => (!query || `${item.slug} ${item.description}`.toLowerCase().includes(query.toLowerCase())) && source !== "composio");
    let composio: any[] = [];
    if (source !== "native" && query) { try { composio = (await searchTools(sdkUser(c)!.userId, query)).slice(0, 50).map((item: any) => ({ slug: String(item.slug ?? item.name ?? ""), description: String(item.description ?? item.name ?? ""), source: "composio", toolkit: item.toolkit ?? item.appName, connected: Boolean(item.connection?.isActive ?? item.connected) })).filter((item: any) => item.slug); } catch { composio = []; } }
    const data = [...native, ...composio].filter((item: any) => !toolkit || String(item.toolkit ?? "").toLowerCase() === toolkit).slice(0, Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 50) || 50)));
    return c.json({ data });
  });
  app.get("/v1/tools/:slug", async (c) => { const slug = c.req.param("slug"); const native = chuckTools.find((item) => item.function.name === slug); if (native) return c.json({ slug, description: native.function.description, source: "native", parameters: native.function.parameters, execution: "durable_run" }); try { const matches = await searchTools(sdkUser(c)!.userId, slug); const item: any = matches.find((candidate: any) => String(candidate.slug ?? candidate.name) === slug); return item ? c.json({ slug, description: String(item.description ?? item.name ?? ""), source: "composio", toolkit: item.toolkit ?? item.appName, connected: Boolean(item.connection?.isActive ?? item.connected) }) : apiError(c, 404, "not_found", "Tool not found."); } catch { return apiError(c, 502, "tools_unavailable", "Tool catalogue is temporarily unavailable."); } });
  app.get("/v1/skills", async (c) => { try { const data = await searchSkills(c.req.query("query") ?? "", Number(c.req.query("limit") ?? 20)); return c.json({ data }); } catch (error) { return apiError(c, 500, "skills_unavailable", error instanceof Error ? error.message : "Skill catalogue unavailable."); } });
  app.get("/v1/skills/:name/files", async (c) => { try { const data = await listSkillFiles(c.req.param("name"), Number(c.req.query("maxFiles") ?? 100)); return c.json({ data }); } catch (error) { return apiError(c, 404, "skill_not_found", error instanceof Error ? error.message : "Skill not found."); } });
  app.get("/v1/skills/:name/files/read", async (c) => { try { return c.json(await readSkillFile(c.req.param("name"), c.req.query("path") ?? "SKILL.md", Number(c.req.query("maxChars") ?? 12000))); } catch (error) { return apiError(c, 404, "skill_file_not_found", error instanceof Error ? error.message : "Skill file not found."); } });
  app.get("/v1/artifacts", async (c) => { const session = await getSession(sdkUser(c)!.userId); const type = c.req.query("type"); const items = (session.artifacts ?? []).filter((item) => !type || item.type === type); const result = page(items, c.req.query("cursor"), c.req.query("limit")); return c.json({ data: result.data.map(artifactView), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }); });
  app.get("/v1/artifacts/:id", async (c) => { const artifact = (await getSession(sdkUser(c)!.userId)).artifacts?.find((item) => item.id === c.req.param("id")); return artifact ? c.json(artifactView(artifact)) : apiError(c, 404, "not_found", "Artifact not found."); });
  app.delete("/v1/artifacts/:id", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const index = (session.artifacts ?? []).findIndex((item) => item.id === c.req.param("id")); if (index < 0) return apiError(c, 404, "not_found", "Artifact not found."); session.artifacts!.splice(index, 1); await saveSession(owner.userId, session); return c.body(null, 204); });
  app.get("/v1/artifacts/:id/download", async (c) => { try { const delivery = await daytonaEngine.streamArtifact(sdkUser(c)!.userId, c.req.param("id")); return new Response(Readable.toWeb(delivery.stream) as unknown as any, { headers: { "Content-Type": delivery.contentType, "Content-Length": String(delivery.size), "Content-Disposition": `attachment; filename="${delivery.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`, "Cache-Control": "private, max-age=300" } }); } catch (error) { return apiError(c, 404, "artifact_unavailable", error instanceof Error ? error.message : "Artifact download unavailable."); } });
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
  app.get("/v1/deliveries", async (c) => { const data = (await listOutbox(undefined, 500, sdkUser(c)!.userId)).filter((item) => !item.webhook).sort((a, b) => b.createdAt - a.createdAt).map((item) => ({ id: item.id, provider: item.provider, status: item.status, kind: item.kind, attempts: item.attempts, providerStatus: item.providerStatus, lastError: item.lastError, durationMs: item.deliveredAt ? Math.max(0, item.deliveredAt - item.createdAt) : undefined, createdAt: new Date(item.createdAt).toISOString(), updatedAt: new Date(item.updatedAt).toISOString(), deliveredAt: item.deliveredAt ? new Date(item.deliveredAt).toISOString() : undefined })); return c.json({ data }); });
  app.post("/v1/deliveries/:deliveryId/confirm-delivered", async (c) => { const owner = sdkUser(c)!; const record = await getOutbox(c.req.param("deliveryId")); if (!record || record.userId !== owner.userId || record.webhook) return apiError(c, 404, "not_found", "Delivery not found."); if (record.status === "delivered" && record.providerStatus === "owner_confirmed_delivered") return c.json({ id: record.id, provider: record.provider, status: record.status, kind: record.kind, attempts: record.attempts, providerStatus: record.providerStatus, durationMs: record.deliveredAt ? Math.max(0, record.deliveredAt - record.createdAt) : undefined, createdAt: new Date(record.createdAt).toISOString(), updatedAt: new Date(record.updatedAt).toISOString(), deliveredAt: record.deliveredAt ? new Date(record.deliveredAt).toISOString() : undefined }); if (record.status !== "ambiguous") return apiError(c, 409, "delivery_not_ambiguous", "Only an ambiguous delivery can be confirmed after checking the destination."); const updated = await updateOutbox(record.id, { status: "delivered", deliveredAt: Date.now(), providerStatus: "owner_confirmed_delivered", leaseToken: undefined, leaseExpiresAt: undefined, lastError: undefined }); const value = updated ?? { ...record, status: "delivered" as const, providerStatus: "owner_confirmed_delivered", deliveredAt: Date.now() }; return c.json({ id: value.id, provider: value.provider, status: value.status, kind: value.kind, attempts: value.attempts, providerStatus: value.providerStatus, durationMs: value.deliveredAt ? Math.max(0, value.deliveredAt - value.createdAt) : undefined, createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString(), deliveredAt: value.deliveredAt ? new Date(value.deliveredAt).toISOString() : undefined }); });
  app.get("/v1/reminders", async (c) => c.json({ data: (await listReminders(sdkUser(c)!.userId)).map(reminderView) }));
  app.post("/v1/reminders", async (c) => { const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; const text = String(body.text ?? "").trim(); if (!text || text.length > 2000) return apiError(c, 400, "invalid_reminder", "text is required and must be 2000 characters or fewer."); try { return await sdkMutation(c, `POST:${c.req.path}:${JSON.stringify(body)}`, async (userId) => { const reminder = await setReminder(userId, { text, ...(body.delaySeconds !== undefined ? { delaySeconds: body.delaySeconds } : {}), ...(typeof body.runAt === "string" ? { runAt: body.runAt } : {}), ...(typeof body.mode === "string" ? { mode: body.mode } : {}), ...(body.links && typeof body.links === "object" ? { links: body.links } : {}), ...(typeof body.nextAction === "string" ? { nextAction: body.nextAction } : {}), ...(Array.isArray(body.preconditions) ? { preconditions: body.preconditions } : {}), ...(Array.isArray(body.postconditions) ? { postconditions: body.postconditions } : {}), ...(body.pollEverySeconds !== undefined ? { pollEverySeconds: body.pollEverySeconds } : {}) }); return reminderView(reminder); }, 201); } catch (error) { return apiError(c, 400, "reminder_create_failed", error instanceof Error ? error.message : "Reminder could not be scheduled."); } });
  app.delete("/v1/reminders/:id", async (c) => { try { await cancelReminder(sdkUser(c)!.userId, c.req.param("id")); return c.body(null, 204); } catch (error) { return apiError(c, 404, "reminder_not_found", error instanceof Error ? error.message : "Reminder not found."); } });
  app.post("/v1/reminders/:id/pause", async (c) => { try { const id = c.req.param("id"); return await sdkMutation(c, `POST:${c.req.path}:pause`, async (userId) => { const message = await pauseReminder(userId, id); return { message, data: reminderView(await getReminder(userId, id)) }; }); } catch (error) { return apiError(c, 409, "reminder_pause_failed", error instanceof Error ? error.message : "Reminder could not be paused."); } });
  app.post("/v1/reminders/:id/resume", async (c) => { try { const id = c.req.param("id"); return await sdkMutation(c, `POST:${c.req.path}:resume`, async (userId) => { const message = await resumeReminder(userId, id); return { message, data: reminderView(await getReminder(userId, id)) }; }); } catch (error) { return apiError(c, 409, "reminder_resume_failed", error instanceof Error ? error.message : "Reminder could not be resumed."); } });
  app.post("/v1/reminders/:id/run", async (c) => { try { const id = c.req.param("id"); return await sdkMutation(c, `POST:${c.req.path}:run`, async (userId) => { const run = await runReminderNow(userId, id); return { ...run, data: reminderView(await getReminder(userId, id)) }; }, 202); } catch (error) { return apiError(c, 409, "reminder_run_failed", error instanceof Error ? error.message : "Reminder could not be run."); } });
  app.get("/v1/jobs", async (c) => c.json({ data: (await listJobs(sdkUser(c)!.userId)).map(jobView) }));
  app.post("/v1/jobs", async (c) => { const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; const text = String(body.text ?? "").trim(); const cron = String(body.cron ?? "").trim(); if (!text || !cron) return apiError(c, 400, "invalid_job", "text and cron are required."); try { return await sdkMutation(c, `POST:${c.req.path}:${JSON.stringify(body)}`, async (userId) => { const job = await scheduleJob(userId, { text, cron, ...(typeof body.mode === "string" ? { mode: body.mode } : {}), ...(body.links && typeof body.links === "object" ? { links: body.links } : {}), ...(typeof body.nextAction === "string" ? { nextAction: body.nextAction } : {}), ...(Array.isArray(body.preconditions) ? { preconditions: body.preconditions } : {}), ...(Array.isArray(body.postconditions) ? { postconditions: body.postconditions } : {}) }); return jobView(job); }, 201); } catch (error) { return apiError(c, 400, "job_create_failed", error instanceof Error ? error.message : "Recurring job could not be scheduled."); } });
  app.delete("/v1/jobs/:id", async (c) => { try { await cancelJob(sdkUser(c)!.userId, c.req.param("id")); return c.body(null, 204); } catch (error) { return apiError(c, 404, "job_not_found", error instanceof Error ? error.message : "Recurring job not found."); } });
  app.post("/v1/jobs/:id/pause", async (c) => { try { const id = c.req.param("id"); return await sdkMutation(c, `POST:${c.req.path}:pause`, async (userId) => { const message = await pauseJob(userId, id); return { message, data: jobView(await getJob(userId, id)) }; }); } catch (error) { return apiError(c, 409, "job_pause_failed", error instanceof Error ? error.message : "Job could not be paused."); } });
  app.post("/v1/jobs/:id/resume", async (c) => { try { const id = c.req.param("id"); return await sdkMutation(c, `POST:${c.req.path}:resume`, async (userId) => { const message = await resumeJob(userId, id); return { message, data: jobView(await getJob(userId, id)) }; }); } catch (error) { return apiError(c, 409, "job_resume_failed", error instanceof Error ? error.message : "Job could not be resumed."); } });
  app.post("/v1/jobs/:id/run", async (c) => { try { const id = c.req.param("id"); return await sdkMutation(c, `POST:${c.req.path}:run`, async (userId) => { const run = await runJobNow(userId, id); return { ...run, data: jobView(await getJob(userId, id)) }; }, 202); } catch (error) { return apiError(c, 409, "job_run_failed", error instanceof Error ? error.message : "Job could not be run."); } });
  app.get("/v1/jobs/:id/occurrences", async (c) => { const userId = sdkUser(c)!.userId; const job = await getJob(userId, c.req.param("id")); if (!job) return apiError(c, 404, "job_not_found", "Recurring job not found."); const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50) || 50)); const data = (await listJobOccurrences(userId, job.id, limit)).map(occurrenceView); return c.json({ data }); });
  app.get("/v1/scratchpad", async (c) => { const data = Object.entries(await readScratchpad(sdkUser(c)!.userId, c.req.query("query"))).map(([key, item]) => ({ key, content: item.content, updatedAt: new Date(item.updatedAt).toISOString() })); return c.json({ data }); });
  app.put("/v1/scratchpad/:key", async (c) => { const key = decodeURIComponent(c.req.param("key")).trim(); const body = await c.req.json().catch(() => ({})) as { content?: string }; const content = String(body.content ?? ""); if (!key || key.length > 120 || content.length > 20_000) return apiError(c, 400, "invalid_scratchpad", "key and content are required; content must be 20000 characters or fewer."); await writeScratchpad(sdkUser(c)!.userId, key, content); return c.json({ key, content, updatedAt: new Date().toISOString() }); });
  app.delete("/v1/scratchpad", async (c) => { await clearScratchpad(sdkUser(c)!.userId, c.req.query("key")); return c.body(null, 204); });
  app.delete("/v1/scratchpad/:key", async (c) => { await clearScratchpad(sdkUser(c)!.userId, decodeURIComponent(c.req.param("key"))); return c.body(null, 204); });
  app.get("/v1/context", async (c) => { const scope = c.req.query("scope") as never; const purpose = c.req.query("purpose") as never; const data = await selectContext(sdkUser(c)!.userId, { query: c.req.query("query"), scope, scopeId: c.req.query("scopeId"), purpose, limit: Number(c.req.query("limit") ?? 30) || 30 }); return c.json({ data, prompt: await contextPrompt(sdkUser(c)!.userId, { query: c.req.query("query"), scope, scopeId: c.req.query("scopeId"), purpose, limit: Number(c.req.query("limit") ?? 30) || 30 }) }); });
  app.post("/v1/context", async (c) => { const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; if (typeof body.scope !== "string" || typeof body.kind !== "string" || typeof body.key !== "string" || typeof body.value !== "string" || (body.sensitivity !== "normal" && body.sensitivity !== "sensitive")) return apiError(c, 400, "invalid_context", "scope, kind, key, value, and sensitivity are required."); try { const node = await upsertContextNode(sdkUser(c)!.userId, { scope: body.scope as never, scopeId: typeof body.scopeId === "string" ? body.scopeId : undefined, kind: body.kind as never, key: body.key, value: body.value, sensitivity: body.sensitivity, source: typeof body.source === "string" ? body.source : undefined, sourceRef: typeof body.sourceRef === "string" ? body.sourceRef : undefined, confidence: typeof body.confidence === "number" ? body.confidence : undefined, tags: Array.isArray(body.tags) ? body.tags.filter((item): item is string => typeof item === "string") : undefined, reviewAt: typeof body.reviewAt === "number" ? body.reviewAt : undefined, expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : undefined }); return c.json(node, 201); } catch (error) { return apiError(c, 400, "context_save_failed", error instanceof Error ? error.message : "Context could not be saved."); } });
  app.get("/v1/departments/catalog", async (c) => c.json({ data: listDepartments() }));
  app.get("/v1/departments", async (c) => c.json({ data: await listDepartmentSpaces(sdkUser(c)!.userId) }));
  app.post("/v1/departments", async (c) => { const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; try { const department = await provisionDepartment(sdkUser(c)!.userId, String(body.department ?? ""), { name: typeof body.name === "string" ? body.name : undefined, mission: typeof body.mission === "string" ? body.mission : undefined, objectives: Array.isArray(body.objectives) ? body.objectives.filter((item): item is string => typeof item === "string") : undefined, policies: Array.isArray(body.policies) ? body.policies.filter((item): item is string => typeof item === "string") : undefined, approvedTools: Array.isArray(body.approvedTools) ? body.approvedTools.filter((item): item is string => typeof item === "string") : undefined, escalationOwner: typeof body.escalationOwner === "string" ? body.escalationOwner : undefined }); return c.json(department, 201); } catch (error) { return apiError(c, 400, "department_create_failed", error instanceof Error ? error.message : "Department could not be provisioned."); } });
  app.post("/v1/departments/:department/handoffs", async (c) => { const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; if (typeof body.objective !== "string") return apiError(c, 400, "invalid_handoff", "objective is required."); try { const packet = await createDepartmentHandoff(sdkUser(c)!.userId, { department: c.req.param("department"), objective: body.objective, inputs: body.inputs && typeof body.inputs === "object" ? body.inputs as Record<string, unknown> : {}, constraints: Array.isArray(body.constraints) ? body.constraints.filter((item): item is string => typeof item === "string") : [], evidenceRequired: Array.isArray(body.evidenceRequired) ? body.evidenceRequired.filter((item): item is string => typeof item === "string") : [], ...(body.outputSchema && typeof body.outputSchema === "object" ? { outputSchema: body.outputSchema as Record<string, unknown> } : {}), ...(typeof body.toAgent === "string" ? { toAgent: body.toAgent } : {}), ...(typeof body.deadline === "number" ? { deadline: body.deadline } : {}), ...(typeof body.approvalBoundary === "string" ? { approvalBoundary: body.approvalBoundary } : {}) }); return c.json(packet, 201); } catch (error) { return apiError(c, 400, "handoff_create_failed", error instanceof Error ? error.message : "Handoff could not be created."); } });
  app.get("/v1/outcomes", async (c) => c.json({ data: listOutcomePackages() }));
  app.get("/v1/outcomes/:slug", async (c) => { const outcome = getOutcomePackage(c.req.param("slug")); return outcome ? c.json({ data: outcome }) : apiError(c, 404, "outcome_not_found", "Outcome package not found."); });
  app.post("/v1/outcomes/:slug/plan", async (c) => { const body = await c.req.json().catch(() => ({})); try { return c.json({ data: planOutcome(c.req.param("slug"), body && typeof body === "object" ? body as Record<string, unknown> : {}) }); } catch (error) { return apiError(c, 400, "outcome_plan_failed", error instanceof Error ? error.message : "Outcome could not be planned."); } });
  app.get("/v1/memory", async (c) => { const data = (await searchMemories(sdkUser(c)!.userId, c.req.query("query"), { limit: 20 })).map(memoryView); return c.json({ data }); });
  app.post("/v1/memory", async (c) => { const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; const categories = new Set(["profile", "personal", "preference", "business", "relationship", "project", "procedural", "episodic", "document", "negative", "fact", "instruction", "asset"]); const category = String(body.category ?? "fact"); const key = String(body.key ?? "").trim(); const value = String(body.value ?? "").trim(); const sensitivity = body.sensitivity; if (!categories.has(category) || !key || !value || key.length > 200 || value.length > 20_000 || (sensitivity !== "normal" && sensitivity !== "sensitive")) return apiError(c, 400, "invalid_memory", "category, key, value, and sensitivity (normal or sensitive) are required."); try { const owner = sdkUser(c)!; const source = String(body.source ?? "web_dashboard"); const confidence = Number(body.confidence ?? 1); const saved = await upsertMemoryAndContext(owner.userId, { category: category as any, key, value, confidence, source, sensitivity, projectId: typeof body.projectId === "string" ? body.projectId : undefined, personKey: typeof body.personKey === "string" ? body.personKey : undefined, reviewAt: typeof body.reviewAt === "number" ? body.reviewAt : undefined, expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : undefined }, { scope: typeof body.projectId === "string" ? "project" : "user", ...(typeof body.projectId === "string" ? { scopeId: body.projectId } : {}), kind: (["preference", "relationship", "fact", "decision", "objective", "open_loop"].includes(category) ? category : "memory") as never, key, value, source, sourceRef: "pending", sensitivity, confidence, ...(typeof body.reviewAt === "number" ? { reviewAt: body.reviewAt } : {}), ...(typeof body.expiresAt === "number" ? { expiresAt: body.expiresAt } : {}) }); return c.json({ ...memoryView(saved.memory), contextNodeId: saved.context.id }, 201); } catch (error) { return apiError(c, 400, "memory_save_failed", error instanceof Error ? error.message : "Memory could not be saved."); } });
  app.delete("/v1/memory/:id", async (c) => { const removed = await forgetMemory(sdkUser(c)!.userId, decodeURIComponent(c.req.param("id"))); return removed ? c.body(null, 204) : apiError(c, 404, "memory_not_found", "Memory not found."); });
  app.get("/v1/tasks", async (c) => c.json({ data: await listTasks(sdkUser(c)!.userId) }));
  app.post("/v1/tasks/:taskId/retry", async (c) => { const userId = sdkUser(c)!.userId; const task = await retryTask(userId, c.req.param("taskId")); if (!task) return apiError(c, 409, "task_not_retryable", "Only failed, blocked, or cancelled tasks can be retried."); try { const workflowRunId = await enqueueTaskWithClaim(userId, task.id, task.runAt ?? Date.now(), sdkTaskWorkflowEnqueuer); if (!workflowRunId) return apiError(c, 409, "task_enqueue_in_progress", "This task is already being queued."); const updated = await getTask(userId, task.id); return c.json(updated ?? task); } catch (error) { return apiError(c, 503, "task_enqueue_failed", error instanceof Error ? error.message : "Task could not be queued."); } });
  app.post("/v1/tasks/:taskId/cancel", async (c) => { const task = await cancelTask(sdkUser(c)!.userId, c.req.param("taskId")); return task ? c.json(task) : apiError(c, 409, "task_not_cancellable", "This task is already completed or cancelled."); });
  app.get("/v1/missions", async (c) => c.json({ data: await listMissions(sdkUser(c)!.userId) }));
  app.post("/v1/missions", async (c) => {
    const owner = sdkUser(c)!;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const objective = typeof body.objective === "string" ? body.objective.trim() : "";
    const definitionOfDone = typeof body.definitionOfDone === "string" ? body.definitionOfDone.trim() : "";
    const steps = Array.isArray(body.steps) ? body.steps.slice(0, 100).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const step = value as Record<string, unknown>;
      if (typeof step.title !== "string" || typeof step.objective !== "string") return [];
      return [{ id: typeof step.id === "string" ? step.id : undefined, title: step.title, objective: step.objective, dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter((item): item is string => typeof item === "string") : undefined, retryLimit: step.retryLimit === undefined ? undefined : Number(step.retryLimit), input: step.input && typeof step.input === "object" ? step.input as Record<string, unknown> : undefined, outputSchema: step.outputSchema && typeof step.outputSchema === "object" ? step.outputSchema as Record<string, unknown> : undefined, evidenceRequired: Array.isArray(step.evidenceRequired) ? step.evidenceRequired.filter((item): item is string => typeof item === "string") : undefined, compensationObjective: typeof step.compensationObjective === "string" ? step.compensationObjective : undefined, retryBackoffSeconds: step.retryBackoffSeconds === undefined ? undefined : Number(step.retryBackoffSeconds), parallelGroup: typeof step.parallelGroup === "string" ? step.parallelGroup : undefined }];
    }) : undefined;
    if (!title || !objective || !definitionOfDone || title.length > 240 || objective.length > 8000 || definitionOfDone.length > 4000) return apiError(c, 400, "invalid_mission", "title, objective, and definitionOfDone are required and must be within their size limits.");
    const idempotencyKey = (c.req.header("Idempotency-Key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "")).trim().slice(0, 200) || undefined;
    try {
      const requiredEvidence = Array.isArray(body.requiredEvidence) ? body.requiredEvidence.filter((item): item is string => typeof item === "string") : undefined;
      const mission = await createMission(owner.userId, { title, objective, definitionOfDone, idempotencyKey, steps, requiredEvidence, verificationMode: body.verificationMode === "strict" || (body.verificationMode === undefined && Boolean(requiredEvidence?.length)) ? "strict" : "legacy", budget: {
        maxDurationSeconds: body.maxDurationSeconds === undefined ? undefined : Number(body.maxDurationSeconds),
        maxSteps: body.maxSteps === undefined ? undefined : Number(body.maxSteps),
        maxToolCalls: body.maxToolCalls === undefined ? undefined : Number(body.maxToolCalls),
        maxCost: body.maxCost === undefined ? undefined : Number(body.maxCost),
      } });
      if (mission.rootTaskId) return c.json(mission, 200);
      const started = await startMission(owner.userId, mission.id);
      if (!started) return apiError(c, 409, "mission_not_startable", "Mission is no longer in a startable state.");
      try {
        const linked = await scheduleMissionSteps(owner.userId, started, sdkTaskWorkflowEnqueuer);
        return c.json(linked ?? started, 201);
      } catch (error) {
        await updateMission(owner.userId, started.id, { status: "blocked", error: `Mission could not be scheduled: ${error instanceof Error ? error.message : String(error)}`, nextAction: "Retry after the durable workflow service is available." });
        return apiError(c, 503, "mission_enqueue_failed", error instanceof Error ? error.message : "Mission could not be scheduled.");
      }
    } catch (error) { return apiError(c, 400, "mission_create_failed", error instanceof Error ? error.message : "Mission could not be created."); }
  });
  app.get("/v1/missions/:missionId", async (c) => { const mission = await getMission(sdkUser(c)!.userId, c.req.param("missionId")); return mission ? c.json(mission) : apiError(c, 404, "not_found", "Mission not found."); });
  app.get("/v1/missions/:missionId/events", async (c) => { const mission = await getMission(sdkUser(c)!.userId, c.req.param("missionId")); return mission ? c.json({ data: mission.events }) : apiError(c, 404, "not_found", "Mission not found."); });
  app.get("/v1/missions/:missionId/proof", async (c) => { const mission = await getMission(sdkUser(c)!.userId, c.req.param("missionId")); return mission ? c.json(missionProof(mission)) : apiError(c, 404, "not_found", "Mission not found."); });
  app.post("/v1/missions/:missionId/evidence", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { stepId?: unknown; evidence?: unknown };
    const evidence = Array.isArray(body.evidence) ? body.evidence.slice(0, 20).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      if (typeof value.summary !== "string" || typeof value.kind !== "string" || typeof value.verified !== "boolean") return [];
      return [{ id: typeof value.id === "string" ? value.id : `evidence_${randomUUID()}`, kind: value.kind as "source", summary: value.summary, ...(typeof value.source === "string" ? { source: value.source } : {}), ...(typeof value.ref === "string" ? { ref: value.ref } : {}), ...(typeof value.hash === "string" ? { hash: value.hash } : {}), verified: value.verified, ...(value.verifiedBy === "agent" || value.verifiedBy === "system" || value.verifiedBy === "human" ? { verifiedBy: value.verifiedBy as "agent" | "system" | "human" } : {}) }];
    }) : [];
    if (!evidence.length) return apiError(c, 400, "invalid_evidence", "At least one valid evidence record is required.");
    const mission = await recordMissionEvidence(sdkUser(c)!.userId, c.req.param("missionId"), evidence, typeof body.stepId === "string" ? body.stepId : undefined);
    return mission ? c.json(mission) : apiError(c, 409, "mission_evidence_failed", "Mission not found, finished, or not owned by you.");
  });
  app.post("/v1/missions/:missionId/verify", async (c) => { const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; const mission = await verifyMission(sdkUser(c)!.userId, c.req.param("missionId"), { evidenceIds: Array.isArray(body.evidenceIds) ? body.evidenceIds.filter((item): item is string => typeof item === "string") : undefined, confidence: typeof body.confidence === "number" ? body.confidence : undefined, verifiedBy: "agent" }); return mission ? c.json(mission) : apiError(c, 404, "not_found", "Mission not found."); });
  app.post("/v1/missions/:missionId/repair", async (c) => { const body = await c.req.json().catch(() => ({})) as { reason?: unknown; nextAction?: unknown }; if (typeof body.reason !== "string" || !body.reason.trim()) return apiError(c, 400, "invalid_repair", "reason is required."); const mission = await repairMission(sdkUser(c)!.userId, c.req.param("missionId"), { reason: body.reason, nextAction: typeof body.nextAction === "string" ? body.nextAction : undefined }); return mission ? c.json(mission) : apiError(c, 409, "mission_repair_failed", "Mission is not repairable or not owned by you."); });
  app.post("/v1/missions/:missionId/pause", async (c) => { const owner = sdkUser(c)!; const mission = await pauseMission(owner.userId, c.req.param("missionId"), "Mission paused through the API."); if (mission) await cancelMissionTasks(owner.userId, mission.id); return mission ? c.json(mission) : apiError(c, 409, "mission_not_paused", "Only a running or waiting mission can be paused."); });
  app.post("/v1/missions/:missionId/resume", async (c) => {
    const owner = sdkUser(c)!; const mission = await resumeMission(owner.userId, c.req.param("missionId"));
    if (!mission) return apiError(c, 409, "mission_not_resumable", "Only a paused, blocked, or failed mission can be resumed.");
    await scheduleMissionSteps(owner.userId, mission, sdkTaskWorkflowEnqueuer);
    return c.json(await getMission(owner.userId, mission.id) ?? mission);
  });
  app.post("/v1/missions/:missionId/events", async (c) => {
    const owner = sdkUser(c)!;
    const body = await c.req.json().catch(() => ({})) as { provider?: unknown; providerEventId?: unknown };
    const provider = typeof body.provider === "string" ? body.provider.trim().slice(0, 120) : "";
    const providerEventId = typeof body.providerEventId === "string" ? body.providerEventId.trim().slice(0, 240) : "";
    if (!provider || !providerEventId) return apiError(c, 400, "invalid_provider_event", "provider and providerEventId are required.");
    const mission = await resumeMissionFromProviderEvent(owner.userId, c.req.param("missionId"), provider, providerEventId);
    if (!mission) return apiError(c, 409, "mission_event_not_expected", "This mission is not waiting for that provider event.");
    await scheduleMissionSteps(owner.userId, mission, sdkTaskWorkflowEnqueuer);
    return c.json(await getMission(owner.userId, mission.id) ?? mission, 202);
  });
  app.post("/v1/missions/:missionId/events/signed", async (c) => {
    const owner = sdkUser(c)!;
    const raw = await c.req.text();
    if (!validMissionWebhookSignature(raw, c.req.raw.headers)) return apiError(c, 401, "invalid_mission_signature", "The mission webhook signature is missing, invalid, or expired.");
    let body: { provider?: unknown; providerEventId?: unknown };
    try { body = JSON.parse(raw) as { provider?: unknown; providerEventId?: unknown }; } catch { return apiError(c, 400, "invalid_provider_event", "The mission webhook body must be valid JSON."); }
    const provider = typeof body.provider === "string" ? body.provider.trim().slice(0, 120) : "";
    const providerEventId = typeof body.providerEventId === "string" ? body.providerEventId.trim().slice(0, 240) : "";
    if (!provider || !providerEventId) return apiError(c, 400, "invalid_provider_event", "provider and providerEventId are required.");
    const mission = await resumeMissionFromProviderEvent(owner.userId, c.req.param("missionId"), provider, providerEventId);
    if (!mission) return apiError(c, 409, "mission_event_not_expected", "This mission is not waiting for that provider event.");
    await scheduleMissionSteps(owner.userId, mission, sdkTaskWorkflowEnqueuer);
    return c.json(await getMission(owner.userId, mission.id) ?? mission, 202);
  });
  app.post("/v1/missions/:missionId/steps/:stepId/complete", async (c) => {
    const owner = sdkUser(c)!;
    const body = await c.req.json().catch(() => ({})) as { result?: unknown };
    const result = typeof body.result === "string" ? body.result.trim() : "";
    if (!result || result.length > 12_000) return apiError(c, 400, "invalid_step_result", "result is required and must be 12000 characters or fewer.");
    const mission = await completeMissionStep(owner.userId, c.req.param("missionId"), c.req.param("stepId"), result);
    return mission ? c.json(mission) : apiError(c, 409, "mission_step_not_completable", "The mission step is not pending/running, is not owned by you, or the mission is finished.");
  });
  app.post("/v1/missions/:missionId/replan", async (c) => {
    const owner = sdkUser(c)!;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "Verified information changed the remaining plan.";
    const steps = Array.isArray(body.steps) ? body.steps.slice(0, 100).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const step = value as Record<string, unknown>;
      if (typeof step.title !== "string" || typeof step.objective !== "string") return [];
      return [{ id: typeof step.id === "string" ? step.id : undefined, title: step.title, objective: step.objective, dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter((item): item is string => typeof item === "string") : undefined, retryLimit: step.retryLimit === undefined ? undefined : Number(step.retryLimit) }];
    }) : [];
    if (!reason || reason.length > 2_000 || !steps.length) return apiError(c, 400, "invalid_replan", "reason and at least one valid step are required.");
    try {
      const mission = await replanMission(owner.userId, c.req.param("missionId"), steps, reason);
      return mission ? c.json(mission) : apiError(c, 409, "mission_not_replannable", "Only an unfinished mission you own can be replanned.");
    } catch (error) { return apiError(c, 400, "mission_replan_failed", error instanceof Error ? error.message : "Mission could not be replanned."); }
  });
  app.post("/v1/missions/:missionId/cancel", async (c) => { const owner = sdkUser(c)!; const mission = await cancelMission(owner.userId, c.req.param("missionId"), "Mission cancelled through the API."); if (!mission) return apiError(c, 409, "mission_not_cancellable", "This mission is already completed or cancelled."); await cancelMissionTasks(owner.userId, mission.id); return c.json(mission); });
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
  app.post("/v1/webhooks/:webhookId/deliveries/:deliveryId/retry", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const hook = session.sdkWebhooks!.find((item) => item.id === c.req.param("webhookId")); if (!hook) return apiError(c, 404, "not_found", "Webhook not found."); const record = (await listOutbox(undefined, 100, owner.userId)).find((item) => item.id === c.req.param("deliveryId") && item.webhook?.webhookId === hook.id); if (!record) return apiError(c, 404, "not_found", "Webhook delivery not found."); if (record.status !== "failed") return apiError(c, 409, "delivery_not_retryable", record.status === "ambiguous" ? "The receiver may have accepted this event. Verify its state before creating a new event; ambiguous events cannot be replayed through this endpoint." : "Only definitively failed webhook deliveries can be retried."); const updated = await updateOutbox(record.id, { status: "queued", attempts: 0, lastError: undefined, leaseToken: undefined, leaseExpiresAt: undefined }); return c.json(updated ? { id: updated.id, status: updated.status, attempts: updated.attempts } : { id: record.id, status: "queued", attempts: 0 }); });
  app.delete("/v1/webhooks/:webhookId", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const hook = session.sdkWebhooks!.find((item) => item.id === c.req.param("webhookId")); if (!hook) return apiError(c, 404, "not_found", "Webhook not found."); hook.disabledAt = Date.now(); await saveSession(owner.userId, session); return c.body(null, 204); });
  app.post("/v1/files", async (c) => { const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { name?: string; contentType?: string; size?: number }; const name = String(body.name ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120); const contentType = String(body.contentType ?? "").toLowerCase(); const size = Number(body.size); const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/plain", "text/markdown", "application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "audio/mpeg", "audio/ogg", "audio/wav", "video/mp4", "video/webm"]); if (!name || !allowed.has(contentType) || !Number.isFinite(size) || size < 1 || size > config.sdkMaxFileBytes) return apiError(c, 400, "invalid_file", "File name, type, or size is invalid."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "R2 storage is not configured."); const session = await getSession(owner.userId); const fingerprint = createHash("sha256").update(`POST:${c.req.path}:${JSON.stringify(body)}`).digest("hex"); const prior = idempotency(c, session, fingerprint); if (prior.mismatch) return apiError(c, 409, "idempotency_mismatch", "Idempotency-Key was reused with a different request."); if (prior.replay) return c.json(prior.replay, 201); const file = { id: `file_${randomUUID()}`, key: `sdk/${owner.userId}/${randomUUID()}-${name}`, name, contentType, size, status: "pending" as const, createdAt: Date.now() }; const expiresAt = new Date(Date.now() + 300_000).toISOString(); const response = { ...file, uploadUrl: await signR2Upload(file.key, file.contentType), expiresAt }; session.sdkFiles!.push(file); if (prior.key) session.sdkIdempotency![prior.key] = { fingerprint, response, createdAt: Date.now() }; await saveSession(owner.userId, session); return c.json(response, 201); });
 app.post("/v1/files/:fileId/complete", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const file = session.sdkFiles!.find((item) => item.id === c.req.param("fileId")); if (!file) return apiError(c, 404, "not_found", "File not found."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "Storage is not configured."); try { const remote = await inspectR2Object(file.key); if (remote.size !== file.size || remote.contentType !== file.contentType) { file.status = "rejected"; await saveSession(owner.userId, session); return apiError(c, 409, "file_verification_failed", "R2 object size or content type did not match the upload intent."); } file.status = "available"; await saveSession(owner.userId, session); if (["image/jpeg", "image/png", "image/webp"].includes(file.contentType)) { try { await registerImageAsset(owner.userId, { name: file.name, purpose: "Image uploaded through the Chusky dashboard", description: file.name, tags: ["dashboard", "uploaded-image"], contentType: file.contentType as "image/jpeg" | "image/png" | "image/webp", r2Key: file.key, size: file.size }); } catch (error) { logger.warn({ err: error, userId: owner.userId, fileId: file.id }, "Could not register SDK image asset"); } } if (vectorConfigured() && (file.contentType.startsWith("image/") || file.contentType === "text/plain" || file.contentType === "text/markdown" || file.contentType === "application/pdf" || file.contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")) { try { const bytes = await readR2Object(file.key); const extracted = file.contentType === "text/plain" || file.contentType === "text/markdown" ? bytes.toString("utf8") : await extractMediaText(bytes, file.name, file.contentType, session.model); await indexExtractedDocument({ userId: String(owner.userId), documentId: file.id, filename: file.name, contentType: file.contentType, text: extracted, sourceType: "sdk_upload" }); } catch (error) { logger.warn({ err: error, userId: owner.userId, fileId: file.id }, "Could not index SDK file"); } } return c.json(file); } catch { return apiError(c, 409, "file_not_uploaded", "The upload is not available in R2 yet."); } });
  app.get("/v1/files/:fileId", async (c) => { const owner = sdkUser(c)!; const file = (await getSession(owner.userId)).sdkFiles!.find((item) => item.id === c.req.param("fileId")); if (!file) return apiError(c, 404, "not_found", "File not found."); if (file.status !== "available") return apiError(c, 409, "file_not_available", "Only a verified upload can be downloaded."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "R2 storage is not configured."); return c.json({ ...file, downloadUrl: await signR2Download(file.key), expiresAt: new Date(Date.now() + 300_000).toISOString() }); });
  app.delete("/v1/files/:fileId", async (c) => { const owner = sdkUser(c)!; const session = await getSession(owner.userId); const index = session.sdkFiles!.findIndex((item) => item.id === c.req.param("fileId")); if (index < 0) return apiError(c, 404, "not_found", "File not found."); if (!r2Configured()) return apiError(c, 503, "storage_unavailable", "R2 storage is not configured."); await deleteR2Object(session.sdkFiles![index].key); session.sdkFiles!.splice(index, 1); await saveSession(owner.userId, session); return c.body(null, 204); });
  app.get("/v1/tasks/:taskId", async (c) => { const task = await getTask(sdkUser(c)!.userId, c.req.param("taskId")); return task ? c.json(task) : apiError(c, 404, "not_found", "Task not found."); });
  app.get("/v1/approvals/:approvalId", async (c) => { const approval = await getApproval(sdkUser(c)!.userId, c.req.param("approvalId")); return approval ? c.json(approvalView(approval)) : apiError(c, 404, "not_found", "Approval not found."); });
  app.post("/v1/approvals/:approvalId", async (c) => {
    const owner = sdkUser(c)!; const body = await c.req.json().catch(() => ({})) as { decision?: string };
    const pending = await getApproval(owner.userId, c.req.param("approvalId"));
    if (!pending || pending.status !== "pending" || pending.expiresAt <= Date.now()) return apiError(c, 404, "not_found", "Pending approval not found.");
    if (body.decision !== "approve" && body.decision !== "deny") return apiError(c, 400, "invalid_decision", "decision must be approve or deny.");
    if (body.decision === "deny") {
      await setApprovalStatus(owner.userId, pending.id, "denied");
      const deniedSession = await getSession(owner.userId);
      const deniedThread = deniedSession.sdkThreads!.find((item) => item.runs.some((run) => run.approvalId === pending.id));
      const deniedRun = deniedThread?.runs.find((run) => run.approvalId === pending.id);
      if (deniedThread && deniedRun) {
        deniedRun.status = "cancelled";
        deniedRun.approvalId = undefined;
        deniedRun.events.push(event("run.cancelled", "Approval denied; the action was not executed."));
        deniedRun.updatedAt = Date.now();
        deniedThread.updatedAt = deniedRun.updatedAt;
        await persistSdkRunSnapshot(owner.userId, deniedThread.id, deniedRun);
      }
      await rejectComposerApproval(owner.userId, pending.id);
      const missionTarget = await findMissionApprovalTarget(owner.userId, pending.id);
      if (missionTarget) {
        await updateMission(owner.userId, missionTarget.mission.id, { status: "blocked", waiting: undefined, error: `Approval denied for ${pending.toolSlug}.`, nextAction: "Review the mission checkpoint and resume only after revising the action." });
      }
      return c.json({ id: pending.id, status: "denied" });
    }
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
      if (approval.toolSlug === "CHUCK_WORKFLOW_STAGE") {
        const workflowId = typeof approval.args.workflowId === "string" ? approval.args.workflowId : "";
        const workflow = workflowId ? await reconcileComposerWorkflow(owner.userId, workflowId, sdkTaskWorkflowEnqueuer) : undefined;
        if (!workflow) { await setApprovalStatus(owner.userId, approval.id, "denied"); return apiError(c, 404, "workflow_not_found", "The workflow stage no longer exists."); }
        return c.json({ id: approval.id, status: "consumed", workflow });
      }
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
      const missionResume = await resumeMissionTaskAfterApproval(owner.userId, approval.id, sdkTaskWorkflowEnqueuer);
      if (missionResume.status !== "not_mission") {
        if (missionResume.status === "task_running") return apiError(c, 409, "mission_task_running", "The mission task is already running; its current worker will settle before another slice starts.");
        if (missionResume.status === "not_resumable") return apiError(c, 409, "mission_not_resumable", "The mission approval no longer matches a resumable task.");
        if (missionResume.status === "enqueue_failed") return apiError(c, 503, "mission_enqueue_failed", "Approval was recorded, but the mission could not be queued. The checkpoint is preserved for recovery.");
        const resumedMission = missionResume.mission;
        if (!resumedMission) return apiError(c, 409, "mission_not_resumable", "The mission approval no longer matches a resumable task.");
        return c.json({ id: approval.id, status: "approved", mission: await getMission(owner.userId, resumedMission.id) ?? resumedMission }, 202);
      }
      const session = await getSession(owner.userId); const thread = session.sdkThreads!.find((item) => item.runs.some((run) => run.approvalId === approval.id));
      if (!thread) { await setApprovalStatus(owner.userId, approval.id, "denied"); return apiError(c, 409, "run_not_found", "The run that requested this approval no longer exists."); }
      const run = thread.runs.find((item) => item.approvalId === approval.id)!;
      const historyStart = thread.history.length;
      run.status = "running";
      run.approvalId = undefined;
      run.events.push(event("run.started", "Approval granted; continuing this run."));
      run.updatedAt = Date.now();
      thread.updatedAt = run.updatedAt;
      await persistSdkRunSnapshot(owner.userId, thread.id, run);
      const abort = new AbortController();
      activeRuns.set(run.id, abort);
      let costIncrement = 0;
      try {
        const result = await runAgent(owner.userId, approval.request, approval.history, approval.model, undefined, abort.signal, undefined, approval.id, undefined, {
          ...await sdkAgentOptions({ budget: run.budget, tools: run.tools, skills: run.skills }, run.id, thread.id, run.agentInstructions),
          onToolActivity: async (activity: AgentToolActivity) => {
            const activityEvent = { id: `evt_${randomUUID()}`, type: "run.tool_activity", at: Date.now(), ...activity };
            run.events.push(activityEvent);
            run.updatedAt = activityEvent.at;
            thread.updatedAt = activityEvent.at;
            await persistSdkRunSnapshot(owner.userId, thread.id, run);
          },
        });
        if (abort.signal.aborted) { run.status = "cancelled"; run.events.push(event("run.cancelled", "Run cancelled. Completed steps are preserved.")); }
        else { run.status = "completed"; run.output = result.text; run.artifacts = sdkRunArtifacts(result.generatedFiles); run.cost = result.cost; costIncrement = result.cost ?? 0; run.error = undefined; run.events.push(event("run.completed")); thread.history.push({ role: "user", content: approval.request }, { role: "assistant", content: result.text }); }
      } catch (error) {
        if (error instanceof ApprovalRequiredError) { run.status = "requires_approval"; run.approvalId = error.approvalId; run.events.push(event("run.approval_required", "Another action needs your approval.")); }
        else if (abort.signal.aborted) { run.status = "cancelled"; run.events.push(event("run.cancelled", "Run cancelled. Completed steps are preserved.")); }
        else { run.status = "failed"; run.error = { code: "resume_failed", message: error instanceof Error ? error.message : "Approval resume failed" }; run.events.push(event("run.failed", run.error.message)); }
      }
      run.updatedAt = Date.now(); thread.updatedAt = run.updatedAt;
      try {
        await persistSdkRunSnapshot(owner.userId, thread.id, run, run.status === "completed" ? thread.history.slice(historyStart) : [], costIncrement);
        const latestSession = await getSession(owner.userId);
        return c.json(runView(thread.id, latestSession.sdkThreads!.find((item) => item.id === thread.id)?.runs.find((item) => item.id === run.id) ?? run));
      } finally { activeRuns.delete(run.id); }
    } finally { await releaseUserLock(owner.userId, token); }
  });
}
