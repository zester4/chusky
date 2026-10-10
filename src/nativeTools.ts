//src/nativeTools.ts
import { Client as QStashClient } from "@upstash/qstash";
import { createTregEndpointJudge } from "./decisions/tregRouter.js";
import { Client as WorkflowClient } from "@upstash/workflow";
import { enqueueTaskWorkflow, enqueueTinyFishResearchWorkflow, workflowFailureUrl } from "./triggerWorkflow.js";
import { enqueueTaskWithClaim } from "./taskEnqueue.js";
import { MissionDurationApprovalRequiredError, requestMissionDurationApproval, resumeMissionTaskAfterApproval } from "./missionApproval.js";
import { resolveWorkflowEndpoint } from "./workflowUrls.js";
import { createHash, randomUUID } from "node:crypto";
import { classifyMemory } from "./memory/classifier.js";
import { config } from "./config.js";
import { ensureAttentionPulseCapabilityCandidates, getAttentionPulseWatchCoverage } from "./attentionPulse.js";
import { classifyPulseHealth } from "./proactive/pulseHealth.js";
import { DEFAULT_PROACTIVE_WATCHES, DEFAULT_WATCH_CONNECTION_WAIT_ERROR, defaultWatchInput, defaultWatchSpecsForConnectedAccounts, missingDefaultWatchKeys, normalizeProactiveCapabilityIds } from "./proactive/watches.js";
import { logger } from "./logger.js";
import { assertPublicHttpUrl, createTinyFishClient } from "./tinyfish.js";
import { receiveTinyFishMonitorWebhook, tinyFishMonitorSignature, tinyFishMonitorSnapshotHash, validateTinyFishMonitorSchedule } from "./tinyfishMonitors.js";
import { reconcileTinyFishResearchRun } from "./tinyfishResearch.js";
import {
  addJob, addReminder, clearScratchpad, getJob, getReminder, getSession, getRecallMeeting, listJobs, listJobOccurrences, createJobOccurrence, updateJobOccurrence, listReminders, claimHandoffBudget, searchConversationMessages, getConversationMessage, isDurableStore,
  getMeetingRepresentativeProfile, updateMeetingRepresentativeProfile,
  upsertMeetingContact, listMeetingContacts, deleteMeetingContact, getMeetingContact, updateMeetingContact,
  readScratchpad, updateJob, updateReminder, transitionReminderStatus, writeScratchpad,
  forgetMemory, searchMemories, updateMemory, upsertMemoryAndContext,
  blockTask, cancelTask, checkpointTask, completeTask, createTask, getTask, listTasks, retryTask, scheduleTask, getApproval, getAgentRun, setApprovalStatus, updateTask, getHandoffRecord,
  blockMission, cancelMission, cancelMissionTasks, checkpointMission, completeMission, createMission, finalizeMissionIfReady, getMission, listMissions, missionProof, pauseMission, startMission, updateMission, updateMissionControl, waitMission, recordTrustedMissionEvidence, verifyMission, repairMission, missionBudgetPreflight, missingMissionEvidenceRequirements, MissionReplanConflictError,
  createAttentionRecord, getAttentionRecord, listAttentionRecords, updateAttentionRecord,
  countLeadCampaignCandidates, createLeadCampaign, finalizeLeadCampaign, getLeadCampaign, listLeadCampaigns, listLeadCampaignCandidates, reserveLeadCampaignTregSpend, settleLeadCampaignTregSpend, updateLeadCampaign, updateLeadCampaignCandidate, upsertLeadCampaignCandidates,
  type AttentionEntityKind, type AutonomyWatchRecord, type DeliveryPreferenceRecord, type ImageAsset, type TinyFishMonitorRecord, type TinyFishResearchRunRecord, type LeadCampaignCandidateRecord,
  type TaskStatus, type MissionStatus, type MissionBudget, type MissionWorkSchedule,
  type JobRecord, type ReminderRecord, type ScheduledWorkerBinding, type ReminderDeliveryTarget,
  listPhoneCalls, saveImageAsset, searchImageAssets, getImageAsset, forgetImageAsset,
  listVideoJobs, getVideoJob, updateVideoJob, listHandoffRecords, saveHandoffRecord, listCalendarMeetingPreparations,
  searchRecallMeetingTranscripts, deleteRecallMeetingTranscript, saveBrowserPlaybook, findBrowserPlaybook, listBrowserPlaybooks, removeBrowserPlaybook, addBrowserAudit, listBrowserAudit, saveBrowserHandoff, getBrowserHandoff, listBrowserHandoffs, updateBrowserHandoff, updateBrowserHandoffResolution,
  getTregSpend, saveTregSpend, saveTregReceipt, listTregReceipts, acquireTregSpendLock, releaseTregSpendLock, saveTregOAuthState, getTregOAuthState, removeTregOAuthState,
} from "./store.js";
import { daytonaEngine } from "./lib/daytona/index.js";
import { e2bBrowserEngine } from "./lib/e2b/index.js";
import { E2BBrowserHandoffWaitingError } from "./lib/e2b/errors.js";
import { browserHandoffWaitingResult } from "./lib/e2b/contracts.js";
import { isTrustedBrowserUrlObservation } from "./lib/e2b/contracts.js";
import { browserChallengeStillActive } from "./lib/e2b/handoffStatus.js";
import { E2B_BROWSER_ACTIONS } from "./lib/e2b/types.js";
import { transferDaytonaImage, type DaytonaImageTransferInput } from "./daytonaImageTransfer.js";
import { startTwilioCallForUser } from "./calls/twilio.js";
import { startBlandCallForUser } from "./calls/bland.js";
import { executeDelegation, requestDelegationCancellation } from "./subagents/executor.js";
import type { SubagentActivityUpdate } from "./subagents/contracts.js";
import type { ComposioToolPresentation } from "./toolActivity.js";
import { ATTENTION_PULSE_TOOLS, WORKER_CAPABILITIES, isComposioToolAllowedForWorker, normalizeDelegationToolScopes, planDelegationObjective } from "./subagents/capabilities.js";
import { enqueueSubagentToolContinuation, resolveSubagentToolRequest } from "./subagents/workflow.js";
import { listSkillFiles, readSkillFile, searchSkills } from "./skills/catalog.js";
import { abortable, throwIfAborted } from "./cancellation.js";
import { beginVaultSetup, browserSessionHealth, listVault, logoutVault, normaliseVaultOrigin, normaliseVaultService, recordVaultSession, vaultStatus } from "./vault/vault.js";
import { loginWithVault } from "./vault/broker.js";
import { classifyBrowserIntent, createBrowserOperationPlan, normalizeBrowserAlias, normalizeBrowserOrigin, normalizePlaybook, verifyBrowserResult, type BrowserHandoffReason, type BrowserPlaybookRecord } from "./vault/browserOps.js";
import { normalizeChallengeProvider, normalizeChallengeType, transitionChallengeState } from "./vault/challengeResolution.js";
import { cancelShopping, listSavedShoppingSites, listShopping, pauseShopping, removeSavedShoppingSite, resumeShopping, saveShoppingSitePreference, selectShoppingRetailer, startShopping, updateShopping } from "./shopping/shopping.js";
import { cancelAutomaticCalendarMeetingJoins, confirmRecallMeetingParticipant, getRecallMeetingForUser, joinRecallMeeting, joinPreparedCalendarMeeting, leaveRecallMeeting, listRecallMeetingsForUser, listRecallMeetingParticipantsForOwner, lookupRecallMeetingContext, ownerExplicitlyRequestedTranscriptRetention, prepareRecallMeetingMission } from "./meetings/service.js";
import { hasMeetingMissionInput } from "./meetings/mission.js";
import { isMeetingRepresentativeEmailTool, needsPrivateMeetingBriefBeforeJoin } from "./meetings/representative.js";
import type { TaskWaitRequest } from "./types.js";
import { createTaskWaitRequest } from "./taskWait.js";
import type { AutonomyLinks, AutonomyMode } from "./autonomy/types.js";
import { contextPrompt, selectContext, upsertContextNode } from "./contextGraph.js";
import { getMemoryBrief, durableMemoryConfigured, saveMemoryEdge, saveMemoryEntity } from "./memory/durable.js";
import { createDepartmentHandoff } from "./departments.js";
import { listOutcomePackages, planOutcome } from "./outcomes/catalog.js";
import { completeMissionStepAndAdvance, finalizeMissionCloseout, reconcileMissionExecution, recordMissionEvidenceAndCloseout, replanMissionAndSchedule, rescheduleQueuedMissionTasks, stripSupervisorOwnedMissionStepTools, resumeMissionAndSchedule, validateMissionStepsPayload, type MissionTaskEnqueuer } from "./missionScheduler.js";
import { getAutonomySnapshot } from "./autonomy/queue.js";
import { listImageModels } from "./imageModels.js";
import { listVideoModels } from "./videoModels.js";
import { runDueAutonomyWatches } from "./autonomy/reconciliation.js";
import { planBusinessGapPlaybook } from "./autonomy/playbooks.js";
import type { BusinessGap } from "./autonomy/gapDetectors.js";
import { canonicalNativeToolSlug, validateNativeToolArguments } from "./agentTools.js";
import { isReadOnlyToolSlug } from "./policy.js";
import { searchDiscoveredToolManifest, type NativeToolBundle } from "./decisions/nativeToolRouter.js";
import { externalArgumentsHash } from "./autonomy/actions.js";
import { inspectToolRecovery, preflightToolCall, summarizeIntegrationHealth } from "./toolDiagnostics.js";
import { isSharedChannelToolDenied } from "./sharedChannelPolicy.js";
import { executeOutcomeVerification, verifiedOutcomeEvidenceSummary, type OutcomeReadAdapter } from "./reliability/outcomeEngine.js";
import { appendTraceEvent, compensationView, executeCompensation, listCompensations } from "./reliability/persistence.js";
import type { OutcomeCheck } from "./reliability/contracts.js";
import { diagnoseMissionRepair } from "./reliability/repair.js";
import { TregGateway } from "./treg/gateway.js";
import { TregSpendGuard } from "./treg/spend.js";
import { TregOAuth } from "./treg/oauth.js";
import { decideMemoryDisposition } from "./autonomy/decisionLoop.js";
import { routeBrowserNext } from "./decisions/browserRouter.js";
import { buildBrowserCandidates } from "./vault/browserObservation.js";
import { beginLinkOAuth, cancelLinkSpendRequest, completeApprovedLinkCheckout, completeLinkUcpCheckout, confirmLinkMerchantOrder, createLinkSpendRequest, createLinkUcpCheckout, discoverLinkMppPayment, disconnectLinkWallet, executeLinkPayment, inspectLinkPayTokenCheckout, linkPaymentMethods, linkSpendReceipt, linkSpendStatus, linkWalletStatus, listLinkSpendRequestViews, payLinkMppRequest, reportLinkOutcome, searchLinkUcpCatalog, waitForLinkSpendApproval } from "./link/agentWallet.js";

const MAX_TEXT = 1000;
const MAX_DAYTONA_COMMAND = 64000;
function modelVisibleImageAsset(asset: ImageAsset): Omit<ImageAsset, "userId" | "r2Key"> {
  const { id, name, purpose, description, tags, contentType, size, createdAt, updatedAt } = asset;
  return { id, name, purpose, description, tags, contentType, size, createdAt, updatedAt };
}
// Mission lifecycle changes belong to the Chusky supervisor.  They are useful
// while coordinating a specialist, but must never become delegated authority.
// A model can occasionally include them in a worker contract while trying to
// preserve context; recover those known supervisor controls at the native
// boundary without weakening the worker manifest for any other invalid tool.
const SUPERVISOR_DELEGATION_TOOLS = new Set([
  "CHUCK_MISSION_GET",
  "CHUCK_MISSION_LIST",
  "CHUCK_MISSION_PROOF",
  "CHUCK_MISSION_CHECKPOINT",
  "CHUCK_MISSION_STEP_COMPLETE",
  "CHUCK_MISSION_EVIDENCE",
  "CHUCK_MISSION_VERIFY",
  "CHUCK_MISSION_COMPENSATE",
  "CHUCK_MISSION_REPLAN",
  "CHUCK_MISSION_BLOCK",
  "CHUCK_MISSION_PAUSE",
  "CHUCK_MISSION_RESUME",
  "CHUCK_MISSION_CONTROL",
  "CHUCK_MISSION_CANCEL",
  "CHUCK_MISSION_WAIT_EVENT",
]);
export interface NativeToolRuntime {
  currentImages?: Array<{ data: Uint8Array; mediaType: string; filename?: string }>;
  generatedImages?: Array<{ data: Uint8Array; mediaType: string; filename?: string }>;
  model?: string;
  historySummary?: string;
  onStatus?: (statusText: string) => Promise<void> | void;
  /** Safe worker lifecycle updates forwarded to the authenticated parent run. */
  onSubagentActivity?: (activity: SubagentActivityUpdate & { parentToolCallId: string }) => Promise<void> | void;
  getComposioToolPresentation?: (toolSlug: string) => ComposioToolPresentation | undefined;
  parentToolCallId?: string;
  approvedApprovalId?: string;
  signal?: AbortSignal;
  /** Worker-owned resources can register bounded cleanup on cancellation. */
  registerCancellationCleanup?: (cleanup: () => Promise<void>) => void;
  deliveryTarget?: import("./channels/contracts.js").ReplyTarget;
  /** Present only when a specialist is executing its own native tool call. */
  worker?: Exclude<import("./memory/types.js").CapabilityWorkerName, "chusky">;
  workerBinding?: Omit<ScheduledWorkerBinding, "worker" | "objective">;
  /** Server-only peer delegation lineage propagated by the worker executor. */
  handoffId?: string;
  rootHandoffId?: string;
  delegationDepth?: number;
  /** Present only for an authenticated Recall meeting run. */
  meetingId?: string;
  /** Current authenticated channel conversation, used for scope checks. */
  conversationId?: string;
  /** Private relationship preparation must never run from a shared channel. */
  sharedConversation?: boolean;
  /** Authenticated owner-private interactive run; broadens context/tools while preserving high-impact approval checks. */
  ownerPrivateRun?: boolean;
  /** Current owner request, used for explicit-opt-in checks at native boundaries. */
  userRequest?: string;
  /** The durable task currently executing; absent for interactive turns. */
  taskId?: string;
  /** The autonomous mission currently executing this bounded slice. */
  missionId?: string;
  /** Exact dependency-aware step currently executing; used only for trusted evidence attribution. */
  missionStepId?: string;
  /** True when this slice is the first worker turn after a persisted timer wake. */
  missionTimerResumed?: boolean;
  /** Checkpoint/action pair that created the timer wait, used to reject an exact duplicate wait. */
  missionWakeCheckpoint?: string;
  missionWakeNextAction?: string;
  /** Hard per-run Treg limits for explicitly configured autonomous monitors. */
  tregMaxCalls?: number;
  tregMaxSpendUsd?: number;
  /** Optional workflow publisher for deterministic mission scheduling tests and internal recovery. */
  enqueueMissionTask?: MissionTaskEnqueuer;
  /** Trusted company workspace scope; never accepted from model tool arguments. */
  organizationId?: string;
  /** Exact model-visible tool catalog and safe owner connection snapshot for read-only diagnostics. */
  toolCatalog?: unknown[];
  /** Server-side filtered catalog used only by progressive discovery. */
  availableToolCatalog?: unknown[];
  connectedAccounts?: Array<{ id: string; toolkit: string; status: string; alias?: string; updatedAt?: string }>;
  currentRunId?: string;
  /** Executes provider outcome checks only through an active, exact read-only tool grant. */
  outcomeReadAdapter?: OutcomeReadAdapter;
  /** Executes a compensation action only after the agent boundary verified the exact owner approval and live tool grant. */
  executeMissionCompensation?: (input: { compensationId: string; missionId?: string; missionStepId?: string; toolSlug: string; arguments: Record<string, unknown>; verification: { toolSlug: string; arguments: Record<string, unknown>; expected: Record<string, unknown> }; approvedArguments: Record<string, unknown>; approvalId: string }) => Promise<{ receiptId: string; providerReceiptId?: string; verificationId: string; summary: string }>;
  /** Set by the internal task-wait tool; the workflow settles the run after the agent turn ends. */
  requestTaskWait?: (request: TaskWaitRequest) => void;
  /** Set by the mission event-wait tool; the workflow parks the durable slice. */
  requestMissionWait?: (request: MissionWaitRequest) => void;
}

export interface MissionWaitRequest {
  provider: string;
  providerEventId: string;
  stepId?: string;
  checkpoint?: string;
  nextAction?: string;
  timeoutSeconds?: number;
}

type PhoneCallLauncherForTests = (userId: number, input: Record<string, unknown>) => Promise<unknown>;
let phoneCallLauncherForTests: PhoneCallLauncherForTests | undefined;
let tregGatewayForTests: TregGateway | undefined;

function tregGateway(): TregGateway {
  if (tregGatewayForTests) return tregGatewayForTests;
  const spend = new TregSpendGuard({
    getSnap: getTregSpend,
    saveSnap: saveTregSpend,
    acquireLock: async (key, token, leaseSeconds) => {
      const match = /^treg-spend:(\d+):(.+)$/.exec(key);
      return match ? acquireTregSpendLock(Number(match[1]), match[2], token, leaseSeconds) : false;
    },
    releaseLock: async (key, token) => {
      const match = /^treg-spend:(\d+):(.+)$/.exec(key);
      if (match) await releaseTregSpendLock(Number(match[1]), match[2], token);
    },
  });
  tregGatewayForTests = new TregGateway({
    spend,
    recordReceipt: saveTregReceipt,
    judge: createTregEndpointJudge(),
    recordMissionEvidence: async ({ userId, missionId, receipt, resultHash }) => Boolean(await recordTrustedMissionEvidence(userId, missionId, [{ id: `treg_${receipt.callId}`, kind: "tool_receipt", summary: `Treg ${receipt.endpointId} completed for $${receipt.costUsd.toFixed(4)} with provider status ${receipt.statusCode ?? "unknown"}.`, ref: `treg://receipts/${receipt.callId}`, hash: resultHash, verified: true, verifiedBy: "system" }])),
  });
  return tregGatewayForTests;
}

function tregOAuth(): TregOAuth {
  return new TregOAuth(tregGateway());
}

function tregStateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export function setTregGatewayForTests(gateway?: TregGateway): void {
  tregGatewayForTests = gateway;
}

/** Test seam for authenticated call routes; production uses the configured provider below. */
export function setPhoneCallLauncherForTests(launcher?: PhoneCallLauncherForTests): void {
  phoneCallLauncherForTests = launcher;
}

function text(value: unknown, max = MAX_TEXT): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new Error(`Text must be 1-${max} characters`);
  return result;
}

function requiredText(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const result = value.trim();
  if (!result) throw new Error(`${field} must contain non-whitespace text.`);
  if (result.length > max) throw new Error(`${field} exceeds the ${max}-character limit.`);
  return result;
}

function optionalText(value: unknown, max: number, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be text when provided.`);
  const result = value.trim();
  if (!result) return undefined;
  if (result.length > max) throw new Error(`${field} must be at most ${max} characters when provided.`);
  return result;
}

function optionalIdentifier(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  if (!result) return undefined;
  if (result.length > max) throw new Error(`Text must be 1-${max} characters`);
  return result;
}

function missionText(value: unknown, field: string, max: number): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new Error(`${field} must be 1-${max} characters`);
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function missionStartIdempotencyKey(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime): string | undefined {
  const explicit = optionalIdentifier(args.idempotencyKey, 200);
  if (explicit) return explicit;
  const runId = runtime.currentRunId?.trim();
  if (!runId) return undefined;
  const intent = {
    title: args.title,
    objective: args.objective,
    definitionOfDone: args.definitionOfDone,
    requiredEvidence: args.requiredEvidence,
    verificationMode: args.verificationMode ?? (Array.isArray(args.requiredEvidence) && args.requiredEvidence.length ? "strict" : "legacy"),
    steps: Array.isArray(args.steps) && args.steps.length ? args.steps : null,
    budget: {
      maxDurationSeconds: args.maxDurationSeconds,
      maxSteps: args.maxSteps,
      maxSlices: args.maxSlices,
      maxToolCalls: args.maxToolCalls,
      maxCost: args.maxCost,
      budgetCeiling: args.budgetCeiling,
    },
    workSchedule: args.workSchedule,
  };
  const scope = createHash("sha256").update(`${userId}:${runId}`).digest("hex");
  const fingerprint = createHash("sha256").update(stableJson(intent)).digest("hex");
  return `agent-run:${scope}:${fingerprint}`;
}

function leadDedupeKey(candidate: { companyName: string; domain?: string; website?: string; personName?: string; workEmail?: string; linkedinUrl?: string }): string {
  const cleanUrl = (value: string) => {
    try { const url = new URL(value); url.hash = ""; url.search = ""; return url.toString().replace(/\/$/, "").toLowerCase(); } catch { return value.trim().toLowerCase(); }
  };
  if (candidate.workEmail) return `email:${candidate.workEmail.trim().toLowerCase()}`;
  if (candidate.linkedinUrl) return `linkedin:${cleanUrl(candidate.linkedinUrl)}`;
  const domain = candidate.domain?.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "")
    || (candidate.website ? (() => { try { return new URL(candidate.website).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } })() : "");
  if (domain && candidate.personName) return `person:${domain}:${candidate.personName.trim().toLowerCase()}`;
  if (domain) return `company:${domain}`;
  return `company:${candidate.companyName.trim().toLowerCase()}:${candidate.personName?.trim().toLowerCase() ?? ""}`;
}

function leadCampaignTools(runtime: NativeToolRuntime): string[] {
  const connectedReadTools = (runtime.availableToolCatalog ?? runtime.toolCatalog ?? []).flatMap((tool: any) => {
    const slug = String(tool?.function?.name ?? "").trim().toUpperCase();
    return slug && !/^(?:CHUCK_|COMPOSIO_|MCP_)/.test(slug) && isReadOnlyToolSlug(slug) ? [slug] : [];
  }).slice(0, 40);
  return [...new Set([
    "CHUCK_LEAD_CAMPAIGN", "CHUCK_SEARCH_SKILLS", "CHUCK_LIST_SKILL_FILES", "CHUCK_READ_SKILL_FILE",
    "CHUCK_TINYFISH_SEARCH", "CHUCK_TINYFISH_FETCH", "COMPOSIO_SEARCH_WEB", "COMPOSIO_SEARCH_FETCH_URL_CONTENT",
    ...connectedReadTools,
    "CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_PLATFORMS", "CHUCK_TREG_ENRICH_PERSON", "CHUCK_TREG_ENRICH_COMPANY", "CHUCK_TREG_RESOLVE",
    "CHUCK_CREATE_SPREADSHEET", "CHUCK_ARTIFACT",
  ])];
}

async function startLeadCampaign(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime): Promise<unknown> {
  const title = missionText(args.title, "title", 200);
  const objective = missionText(args.objective, "objective", 3000);
  const idealCustomerProfile = missionText(args.idealCustomerProfile, "idealCustomerProfile", 2000);
  const geography = missionText(args.geography, "geography", 300);
  const targetCount = Number(args.targetCount);
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 500) throw new Error("targetCount must be from 1 to 500.");
  const maxTregSpendUsd = args.maxTregSpendUsd === undefined ? config.tregMissionBudgetUsd : Number(args.maxTregSpendUsd);
  if (!Number.isFinite(maxTregSpendUsd) || maxTregSpendUsd < 0 || maxTregSpendUsd > 1000) throw new Error("maxTregSpendUsd must be from 0 to 1000.");
  const seedQueries = Array.isArray(args.seedQueries) ? [...new Set(args.seedQueries.map((item) => missionText(item, "seed query", 240)))].slice(0, 100) : [];
  const explicitIdempotencyKey = optionalIdentifier(args.idempotencyKey, 180);
  const runScope = runtime.currentRunId?.trim();
  const fingerprint = createHash("sha256").update(stableJson({ title, objective, idealCustomerProfile, geography, targetCount, maxTregSpendUsd, seedQueries })).digest("hex").slice(0, 48);
  const idempotencyKey = explicitIdempotencyKey ?? (runScope ? `lead-run:${createHash("sha256").update(`${userId}:${runScope}`).digest("hex").slice(0, 24)}:${fingerprint}` : `lead:${randomUUID()}`);
  const campaign = await createLeadCampaign(userId, {
    idempotencyKey, title, objective, idealCustomerProfile, geography, targetCount, maxTregSpendUsd,
    seedQueries, tregSpentUsd: 0, tregReservedUsd: 0,
  });
  const mission = await createMission(userId, {
    title: `Lead campaign: ${title}`.slice(0, 240),
    objective: `Run owner-private lead campaign ${campaign.id}. Objective: ${objective}. ICP: ${idealCustomerProfile}. Geography: ${geography}. Target: ${targetCount}. Treg enrichment budget: $${maxTregSpendUsd.toFixed(2)}. Seed terms: ${seedQueries.join("; ") || "none supplied"}.`,
    definitionOfDone: `Persist a deduplicated, source-linked campaign tracker for ${targetCount} target leads or honestly report the achievable shortfall; qualify candidates against the stated ICP, enrich only the qualified shortlist within the $${maxTregSpendUsd.toFixed(2)} Treg cap, preserve next actions, and record a server-verified campaign snapshot. No outreach or external CRM write is part of this campaign.`,
    idempotencyKey: `lead-campaign:${campaign.id}`,
    requiredEvidence: ["kind:before_after"], verificationMode: "strict",
    steps: [
      { id: "campaign-intake", title: "Load lead research playbook and confirm campaign scope", objective: `Read lead-intel-pro skill and references needed for ${campaign.id}. Confirm ICP, geography, target, supplied seeds, and no-contact boundary. Use CHUCK_LEAD_CAMPAIGN get to inspect this campaign.`, allowedTools: ["CHUCK_LEAD_CAMPAIGN", "CHUCK_SEARCH_SKILLS", "CHUCK_LIST_SKILL_FILES", "CHUCK_READ_SKILL_FILE"] },
      { id: "candidate-discovery", title: "Discover and persist source-linked candidates", objective: `Find candidates for campaign ${campaign.id} using owner-provided seeds, eligible connected-app read sources, and low-cost public research first. Use TinyFish/Composio web search where available and exact read-only connected-app actions already present in this private run. Never use a generic write gateway. Deduplicate and persist batches of at most 50 using CHUCK_LEAD_CAMPAIGN record_candidates. Every candidate must have an HTTPS source URL and a concise observed-fact summary. Aim for ${targetCount}; do not invent contacts or intent.`, dependsOn: ["campaign-intake"], allowedTools: leadCampaignTools(runtime).filter((slug) => !slug.startsWith("CHUCK_TREG_") && !["CHUCK_CREATE_SPREADSHEET", "CHUCK_ARTIFACT"].includes(slug)) },
      { id: "candidate-qualification", title: "Qualify and deduplicate candidates", objective: `Review persisted candidates in campaign ${campaign.id} against the explicit ICP/geography. Update qualificationStatus and reason; distinguish observed evidence from inference. Keep uncertain rows in review and reject clear mismatches. Qualification means fit, never purchase intent.`, dependsOn: ["candidate-discovery"], allowedTools: ["CHUCK_LEAD_CAMPAIGN", "CHUCK_TINYFISH_FETCH", "COMPOSIO_SEARCH_WEB", "COMPOSIO_SEARCH_FETCH_URL_CONTENT"] },
      { id: "shortlist-enrichment", title: "Enrich only the qualified shortlist within budget", objective: `For qualified candidates only, use the narrow Treg person/company enrichment tools when Treg is configured and useful. Pass campaign mission ID and a maxSpendUsd no greater than the remaining campaign budget on each call; process one paid call at a time. Record returned fields, provider/source, and no-match state. Never enrich rejected/review rows or exceed the campaign cap. If the cap is zero/exhausted or Treg is unavailable, mark enrichment skipped and continue without asking the owner to reconnect unnecessarily.`, dependsOn: ["candidate-qualification"], allowedTools: ["CHUCK_LEAD_CAMPAIGN", "CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_PLATFORMS", "CHUCK_TREG_ENRICH_PERSON", "CHUCK_TREG_ENRICH_COMPANY", "CHUCK_TREG_RESOLVE"] },
      { id: "campaign-tracker", title: "Prepare the internal campaign tracker", objective: `Read campaign ${campaign.id} candidates in bounded pages and prepare a professional spreadsheet artifact with company, contact, qualification, source URLs, enrichment status, and next action. Keep the persisted campaign records as the source of truth. Do not create or modify an external CRM/Sheet/Notion database or send outreach in this run; offer the user an approval-gated connected-app sync as a next action.`, dependsOn: ["shortlist-enrichment"], allowedTools: ["CHUCK_LEAD_CAMPAIGN", "CHUCK_CREATE_SPREADSHEET", "CHUCK_ARTIFACT"] },
      { id: "campaign-finalize", title: "Verify and finalize the campaign snapshot", objective: `Call CHUCK_LEAD_CAMPAIGN finalize for campaign ${campaign.id}. The server computes persisted candidate counts, shortfall, and a hash and records trusted mission evidence. Report actual persisted counts, Treg campaign spend, and unresolved gaps; never claim more leads than the store contains.`, dependsOn: ["campaign-tracker"], allowedTools: ["CHUCK_LEAD_CAMPAIGN"] },
    ],
    budget: {
      maxDurationSeconds: 3 * 24 * 60 * 60,
      maxLifetimeSeconds: 7 * 24 * 60 * 60,
      maxSteps: 12,
      maxSlices: Math.min(500, Math.max(20, 20 + Math.ceil(targetCount / 10))),
      maxToolCalls: Math.min(3000, 60 + targetCount * 4),
      maxCost: Math.min(1000, 20 + targetCount * 0.1 + maxTregSpendUsd),
    },
  });
  await updateLeadCampaign(userId, campaign.id, { missionId: mission.id });
  if (mission.status === "queued") {
    const started = await startMission(userId, mission.id);
    if (started) {
      try {
        const scheduled = await reconcileMissionExecution(userId, started.id, runtime.enqueueMissionTask ?? enqueueTaskWorkflow);
        return { ...(await getLeadCampaign(userId, campaign.id)), status: scheduled?.status ?? started.status, missionId: mission.id };
      } catch (error) {
        await blockMission(userId, started.id, `Lead campaign could not be scheduled: ${error instanceof Error ? error.message : String(error)}`, "Retry this same campaign after the durable workflow service is available.");
        throw error;
      }
    }
  }
  if (mission.status === "running") {
    const scheduled = await reconcileMissionExecution(userId, mission.id, runtime.enqueueMissionTask ?? enqueueTaskWorkflow);
    return { ...(await getLeadCampaign(userId, campaign.id)), status: scheduled?.status ?? mission.status, missionId: mission.id };
  }
  return { ...(await getLeadCampaign(userId, campaign.id)), status: mission.status, missionId: mission.id };
}

async function leadCampaignTool(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime): Promise<unknown> {
  const action = missionText(args.action, "action", 40);
  if (action === "start") return startLeadCampaign(userId, args, runtime);
  if (action === "list") {
    if (runtime.missionId) throw new Error("A campaign mission worker may inspect only its own campaign, not the owner's campaign list.");
    const campaigns = await listLeadCampaigns(userId);
    const rows = await Promise.all(campaigns.slice(0, args.limit === undefined ? 20 : Number(args.limit)).map(async (campaign) => {
      const mission = campaign.missionId ? await getMission(userId, campaign.missionId) : undefined;
      const counts = await countLeadCampaignCandidates(userId, campaign.id);
      return { ...campaign, status: mission?.status ?? (campaign.missionId ? "missing_mission" : "pending"), ...counts };
    }));
    return { campaigns: rows };
  }
  const id = missionText(args.id, "id", 160);
  const campaign = await getLeadCampaign(userId, id);
  if (!campaign) throw new Error("Lead campaign not found or not owned by you.");
  if (runtime.missionId && campaign.missionId !== runtime.missionId) throw new Error("A mission worker may access only its own lead campaign.");
  if (action === "get") {
    const mission = campaign.missionId ? await getMission(userId, campaign.missionId) : undefined;
    const counts = await countLeadCampaignCandidates(userId, campaign.id);
    const candidates = await listLeadCampaignCandidates(userId, campaign.id, {
      limit: args.limit === undefined ? 50 : Number(args.limit), offset: args.offset === undefined ? 0 : Number(args.offset),
      qualificationStatus: args.qualificationFilter as LeadCampaignCandidateRecord["qualificationStatus"] | undefined,
    });
    return { campaign: { ...campaign, status: mission?.status ?? (campaign.missionId ? "missing_mission" : "pending"), ...counts }, candidates, nextOffset: Number(args.offset ?? 0) + candidates.length < counts.total ? Number(args.offset ?? 0) + candidates.length : undefined };
  }
  if (action === "record_candidates") {
    if (!runtime.missionId || campaign.missionId !== runtime.missionId) throw new Error("Only this campaign's durable mission worker can record candidate batches.");
    const candidates = args.candidates as Array<Record<string, unknown>>;
    const prepared = candidates.map((candidate) => {
      const companyName = missionText(candidate.companyName, "companyName", 240);
      const domain = optionalText(candidate.domain, 253, "domain")?.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
      const website = optionalText(candidate.website, 2000, "website");
      const personName = optionalText(candidate.personName, 240, "personName");
      const jobTitle = optionalText(candidate.jobTitle, 240, "jobTitle");
      const workEmail = optionalText(candidate.workEmail, 320, "workEmail");
      const linkedinUrl = optionalText(candidate.linkedinUrl, 2000, "linkedinUrl");
      const sourceUrls = Array.isArray(candidate.sourceUrls) ? candidate.sourceUrls.map((value) => {
        const url = new URL(missionText(value, "source URL", 2000));
        if (url.protocol !== "https:" || url.username || url.password) throw new Error("Lead provenance URLs must be credential-free HTTPS links.");
        return url.toString();
      }) : [];
      return {
        dedupeKey: leadDedupeKey({ companyName, domain, website, personName, workEmail, linkedinUrl }), companyName, domain, website,
        personName, jobTitle, workEmail, linkedinUrl, sourceUrls,
        evidenceSummary: missionText(candidate.evidenceSummary, "evidenceSummary", 2000),
        qualificationStatus: (candidate.qualificationStatus ?? "review") as LeadCampaignCandidateRecord["qualificationStatus"],
        qualificationReason: optionalText(candidate.qualificationReason, 1000, "qualificationReason"),
        enrichmentStatus: (candidate.enrichmentStatus ?? "not_started") as LeadCampaignCandidateRecord["enrichmentStatus"],
        enrichmentSource: optionalText(candidate.enrichmentSource, 300, "enrichmentSource"),
        enrichmentFields: Array.isArray(candidate.enrichmentFields) ? candidate.enrichmentFields.map((item) => missionText(item, "enrichment field", 120)).slice(0, 30) : [],
        nextAction: optionalText(candidate.nextAction, 1000, "nextAction"),
        followUpAt: candidate.followUpAt === undefined ? undefined : Number(candidate.followUpAt),
      };
    });
    for (const candidate of prepared) {
      if (candidate.qualificationStatus !== "review" && !candidate.qualificationReason) throw new Error("A qualified or rejected lead must include a qualificationReason.");
      if (candidate.enrichmentStatus === "enriched" && (!candidate.enrichmentSource || candidate.enrichmentFields.length === 0)) throw new Error("Enriched leads must retain their provider/source and returned field names.");
    }
    const result = await upsertLeadCampaignCandidates(userId, campaign.id, prepared);
    return { ...result, contentIsUntrusted: true, persisted: true };
  }
  if (action === "update_candidate") {
    const candidateId = missionText(args.candidateId, "candidateId", 160);
    const patch: Record<string, unknown> = {};
    for (const key of ["qualificationStatus", "qualificationReason", "enrichmentStatus", "enrichmentSource", "enrichmentFields", "nextAction", "followUpAt", "workEmail", "personName", "jobTitle", "linkedinUrl", "evidenceSummary", "sourceUrls"] as const) {
      if (Object.hasOwn(args, key)) patch[key] = args[key];
    }
    if (patch.qualificationStatus !== undefined && patch.qualificationStatus !== "review" && !patch.qualificationReason) throw new Error("A qualified or rejected lead must include a qualificationReason.");
    if (Array.isArray(patch.sourceUrls)) patch.sourceUrls = patch.sourceUrls.map((value) => {
      const url = new URL(missionText(value, "source URL", 2000));
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Lead provenance URLs must be credential-free HTTPS links.");
      return url.toString();
    });
    const updated = await updateLeadCampaignCandidate(userId, campaign.id, candidateId, patch as any);
    if (!updated) throw new Error("Lead candidate not found in this campaign.");
    return { candidate: updated, persisted: true };
  }
  if (action === "finalize") {
    if (!runtime.missionId || campaign.missionId !== runtime.missionId) throw new Error("Only this campaign's durable mission worker can finalize its snapshot.");
    const result = await finalizeLeadCampaign(userId, campaign.id, runtime.missionId);
    if (!result) throw new Error("Lead campaign could not be finalized.");
    const summary = `Server snapshot for ${campaign.id}: ${result.candidateCount}/${campaign.targetCount} candidate rows persisted; ${result.qualifiedCount} qualified, ${result.reviewCount} review, ${result.rejectedCount} rejected, shortfall ${result.shortfall}.`;
    await recordTrustedMissionEvidence(userId, runtime.missionId, [{
      id: `lead_campaign_${campaign.id}_snapshot`, kind: "before_after", summary, source: "CHUCK_LEAD_CAMPAIGN",
      ref: `chusky://lead-campaigns/${campaign.id}`, hash: result.evidenceHash, verified: true, verifiedBy: "system",
    }], runtime.missionStepId);
    return { ...result, summary, evidenceRecorded: true };
  }
  throw new Error("Unsupported lead campaign action.");
}

function effectiveTregMissionId(args: Record<string, unknown>, runtime: NativeToolRuntime): string | undefined {
  if (runtime.missionId) return runtime.missionId;
  return args.missionId ? text(args.missionId, 160) : undefined;
}

async function withLeadCampaignTregBudget<T>(userId: number, missionId: string | undefined, requestedUsd: number | undefined, runtime: NativeToolRuntime, execute: (reservedUsd: number | undefined) => Promise<T>): Promise<T> {
  if (!missionId) return execute(undefined);
  const campaign = (await listLeadCampaigns(userId)).find((item) => item.missionId === missionId);
  if (!campaign) return execute(undefined);
  const remainingUsd = Math.max(0, campaign.maxTregSpendUsd - campaign.tregSpentUsd - campaign.tregReservedUsd);
  const runLimit = runtime.tregMaxSpendUsd === undefined ? remainingUsd : Math.min(remainingUsd, runtime.tregMaxSpendUsd);
  const requested = requestedUsd === undefined ? runLimit : Math.min(runLimit, requestedUsd);
  if (requested <= 0) throw new Error("This lead campaign has no remaining Treg enrichment budget; continue with the source data already collected.");
  const reservation = await reserveLeadCampaignTregSpend(userId, missionId, requested);
  if (!reservation) return execute(undefined);
  const seenCallIds = new Set((await listTregReceipts(userId, 200, runtime.organizationId)).filter((receipt) => receipt.missionId === missionId).map((receipt) => receipt.callId));
  let result: T | undefined;
  let succeeded = false;
  try {
    result = await execute(reservation.reservedUsd);
    succeeded = true;
    return result;
  } finally {
    const receipts = await listTregReceipts(userId, 200, runtime.organizationId);
    const receiptSpend = receipts.filter((receipt) => receipt.missionId === missionId && !seenCallIds.has(receipt.callId)).reduce((sum, receipt) => sum + receipt.costUsd, 0);
    const resultSpend = result && typeof result === "object" && "totalCostUsd" in result && Number.isFinite(Number((result as Record<string, unknown>).totalCostUsd))
      ? Number((result as Record<string, unknown>).totalCostUsd)
      : result && typeof result === "object" && "receipt" in result && (result as any).receipt && Number.isFinite(Number((result as any).receipt.costUsd))
        ? Number((result as any).receipt.costUsd)
        : 0;
    const actualSpend = Math.max(receiptSpend, resultSpend);
    // The provider may have completed a paid request before its response was
    // lost. Without a receipt, keep the reservation consumed rather than
    // blindly retrying into an unknown billable effect.
    await settleLeadCampaignTregSpend(userId, reservation.campaignId, reservation.reservedUsd, !succeeded && actualSpend === 0 ? reservation.reservedUsd : actualSpend);
  }
}

function taskCreateIdempotencyId(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime): string | undefined {
  const runId = runtime.currentRunId?.trim();
  if (!runId) return undefined;
  const fingerprint = createHash("sha256").update(stableJson({
    userId,
    runId,
    title: args.title,
    objective: args.objective,
    workspaceId: args.workspaceId,
  })).digest("hex").slice(0, 48);
  return `task_${fingerprint}`;
}

function daytonaCommand(value: unknown): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > MAX_DAYTONA_COMMAND) throw new Error(`Command must be 1-${MAX_DAYTONA_COMMAND} characters`);
  return result;
}

export function shouldUseE2BBrowser(action: unknown, enabled: boolean, apiKeyConfigured: boolean): boolean {
  return enabled && apiKeyConfigured && (action === undefined || (typeof action === "string" && (E2B_BROWSER_ACTIONS as readonly string[]).includes(action)));
}

function automatedBrowserEngine(action?: unknown) {
  if (!shouldUseE2BBrowser(action, config.e2bEnabled, Boolean(config.e2bApiKey))) {
    throw new Error("E2B is required for browser operations. Configure E2B_ENABLED=true and E2B_API_KEY; Daytona is only the computer and workspace runtime.");
  }
  return e2bBrowserEngine;
}

function fileContent(value: unknown): string {
  const result = String(value ?? "");
  const max = 48000;
  if (result.length > max) throw new Error(`File content must be at most ${max} characters`);
  return result;
}

function taskStatuses(value: unknown): TaskStatus[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("statuses must be an array");
  const allowed: TaskStatus[] = ["queued", "running", "blocked", "completed", "failed", "cancel_requested", "cancelled"];
  const statuses = value.map((item) => String(item));
  if (statuses.length > allowed.length || statuses.some((status) => !allowed.includes(status as TaskStatus))) throw new Error("Invalid task status filter");
  return [...new Set(statuses)] as TaskStatus[];
}

function missionStatuses(value: unknown): MissionStatus[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("statuses must be an array");
  const allowed: MissionStatus[] = ["queued", "running", "waiting", "paused", "blocked", "completed", "failed", "cancelled"];
  const statuses = value.map((item) => String(item));
  if (statuses.length > allowed.length || statuses.some((status) => !allowed.includes(status as MissionStatus))) throw new Error("Invalid mission status filter");
  return [...new Set(statuses)] as MissionStatus[];
}

function stringList(value: unknown, label: string, maxItems = 12): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const items = [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (!items.length || items.length > maxItems || items.some((item) => item.length > 200)) {
    throw new Error(`${label} must contain 1-${maxItems} non-empty items of at most 200 characters`);
  }
  return items;
}

function assertSafeBrowserRecipe(value: unknown, path = "recipe"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeBrowserRecipe(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(password|username|credential|cookie|secret|token|accessToken|refreshToken|inputValue|textValue)$/i.test(key)) throw new Error(`${path} contains a forbidden secret field`);
    assertSafeBrowserRecipe(child, `${path}.${key}`);
  }
}

function browserHandoffReason(value: unknown): BrowserHandoffReason {
  const reason = String(value ?? "site_challenge");
  if (!["captcha", "two_factor", "age_verification", "site_challenge", "login", "user_requested"].includes(reason)) throw new Error("reason is not a supported browser handoff reason");
  return reason as BrowserHandoffReason;
}

async function createBrowserHandoffRecord(userId: number, input: { reason?: unknown; service?: unknown; origin?: unknown; shoppingPlanId?: unknown; credentialId?: unknown }, ownerPrivateRun: boolean) {
  if (!ownerPrivateRun) throw new Error("Private browser handoffs are available only in the owner's private conversation");
  const reason = browserHandoffReason(input.reason);
  const service = input.service ? normaliseVaultService(text(input.service)) : undefined;
  let origin = input.origin ? normaliseVaultOrigin(text(input.origin)) : undefined;
  if (!config.e2bEnabled || !config.e2bApiKey) {
    throw new Error("E2B is required for browser handoff. Configure E2B_ENABLED=true and E2B_API_KEY; Daytona cannot provide browser handoffs.");
  }
  if (!origin) {
    const observed = await e2bBrowserEngine.browser(userId, { action: "state" });
    const currentUrl = observed && typeof observed === "object" ? (observed as { observedUrl?: unknown }).observedUrl : undefined;
    if (typeof currentUrl === "string") {
      try { const url = new URL(currentUrl); if (url.protocol === "https:") origin = url.origin; } catch { /* no safe live origin */ }
    }
  }
  const credentialId = input.credentialId ? text(input.credentialId, 200) : undefined;
  const handoff = await e2bBrowserEngine.browserHandoff(userId, reason.replaceAll("_", " "));
  const record = await saveBrowserHandoff(userId, {
    id: `bh_${randomUUID()}`,
    userId,
    workspaceId: handoff.sandboxId,
    ...(service ? { service } : {}),
    ...(origin ? { origin } : {}),
    ...(credentialId ? { credentialId } : {}),
    reason,
    provider: config.browserProvider === "kernel" ? "kernel" : "e2b",
    challengeType: normalizeChallengeType(reason),
    resolutionState: "handoff_required",
    status: "waiting",
    createdAt: Date.now(),
    expiresAt: handoff.expiresAt,
  });
  await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "handoff_requested", ...(service ? { service } : {}), ...(origin ? { origin } : {}), status: "waiting", summary: `Private browser handoff requested for ${reason.replaceAll("_", " ")}`, createdAt: Date.now() });
  const shoppingPlan = input.shoppingPlanId ? await pauseShopping(userId, { id: text(input.shoppingPlanId), reason }) : undefined;
  return { ...handoff, handoffId: record.id, status: record.status, reason, ...(service ? { service } : {}), ...(origin ? { origin } : {}), ...(shoppingPlan ? { shoppingPlan: { id: shoppingPlan.id, status: shoppingPlan.status, pausedReason: shoppingPlan.pausedReason } } : {}) };
}

async function runDelegationWithDurableContinuation(
  userId: number,
  contract: Parameters<typeof executeDelegation>[1],
  runtime: NativeToolRuntime,
): Promise<unknown> {
  if (runtime.worker) {
    if ((runtime.delegationDepth ?? 0) >= 1) {
      throw new Error("Peer handoff depth is limited to one specialist-to-specialist hop. Return the blocker to Chusky for further coordination.");
    }
    const rootHandoffId = runtime.rootHandoffId ?? runtime.handoffId;
    if (!rootHandoffId || !(await claimHandoffBudget(userId, rootHandoffId, "peer"))) {
      throw new Error("The shared specialist peer-handoff budget is exhausted or unavailable. Return the blocker to Chusky for further coordination.");
    }
    const target = WORKER_CAPABILITIES[contract.worker];
    const parentNativeTools = runtime.workerBinding?.allowedTools ?? [];
    const parentComposioTools = runtime.workerBinding?.allowedComposioTools ?? [];
    const requestedNativeTools = contract.allowedTools ?? parentNativeTools;
    const requestedComposioTools = contract.allowedComposioTools ?? parentComposioTools;
    contract = {
      ...contract,
      // A peer receives only the intersection of the parent's current grant
      // and the target worker's manifest, even when the model supplies a
      // broader CHUCK_DELEGATE_SUBAGENT contract.
      allowedTools: requestedNativeTools.filter((tool) => parentNativeTools.includes(tool)
        && target?.allowedTools.includes(tool) && tool !== "CHUCK_HANDOFF_SUBAGENT"),
      allowedComposioTools: requestedComposioTools.filter((slug) => parentComposioTools.includes(slug)
        && isComposioToolAllowedForWorker(contract.worker, slug)),
      timeoutSeconds: Math.min(60, runtime.workerBinding?.timeoutSeconds ?? 60, contract.timeoutSeconds ?? 60),
      maxToolCalls: Math.min(20, runtime.workerBinding?.maxToolCalls ?? 20, contract.maxToolCalls ?? 20),
      duration: runtime.workerBinding?.duration ?? "30m",
      budgetSeconds: Math.min(300, runtime.workerBinding?.budgetSeconds ?? 300, contract.budgetSeconds ?? 300),
      maxTotalToolCalls: runtime.workerBinding?.maxTotalToolCalls ?? 200,
    };
  }
  const durableTarget = durableReminderTarget(runtime.deliveryTarget);
  const durableContext = durableTarget && !contract.context?.deliveryTarget
    ? { ...(contract.context ?? {}), deliveryTarget: durableTarget }
    : contract.context;
  const result = await executeDelegation(userId, { ...contract, context: durableContext }, {
    ...runtime,
    onActivity: runtime.onSubagentActivity,
    parentToolCallId: runtime.parentToolCallId,
    parentHandoffId: runtime.worker ? runtime.handoffId : undefined,
    rootHandoffId: runtime.worker ? runtime.rootHandoffId ?? runtime.handoffId : undefined,
    parentWorker: runtime.worker,
    delegationDepth: runtime.worker ? (runtime.delegationDepth ?? 0) + 1 : 0,
  });
  if (result.status !== "requires_tool_request" || !result.handoffRecord) return result;
  const continuation = await enqueueSubagentToolContinuation(userId, result.handoffRecord.id);
  return { ...result, durableContinuation: { queued: true, ...continuation } };
}

async function abortableToolCall<T>(runtime: NativeToolRuntime, operation: () => Promise<T>): Promise<T> {
  throwIfAborted(runtime.signal);
  const result = await abortable(operation(), runtime.signal);
  throwIfAborted(runtime.signal);
  return result;
}

type LiveBrowserVerificationInput = {
  userId: number;
  runtime: NativeToolRuntime;
  detectors: Parameters<typeof verifyBrowserResult>[0]["detectors"];
  waitMs?: number;
  pollMs?: number;
};

/**
 * Verify a browser postcondition against fresh server-observed state. Dynamic
 * sites often render success after the click has already returned, so a
 * bounded retry belongs at this boundary rather than in the model prompt.
 */
async function verifyLiveBrowser(input: LiveBrowserVerificationInput): Promise<Record<string, unknown>> {
  const waitMs = Math.max(0, Math.min(30_000, Math.floor(Number(input.waitMs ?? 0))));
  const pollMs = Math.max(250, Math.min(5_000, Math.floor(Number(input.pollMs ?? 500))));
  const startedAt = Date.now();
  let attempts = 0;
  let last: ReturnType<typeof verifyBrowserResult> = { passed: false, matched: [], missing: ["No live browser observation"], detectors: [] };
  let lastUrl: string | undefined;
  let lastTitle: string | undefined;
  while (true) {
    throwIfAborted(input.runtime.signal);
    const browser = automatedBrowserEngine("state");
    const observed = await abortableToolCall(input.runtime, () => browser.browser(input.userId, { action: "state", maxDepth: 8 }, { ownerPrivateRun: input.runtime.ownerPrivateRun })) as {
      observedUrl?: unknown; title?: unknown; accessibility?: unknown; pageContent?: unknown;
    };
    attempts += 1;
    lastUrl = typeof observed.observedUrl === "string" ? observed.observedUrl : undefined;
    lastTitle = typeof observed.title === "string" ? observed.title : undefined;
    last = verifyBrowserResult({
      currentUrl: lastUrl,
      title: lastTitle,
      text: `${JSON.stringify(observed.accessibility ?? "")} ${typeof observed.pageContent === "string" ? observed.pageContent : ""}`.slice(0, 12_000),
      detectors: input.detectors,
    });
    if (last.passed || Date.now() - startedAt >= waitMs) break;
    await abortable(new Promise<void>((resolve) => setTimeout(resolve, pollMs)), input.runtime.signal);
  }
  return { ...last, attempts, waitedMs: Math.max(0, Date.now() - startedAt), ...(lastUrl ? { observedUrl: lastUrl } : {}), ...(lastTitle ? { observedTitle: lastTitle } : {}) };
}

async function daytonaCall<T>(runtime: NativeToolRuntime, operation: () => Promise<T>): Promise<T> {
  return abortableToolCall(runtime, operation);
}

/**
 * A mixed supervisor request must never leak a routing error to the user. Each
 * stage remains a normal durable least-privilege delegation; later stages see
 * only a bounded prior handoff, and are not started after a paused/failed one.
 */
async function runPlannedDelegation(
  userId: number,
  contract: Parameters<typeof executeDelegation>[1],
  runtime: NativeToolRuntime,
): Promise<unknown> {
  contract = { ...contract, ...normalizeDelegationToolScopes(contract) };
  if (runtime.worker) return runDelegationWithDurableContinuation(userId, contract, runtime);
  const requestedTools = contract.allowedTools ?? [];
  const supervisorToolsRetained = requestedTools.filter((tool) => SUPERVISOR_DELEGATION_TOOLS.has(tool));
  if (supervisorToolsRetained.length) {
    const workerTools = requestedTools.filter((tool) => !SUPERVISOR_DELEGATION_TOOLS.has(tool));
    // `undefined` retains the worker's manifest defaults. An empty array would
    // accidentally remove every permitted native tool from an otherwise valid
    // delegation.
    contract = { ...contract, allowedTools: workerTools.length ? workerTools : undefined };
  }
  const plan = planDelegationObjective(contract.objective, contract.allowedTools ?? []);
  if (plan.length < 2) {
    const result = await runDelegationWithDurableContinuation(userId, contract, runtime);
    return supervisorToolsRetained.length
      ? { ...(result as Record<string, unknown>), supervisorToolsRetained, note: "Mission-control tools remain with the Chusky supervisor; the specialist received only its manifest-scoped tools." }
      : result;
  }

  await runtime.onStatus?.(`🧭 Coordinating ${plan.map((step) => WORKER_CAPABILITIES[step.worker].displayName).join(" → ")}`);
  const stages: Array<{ worker: string; handoffId?: string; taskId?: string; status: string; output: string }> = [];
  let priorHandoff = "";
  for (let index = 0; index < plan.length; index += 1) {
    const step = plan[index]!;
    const capability = WORKER_CAPABILITIES[step.worker];
    const sourceContext = { ...(contract.context ?? {}) } as Record<string, unknown>;
    const requestedTool = sourceContext.toolCall as { name?: unknown } | undefined;
    if (requestedTool?.name && !capability.allowedTools.includes(String(requestedTool.name))) delete sourceContext.toolCall;
    const result = await runDelegationWithDurableContinuation(userId, {
      ...contract,
      worker: step.worker,
      objective: step.objective,
      expectedOutput: `${capability.displayName} handoff for the supervisor and any dependent specialist.`,
      allowedTools: contract.allowedTools?.filter((tool) => capability.allowedTools.includes(tool)),
      allowedComposioTools: contract.allowedComposioTools?.filter((tool) => isComposioToolAllowedForWorker(step.worker, tool)),
      context: {
        ...sourceContext,
        supervisorObjective: contract.objective,
        stage: { index: index + 1, total: plan.length, worker: step.worker, dependsOn: step.dependsOn },
        ...(priorHandoff ? { priorSpecialistHandoff: priorHandoff } : {}),
      },
    }, runtime) as { status?: string; output?: string; handoffRecord?: { id?: string }; taskId?: string };
    const status = String(result.status ?? "failed");
    const output = String(result.output ?? "");
    stages.push({ worker: step.worker, status, output: output.slice(0, 4000), handoffId: result.handoffRecord?.id, taskId: result.taskId });
    priorHandoff = output.slice(0, 6000);
    if (status !== "success" && status !== "fallback_executed") {
      return {
        orchestration: "multi_specialist", status, originalObjective: contract.objective, completedStages: stages,
        pendingStages: plan.slice(index + 1).map((pending) => pending.worker),
        note: "The remaining specialists were not started; Chusky will continue only after this durable stage is resolved.",
      };
    }
  }
  return {
    orchestration: "multi_specialist", status: "success", originalObjective: contract.objective, completedStages: stages,
    ...(supervisorToolsRetained.length ? { supervisorToolsRetained, note: "Mission-control tools remain with the Chusky supervisor; specialists received only manifest-scoped tools." } : {}),
  };
}

async function reviewSubagentAction(userId: number, args: Record<string, unknown>): Promise<unknown> {
  const approvalId = text(args.approvalId);
  const decision = String(args.decision ?? "").toLowerCase();
  if (decision !== "deny") throw new Error("Only the account owner can approve a specialist action using its explicit approval controls.");
  const approval = await getApproval(userId, approvalId);
  if (!approval?.handoffId || approval.status !== "pending" || approval.expiresAt <= Date.now()) throw new Error("Subagent proposal is missing, expired, or already reviewed");
  const handoff = await getHandoffRecord(userId, approval.handoffId);
  if (!handoff?.taskId || !handoff.delegation) throw new Error("Subagent proposal is no longer attached to a durable handoff");
  if (!(await setApprovalStatus(userId, approvalId, "denied"))) throw new Error("Subagent proposal could not be denied safely");
  await updateTask(userId, handoff.taskId, { status: "blocked", error: "The account owner denied the proposed action.", nextAction: "Revise the plan or request a different action." });
  await saveHandoffRecord(userId, { ...handoff, status: "failed" });
  return { reviewed: true, decision, approvalId, taskId: handoff.taskId };
}

function attentionKind(value: unknown): AttentionEntityKind {
  const allowed: AttentionEntityKind[] = ["observation", "open_loop", "attention_candidate", "standing_order", "delivery_preference", "relationship", "project_state", "autonomy_watch", "autonomy_profile"];
  const kind = String(value ?? "");
  if (!allowed.includes(kind as AttentionEntityKind)) throw new Error("Unsupported attention entity");
  return kind as AttentionEntityKind;
}

function attentionInput(args: Record<string, unknown>): Record<string, unknown> {
  const excluded = new Set(["action", "kind", "id", "query", "limit"]);
  return Object.fromEntries(Object.entries(args).filter(([key]) => !excluded.has(key)));
}

async function attentionTool(userId: number, args: Record<string, unknown>): Promise<unknown> {
  const action = String(args.action ?? "");
  if (!["create", "list", "update"].includes(action)) throw new Error("Attention action must be create, list, or update");
  const kind = attentionKind(args.kind);
  if (action === "list") return listAttentionRecords(userId, kind, { query: args.query ? text(args.query) : undefined, status: args.status ? String(args.status).trim().slice(0, 100) : undefined, limit: args.limit === undefined ? undefined : Number(args.limit) });
  if (action === "update") {
    const id = text(args.id);
    const patch = attentionInput(args);
    if (kind === "autonomy_watch" && patch.capabilityIds !== undefined) {
      patch.capabilityIds = normalizeProactiveCapabilityIds(patch.capabilityIds);
      if (patch.authority !== undefined && patch.authority !== "observe") throw new Error("Typed proactive watches are read-only and must use authority=observe.");
    }
    const updated = await updateAttentionRecord(userId, kind, id, patch);
    if (!updated) throw new Error("Attention record not found or not owned by you");
    return updated;
  }
  const input = attentionInput(args);
  if (kind === "autonomy_watch") {
    input.capabilityIds = normalizeProactiveCapabilityIds(input.capabilityIds);
    if (input.authority !== undefined && input.authority !== "observe") throw new Error("Typed proactive watches are read-only and must use authority=observe.");
    const query = typeof args.query === "string" ? args.query : args.queryText;
    if (typeof query === "string" && query.trim()) input.query = text(query);
  }
  const requiredByKind: Partial<Record<AttentionEntityKind, string[]>> = {
    observation: ["source", "eventType", "summary"], open_loop: ["title", "nextAction"], attention_candidate: ["candidateType", "reason"],
    standing_order: ["name", "instruction", "authority"], delivery_preference: ["provider"], relationship: ["personKey"], project_state: ["projectKey", "name", "summary"],
    autonomy_watch: ["name", "domain", "objective"], autonomy_profile: ["mode"],
  };
  for (const field of requiredByKind[kind] ?? []) if (!(field in input) || input[field] === undefined || input[field] === null || input[field] === "") throw new Error(`${field} is required for ${kind}`);
  return createAttentionRecord(userId, kind, input);
}

async function autonomyReconcileTool(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime): Promise<unknown> {
  if (runtime.sharedConversation) throw new Error("Autonomy reconciliation is only available in a private owner conversation");
  const mode = args.mode === "business" ? "business" : "personal";
  const maxWatches = args.maxWatches === undefined ? 8 : Math.max(1, Math.min(20, Math.floor(Number(args.maxWatches))));
  const force = args.force === true;
  const results = await runDueAutonomyWatches(userId, { mode, maxWatches, force });
  return { mode, forced: force, checked: results.length, results, message: results.length ? "Configured watches were reconciled with read-only scopes; proposed gaps remain subject to the normal approval boundary." : force ? "No active watches are configured for this mode." : "No autonomy watches are due." };
}

async function autonomyPlaybookTool(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime): Promise<unknown> {
  if (runtime.sharedConversation) throw new Error("Autonomy playbooks are only available in a private owner conversation");
  const raw = args.gap && typeof args.gap === "object" ? args.gap as Record<string, unknown> : {};
  const gap = {
    key: text(raw.key), type: String(raw.type ?? "") as BusinessGap["type"], severity: (String(raw.severity ?? "medium") as BusinessGap["severity"]), title: text(raw.title), reason: text(raw.reason), recommendedNextAction: text(raw.recommendedNextAction), requiresApproval: raw.requiresApproval !== false, evidence: Array.isArray(raw.evidence) ? raw.evidence as BusinessGap["evidence"] : [], detectedAt: Number(raw.detectedAt ?? Date.now()),
  } satisfies BusinessGap;
  const planned = planBusinessGapPlaybook(gap, args.input && typeof args.input === "object" ? args.input as Record<string, unknown> : {});
  if (args.action !== "start") return { action: "plan", ...planned };
  if (planned.missingInputs.length) return { action: "blocked_missing_inputs", ...planned };
  const mission = await createMission(userId, { title: planned.outcome.name, objective: planned.objective, definitionOfDone: planned.definitionOfDone, idempotencyKey: `gap:${gap.key}`, requiredEvidence: planned.outcome.evidenceRequired, verificationMode: "strict", steps: planned.steps, budget: planned.outcome.budget });
  if (mission.status === "queued") {
    const started = await startMission(userId, mission.id);
    if (started) return (await reconcileMissionExecution(userId, started.id, enqueueTaskWorkflow)) ?? started;
    return started ?? mission;
  }
  return mission;
}

export function workflowUrl(configured: string, label: string, path: string): string {
  return resolveWorkflowEndpoint(configured, config.webhookUrl, path, label);
}

export function validateCronExpression(value: string): string {
  const cron = value.trim();
  const timezoneMatch = cron.match(/^CRON_TZ=([A-Za-z0-9_./+-]+)\s+/);
  if (timezoneMatch) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezoneMatch[1] }).format(); }
    catch { throw new Error(`cron uses an unknown timezone: ${timezoneMatch[1]}`); }
  }
  const withoutTimezone = timezoneMatch ? cron.slice(timezoneMatch[0].length) : cron;
  const fields = withoutTimezone.split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !field || !/^[0-9*/?,LW#-]+$/.test(field))) {
    throw new Error("cron must be a valid 5-field CRON expression (optionally prefixed with CRON_TZ=<IANA timezone>)");
  }
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  fields.forEach((field, index) => {
    for (const token of field.split(",")) {
      const [base, step] = token.split("/");
      if (token.split("/").length > 2 || base.split("-").length > 2) throw new Error(`cron field ${index + 1} contains an invalid range or step`);
      if (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1 || Number(step) > 60)) throw new Error(`cron field ${index + 1} contains an invalid step`);
      const parts = base.split("-");
      for (const part of parts) {
        if (/^\d+$/.test(part) && (Number(part) < ranges[index][0] || Number(part) > ranges[index][1])) throw new Error(`cron field ${index + 1} contains an out-of-range value`);
      }
    }
  });
  return cron;
}

function requireQStash(): string {
  if (!config.qstashToken) throw new Error("QStash is not configured. Set QSTASH_TOKEN.");
  return config.qstashToken;
}

const ATTENTION_PULSE_JOB_ID = (userId: number) => `pulse_${userId}`;
const ATTENTION_PULSE_SCHEDULE_ID = (userId: number) => `chuck-attention-pulse-${userId}`;
const ATTENTION_PULSE_BINDING: ScheduledWorkerBinding = {
  worker: "elena",
  objective: "Review the owner's attention state and act within standing-order authority.",
  expectedOutput: "A concise owner-facing attention digest, or NO_ACTION when nothing needs delivery.",
  model: config.defaultModel,
  // Pulse runs are deliberately narrower than ordinary Elena work. They can
  // inspect and update attention/task/reminder state, but cannot directly use
  // connected-app actions without an explicit capability expansion.
  allowedTools: [...ATTENTION_PULSE_TOOLS],
  allowedComposioTools: [],
  approvalPolicy: "require_chusky_approval",
  timeoutSeconds: 90,
  maxToolCalls: 30,
  duration: "30m",
  budgetSeconds: 1800,
};

async function ensureAttentionPulseDeliveryPreference(userId: number, runtime: NativeToolRuntime): Promise<void> {
  const conversationId = runtime.deliveryTarget?.provider === "telegram"
    ? runtime.deliveryTarget.conversationId
    : String(userId);
  const preferences = await listAttentionRecords(userId, "delivery_preference", { limit: 50 }) as DeliveryPreferenceRecord[];
  const existing = preferences.find((item) => item.provider === "telegram" && (!item.conversationId || item.conversationId === conversationId));
  if (existing) return;
  await createAttentionRecord(userId, "delivery_preference", {
    provider: "telegram",
    conversationId,
    enabled: true,
    mode: "immediate",
    // Hourly pulse runs should never turn into an unbounded notification stream.
    maxPerDay: 4,
  });
}

type PulseConnectedAccount = { id: string; toolkit: string; alias?: string; status?: string };

async function loadPulseConnectedAccounts(userId: number): Promise<{ verified: boolean; accounts: PulseConnectedAccount[] }> {
  try {
    // Keep this boundary lazy: agent.ts and nativeTools.ts participate in the
    // runtime tool graph, while status/enable can still be used in isolation.
    const { listConnectedAccounts } = await import("./agent.js");
    return { verified: true, accounts: await listConnectedAccounts(userId) };
  } catch (error) {
    logger.warn({ err: error, userId }, "Could not verify connected accounts while reconciling Attention Pulse state");
    return { verified: false, accounts: [] };
  }
}

/**
 * Keep universal starter watches aligned with verified connected accounts.
 * Missing providers are represented by capability candidates, never by active
 * watches that can later be reported as overdue.
 */
export async function syncDefaultProactiveWatchesForConnectedAccounts(
  userId: number,
  accounts: readonly PulseConnectedAccount[],
  now = Date.now(),
): Promise<AutonomyWatchRecord[]> {
  const existing = await listAttentionRecords(userId, "autonomy_watch", { limit: 200 }) as AutonomyWatchRecord[];
  const availableSpecs = defaultWatchSpecsForConnectedAccounts(accounts);
  const availableKeys = new Set(availableSpecs.map((spec) => `${spec.domain}:${spec.name}`.toLowerCase()));
  const defaultKeys = new Set(DEFAULT_PROACTIVE_WATCHES.map((spec) => `${spec.domain}:${spec.name}`.toLowerCase()));

  for (const watch of existing) {
    const key = `${watch.domain}:${watch.name}`.toLowerCase();
    if (!defaultKeys.has(key) || watch.connectedAccountId) continue;
    if (!availableKeys.has(key) && watch.status === "active") {
      await updateAttentionRecord(userId, "autonomy_watch", watch.id, {
        status: "paused",
        lastError: DEFAULT_WATCH_CONNECTION_WAIT_ERROR,
      });
    } else if (availableKeys.has(key) && watch.status === "paused" && watch.lastError === DEFAULT_WATCH_CONNECTION_WAIT_ERROR) {
      await updateAttentionRecord(userId, "autonomy_watch", watch.id, {
        status: "active",
        nextCheckAt: now,
        lastError: "",
      });
    }
  }

  for (const spec of missingDefaultWatchKeys(existing, availableSpecs)) {
    await createAttentionRecord(userId, "autonomy_watch", defaultWatchInput(spec, now));
  }
  return await listAttentionRecords(userId, "autonomy_watch", { limit: 200 }) as AutonomyWatchRecord[];
}

async function syncAttentionPulseProactiveState(userId: number, now = Date.now()): Promise<{
  verified: boolean;
  accounts: PulseConnectedAccount[];
  candidates: Awaited<ReturnType<typeof ensureAttentionPulseCapabilityCandidates>>;
}> {
  const connectionState = await loadPulseConnectedAccounts(userId);
  if (!connectionState.verified) return { ...connectionState, candidates: [] };
  await syncDefaultProactiveWatchesForConnectedAccounts(userId, connectionState.accounts, now);
  const candidates = await ensureAttentionPulseCapabilityCandidates(userId, {
    connectedAccounts: connectionState.accounts,
    connectedAccountsVerified: true,
  }, now);
  return { ...connectionState, candidates };
}

export async function configureAttentionPulse(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime = {}): Promise<unknown> {
  const action = String(args.action ?? "");
  if (!["enable", "disable", "status"].includes(action)) throw new Error("Attention pulse action must be enable, disable, or status");
  if (runtime.sharedConversation && action === "enable") throw new Error("Attention pulse must be enabled from your private Chusky chat");
  const active = (await listJobs(userId)).filter((job) => job.kind === "attention_pulse");
  if (action === "status") {
    // Status may be inspected while Pulse is disabled. Do not create
    // notification candidates until the owner has opted into the loop.
    const proactiveState = active.length ? await syncAttentionPulseProactiveState(userId) : {
      verified: false,
      accounts: [] as PulseConnectedAccount[],
      candidates: [] as Awaited<ReturnType<typeof ensureAttentionPulseCapabilityCandidates>>,
    };
    const pulseJob = active.find((job) => job.id === ATTENTION_PULSE_JOB_ID(userId));
    if (pulseJob?.status === "active" && config.qstashToken && isDurableStore()) {
      const latest = (await listJobOccurrences(userId, pulseJob.id, 1))[0];
      const watchCoverage = await getAttentionPulseWatchCoverage(userId);
      const needsFirstCheck = watchCoverage.some((watch) => watch.status === "not_checked");
      const latestAt = latest?.completedAt ?? latest?.startedAt ?? latest?.createdAt;
      const needsRecoveryKick = !latestAt || Date.now() - latestAt > 2 * 60 * 60_000;
      if (needsFirstCheck || needsRecoveryKick) {
        try { await runJobNow(userId, pulseJob.id); }
        catch (error) { logger.warn({ err: error, userId, jobId: pulseJob.id }, "Could not queue the Attention Pulse recovery kick"); }
      }
    }
    const watchCoverage = await getAttentionPulseWatchCoverage(userId);
    const pulseJobs = active.filter((job) => job.id === ATTENTION_PULSE_JOB_ID(userId));
    const occurrences = (await listJobOccurrences(userId, ATTENTION_PULSE_JOB_ID(userId), 12)).map((occurrence) => ({
      occurrenceId: occurrence.occurrenceId, status: occurrence.status, startedAt: occurrence.startedAt, completedAt: occurrence.completedAt,
      error: occurrence.error, nextAction: occurrence.nextAction, result: occurrence.result?.slice(0, 500), pulseEvidence: occurrence.pulseEvidence,
    }));
    const latestOccurrence = occurrences[0];
    const latestActivityAt = latestOccurrence?.completedAt ?? latestOccurrence?.startedAt;
    const cadence = pulseJobs[0]?.cron === "*/30 * * * *" ? "every_30_minutes" as const : pulseJobs[0]?.cron === "0 9 * * *" ? "daily" as const : "hourly" as const;
    const productHealth = classifyPulseHealth({
      enabled: pulseJobs.some((job) => job.status === "active"),
      cadence,
      jobStatus: pulseJobs[0]?.status === "paused" || pulseJobs[0]?.status === "cancelled" ? pulseJobs[0].status : pulseJobs[0]?.status === "active" ? "active" : undefined,
      scheduleError: pulseJobs[0]?.scheduleError,
      latestOccurrence,
      activeWatches: watchCoverage.length,
      currentWatches: watchCoverage.filter((watch) => watch.status === "current").length,
      scheduledWatches: watchCoverage.filter((watch) => watch.status === "scheduled").length,
      staleWatches: watchCoverage.filter((watch) => watch.status === "stale").length,
      failedWatches: watchCoverage.filter((watch) => watch.status === "failed").length,
      neverCheckedWatches: watchCoverage.filter((watch) => watch.status === "not_checked").length,
      pendingSuggestions: proactiveState.candidates.filter((candidate) => candidate.status === "pending").length,
      connectedAccountsVerified: proactiveState.verified,
    });
    return {
      enabled: pulseJobs.some((job) => job.status === "active"),
      jobs: pulseJobs,
      // Keep the legacy occurrence counters for older callers, but include the
      // canonical product classifier so Telegram, the API, and the dashboard
      // can describe one durable state consistently.
      health: { ...productHealth, lastOccurrence: latestOccurrence, recentFailures: occurrences.filter((item) => item.status === "failed" || item.status === "blocked").length, neverRun: Boolean(pulseJobs[0] && !latestActivityAt), stale: Boolean(pulseJobs[0] && (!latestActivityAt || Date.now() - latestActivityAt > 2 * 60 * 60_000)) },
      occurrences,
      connectedAccountsVerified: proactiveState.verified,
      capabilitySuggestions: proactiveState.candidates.filter((candidate) => candidate.status === "pending").slice(0, 3),
      watchCoverage: {
        scope: "owner-configured watches plus bounded read-only starter watches for active connected apps; not an unrestricted provider sweep",
        active: watchCoverage.length,
        current: watchCoverage.filter((watch) => watch.status === "current").length,
        scheduled: watchCoverage.filter((watch) => watch.status === "scheduled").length,
        stale: watchCoverage.filter((watch) => watch.status === "stale").length,
        failed: watchCoverage.filter((watch) => watch.status === "failed").length,
        neverChecked: watchCoverage.filter((watch) => watch.status === "not_checked").length,
        watches: watchCoverage,
      },
    };
  }
  if (action === "disable") {
    for (const job of active) await cancelJob(userId, job.id);
    return { enabled: false, cancelled: active.map((job) => job.id) };
  }
  const cron = validateCronExpression(args.cron ? text(args.cron) : "0 * * * *");
  const existing = active.find((job) => job.id === ATTENTION_PULSE_JOB_ID(userId));
  if (existing) {
    if (existing.cron === cron) {
      await ensureAttentionPulseDeliveryPreference(userId, runtime);
      await syncAttentionPulseProactiveState(userId);
      if (!existing.heartbeat) await updateJob(userId, existing.id, { heartbeat: true });
      // A legacy Pulse can be active while its first provider check was never
      // admitted. Give an existing job the same observable first run as a new
      // job when QStash is available; status/enable remains usable in tests or
      // installations that have not configured the scheduler yet.
      const latestOccurrence = (await listJobOccurrences(userId, existing.id, 1))[0];
      if (config.qstashToken && isDurableStore() && process.env.NODE_ENV !== "test" && (!latestOccurrence || Date.now() - latestOccurrence.createdAt > 30 * 60_000)) await runJobNow(userId, existing.id);
      return existing;
    }
    const client = new QStashClient({ token: requireQStash() });
    const schedule = (scheduledCron: string) => ({
      scheduleId: existing.scheduleId,
      destination: workflowUrl(config.jobWorkflowUrl, "JOB_WORKFLOW_URL", "/workflows/job"),
      body: JSON.stringify({ jobId: existing.id, userId }), headers: { "Content-Type": "application/json" },
      cron: scheduledCron, retries: 3, retryDelay: "1000 * (1 + retried)",
      ...(workflowFailureUrl() ? { failureCallback: workflowFailureUrl() } : {}),
    });
    await client.schedules.delete(existing.scheduleId);
    try {
      await client.schedules.create(schedule(cron));
      if (!(await updateJob(userId, existing.id, { cron, deliveryError: undefined }))) throw new Error("The attention-pulse record disappeared while updating its schedule");
    } catch (error) {
      try {
        await client.schedules.delete(existing.scheduleId).catch(() => undefined);
        await client.schedules.create(schedule(existing.cron));
      } catch (restoreError) {
        await updateJob(userId, existing.id, { deliveryError: `Schedule update failed and the prior QStash schedule could not be restored: ${String(restoreError).slice(0, 300)}` });
        throw new Error("The attention-pulse schedule update failed, and QStash could not restore the previous schedule. Inspect the job status before retrying.", { cause: error });
      }
      throw error;
    }
    await ensureAttentionPulseDeliveryPreference(userId, runtime);
    await syncAttentionPulseProactiveState(userId);
    return { ...existing, cron };
  }
  const qstashToken = requireQStash();
  await ensureAttentionPulseDeliveryPreference(userId, runtime);
  await syncAttentionPulseProactiveState(userId);
  const deliveryTarget = durableReminderTarget(runtime.deliveryTarget);
  const job: JobRecord = {
    id: ATTENTION_PULSE_JOB_ID(userId), userId,
    text: "Run the owner's proactive attention pulse.", cron,
    scheduleId: ATTENTION_PULSE_SCHEDULE_ID(userId), status: "active", kind: "attention_pulse",
    workerBinding: ATTENTION_PULSE_BINDING, heartbeat: true,
    ...(deliveryTarget ? { deliveryTarget } : {}), createdAt: Date.now(),
  };
  const client = new QStashClient({ token: qstashToken });
  await addJob(userId, job);
  try {
    await client.schedules.create({
      scheduleId: job.scheduleId,
      destination: workflowUrl(config.jobWorkflowUrl, "JOB_WORKFLOW_URL", "/workflows/job"),
      body: JSON.stringify({ jobId: job.id, userId }), headers: { "Content-Type": "application/json" },
      cron, retries: 3, retryDelay: "1000 * (1 + retried)",
      ...(workflowFailureUrl() ? { failureCallback: workflowFailureUrl() } : {}),
    });
  } catch (error) {
    await updateJob(userId, job.id, { status: "cancelled", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  // A new Pulse must produce observable work immediately. The recurring
  // schedule remains hourly; this one-shot admission gives the owner a first
  // bounded check without waiting for the next cron tick.
  try {
    await runJobNow(userId, job.id);
  } catch (error) {
    await updateJob(userId, job.id, { deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw new Error("Attention Pulse was scheduled, but its first run could not be queued. Inspect Pulse status before retrying.", { cause: error });
  }
  return job;
}

function futureTimestamp(args: Record<string, unknown>): number {
  const now = Date.now();
  const hasRunAt = args.runAt !== undefined;
  const hasDelay = args.delaySeconds !== undefined;
  if (hasRunAt === hasDelay) throw new Error("Provide exactly one of runAt (ISO-8601 with timezone) or delaySeconds");
  let runAt: number;
  if (hasRunAt) {
    const value = String(args.runAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
      throw new Error("runAt must be an ISO-8601 timestamp with an explicit timezone, such as Z or +01:00");
    }
    runAt = Date.parse(value);
    if (!Number.isFinite(runAt)) throw new Error("runAt is not a valid ISO-8601 timestamp");
  } else {
    const delay = Number(args.delaySeconds);
    if (!Number.isSafeInteger(delay) || delay < 1 || delay > 365 * 24 * 60 * 60) {
      throw new Error("delaySeconds must be a whole number from 1 to 31536000");
    }
    runAt = now + delay * 1000;
  }
  if (!Number.isFinite(runAt) || runAt <= now) throw new Error("Reminder time must be in the future (use runAt ISO or delaySeconds)");
  if (runAt > now + 365 * 24 * 60 * 60 * 1000) throw new Error("Reminder cannot be more than one year ahead");
  return runAt;
}

function durableReminderTarget(target: NativeToolRuntime["deliveryTarget"]): ReminderDeliveryTarget | undefined {
  if (!target?.provider || !target.conversationId) return undefined;
  const metadata = target.metadata
    ? Object.fromEntries(Object.entries(target.metadata).filter(([key]) => key === "groupId" || key === "groupParticipants"))
    : undefined;
  return {
    provider: target.provider,
    conversationId: target.conversationId,
    ...(target.threadId ? { threadId: target.threadId } : {}),
    ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
    ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
  };
}

function autonomyMode(args: Record<string, unknown>, fallback: AutonomyMode = "notify", allowWait = false): AutonomyMode {
  const candidate = typeof args.mode === "string" ? args.mode : fallback;
  const allowed: AutonomyMode[] = allowWait ? ["notify", "check_in", "act", "wait_until"] : ["notify", "check_in", "act"];
  return allowed.includes(candidate as AutonomyMode) ? candidate as AutonomyMode : fallback;
}

function autonomyLinks(args: Record<string, unknown>): AutonomyLinks | undefined {
  if (!args.links || typeof args.links !== "object" || Array.isArray(args.links)) return undefined;
  const input = args.links as Record<string, unknown>;
  const allowed = ["taskId", "missionId", "missionStepId", "openLoopId", "attentionCandidateId", "projectId", "meetingId", "conversationId"] as const;
  const links: AutonomyLinks = {};
  for (const key of allowed) if (typeof input[key] === "string" && input[key].trim()) links[key] = input[key].trim().slice(0, 160);
  return Object.keys(links).length ? links : undefined;
}

function boundedAutonomyList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 8).map((item) => item.trim().slice(0, 500));
}

export async function setReminder(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime = {}): Promise<ReminderRecord> {
  const deliveryTarget = durableReminderTarget(runtime.deliveryTarget);
  const mode = autonomyMode(args, "notify", true);
  const links = autonomyLinks(args);
  const reminder: ReminderRecord = {
    id: `rem_${randomUUID()}`,
    userId,
    text: text(args.text),
    runAt: futureTimestamp(args),
    status: "scheduled",
    ...(mode !== "notify" ? { mode } : {}),
    ...(links ? { links } : {}),
    ...(typeof args.nextAction === "string" && args.nextAction.trim() ? { nextAction: text(args.nextAction) } : {}),
    ...(mode === "wait_until" && Number.isFinite(Number(args.pollEverySeconds)) ? { pollEverySeconds: Math.max(60, Math.min(7 * 24 * 60 * 60, Math.floor(Number(args.pollEverySeconds)))) } : {}),
    ...(boundedAutonomyList(args.preconditions) ? { preconditions: boundedAutonomyList(args.preconditions) } : {}),
    ...(boundedAutonomyList(args.postconditions) ? { postconditions: boundedAutonomyList(args.postconditions) } : {}),
    ...(mode !== "notify" ? { contextSnapshot: { capturedAt: Date.now(), objective: text(args.text), ...(links ? { links } : {}), source: "user" as const } } : {}),
    ...(deliveryTarget ? { deliveryTarget } : {}),
    createdAt: Date.now(),
  };
  await addReminder(userId, reminder);
  try {
    const workflow = await enqueueReminderWorkflow(userId, reminder, Math.max(1, Math.ceil((reminder.runAt - Date.now()) / 1000)), reminder.id);
    reminder.workflowRunId = workflow.workflowRunId;
    await updateReminder(userId, reminder.id, { workflowRunId: reminder.workflowRunId });
  } catch (error) {
    await updateReminder(userId, reminder.id, { status: "failed", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  return reminder;
}

async function enqueueReminderWorkflow(userId: number, reminder: ReminderRecord, delaySeconds: number, workflowRunId: string, attemptId?: string) {
  return new WorkflowClient({ token: requireQStash(), baseUrl: config.qstashUrl || undefined }).trigger({
    url: workflowUrl(config.reminderWorkflowUrl, "REMINDER_WORKFLOW_URL", "/workflows/reminder"),
    body: { reminderId: reminder.id, userId, ...(attemptId ? { attemptId } : {}) },
    delay: Math.max(1, Math.floor(delaySeconds)),
    workflowRunId,
    retries: 3,
    retryDelay: "1000 * (1 + retried)",
    ...(workflowFailureUrl() ? { failureUrl: workflowFailureUrl() } : {}),
  });
}

export async function cancelReminder(userId: number, id: string): Promise<string> {
  const reminder = await getReminder(userId, id);
  if (!reminder) throw new Error("Reminder not found or not owned by you");
  const allowed = ["scheduled", "waiting", "paused"] as const;
  if (!allowed.includes(reminder.status as typeof allowed[number])) throw new Error(`Cannot cancel a ${reminder.status} reminder`);
  const updated = await transitionReminderStatus(userId, id, [...allowed], { status: "cancelled" });
  if (!updated) {
    const latest = await getReminder(userId, id);
    throw new Error(`Reminder state changed${latest ? ` to ${latest.status}` : " or the reminder was removed"}; it was not cancelled`);
  }
  return `Reminder ${id} cancelled.`;
}

export async function pauseReminder(userId: number, id: string): Promise<string> {
  const reminder = await getReminder(userId, id);
  if (!reminder) throw new Error("Reminder not found or not owned by you");
  if (["sent", "cancelled", "failed"].includes(reminder.status)) throw new Error(`Cannot pause a ${reminder.status} reminder`);
  if (reminder.status === "paused") return `Reminder ${id} is already paused.`;
  await updateReminder(userId, id, { status: "paused", deliveryError: undefined });
  return `Reminder ${id} paused.`;
}

export async function resumeReminder(userId: number, id: string): Promise<string> {
  const reminder = await getReminder(userId, id);
  if (!reminder) throw new Error("Reminder not found or not owned by you");
  if (reminder.status !== "paused") return reminder.status === "scheduled" || reminder.status === "waiting" ? `Reminder ${id} is already active.` : `Cannot resume a ${reminder.status} reminder`;
  const runAt = Math.max(Date.now() + 1_000, reminder.runAt);
  await updateReminder(userId, id, { status: "scheduled", runAt, deliveryError: undefined });
  try {
    const workflow = await enqueueReminderWorkflow(userId, { ...reminder, status: "scheduled", runAt }, Math.ceil((runAt - Date.now()) / 1000), `${id}-resume-${randomUUID()}`, `resume-${randomUUID()}`);
    await updateReminder(userId, id, { workflowRunId: workflow.workflowRunId });
  } catch (error) {
    await updateReminder(userId, id, { status: "paused", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  return `Reminder ${id} resumed.`;
}

export async function runReminderNow(userId: number, id: string): Promise<{ reminderId: string; workflowRunId: string }> {
  const reminder = await getReminder(userId, id);
  if (!reminder) throw new Error("Reminder not found or not owned by you");
  if (["sent", "cancelled", "failed"].includes(reminder.status)) throw new Error(`Cannot run a ${reminder.status} reminder`);
  const next = { ...reminder, status: "scheduled" as const, runAt: Date.now() + 1_000 };
  await updateReminder(userId, id, { status: next.status, runAt: next.runAt, deliveryError: undefined });
  try {
    const workflow = await enqueueReminderWorkflow(userId, next, 1, `${id}-manual-${randomUUID()}`, `manual-${randomUUID()}`);
    await updateReminder(userId, id, { workflowRunId: workflow.workflowRunId });
    return { reminderId: id, workflowRunId: workflow.workflowRunId };
  } catch (error) {
    await updateReminder(userId, id, { status: reminder.status, deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
}

export async function scheduleJob(userId: number, args: Record<string, unknown>, runtime: NativeToolRuntime = {}): Promise<JobRecord> {
  const cron = validateCronExpression(text(args.cron));
  const jobText = text(args.text);
  const workerBinding: ScheduledWorkerBinding | undefined = runtime.worker && runtime.workerBinding
    ? { worker: runtime.worker, objective: jobText, ...runtime.workerBinding }
    : undefined;
  const deliveryTarget = durableReminderTarget(runtime.deliveryTarget);
  const mode = autonomyMode(args, workerBinding ? "act" : "notify");
  const links = autonomyLinks(args);
  const job: JobRecord = { id: `job_${randomUUID()}`, userId, text: jobText, cron, scheduleId: `chuck-${userId}-${randomUUID()}`, status: "active", ...(mode !== "notify" ? { mode } : {}), ...(links ? { links } : {}), ...(typeof args.nextAction === "string" && args.nextAction.trim() ? { nextAction: text(args.nextAction) } : {}), ...(boundedAutonomyList(args.preconditions) ? { preconditions: boundedAutonomyList(args.preconditions) } : {}), ...(boundedAutonomyList(args.postconditions) ? { postconditions: boundedAutonomyList(args.postconditions) } : {}), ...(mode !== "notify" ? { contextSnapshot: { capturedAt: Date.now(), objective: jobText, ...(links ? { links } : {}), source: "user" as const } } : {}), ...(workerBinding ? { workerBinding } : {}), ...(deliveryTarget ? { deliveryTarget } : {}), createdAt: Date.now() };
  const client = new QStashClient({ token: requireQStash() });
  await addJob(userId, job);
  try { await client.schedules.create({
    scheduleId: job.scheduleId,
    destination: workflowUrl(config.jobWorkflowUrl, "JOB_WORKFLOW_URL", "/workflows/job"),
    body: JSON.stringify({ jobId: job.id, userId }),
    headers: { "Content-Type": "application/json" },
    cron,
    retries: 3,
    retryDelay: "1000 * (1 + retried)",
    ...(workflowFailureUrl() ? { failureCallback: workflowFailureUrl() } : {}),
  }); } catch (error) {
    await updateJob(userId, job.id, { status: "cancelled", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw error;
  }
  return job;
}

export async function cancelJob(userId: number, id: string): Promise<string> {
  const job = await getJob(userId, id);
  if (!job) throw new Error("Job not found or not owned by you");
  // Flip durable state first: an already-queued QStash invocation must observe
  // cancellation and skip, even if schedule deletion races or is delayed.
  await updateJob(userId, id, { status: "cancelled" });
  const client = new QStashClient({ token: requireQStash() });
  try { await client.schedules.delete(job.scheduleId); }
  catch (error) {
    // The schedule may already be gone. Keep the cancellation authoritative;
    // a stray delivery will re-read the record and be safely ignored.
    throw new Error(`Recurring job cancelled locally but QStash schedule removal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return `Recurring job ${id} cancelled.`;
}

export async function pauseJob(userId: number, id: string): Promise<string> {
  const job = await getJob(userId, id);
  if (!job) throw new Error("Job not found or not owned by you");
  if (job.status === "cancelled") throw new Error("Cannot pause a cancelled job");
  if (job.status === "paused") return `Recurring job ${id} is already paused.`;
  await updateJob(userId, id, { status: "paused", deliveryError: undefined });
  try {
    await new QStashClient({ token: requireQStash() }).schedules.pause({ schedule: job.scheduleId });
  } catch (error) {
    await updateJob(userId, id, { status: "active", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw new Error(`Recurring job was not paused: ${error instanceof Error ? error.message : String(error)}`);
  }
  return `Recurring job ${id} paused.`;
}

export async function resumeJob(userId: number, id: string): Promise<string> {
  const job = await getJob(userId, id);
  if (!job) throw new Error("Job not found or not owned by you");
  if (job.status === "cancelled") throw new Error("Cannot resume a cancelled job");
  if (job.status === "active") return `Recurring job ${id} is already active.`;
  await updateJob(userId, id, { status: "active", deliveryError: undefined });
  try {
    await new QStashClient({ token: requireQStash() }).schedules.resume({ schedule: job.scheduleId });
  } catch (error) {
    await updateJob(userId, id, { status: "paused", deliveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
    throw new Error(`Recurring job was not resumed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return `Recurring job ${id} resumed.`;
}

export async function runJobNow(userId: number, id: string): Promise<{ jobId: string; occurrenceId: string; workflowRunId: string }> {
  const job = await getJob(userId, id);
  if (!job) throw new Error("Job not found or not owned by you");
  if (job.status !== "active") throw new Error("Resume the job before running it");
  const occurrenceId = `manual-${randomUUID()}`;
  const now = Date.now();
  const occurrence = await createJobOccurrence({
    id: `occ_${job.id}_${occurrenceId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 240),
    userId,
    jobId: job.id,
    occurrenceId,
    status: "queued",
    mode: job.mode ?? (job.workerBinding ? "act" : "notify"),
    idempotencyKey: `job:${job.id}:${occurrenceId}`,
    ...(job.contextSnapshot ? { context: job.contextSnapshot } : {}),
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
  const workflow = await new WorkflowClient({ token: requireQStash(), baseUrl: config.qstashUrl || undefined }).trigger({
    url: workflowUrl(config.jobWorkflowUrl, "JOB_WORKFLOW_URL", "/workflows/job"),
    // Manual Pulse runs are explicit owner requests. The workflow uses this
    // flag to force one bounded read-only watch check even when the watch's
    // normal hourly checkpoint is still in the future.
    body: { jobId: job.id, userId, occurrenceId, ...(job.kind === "attention_pulse" ? { forceAttentionPulse: true } : {}) },
    delay: 1,
    workflowRunId: `job-${job.id}-${occurrenceId}`,
    retries: 3,
    retryDelay: "1000 * (1 + retried)",
    ...(workflowFailureUrl() ? { failureUrl: workflowFailureUrl() } : {}),
    flowControl: { key: `chusky-job-user-${userId}`, parallelism: 1, rate: 1, period: "1s" },
  }).catch(async (error) => {
    await updateJobOccurrence(userId, occurrence.id, {
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      completedAt: Date.now(),
    }, occurrence.version);
    throw error;
  });
  return { jobId: job.id, occurrenceId, workflowRunId: workflow.workflowRunId };
}

async function resumeBrowserHandoff(userId: number, id: string, ownerPrivateRun: boolean): Promise<Record<string, unknown>> {
  if (!ownerPrivateRun) throw new Error("Private browser handoffs are available only in the owner's private conversation");
  const handoff = await getBrowserHandoff(userId, id);
  if (!handoff) throw new Error("Browser handoff not found or not owned by you");
  if (["expired", "cancelled"].includes(handoff.status)) throw new Error(`This browser handoff is ${handoff.status}. Request a new private handoff.`);
  if (handoff.status === "completed") return { id, status: "completed", alreadyCompleted: true };

  // A model may call resume immediately after the owner says "continue",
  // before the explicit handoff-complete acknowledgement has been recorded.
  // This is a normal protocol state, not a browser failure. Do not touch the
  // retained page or convert the handoff to awaiting_verification here.
  if (handoff.status === "waiting") {
    return {
      id,
      status: "waiting_for_owner",
      needsUserInteraction: true,
      expiresAt: handoff.expiresAt,
      next: "The private browser handoff is still waiting for the owner. After the owner finishes the website step, call CHUCK_BROWSER_HANDOFF_COMPLETE, then inspect and verify the same-origin page before resuming browser actions.",
    };
  }

  // The owner has explicitly completed the handoff. The retained page may now
  // be inspected for same-origin verification; no website mutation occurs in
  // this function.
  const browser = automatedBrowserEngine("state");
  const observed = await browser.browser(userId, { action: "state", maxDepth: 8 }, { ownerPrivateRun: true }) as {
    provider?: unknown; observedUrl?: unknown; observationMethod?: unknown; title?: unknown; challenge?: unknown; needsUserInteraction?: unknown;
  };
  const currentUrl = typeof observed.observedUrl === "string" ? observed.observedUrl : undefined;
  if (!currentUrl || !isTrustedBrowserUrlObservation(observed.provider, observed.observationMethod)) {
    return { id, status: "awaiting_verification", needsUserInteraction: true, next: "The retained browser URL is not yet observable. Keep the handoff open and try resume again." };
  }
  let currentOrigin: string;
  try { currentOrigin = new URL(currentUrl).origin; } catch { throw new Error("The retained browser returned an invalid URL; the handoff remains unverified"); }
  if (handoff.origin && currentOrigin !== handoff.origin) throw new Error("The retained browser is outside the website origin bound to this handoff");
  const challenge = observed.challenge && typeof observed.challenge === "object" ? observed.challenge as { detected?: unknown } : undefined;
  if (browserChallengeStillActive(observed)) {
    if (handoff.resolutionState !== "handoff_required") await updateBrowserHandoffResolution(userId, id, "handoff_required");
    return { id, status: "awaiting_verification", needsUserInteraction: true, ...(typeof observed.title === "string" ? { title: observed.title } : {}), next: "The challenge is still present. Complete it in the retained private browser, then resume again." };
  }

  const linkedVaultLogin = Boolean(handoff.credentialId || (handoff.reason === "login" && handoff.service));
  if (linkedVaultLogin) {
    const credentials = await listVault(userId);
    const matches = credentials.filter((credential) => credential.session?.workspaceId === handoff.workspaceId && credential.session.status === "awaiting_user_interaction"
      && (handoff.credentialId ? credential.id === handoff.credentialId : (!handoff.service || credential.service === handoff.service)));
    const saved = matches.length === 1 ? matches[0] : undefined;
    if (!saved?.session) throw new Error("The retained browser is no longer linked to a pending vault login");
    const session = await recordVaultSession(userId, { credentialId: saved.id, service: saved.service, accountAlias: saved.accountAlias, origin: saved.origin, workspaceId: saved.session.workspaceId, status: "authenticated", lastAuthenticatedAt: Date.now(), lastUsedAt: Date.now() });
    await updateBrowserHandoffResolution(userId, id, transitionChallengeState(handoff.resolutionState ?? "handoff_required", "verification_passed"));
    await updateBrowserHandoff(userId, id, "completed", Date.now());
    await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "handoff_completed", service: saved.service, origin: saved.origin, status: "succeeded", summary: "Private browser handoff resumed automatically after same-origin challenge clearance", createdAt: Date.now() });
    return { id, status: "completed", handoffCompleted: true, session: { id: session.id, workspaceId: session.workspaceId, status: session.status, origin: session.origin } };
  }
  await updateBrowserHandoffResolution(userId, id, transitionChallengeState(handoff.resolutionState ?? "handoff_required", "verification_passed"));
  await updateBrowserHandoff(userId, id, "completed", Date.now());
  await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "handoff_completed", ...(handoff.origin ? { origin: handoff.origin } : {}), status: "succeeded", summary: "Private browser handoff resumed automatically after same-origin challenge clearance", createdAt: Date.now() });
  return { id, status: "completed", handoffCompleted: true };
}

export async function nativeTool(userId: number, slug: string, args: Record<string, unknown>, runtime: NativeToolRuntime = {}): Promise<unknown> {
  const canonicalSlug = canonicalNativeToolSlug(slug);
  if (canonicalSlug !== slug) return nativeTool(userId, canonicalSlug, args, runtime);
  if (runtime.sharedConversation && isSharedChannelToolDenied(slug)) {
    throw new Error(`${slug} is available only in a private owner conversation`);
  }
  if (slug === "CHUCK_REQUEST_ADDITIONAL_TOOLS" && !runtime.worker) {
    throw new Error("CHUCK_REQUEST_ADDITIONAL_TOOLS is reserved for specialist workers; Chusky must search and verify the capability directly.");
  }
  if (slug === "CHUCK_REVIEW_SUBAGENT_ACTION" && runtime.worker) {
    throw new Error("Only Chusky can review specialist actions.");
  }
  validateNativeToolArguments(slug, args);
  switch (slug) {
    case "CHUCK_FIND_TOOLS": {
      const allowed = (runtime.availableToolCatalog ?? runtime.toolCatalog)
        ? new Set((runtime.availableToolCatalog ?? runtime.toolCatalog)!.map((tool: any) => String(tool?.function?.name ?? "").trim().toUpperCase()).filter(Boolean))
        : undefined;
      const query = text(args.query, 500);
      const found = searchDiscoveredToolManifest(query, args.bundle as NativeToolBundle | undefined, args.maxResults === undefined ? undefined : Number(args.maxResults), allowed);
      return { tools: found, next: "The returned tools can be called on the next agent round if they are exposed by this run. For a recognized family, this is the complete available family; use one of these tools rather than searching again." };
    }
    case "CHUCK_SEARCH_SKILLS": return searchSkills(text(args.query), args.limit === undefined ? 5 : Number(args.limit));
    case "CHUCK_TINYFISH_SEARCH": {
      if (!config.tinyFishApiKey) throw new Error("TinyFish is not configured. Set the server-only TINYFISH_API_KEY.");
      return createTinyFishClient(config.tinyFishApiKey).search({
        query: text(args.query, 500),
        purpose: optionalText(args.purpose, 2_000, "purpose"),
        location: optionalText(args.location, 100, "location"),
        language: optionalText(args.language, 20, "language"),
        recencyMinutes: args.recencyMinutes === undefined ? undefined : Number(args.recencyMinutes),
        afterDate: optionalText(args.afterDate, 10, "afterDate"),
        beforeDate: optionalText(args.beforeDate, 10, "beforeDate"),
        page: args.page === undefined ? undefined : Number(args.page),
        limit: args.limit === undefined ? undefined : Number(args.limit),
        includeDomains: Array.isArray(args.includeDomains) ? args.includeDomains.map((item) => text(item, 253)) : undefined,
        excludeDomains: Array.isArray(args.excludeDomains) ? args.excludeDomains.map((item) => text(item, 253)) : undefined,
        domainType: args.domainType as "web" | "news" | "research_paper" | undefined,
        pubYearMin: args.pubYearMin === undefined ? undefined : Number(args.pubYearMin),
        pubYearMax: args.pubYearMax === undefined ? undefined : Number(args.pubYearMax),
      }, runtime.signal);
    }
    case "CHUCK_TINYFISH_FETCH": {
      if (!config.tinyFishApiKey) throw new Error("TinyFish is not configured. Set the server-only TINYFISH_API_KEY.");
      return createTinyFishClient(config.tinyFishApiKey).fetch({
        urls: Array.isArray(args.urls) ? args.urls.map((url) => text(url, 2_000)) : [],
        purpose: args.purpose === undefined ? undefined : text(args.purpose, 2_000),
        format: args.format as "markdown" | "html" | "json" | undefined,
        links: args.links === true,
        imageLinks: args.imageLinks === true,
        ttl: args.ttl === undefined ? undefined : Number(args.ttl),
        perUrlTimeoutMs: args.perUrlTimeoutMs === undefined ? undefined : Number(args.perUrlTimeoutMs),
        ifNoneMatch: args.ifNoneMatch === undefined ? undefined : text(args.ifNoneMatch, 500),
        ifModifiedSince: args.ifModifiedSince === undefined ? undefined : text(args.ifModifiedSince, 200),
        includeEtagAndLastModified: args.includeEtagAndLastModified === true,
        includeSelectors: Array.isArray(args.includeSelectors) ? args.includeSelectors.map((item) => text(item, 1_000)) : undefined,
        excludeSelectors: Array.isArray(args.excludeSelectors) ? args.excludeSelectors.map((item) => text(item, 1_000)) : undefined,
        highlights: args.highlights && typeof args.highlights === "object" ? {
          query: text((args.highlights as Record<string, unknown>).query, 2_000),
          maxCount: (args.highlights as Record<string, unknown>).maxCount === undefined ? undefined : Number((args.highlights as Record<string, unknown>).maxCount),
          maxCharacters: (args.highlights as Record<string, unknown>).maxCharacters === undefined ? undefined : Number((args.highlights as Record<string, unknown>).maxCharacters),
        } : undefined,
      }, runtime.signal);
    }
    case "CHUCK_TINYFISH_RESEARCH": {
      if (!config.tinyFishApiKey) throw new Error("TinyFish is not configured. Set the server-only TINYFISH_API_KEY.");
      const action = text(args.action, 20);
      const runs = await listAttentionRecords(userId, "tinyfish_research_run", { limit: 200 }) as TinyFishResearchRunRecord[];
      const client = createTinyFishClient(config.tinyFishApiKey);
      if (action === "list") {
        const limit = args.limit === undefined ? 20 : Number(args.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Research list limit must be an integer from 1 to 50.");
        const statusFilter = args.status === undefined ? "" : text(args.status, 20).toUpperCase();
        if (statusFilter && !["RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(statusFilter)) throw new Error("Unsupported TinyFish Research status filter.");
        const queryFilter = args.query === undefined ? "" : text(args.query, 500).toLowerCase();
        const filtered = runs.filter((item) => (!statusFilter || item.status === statusFilter) && (!queryFilter || item.query.toLowerCase().includes(queryFilter)));
        return { runs: filtered.slice(0, limit).map(({ id, query: savedQuery, mode, status, citations, createdAt, updatedAt }) => ({ id, query: savedQuery, mode, status, citationCount: citations.length, createdAt, updatedAt })), source: "owner-scoped Chusky saved research records" };
      }
      const local = action === "start" ? undefined : runs.find((item) => item.id === text(args.id, 160));
      if (action !== "start" && !local) throw new Error("Saved TinyFish research run not found for this owner.");
      if (action === "get") {
        return { run: await reconcileTinyFishResearchRun(userId, local!.id, config.tinyFishApiKey), contentIsUntrusted: true };
      }
      if (action === "cancel") {
        const provider = await client.cancelResearchRun(local!.providerRunId);
        const status = String(provider.status ?? local!.status).toUpperCase() as TinyFishResearchRunRecord["status"];
        const deep = provider.deep_result && typeof provider.deep_result === "object" ? provider.deep_result as Record<string, unknown> : {};
        const quick = provider.quick_result && typeof provider.quick_result === "object" ? provider.quick_result as Record<string, unknown> : {};
        const report = typeof deep.result === "string" ? deep.result : typeof quick.answer === "string" ? quick.answer : local!.report;
        const citationsValue = deep.citations ?? quick.citations ?? local!.citations;
        const citations = Array.isArray(citationsValue) ? citationsValue.slice(0, 100).flatMap((item) => {
          if (typeof item === "string") { try { return [{ url: assertPublicHttpUrl(item).slice(0, 2_000) }]; } catch { return []; } }
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const citation = item as Record<string, unknown>;
          if (typeof citation.url !== "string") return [];
          try { return [{ url: assertPublicHttpUrl(citation.url).slice(0, 2_000), ...(typeof citation.title === "string" ? { title: citation.title.slice(0, 500) } : {}), ...(typeof citation.snippet === "string" ? { snippet: citation.snippet.slice(0, 1_500) } : {}) }]; } catch { return []; }
        }) : [];
        const errorValue = provider.failure_reason ?? provider.error ?? provider.termination_reason;
        const failureReason = typeof errorValue === "string" ? errorValue.slice(0, 1_000) : undefined;
        const updated = await updateAttentionRecord(userId, "tinyfish_research_run", local!.id, { status: ["RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(status) ? status : local!.status, report, citations, failureReason, progress: typeof provider.progress === "string" ? provider.progress.slice(0, 1_000) : local!.progress }) as TinyFishResearchRunRecord | undefined;
        return { run: updated ?? local, contentIsUntrusted: true };
      }
      if (action !== "start") throw new Error("Unsupported TinyFish research action.");
      if (!config.webhookUrl || !config.qstashToken) throw new Error("Background TinyFish Research requires WEBHOOK_URL and QSTASH_TOKEN so the saved run can be monitored after this chat turn.");
      const query = text(args.query, 2_000);
      const mode = args.mode === "deep" ? "deep" : "standard";
      const existing = runs.find((run) => run.status === "RUNNING" && run.query.toLowerCase() === query.toLowerCase() && run.mode === mode);
      if (existing) return { run: existing, status: existing.status, alreadyRunning: true, note: "An identical owner-scoped TinyFish research run is already active; inspect it instead of starting a duplicate." };
      let saved: TinyFishResearchRunRecord | undefined;
      const result = await client.startResearch({
        query,
        mode,
        outputLanguage: args.outputLanguage === undefined ? undefined : text(args.outputLanguage, 35),
        domainType: args.domainType as "web" | "news" | "research_paper" | undefined,
        afterDate: args.afterDate === undefined ? undefined : text(args.afterDate, 10),
        beforeDate: args.beforeDate === undefined ? undefined : text(args.beforeDate, 10),
        recencyMinutes: args.recencyMinutes === undefined ? undefined : Number(args.recencyMinutes),
        includeDomains: Array.isArray(args.includeDomains) ? args.includeDomains.map((item) => text(item, 253)) : undefined,
        excludeDomains: Array.isArray(args.excludeDomains) ? args.excludeDomains.map((item) => text(item, 253)) : undefined,
        onRunCreated: async (providerRunId) => {
          saved = await createAttentionRecord(userId, "tinyfish_research_run", { providerRunId, query, mode, status: "RUNNING", progress: "TinyFish accepted the saved research run; waiting for report results.", citations: [] }) as TinyFishResearchRunRecord;
        },
      }, runtime.signal);
      if (!saved) throw new Error("TinyFish created a report but its owner-scoped run record could not be saved.");
      let workflowRunId: string | undefined;
      try {
        workflowRunId = await enqueueTinyFishResearchWorkflow(userId, saved.id);
        saved = await updateAttentionRecord(userId, "tinyfish_research_run", saved.id, { workflowRunId }) as TinyFishResearchRunRecord ?? saved;
      } catch (error) {
        return { run: saved, status: "RUNNING", recovery: "The TinyFish run was saved, but automatic reconciliation could not be queued. Use this run ID with action=get to inspect it; do not start a duplicate." };
      }
      return { run: saved, status: result.status, workflowRunId, note: "The cited report is being prepared in the background. Use CHUCK_TINYFISH_RESEARCH action=get or list to inspect it; do not start a duplicate while it is running." };
    }
    case "CHUCK_TINYFISH_MONITOR": {
      if (!config.tinyFishApiKey) throw new Error("TinyFish is not configured. Set the server-only TINYFISH_API_KEY.");
      const client = createTinyFishClient(config.tinyFishApiKey);
      const action = text(args.action, 20);
      const monitors = await listAttentionRecords(userId, "tinyfish_monitor", { limit: 200 }) as TinyFishMonitorRecord[];
      if (action === "list") return { monitors: monitors.filter((item) => item.status !== "deleted"), source: "owner-scoped Chusky monitor records" };
      const monitor = action === "create" ? undefined : monitors.find((item) => item.id === text(args.id, 160));
      if (action !== "create" && !monitor) throw new Error("TinyFish monitor not found for this owner.");
      if (action === "get") {
        const response = await client.getMonitor(monitor!.providerMonitorId);
        const providerMonitor = response.monitor && typeof response.monitor === "object" ? response.monitor as Record<string, unknown> : response;
        return { monitor: { ...monitor, status: ["active", "paused"].includes(String(providerMonitor.status)) ? providerMonitor.status : monitor!.status } };
      }
      if (action === "create") {
        if (monitors.filter((item) => item.status !== "deleted").length >= 10) throw new Error("This account has reached Chusky's limit of 10 active TinyFish monitors.");
        const type = args.type as "fetch" | "search";
        if (type !== "fetch" && type !== "search") throw new Error("Monitor type must be fetch (page) or search (topic).");
        const scheduleCron = validateTinyFishMonitorSchedule(type, text(args.scheduleCron, 120));
        const name = args.name === undefined ? (type === "fetch" ? text(args.url, 2000) : text(args.query, 2000)).slice(0, 100) : text(args.name, 100);
        const purpose = args.purpose === undefined ? undefined : text(args.purpose, 2_000);
        const targetUrl = type === "fetch" ? assertPublicHttpUrl(text(args.url, 2_000)) : undefined;
        const query = type === "search" ? text(args.query, 2_000) : undefined;
        if (type === "search" && query!.trim().length < 2) throw new Error("Topic monitor query must contain at least 2 characters.");
        const duplicate = monitors.find((item) => item.status !== "deleted" && item.monitorType === type && item.scheduleCron === scheduleCron && item.targetUrl === targetUrl && item.query === query);
        if (duplicate) return { monitor: duplicate, alreadyExists: true };
        let callbackBase: URL;
        try { callbackBase = new URL(config.webhookUrl); } catch { throw new Error("TinyFish monitors require WEBHOOK_URL to be configured with the public HTTPS Chusky webhook origin."); }
        if (callbackBase.protocol !== "https:") throw new Error("TinyFish monitor callbacks require a public HTTPS WEBHOOK_URL.");
        assertPublicHttpUrl(callbackBase.origin);
        const callbackId = randomUUID();
        const callbackSignature = tinyFishMonitorSignature(config.tinyFishApiKey, userId, callbackId);
        const webhookUrl = `${callbackBase.origin}/tinyfish/monitor/${userId}/${callbackId}/${callbackSignature}`;
        const response = await client.createMonitor({
          type, name, schedule_cron: scheduleCron, purpose, webhook_url: webhookUrl,
          config: type === "fetch" ? { url: targetUrl, format: args.format ?? "markdown", links: false, image_links: false } : { query, ...(args.recencyMinutes !== undefined ? { recency_minutes: Number(args.recencyMinutes) } : {}), result_limit: args.resultLimit === undefined ? 5 : Number(args.resultLimit) },
        });
        const providerMonitor = response.monitor && typeof response.monitor === "object" ? response.monitor as Record<string, unknown> : {};
        const providerMonitorId = typeof providerMonitor.id === "string" ? providerMonitor.id : "";
        if (!providerMonitorId) throw new Error("TinyFish created no identifiable monitor; check the TinyFish dashboard before retrying.");
        const initialRun = response.run && typeof response.run === "object" ? response.run as Record<string, unknown> : {};
        const initialHash = type === "fetch" ? tinyFishMonitorSnapshotHash(initialRun) : undefined;
        try {
          const record = await createAttentionRecord(userId, "tinyfish_monitor", {
            providerMonitorId, callbackId, monitorType: type, name, purpose, scheduleCron, targetUrl, query,
            status: "active", snapshotHash: initialHash, lastRunId: typeof initialRun.id === "string" ? initialRun.id : undefined,
            lastRunAt: Date.now(), lastSummary: "Baseline captured.", runHistory: typeof initialRun.id === "string" ? [{ id: initialRun.id, occurredAt: Date.now(), status: "unchanged", summary: "Baseline captured." }] : [],
          }) as TinyFishMonitorRecord;
          return { monitor: record, baselineCaptured: true };
        } catch (error) {
          try { await client.deleteMonitor(providerMonitorId); } catch { /* Provider may retain it; error message below is explicit. */ }
          throw new Error(`TinyFish monitor was created but Chusky could not save its owner record; provider cleanup was attempted. ${error instanceof Error ? error.message : ""}`);
        }
      }
      if (action === "pause" || action === "resume") {
        await client.updateMonitor(monitor!.providerMonitorId, { status: action === "pause" ? "paused" : "active" });
        const updated = await updateAttentionRecord(userId, "tinyfish_monitor", monitor!.id, { status: action === "pause" ? "paused" : "active", lastError: "" });
        return { monitor: updated };
      }
      if (action === "edit") {
        if (args.url !== undefined || args.query !== undefined || args.type !== undefined || args.format !== undefined || args.recencyMinutes !== undefined || args.resultLimit !== undefined) {
          throw new Error("Changing a monitor's target or extraction settings is not supported yet. Delete it and create a replacement with the desired target; the existing monitor is unchanged.");
        }
        const patch: Record<string, unknown> = {};
        if (args.scheduleCron !== undefined) patch.schedule_cron = validateTinyFishMonitorSchedule(monitor!.monitorType, text(args.scheduleCron, 120));
        if (args.name !== undefined) patch.name = text(args.name, 100);
        if (args.purpose !== undefined) patch.purpose = text(args.purpose, 2_000);
        if (!Object.keys(patch).length) throw new Error("Provide at least one monitor field to edit.");
        await client.updateMonitor(monitor!.providerMonitorId, patch);
        const updated = await updateAttentionRecord(userId, "tinyfish_monitor", monitor!.id, { name: patch.name, purpose: patch.purpose, scheduleCron: patch.schedule_cron });
        return { monitor: updated };
      }
      if (action === "delete") {
        await client.deleteMonitor(monitor!.providerMonitorId);
        const updated = await updateAttentionRecord(userId, "tinyfish_monitor", monitor!.id, { status: "deleted" });
        return { deleted: true, monitorId: monitor!.id, retainedRunHistory: updated && "runHistory" in updated ? updated.runHistory : [] };
      }
      if (action === "run_now") {
        const response = await client.runMonitorNow(monitor!.providerMonitorId);
        const run = response.run && typeof response.run === "object" ? response.run as Record<string, unknown> : {};
        const webhookPayload = { ...run, id: typeof run.id === "string" ? run.id : randomUUID(), [monitor!.monitorType === "fetch" ? "fetch_monitor_id" : "search_monitor_id"]: monitor!.providerMonitorId, is_baseline: false };
        const callbackSignature = tinyFishMonitorSignature(config.tinyFishApiKey, userId, monitor!.callbackId);
        await receiveTinyFishMonitorWebhook({ userId, internalId: monitor!.callbackId, signature: callbackSignature, apiKey: config.tinyFishApiKey, rawBody: Buffer.from(JSON.stringify(webhookPayload)) });
        return { monitor: await getAttentionRecord(userId, "tinyfish_monitor", monitor!.id), runId: webhookPayload.id, contentIsUntrusted: true };
      }
      throw new Error("Unsupported TinyFish monitor action.");
    }
    case "CHUCK_TREG_SEARCH": return tregGateway().search(text(args.q, 500), args.limit === undefined ? 8 : Number(args.limit), runtime.organizationId);
    case "CHUCK_TREG_GET": return tregGateway().getEndpoint(text(args.endpointId, 200), runtime.organizationId);
    case "CHUCK_TREG_PLATFORMS": return tregGateway().platforms(text(args.slug, 200), runtime.organizationId);
    case "CHUCK_TREG_MY_TOOLS": return tregGateway().myTools(runtime.organizationId);
    case "CHUCK_TREG_CALL": {
      const body = args.body === undefined ? undefined : args.body;
      const query = args.query && typeof args.query === "object" && !Array.isArray(args.query) ? Object.fromEntries(Object.entries(args.query).map(([key, value]) => [key, String(value)])) : undefined;
      return tregGateway().call({
        userId,
        endpointId: text(args.endpointId, 200),
        method: args.method ? String(args.method) : undefined,
        body,
        query,
        missionId: args.missionId ? text(args.missionId, 160) : runtime.missionId,
        organizationId: runtime.organizationId,
        estimateUsd: args.estimateUsd === undefined ? undefined : Number(args.estimateUsd),
        idempotencyKey: args.idempotencyKey ? text(args.idempotencyKey, 200) : undefined,
      });
    }
    case "CHUCK_TREG_ENRICH_PERSON": {
      const missionId = effectiveTregMissionId(args, runtime);
      const requestedSpend = args.maxSpendUsd === undefined ? undefined : Number(args.maxSpendUsd);
      return withLeadCampaignTregBudget(userId, missionId, requestedSpend, runtime, (reservedUsd) => tregGateway().enrichPerson({
        userId,
        name: args.name ? text(args.name, 240) : undefined,
        domain: args.domain ? text(args.domain, 240) : undefined,
        company: args.company ? text(args.company, 240) : undefined,
        linkedinUrl: args.linkedinUrl ? text(args.linkedinUrl, 1000) : undefined,
        missionId,
        maxSpendUsd: reservedUsd ?? (runtime.tregMaxSpendUsd === undefined ? requestedSpend : Math.min(runtime.tregMaxSpendUsd, requestedSpend ?? runtime.tregMaxSpendUsd)),
        organizationId: runtime.organizationId,
      }));
    }
    case "CHUCK_TREG_ENRICH_COMPANY": {
      const missionId = effectiveTregMissionId(args, runtime);
      const requestedSpend = args.maxSpendUsd === undefined ? undefined : Number(args.maxSpendUsd);
      return withLeadCampaignTregBudget(userId, missionId, requestedSpend, runtime, (reservedUsd) => tregGateway().enrichCompany({
        userId,
        domain: args.domain ? text(args.domain, 240) : undefined,
        name: args.name ? text(args.name, 240) : undefined,
        missionId,
        maxSpendUsd: reservedUsd ?? (runtime.tregMaxSpendUsd === undefined ? requestedSpend : Math.min(runtime.tregMaxSpendUsd, requestedSpend ?? runtime.tregMaxSpendUsd)),
        organizationId: runtime.organizationId,
      }));
    }
    case "CHUCK_TREG_RESOLVE": {
      const missionId = effectiveTregMissionId(args, runtime);
      const requestedSpend = args.maxSpendUsd === undefined ? undefined : Number(args.maxSpendUsd);
      return withLeadCampaignTregBudget(userId, missionId, requestedSpend, runtime, (reservedUsd) => tregGateway().resolveDataNeed({
        userId,
        need: text(args.need, 1000),
        requiredFields: Array.isArray(args.requiredFields) ? args.requiredFields.map((field) => text(field, 120)) : undefined,
        maxCalls: runtime.tregMaxCalls === undefined
          ? args.maxCalls === undefined ? undefined : Number(args.maxCalls)
          : Math.max(1, Math.min(runtime.tregMaxCalls, args.maxCalls === undefined ? runtime.tregMaxCalls : Number(args.maxCalls))),
        maxSpendUsd: reservedUsd ?? (runtime.tregMaxSpendUsd === undefined
          ? requestedSpend : Math.min(runtime.tregMaxSpendUsd, requestedSpend ?? runtime.tregMaxSpendUsd)),
        missionId,
        organizationId: runtime.organizationId,
      }));
    }
    case "CHUCK_TREG_BALANCE": return tregGateway().balance(args.orgId ? text(args.orgId, 160) : undefined, runtime.organizationId);
    case "CHUCK_TREG_USAGE": {
      const dayKey = args.dayKey ? text(args.dayKey, 10) : new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new Error("dayKey must use YYYY-MM-DD");
      const spend = await getTregSpend(userId, dayKey);
      return { spend: spend ?? { userId, dayKey, spentUsd: 0, reservedUsd: 0, missionSpent: {}, missionReserved: {}, rateWindowCalls: 0 }, receipts: await listTregReceipts(userId, args.limit === undefined ? 25 : Number(args.limit), runtime.organizationId) };
    }
    case "CHUCK_TREG_OAUTH_START": {
      const provider = text(args.provider, 120);
      const result = await tregOAuth().start(provider, runtime.organizationId);
      await saveTregOAuthState(userId, { stateHash: tregStateHash(result.state), provider, ...(runtime.organizationId ? { organizationId: runtime.organizationId } : {}), createdAt: Date.now(), expiresAt: result.expiresAt ?? Date.now() + 10 * 60 * 1000 });
      return result;
    }
    case "CHUCK_TREG_OAUTH_STATUS": {
      const state = text(args.state, 500);
      const record = await getTregOAuthState(userId, tregStateHash(state));
      if (!record) throw new Error("Treg OAuth state is missing, expired, or belongs to another account");
      const result = await tregOAuth().status(state, record.organizationId);
      if (result.connected === true) await removeTregOAuthState(userId, record.stateHash);
      return result;
    }
    case "CHUCK_TREG_OAUTH_CONNECTIONS": return tregOAuth().connections(runtime.organizationId);
    case "CHUCK_TREG_OAUTH_REVOKE": {
      const id = text(args.connectionId, 200);
      const connections = await tregOAuth().connections(runtime.organizationId);
      if (!connections.some((connection) => connection.id === id)) throw new Error("That Treg connection is not owned by this account or is no longer available");
      return tregOAuth().revoke(id, runtime.organizationId);
    }
    case "CHUCK_TOOL_PREFLIGHT": {
      const requestedTool = text(args.toolName, 200);
      const callArguments = args.arguments;
      if (!callArguments || typeof callArguments !== "object" || Array.isArray(callArguments)) throw new Error("arguments must be an object");
      return preflightToolCall(runtime.toolCatalog, requestedTool, callArguments as Record<string, unknown>, runtime.ownerPrivateRun);
    }
    case "CHUCK_INTEGRATION_HEALTH":
      return summarizeIntegrationHealth(runtime.connectedAccounts, args.toolkit === undefined ? undefined : text(args.toolkit, 120));
    case "CHUCK_TOOL_RECOVERY": {
      const runId = optionalIdentifier(args.runId) ?? runtime.currentRunId;
      if (!runId) return { status: "not_found", retryAdvice: "verify_first", message: "No current run is available; pass an owned run ID. No action was replayed." };
      const run = await getAgentRun(userId, runId);
      if (!run || run.userId !== userId) return { status: "not_found", retryAdvice: "verify_first", message: "That run was not found for this owner. No action was replayed." };
      return inspectToolRecovery(run.events, optionalIdentifier(args.toolCallId));
    }
    case "CHUCK_LIST_SKILL_FILES": return listSkillFiles(text(args.name), args.maxFiles === undefined ? 100 : Number(args.maxFiles));
    case "CHUCK_READ_SKILL_FILE": return readSkillFile(text(args.name), args.path === undefined ? "SKILL.md" : text(args.path), args.maxChars === undefined ? 12_000 : Number(args.maxChars));
    case "CHUCK_SET_REMINDER": return setReminder(userId, args, runtime);
    case "CHUCK_LIST_REMINDERS": return listReminders(userId);
    case "CHUCK_CANCEL_REMINDER": return cancelReminder(userId, text(args.id));
    case "CHUCK_PAUSE_REMINDER": return pauseReminder(userId, text(args.id));
    case "CHUCK_RESUME_REMINDER": return resumeReminder(userId, text(args.id));
    case "CHUCK_RUN_REMINDER_NOW": return runReminderNow(userId, text(args.id));
    case "CHUCK_SCHEDULE_JOB": return scheduleJob(userId, args, runtime);
    case "CHUCK_ATTENTION_PULSE": return configureAttentionPulse(userId, args, runtime);
    case "CHUCK_LIST_JOBS": return listJobs(userId);
    case "CHUCK_PAUSE_JOB": return pauseJob(userId, text(args.id));
    case "CHUCK_RESUME_JOB": return resumeJob(userId, text(args.id));
    case "CHUCK_RUN_JOB_NOW": return runJobNow(userId, text(args.id));
    case "CHUCK_CANCEL_JOB": return cancelJob(userId, text(args.id));
    case "CHUCK_SCRATCHPAD_WRITE": {
      const key = requiredText(args.key, "CHUCK_SCRATCHPAD_WRITE.key");
      const content = requiredText(args.content, "CHUCK_SCRATCHPAD_WRITE.content");
      await writeScratchpad(userId, key, content);
      return { saved: true, key };
    }
    case "CHUCK_SCRATCHPAD_READ": return readScratchpad(userId, args.query ? String(args.query) : undefined);
    case "CHUCK_SCRATCHPAD_CLEAR": await clearScratchpad(userId, args.key ? text(args.key) : undefined); return { cleared: true };
    case "CHUCK_SAVE_MEMORY": {
      if (args.sensitivity !== "normal" && args.sensitivity !== "sensitive") throw new Error("sensitivity is required when saving memory");
      const category = (args.category as string) ?? "fact";
      const key = text(args.key);
      const value = text(args.value);
      const source = args.source ? text(args.source) : "CHUCK_SAVE_MEMORY";
      const explicit = /(?:^|[^a-z])(user|owner|explicit)(?:$|[^a-z])/i.test(source);
      const memoryDecision = await decideMemoryDisposition({
        key,
        value,
        explicit,
        sensitive: args.sensitivity === "sensitive",
      }, { signal: runtime.signal, sessionId: `memory:${userId}:${key}` });
      const classification = await classifyMemory({ key, value, category: category as any, sensitivity: args.sensitivity, explicit, sessionId: `memory:${userId}:${key}`, budgetMs: 400 });
      if (!explicit && memoryDecision.source === "jev" && (memoryDecision.disposition === "do_not_save" || memoryDecision.disposition === "forget")) {
        return { saved: false, skipped: true, reason: memoryDecision.reason, autonomyDecision: memoryDecision.disposition };
      }
      const reviewAt = args.reviewAt === undefined && args.expiresAt === undefined && !explicit && memoryDecision.source === "jev" && memoryDecision.disposition === "remember_until_review" && memoryDecision.reviewAtDays
        ? Date.now() + memoryDecision.reviewAtDays * 24 * 60 * 60 * 1000
        : args.reviewAt === undefined ? undefined : Number(args.reviewAt);
      const contextKind = ["preference", "relationship", "fact", "decision", "objective", "open_loop"].includes(category) ? category : "memory";
      const saved = await upsertMemoryAndContext(userId, {
        category: category as any,
        key,
        value,
        source,
        confidence: Number(args.confidence ?? classification.confidence ?? 1),
        sensitivity: args.sensitivity === "sensitive" || classification.audience === "sensitive" ? "sensitive" : "normal",
        meetingSafe: classification.meetingSafe,
        meetingVerdict: classification.meetingVerdict,
        projectId: args.projectId ? text(args.projectId) : undefined,
        personKey: args.personKey ? text(args.personKey) : undefined,
        reviewAt,
        expiresAt: args.expiresAt === undefined ? undefined : Number(args.expiresAt),
      }, {
        scope: args.projectId ? "project" : "user",
        ...(args.projectId ? { scopeId: text(args.projectId) } : {}),
        kind: contextKind as never,
        key,
        value,
        source,
        sensitivity: args.sensitivity === "sensitive" || classification.audience === "sensitive" ? "sensitive" : "normal",
        confidence: Number(args.confidence ?? 1),
        ...(reviewAt !== undefined ? { reviewAt } : {}),
        ...(args.expiresAt !== undefined ? { expiresAt: Number(args.expiresAt) } : {}),
      });
      return { ...saved.memory, contextNodeId: saved.context.id, contextIndexed: true, autonomyDecision: memoryDecision.disposition };
    }
    case "CHUCK_SEARCH_MEMORY": return searchMemories(userId, args.query ? String(args.query) : undefined, { category: args.category as any, organizationId: args.organizationId ? text(args.organizationId) : undefined, projectId: args.projectId ? text(args.projectId) : undefined, personKey: args.personKey ? text(args.personKey) : undefined, limit: args.limit === undefined ? undefined : Number(args.limit) });
    case "CHUCK_MEMORY_BRIEF": {
      const scopes: Array<{ kind: "personal" | "organization" | "team" | "project" | "client" | "meeting"; externalId: string }> = [{ kind: "personal", externalId: String(userId) }];
      if (args.organizationId) scopes.push({ kind: "organization", externalId: text(args.organizationId) });
      if (args.teamId) scopes.push({ kind: "team", externalId: text(args.teamId) });
      if (args.projectId) scopes.push({ kind: "project", externalId: text(args.projectId) });
      if (args.clientId) scopes.push({ kind: "client", externalId: text(args.clientId) });
      if (args.meetingId) scopes.push({ kind: "meeting", externalId: text(args.meetingId) });
      if (!durableMemoryConfigured()) return { durableMemoryConfigured: false, message: "Durable memory is not enabled; use CHUCK_SEARCH_MEMORY for the legacy bounded memory projection." };
      return getMemoryBrief({ ownerUserId: userId, purpose: text(args.purpose) as never, query: text(args.query, 500), scopes, includeSensitive: args.includeSensitive === true, limit: args.limit === undefined ? 12 : Number(args.limit) });
    }
    case "CHUCK_MEMORY_LINK": {
      if (!durableMemoryConfigured()) throw new Error("Durable memory is not enabled");
      const scope = text(args.scope) as "personal" | "organization" | "team" | "project" | "client" | "meeting";
      const scopeId = text(args.scopeId);
      const from = await saveMemoryEntity({ ownerUserId: userId, type: text(args.fromType) as never, canonicalName: text(args.fromName) });
      const to = await saveMemoryEntity({ ownerUserId: userId, type: text(args.toType) as never, canonicalName: text(args.toName) });
      return saveMemoryEdge({ ownerUserId: userId, scope: { kind: scope, externalId: scopeId }, fromEntityId: from.id, relation: text(args.relation), toEntityId: to.id, confidence: args.confidence === undefined ? undefined : Number(args.confidence) });
    }
    case "CHUCK_UPDATE_MEMORY": {
      const id = optionalText(args.id, 1000, "CHUCK_UPDATE_MEMORY.id");
      const key = optionalText(args.key, 1000, "CHUCK_UPDATE_MEMORY.key");
      if (!id && !key) throw new Error("CHUCK_UPDATE_MEMORY requires a non-blank id or key");
      const updated = await updateMemory(userId, { id, key, category: args.category as any }, {
        category: args.newCategory as any,
        key: optionalText(args.newKey, 1000, "CHUCK_UPDATE_MEMORY.newKey"),
        value: requiredText(args.value, "CHUCK_UPDATE_MEMORY.value"),
        source: optionalText(args.source, 1000, "CHUCK_UPDATE_MEMORY.source"),
        confidence: args.confidence === undefined ? undefined : Number(args.confidence),
        sensitivity: args.sensitivity === "sensitive" ? "sensitive" : args.sensitivity === "normal" ? "normal" : undefined,
        projectId: optionalText(args.projectId, 1000, "CHUCK_UPDATE_MEMORY.projectId"),
        personKey: optionalText(args.personKey, 1000, "CHUCK_UPDATE_MEMORY.personKey"),
        reviewAt: args.reviewAt === undefined ? undefined : Number(args.reviewAt),
        expiresAt: args.expiresAt === undefined ? undefined : Number(args.expiresAt),
      });
      return updated ?? { updated: false, reason: "Memory not found" };
    }
    case "CHUCK_SAVE_IMAGE_ASSET": {
      const images = args.source === "generated" ? runtime.generatedImages : runtime.currentImages;
      const image = images?.[Math.max(0, Math.floor(Number(args.sourceIndex ?? 0)))];
      if (!image) throw new Error("No current image is available to save");
      const contentType = image.mediaType.toLowerCase();
      if (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp") throw new Error("Only JPEG, PNG, and WebP images can be saved");
      const tags = Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : [];
      const asset = await saveImageAsset(userId, { name: text(args.name), purpose: text(args.purpose), description: args.description ? text(args.description) : undefined, tags, contentType }, image.data);
      return { imageAssetSaved: true, asset: modelVisibleImageAsset(asset) };
    }
    case "CHUCK_SEARCH_IMAGE_ASSETS": return (await searchImageAssets(userId, args.query ? text(args.query) : undefined, args.limit === undefined ? 5 : Number(args.limit))).map(modelVisibleImageAsset);
    case "CHUCK_LIST_IMAGE_MODELS": return listImageModels(runtime.signal);
    case "CHUCK_GET_IMAGE_ASSET": {
      const asset = await getImageAsset(userId, text(args.id));
      if (!asset) return { found: false };
      return { __chuskyImageAsset: true, ...asset };
    }
    case "CHUCK_DAYTONA_IMAGE": {
      if (runtime.sharedConversation || runtime.meetingId) throw new Error("Daytona image transfer is available only in a private owner conversation.");
      return daytonaCall(runtime, () => transferDaytonaImage(userId, args as DaytonaImageTransferInput, runtime));
    }
    case "CHUCK_FORGET_IMAGE_ASSET": return { forgotten: await forgetImageAsset(userId, text(args.id)) };
    case "CHUCK_FORGET_MEMORY": return { forgotten: await forgetMemory(userId, text(args.key)) };
    case "CHUCK_ATTENTION_STATE": return attentionTool(userId, args);
    case "CHUCK_AUTONOMY_STATUS": return getAutonomySnapshot(userId);
    case "CHUCK_AUTONOMY_RECONCILE": return autonomyReconcileTool(userId, args, runtime);
    case "CHUCK_AUTONOMY_PLAYBOOK": return autonomyPlaybookTool(userId, args, runtime);
    case "CHUCK_START_PHONE_CALL": {
      const profile = args.profile && typeof args.profile === "object" && !Array.isArray(args.profile) ? args.profile as Record<string, unknown> : undefined;
      const callProfile: "business" | "personal" = args.callProfile === "business" ? "business" : "personal";
      const input = { phoneNumber: text(args.phoneNumber), purpose: text(args.purpose), ...(profile ? { profile } : {}), callProfile };
      if (phoneCallLauncherForTests) return phoneCallLauncherForTests(userId, input);
      return config.blandVoiceEnabled
        ? startBlandCallForUser(userId, input)
        : startTwilioCallForUser(userId, input);
    }
    case "CHUCK_LIST_PHONE_CALLS": return listPhoneCalls(userId);
    case "CHUCK_MEETING_CONTEXT_PREPARE": {
      if (runtime.sharedConversation) throw new Error("Client meeting preparation is available only in a private owner conversation");
      return prepareRecallMeetingMission(userId, { clientName: args.clientName, objective: args.objective, clientContext: args.clientContext, preparationId: args.preparationId });
    }
    case "CHUCK_MEETING_PARTICIPANT_CONFIRM": {
      if (runtime.sharedConversation || !runtime.ownerPrivateRun || runtime.meetingId) throw new Error("Participant identity can be confirmed only by the authenticated owner in a private conversation outside the live meeting");
      if (!/\b(confirm|verify|verified|confirmation)\b/i.test(runtime.userRequest ?? "")) throw new Error("The owner must explicitly ask to confirm this participant's identity");
      return confirmRecallMeetingParticipant(userId, args.meetingId, args.participantId, args.email);
    }
    case "CHUCK_MEETING_PARTICIPANTS_LIST": {
      if (runtime.sharedConversation || !runtime.ownerPrivateRun || runtime.meetingId) throw new Error("Participant identity details are available only in a private owner conversation outside the live meeting");
      return listRecallMeetingParticipantsForOwner(userId);
    }
    case "CHUCK_MEETING_CONTEXT_LOOKUP": {
      if (!runtime.meetingId) throw new Error("CHUCK_MEETING_CONTEXT_LOOKUP is available only inside an active meeting");
      return lookupRecallMeetingContext(userId, runtime.meetingId, text(args.query));
    }
    case "CHUCK_MEETING_CONTACT_CAPTURE": {
      if (!runtime.meetingId || runtime.sharedConversation) throw new Error("Meeting contact capture is available only inside an active representative meeting");
      const meeting = await getRecallMeeting(userId, runtime.meetingId);
      if (!meeting || meeting.interactionMode !== "representative" || !["joining", "waiting_room", "in_call"].includes(meeting.status)) {
        throw new Error("Meeting not found or is not an active representative meeting owned by this account");
      }
      const profile = await getMeetingRepresentativeProfile(userId);
      if (!profile.enabled) throw new Error("The meeting representative profile is not enabled");
      return upsertMeetingContact(userId, meeting.id, {
        participantName: args.participantName,
        email: args.email,
        phone: args.phone,
        contactPreference: args.contactPreference,
        interest: args.interest,
        nextStep: args.nextStep,
        followUpAt: args.followUpAt,
      });
    }
    case "CHUCK_MEETING_CONTACTS_LIST": {
      if (runtime.sharedConversation || runtime.meetingId) throw new Error("Meeting contacts are available only in a private owner conversation");
      return listMeetingContacts(userId, args.limit === undefined ? 20 : Number(args.limit));
    }
    case "CHUCK_MEETING_CONTACT_DELETE": {
      if (runtime.sharedConversation || runtime.meetingId) throw new Error("Meeting contacts are available only in a private owner conversation");
      const id = text(args.id);
      const existing = await getMeetingContact(userId, id);
      if (existing?.followUpTaskId) await cancelTask(userId, existing.followUpTaskId);
      return { deleted: await deleteMeetingContact(userId, id), id };
    }
    case "CHUCK_MEETING_FOLLOWUP_SCHEDULE": {
      if (!runtime.meetingId || runtime.sharedConversation) throw new Error("Delayed meeting follow-up is available only from its owned representative meeting workflow");
      const meeting = await getRecallMeeting(userId, runtime.meetingId);
      if (!meeting || meeting.interactionMode !== "representative" || !["joining", "waiting_room", "in_call", "leaving", "ended"].includes(meeting.status)) {
        throw new Error("Meeting not found or is not an owned representative meeting");
      }
      const profile = await getMeetingRepresentativeProfile(userId);
      if (!profile.enabled) throw new Error("Delayed meeting follow-up is not enabled for this representative");
      const contact = await getMeetingContact(userId, text(args.contactId), meeting.id);
      if (!contact) throw new Error("Contact was not captured in this meeting");
      if (!contact.email || contact.contactPreference === "phone") throw new Error("This contact prefers phone or has no email, so Chusky cannot schedule an email follow-up");
      const emailTool = profile.allowedComposioTools.find(isMeetingRepresentativeEmailTool);
      if (!emailTool) throw new Error("Add an exact connected email-send action to the representative profile before scheduling an email follow-up");
      const runAt = futureTimestamp(args);
      const taskId = `task_mf_${createHash("sha256").update(`${userId}:${meeting.id}:${contact.id}:${runAt}`).digest("hex").slice(0, 32)}`;
      const task = await createTask(userId, {
        id: taskId,
        title: `Follow up with ${contact.participantName}`.slice(0, 120),
        objective: `Send the agreed follow-up email to captured meeting contact ${contact.id}. Use only that person's recorded interest and next step.`,
        runAt,
        meetingFollowUp: { meetingId: meeting.id, contactId: contact.id, emailTool, state: "scheduled" },
      });
      if (task.status === "completed" || task.status === "cancelled") throw new Error("This delayed follow-up task is already closed");
      if (!task.workflowRunId) {
        await scheduleTask(userId, task.id, runAt);
        const workflowRunId = await enqueueTaskWithClaim(userId, task.id, runAt);
        if (!workflowRunId) throw new Error("This follow-up task is already being queued");
      }
      await updateMeetingContact(userId, contact.id, { followUpTaskId: task.id, followUpAt: runAt });
      return { scheduled: true, taskId: task.id, participantName: contact.participantName, runAt: new Date(runAt).toISOString(), emailTool };
    }
    case "CHUCK_MEETING_PREPARATION_LIST": {
      if (runtime.sharedConversation) throw new Error("Calendar meeting preparations are available only in a private owner conversation");
      return listCalendarMeetingPreparations(userId, args.limit === undefined ? 10 : Number(args.limit));
    }
    case "CHUCK_MEETING_PREPARATION_JOIN": {
      if (runtime.sharedConversation) throw new Error("Calendar meetings can be joined only from a private owner conversation");
      return joinPreparedCalendarMeeting(userId, text(args.id), runtime.signal);
    }
    case "CHUCK_MEETING_JOIN": {
      if (runtime.sharedConversation && (args.clientName !== undefined || args.objective !== undefined || args.clientContext !== undefined)) {
        throw new Error("Client-bound meetings must be prepared from a private owner conversation");
      }
      if (runtime.sharedConversation && args.transcriptRetentionDays !== undefined) {
        throw new Error("Searchable meeting transcript retention can be enabled only from a private owner conversation");
      }
      const profile = await getMeetingRepresentativeProfile(userId);
      if (needsPrivateMeetingBriefBeforeJoin(profile, {
        interactionMode: args.interactionMode,
        title: args.title,
        clientName: args.clientName,
        objective: args.objective,
        clientContext: args.clientContext,
        hasSourceMeeting: Boolean(runtime.meetingId),
      })) {
        throw new Error("Before joining as the company representative, ask the owner privately for the client or meeting title and the specific purpose. Do not enter the meeting unprepared.");
      }
      const clientName = typeof args.clientName === "string" && args.clientName.trim() ? args.clientName : undefined;
      // Objective/context without a named client is incomplete model carry-over,
      // not authorization for representative mode. Drop the incomplete brief so
      // an ordinary meeting can still join safely and predictably.
      const hasClientMission = clientName !== undefined && hasMeetingMissionInput({ ...args, clientName });
      const requestedMode = hasClientMission ? "representative" : args.interactionMode;
      // A model can carry a stale representative selection from a previous
      // turn. Never make an ordinary meeting fail just because the owner has
      // not configured that optional profile; downgrade safely to copilot.
      // Client-bound representation remains strict because it requires the
      // owner's approved mandate and bounded relationship brief.
      const interactionMode = requestedMode === "representative" && !profile.enabled && !hasClientMission
        ? "copilot"
        : requestedMode ?? (profile.enabled ? "representative" : "copilot");
      const transcriptRetentionDays = ownerExplicitlyRequestedTranscriptRetention(runtime.userRequest ?? "")
        ? args.transcriptRetentionDays
        : undefined;
      return joinRecallMeeting(userId, {
        meetingUrl: args.meetingUrl, title: args.title, joinAt: args.joinAt, interactionMode, languageMode: args.languageMode, languageHints: args.languageHints, keyterms: args.keyterms, liveCaptions: args.liveCaptions, analyzeScreenShare: args.analyzeScreenShare,
        ...(transcriptRetentionDays !== undefined ? { transcriptRetentionDays } : {}),
        ...(hasClientMission ? { clientName, ...(args.objective !== undefined ? { objective: args.objective } : {}), ...(args.clientContext !== undefined ? { clientContext: args.clientContext } : {}), ...(args.clientContextConfirmed !== undefined ? { clientContextConfirmed: args.clientContextConfirmed } : {}) } : {}),
        ...(runtime.meetingId && !hasClientMission ? { inheritMeetingId: runtime.meetingId } : {}),
      }, runtime.signal);
    }
    case "CHUCK_MEETING_PROFILE_GET": return getMeetingRepresentativeProfile(userId);
    case "CHUCK_MEETING_PROFILE_UPDATE": {
      if (runtime.sharedConversation || runtime.meetingId) throw new Error("Meeting representative settings can be changed only in a private owner conversation");
      const previous = await getMeetingRepresentativeProfile(userId);
      const updated = await updateMeetingRepresentativeProfile(userId, args);
      if (!updated.autoJoinCalendar && (previous.autoJoinCalendar || args.autoJoinCalendar === false || args.enabled === false)) {
        const cleanup = await cancelAutomaticCalendarMeetingJoins(userId);
        return { ...updated, automaticJoinCleanup: cleanup };
      }
      return updated;
    }
    case "CHUCK_MEETING_LIST": return listRecallMeetingsForUser(userId, args.limit === undefined ? 10 : Number(args.limit));
    case "CHUCK_MEETING_STATUS": {
      const meeting = await getRecallMeetingForUser(userId, text(args.id));
      return meeting ?? { found: false, reason: "Meeting not found or not owned by you" };
    }
    case "CHUCK_MEETING_TRANSCRIPT_SEARCH": {
      if (runtime.sharedConversation || runtime.meetingId) throw new Error("Meeting transcripts can be searched only in a private owner conversation");
      const results = await searchRecallMeetingTranscripts(userId, text(args.query), args.meetingId === undefined ? undefined : text(args.meetingId), args.limit === undefined ? 5 : Number(args.limit));
      return { results, count: results.length, ...(results.length ? {} : { message: "No matching unexpired, owner-retained meeting transcript was found." }) };
    }
    case "CHUCK_MEETING_TRANSCRIPT_DELETE": {
      if (runtime.sharedConversation || runtime.meetingId) throw new Error("Meeting transcripts can be deleted only in a private owner conversation");
      const deleted = await deleteRecallMeetingTranscript(userId, text(args.meetingId));
      if (!deleted) throw new Error("No retained transcript was found for that ended meeting");
      return { deleted: true, meetingId: text(args.meetingId) };
    }
    case "CHUCK_MEETING_LEAVE": return leaveRecallMeeting(userId, text(args.id), runtime.signal);
    case "CHUCK_VIDEO_STATUS": {
      const id = args.id ? text(args.id) : undefined;
      const limit = args.limit === undefined ? 5 : Math.max(1, Math.min(10, Math.floor(Number(args.limit))));
      const jobs = await listVideoJobs(userId);
      return jobs.filter((job) => !id || job.id === id).slice(0, limit);
    }
    case "CHUCK_LIST_VIDEO_MODELS": return listVideoModels(runtime.signal);
    case "CHUCK_VIDEO_CANCEL": {
      const id = text(args.id);
      const job = await getVideoJob(userId, id);
      if (!job) throw new Error("Video job not found or not owned by you");
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job;
      return updateVideoJob(userId, id, { status: "cancelled", error: "Cancelled by owner" });
    }
    case "CHUCK_TASK_CREATE": return createTask(userId, { id: taskCreateIdempotencyId(userId, args, runtime), title: text(args.title), objective: text(args.objective), workspaceId: args.workspaceId ? text(args.workspaceId) : undefined });
    case "CHUCK_TASK_LIST": return listTasks(userId, taskStatuses(args.statuses));
    case "CHUCK_TASK_GET": {
      const task = await getTask(userId, text(args.id));
      if (!task) throw new Error("Task not found or not owned by you");
      return task;
    }
    case "CHUCK_TASK_CHECKPOINT": {
      const task = await checkpointTask(userId, text(args.id), text(args.checkpoint, 8_000), optionalText(args.nextAction, 2_000, "nextAction"));
      if (!task) throw new Error("Only unfinished tasks you own can be checkpointed");
      return task;
    }
    case "CHUCK_TASK_BLOCK": {
      const task = await blockTask(userId, text(args.id), text(args.reason), args.nextAction ? text(args.nextAction) : undefined);
      if (!task) throw new Error("Only unfinished tasks you own can be blocked");
      return task;
    }
    case "CHUCK_TASK_COMPLETE": {
      const result = typeof args.result === "string" ? args.result.trim() : "";
      if (!result || result.length > 8_000) throw new Error("CHUCK_TASK_COMPLETE.result must contain 1-8000 non-whitespace characters.");
      const task = await completeTask(userId, text(args.id), result);
      if (!task) throw new Error("Only unfinished tasks you own can be completed");
      return task;
    }
    case "CHUCK_TASK_CANCEL": {
      const task = await cancelTask(userId, text(args.id));
      if (!task) throw new Error("Only unfinished tasks you own can be cancelled");
      return task;
    }
    case "CHUCK_TASK_RETRY": {
      const task = await retryTask(userId, text(args.id));
      if (!task) throw new Error("Only failed, blocked, or cancelled tasks you own can be retried");
      return task;
    }
    case "CHUCK_TASK_SCHEDULE": {
      const id = text(args.id);
      const task = await getTask(userId, id);
      if (!task) throw new Error("Task not found or not owned by you");
      const runAt = futureTimestamp(args);
      await scheduleTask(userId, id, runAt);
      const workflowRunId = await enqueueTaskWithClaim(userId, id, runAt);
      if (!workflowRunId) throw new Error("This task is already being queued");
      return await getTask(userId, id);
    }
    case "CHUCK_TASK_WAIT": {
      if (!runtime.taskId || !runtime.requestTaskWait) throw new Error("CHUCK_TASK_WAIT is only available inside an active durable task");
      const request: TaskWaitRequest = createTaskWaitRequest(args);
      if (runtime.missionTimerResumed) throw new Error("This mission timer already completed; execute the persisted post-wake action instead of waiting again.");
      runtime.requestTaskWait(request);
      return { waiting: true, taskId: runtime.taskId, runAt: new Date(request.runAt).toISOString(), checkpoint: request.checkpoint, nextAction: request.nextAction, ...(request.reason ? { reason: request.reason } : {}) };
    }
    case "CHUCK_MISSION_START": {
      if (Number(args.maxAutomaticExtensions ?? 0) > 0 && !runtime.approvedApprovalId) throw new Error("Automatic mission extensions require owner approval of the initial allowance.");
      const missionSteps = stripSupervisorOwnedMissionStepTools(args.steps);
      const invalidSteps = validateMissionStepsPayload(missionSteps);
      if (invalidSteps) throw new Error(invalidSteps);
      const mission = await createMission(userId, {
        title: missionText(args.title, "title", 240),
        objective: missionText(args.objective, "objective", 8000),
        definitionOfDone: missionText(args.definitionOfDone, "definitionOfDone", 4000),
        idempotencyKey: missionStartIdempotencyKey(userId, args, runtime),
        requiredEvidence: Array.isArray(args.requiredEvidence) ? args.requiredEvidence.filter((value: unknown): value is string => typeof value === "string") : undefined,
        verificationMode: args.verificationMode === "strict" || (args.verificationMode === undefined && Array.isArray(args.requiredEvidence) && args.requiredEvidence.length > 0) ? "strict" : "legacy",
        workSchedule: args.workSchedule && typeof args.workSchedule === "object" ? (() => {
          const schedule = args.workSchedule as Record<string, unknown>;
          return {
          timezone: String(schedule.timezone ?? ""),
          windowStart: String(schedule.windowStart ?? ""),
          windowEnd: String(schedule.windowEnd ?? ""),
          dailyBudgetSeconds: Number(schedule.dailyBudgetSeconds),
          cadenceSeconds: Number(schedule.cadenceSeconds),
          };
        })() : undefined,
        steps: Array.isArray(missionSteps) ? missionSteps.map((step: Record<string, unknown>) => ({
          id: typeof step.id === "string" ? step.id : undefined,
          title: missionText(step.title, "step title", 240),
          objective: missionText(step.objective, "step objective", 4000),
          dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter((value: unknown): value is string => typeof value === "string") : undefined,
          retryLimit: step.retryLimit === undefined ? undefined : Number(step.retryLimit),
          input: step.input && typeof step.input === "object" ? step.input as Record<string, unknown> : undefined,
          outputSchema: step.outputSchema && typeof step.outputSchema === "object" ? step.outputSchema as Record<string, unknown> : undefined,
          evidenceRequired: Array.isArray(step.evidenceRequired) ? step.evidenceRequired.filter((value: unknown): value is string => typeof value === "string") : undefined,
          compensationObjective: typeof step.compensationObjective === "string" ? step.compensationObjective : undefined,
          retryBackoffSeconds: step.retryBackoffSeconds === undefined ? undefined : Number(step.retryBackoffSeconds),
          parallelGroup: typeof step.parallelGroup === "string" ? step.parallelGroup : undefined,
          allowedTools: Array.isArray(step.allowedTools) ? step.allowedTools.filter((value: unknown): value is string => typeof value === "string") : undefined,
        })) : undefined,
        budget: {
          maxDurationSeconds: args.maxDurationSeconds === undefined ? undefined : Number(args.maxDurationSeconds),
          durationMode: args.durationMode as "active" | "wall_clock" | undefined,
          maxLifetimeSeconds: args.maxLifetimeSeconds as number | undefined,
          automaticExtensionSeconds: args.automaticExtensionSeconds as number | undefined,
          maxAutomaticExtensions: args.maxAutomaticExtensions as number | undefined,
          maxSteps: args.maxSteps === undefined ? undefined : Number(args.maxSteps),
          maxSlices: args.maxSlices === undefined ? undefined : Number(args.maxSlices),
          maxToolCalls: args.maxToolCalls === undefined ? undefined : Number(args.maxToolCalls),
          maxCost: args.maxCost === undefined ? undefined : Number(args.maxCost),
        },
        budgetCeiling: args.budgetCeiling && typeof args.budgetCeiling === "object" && !Array.isArray(args.budgetCeiling) ? Object.fromEntries(["maxDurationSeconds", "maxSteps", "maxSlices", "maxToolCalls", "maxCost"].filter((key) => (args.budgetCeiling as Record<string, unknown>)[key] !== undefined).map((key) => [key, Number((args.budgetCeiling as Record<string, unknown>)[key])])) : undefined,
      });
      if (mission.status === "queued") {
        const started = await startMission(userId, mission.id);
        if (started) {
          try {
            return (await reconcileMissionExecution(userId, started.id, runtime.enqueueMissionTask ?? enqueueTaskWorkflow)) ?? started;
          } catch (error) {
            await blockMission(userId, started.id, `Mission could not be scheduled: ${error instanceof Error ? error.message : String(error)}`, "Retry after the durable workflow service is available.");
            throw error;
          }
        }
      }
      if (mission.status === "running") return (await reconcileMissionExecution(userId, mission.id, runtime.enqueueMissionTask ?? enqueueTaskWorkflow)) ?? mission;
      return mission;
    }
    case "CHUCK_MISSION_LIST": return listMissions(userId, missionStatuses(args.statuses));
    case "CHUCK_MISSION_GET": {
      const mission = await getMission(userId, text(args.id));
      if (!mission) throw new Error("Mission not found or not owned by you");
      return mission;
    }
    case "CHUCK_MISSION_PROOF": {
      const mission = await getMission(userId, text(args.id));
      if (!mission) throw new Error("Mission not found or not owned by you");
      return missionProof(mission);
    }
    case "CHUCK_MISSION_CHECKPOINT": {
      if (runtime.missionTimerResumed && args.checkpoint === runtime.missionWakeCheckpoint) throw new Error("This mission timer already completed; persist the post-wake checkpoint or execute the next action instead of repeating the pre-wait checkpoint.");
      const mission = await checkpointMission(userId, text(args.id), text(args.checkpoint, 8000), args.nextAction ? text(args.nextAction, 2000) : undefined);
      if (!mission) throw new Error("Only running missions you own can be checkpointed");
      return mission;
    }
    case "CHUCK_MISSION_PAUSE": {
      const mission = await pauseMission(userId, text(args.id), args.reason ? text(args.reason, 2000) : undefined);
      if (!mission) throw new Error("Only running or waiting missions you own can be paused");
      await cancelMissionTasks(userId, mission.id);
      return mission;
    }
    case "CHUCK_MISSION_RESUME": {
      const missionId = text(args.id);
      const existing = await getMission(userId, missionId);
      const workerBudget = args.budget && typeof args.budget === "object" && !Array.isArray(args.budget) ? args.budget as Record<string, unknown> : undefined;
      const budgetPatch = workerBudget ? Object.fromEntries(["maxDurationSeconds", "maxSteps", "maxSlices", "maxToolCalls", "maxCost"].filter((key) => workerBudget[key] !== undefined).map((key) => [key, Number(workerBudget[key])])) : undefined;
      if (args.maxDurationSeconds !== undefined && !runtime.approvedApprovalId) {
        // A model must never create a second prose-driven approval for an
        // exhausted mission. Reuse the canonical owner approval so the UI
        // and the durable worker share one exact resume action.
        const requested = existing
          ? await requestMissionDurationApproval(userId, missionId, { taskId: runtime.taskId, model: runtime.model })
          : undefined;
        if (requested) throw new MissionDurationApprovalRequiredError(requested.approval.id, requested.approval.args);
        throw new Error("Extending a mission duration requires exact owner approval of the resume arguments.");
      }
      const overdueTimer = existing?.status === "waiting"
        && existing.waiting?.kind === "timer"
        && typeof existing.waiting.runAt === "number"
        && existing.waiting.runAt <= Date.now();
      if (args.maxDurationSeconds !== undefined && existing?.status === "waiting" && !overdueTimer) throw new Error("Resolve this mission's exact provider or approval wait before requesting a duration extension.");
      if (existing?.status === "waiting" && existing.waiting?.kind === "approval" && existing.waiting.key) {
        const resumed = await resumeMissionTaskAfterApproval(userId, existing.waiting.key);
        if (resumed.status === "resumed" || resumed.status === "already_queued") return resumed.mission;
        if (resumed.status === "enqueue_failed") throw new Error("The approved mission action is saved, but its original task could not be queued. Retry after the workflow service recovers.");
        if (resumed.status === "task_running") throw new Error("The approved mission task is already running; wait for that worker to settle.");
        throw new Error("The mission approval no longer matches a resumable task. Inspect the mission checkpoint before retrying.");
      }
      if (existing && args.maxDurationSeconds === undefined) {
        const preflight = missionBudgetPreflight(existing, { steps: 1, toolCalls: 1, cost: 0.0001, durationSeconds: 1 });
        if (!preflight.allowed && preflight.reason === "Mission duration budget would be exceeded.") {
          const requested = await requestMissionDurationApproval(userId, missionId, { taskId: runtime.taskId, model: runtime.model });
          if (requested) throw new MissionDurationApprovalRequiredError(requested.approval.id, requested.approval.args);
        }
      }
      const mission = await resumeMissionAndSchedule(userId, missionId, runtime.enqueueMissionTask ?? enqueueTaskWorkflow, args.maxDurationSeconds === undefined ? undefined : Number(args.maxDurationSeconds), budgetPatch as any);
      if (!mission) throw new Error("Only paused, blocked, failed, or already-running missions you own can be resumed");
      return mission;
    }
    case "CHUCK_MISSION_CONTROL": {
      const missionId = text(args.id);
      if (runtime.missionId && runtime.missionId !== missionId) throw new Error("A mission worker may only control its active mission.");
      const rawBudget = args.budget;
      const budget = rawBudget && typeof rawBudget === "object" && !Array.isArray(rawBudget)
        ? Object.fromEntries(["maxDurationSeconds", "maxSteps", "maxSlices", "maxToolCalls", "maxCost"].filter((key) => (rawBudget as Record<string, unknown>)[key] !== undefined).map((key) => [key, Number((rawBudget as Record<string, unknown>)[key])]))
        : undefined;
      const rawSchedule = args.workSchedule;
      const workSchedule = rawSchedule && typeof rawSchedule === "object" && !Array.isArray(rawSchedule) ? rawSchedule as MissionWorkSchedule : undefined;
      if (!budget && !workSchedule) throw new Error("Provide a budget or workSchedule change.");
      const mission = await updateMissionControl(userId, missionId, {
        ...(budget && Object.keys(budget).length ? { budget: budget as Partial<MissionBudget> } : {}),
        ...(workSchedule ? { workSchedule } : {}),
      });
      if (!mission) throw new Error("Mission not found, finished, unchanged, or not owned by you");
      if (workSchedule) await rescheduleQueuedMissionTasks(userId, mission);
      return mission.status === "running"
        ? (await reconcileMissionExecution(userId, mission.id, runtime.enqueueMissionTask ?? enqueueTaskWorkflow, runtime.taskId)) ?? mission
        : mission;
    }
    case "CHUCK_MISSION_CANCEL": {
      const mission = await cancelMission(userId, text(args.id), args.reason ? text(args.reason, 2000) : undefined);
      if (!mission) throw new Error("Only unfinished missions you own can be cancelled");
      await cancelMissionTasks(userId, mission.id);
      return mission;
    }
    case "CHUCK_MISSION_WAIT_EVENT": {
      const mission = await getMission(userId, text(args.id));
      if (!mission || mission.status !== "running") throw new Error("Only a running mission you own can wait for a provider event");
      if (!runtime.taskId || runtime.missionId !== mission.id || !runtime.requestMissionWait) throw new Error("CHUCK_MISSION_WAIT_EVENT is only available inside the active durable mission task");
      const provider = text(args.provider).trim().slice(0, 120);
      const providerEventId = text(args.providerEventId).trim().slice(0, 240);
      if (!provider || !providerEventId) throw new Error("provider and providerEventId must be non-empty");
      const stepId = args.stepId ? text(args.stepId, 160) : mission.currentStepId;
      const active = new Set(mission.activeStepIds?.length ? mission.activeStepIds : mission.currentStepId ? [mission.currentStepId] : []);
      if (!stepId || !active.has(stepId) || mission.steps.find((step) => step.id === stepId)?.status !== "running") throw new Error("The provider wait must belong to an active mission step");
      const request: MissionWaitRequest = { provider, providerEventId, stepId, checkpoint: args.checkpoint ? text(args.checkpoint, 8000) : mission.checkpoint, nextAction: args.nextAction ? text(args.nextAction, 2000) : `Waiting for ${provider} event ${providerEventId}.`, timeoutSeconds: args.timeoutSeconds === undefined ? undefined : Number(args.timeoutSeconds) };
      runtime.requestMissionWait(request);
      return { status: "waiting", provider, providerEventId, nextAction: request.nextAction };
    }
    case "CHUCK_MISSION_STEP_COMPLETE": {
      const missionId = text(args.id);
      const stepId = text(args.stepId, 160);
      const before = await getMission(userId, missionId);
      const alreadyCompleted = before?.steps.some((step) => step.id === stepId && step.status === "completed") === true;
      const mission = await completeMissionStepAndAdvance(userId, missionId, stepId, text(args.result, 12000), runtime.enqueueMissionTask ?? enqueueTaskWorkflow, runtime.taskId);
      if (!mission) {
        const current = await getMission(userId, missionId);
        if (!current) throw new Error("Mission not found or not owned by you");
        const step = current.steps.find((candidate) => candidate.id === stepId);
        const missingEvidence = step?.status === "running" ? missingMissionEvidenceRequirements(step.evidenceRequired, step.evidence) : [];
        const evidenceBlocker = missingEvidence.length
          ? [`Step “${step?.title ?? stepId}” requires trusted evidence before completion: ${missingEvidence.join(", ")}.`]
          : [];
        return { ...current, stepCompletion: "not_ready", closeout: { status: "not_ready", blockers: [`Mission is ${current.status}; step ${stepId} is ${step?.status ?? "missing"}.`, ...evidenceBlocker, ...(current.error ? [current.error] : [])], nextAction: current.nextAction ?? "Inspect the mission dependencies and resume an eligible active step before completing it." } };
      }
      const finalized = mission;
      const blockers = finalized.status === "completed" ? [] : finalized.verification?.unresolved?.length
        ? finalized.verification.unresolved
        : finalized.steps.filter((step) => step.status !== "completed").slice(0, 20).map((step) => `Step “${step.title}” is ${step.status}.`);
      return alreadyCompleted
        ? { ...finalized, stepCompletion: "already_completed", note: "This exact mission step was already completed; its original result was preserved.", closeout: { status: finalized.status === "completed" ? "completed" : finalized.status === "blocked" ? "blocked" : "not_ready", blockers, ...(finalized.status !== "completed" && finalized.nextAction ? { nextAction: finalized.nextAction } : {}) } }
        : { ...finalized, closeout: { status: finalized.status === "completed" ? "completed" : finalized.status === "blocked" ? "blocked" : "not_ready", blockers, ...(finalized.status !== "completed" && finalized.nextAction ? { nextAction: finalized.nextAction } : {}) } };
    }
    case "CHUCK_MISSION_EVIDENCE": {
      const rawEvidence = Array.isArray(args.evidence) ? args.evidence : [];
      if (!rawEvidence.length) throw new Error("At least one evidence record is required");
      const evidence = rawEvidence.map((item: Record<string, unknown>) => ({ id: `evidence_${randomUUID()}`, kind: text(item.kind) as "source", summary: text(item.summary, 2000), ...(item.source ? { source: text(item.source, 500) } : {}), ...(item.ref ? { ref: text(item.ref, 500) } : {}), ...(item.hash ? { hash: text(item.hash, 128) } : {}), verified: item.verified === true, ...(item.verifiedBy ? { verifiedBy: text(item.verifiedBy) as "agent" } : {}) }));
      const mission = await recordMissionEvidenceAndCloseout(userId, text(args.id), evidence, args.stepId ? text(args.stepId, 160) : undefined);
      if (!mission) throw new Error("Mission not found, finished, or not owned by you");
      return mission;
    }
    case "CHUCK_MISSION_VERIFY": {
      const missionId = text(args.id);
      if (!await getMission(userId, missionId)) throw new Error("Mission not found or not owned by you");
      const selectedEvidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds.filter((value: unknown): value is string => typeof value === "string") : undefined;
      if (Array.isArray(args.checks)) {
        const checks = args.checks.filter((item: unknown): item is OutcomeCheck => Boolean(item) && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string" && typeof (item as Record<string, unknown>).description === "string").slice(0, 50);
        const verification = await executeOutcomeVerification({ ownerId: userId, missionId, checks, adapter: runtime.outcomeReadAdapter });
        if (verification.status !== "verified") {
          let current = await getMission(userId, missionId);
          const allStepsComplete = current?.steps.every((step) => step.status === "completed") === true;
          if (current?.status === "running" && allStepsComplete) {
            const reason = verification.unresolved.slice(0, 5).join("; ") || `Outcome verification ${verification.status}.`;
            current = await blockMission(userId, missionId, `Mission outcome verification is ${verification.status}: ${reason}`, "Resolve the listed outcome checks, obtain fresh read-back evidence, then resume and verify the mission.") ?? current;
          }
          return {
            missionId,
            verification,
            mission: current,
            closeout: {
              status: current?.status === "blocked" ? "blocked" : "not_ready",
              blockers: verification.unresolved,
              ...(current?.nextAction ? { nextAction: current.nextAction } : {}),
            },
          };
        }
        const trustedReadEvidence = verification.results.flatMap((result) => {
          if (result.status !== "passed" || !result.provider || !result.evidenceRef) return [];
          const check = checks.find((candidate) => candidate.id === result.checkId);
          if (check?.kind !== "provider_read") return [];
          return [{ id: `outcome_${verification.id}_${result.checkId}`, kind: "before_after" as const, summary: verifiedOutcomeEvidenceSummary(check), source: result.provider, ref: result.evidenceRef, verified: true, verifiedBy: "system" as const }];
        });
        if (trustedReadEvidence.length) {
          await recordTrustedMissionEvidence(userId, missionId, trustedReadEvidence);
          selectedEvidenceIds?.push(...trustedReadEvidence.map((item) => item.id));
        }
      }
      const mission = await verifyMission(userId, missionId, { evidenceIds: selectedEvidenceIds, confidence: args.confidence === undefined ? undefined : Number(args.confidence), verifiedBy: "agent" });
      if (!mission) throw new Error("Mission not found or not owned by you");
      const finalized = await finalizeMissionCloseout(userId, missionId) ?? mission;
      return {
        ...finalized,
        closeout: {
          status: finalized.status === "completed" ? "completed" : finalized.status === "blocked" ? "blocked" : "not_ready",
          blockers: finalized.verification?.verified ? [] : finalized.verification?.unresolved ?? [],
          ...(finalized.status !== "completed" && finalized.nextAction ? { nextAction: finalized.nextAction } : {}),
        },
      };
    }
    case "CHUCK_MISSION_COMPENSATE": {
      const id = text(args.compensationId);
      const records = await listCompensations(userId);
      const record = records.find((item) => item.id === id);
      if (!record) throw new Error("Compensation record not found or not owned by you");
      if (args.action === "inspect") return compensationView(record);
      if (args.action !== "execute") throw new Error("Compensation requires action=inspect or action=execute");
      if (typeof args.toolSlug !== "string" || !args.toolSlug.trim() || !args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)
        || !args.verification || typeof args.verification !== "object" || Array.isArray(args.verification)) {
        throw new Error("Compensation execution requires an exact provider tool, arguments, and read-back verification plan.");
      }
      if (!runtime.approvedApprovalId || !runtime.executeMissionCompensation) throw new Error("An exact owner approval and active connected-app execution context are required before compensation can run.");
      const toolSlug = args.toolSlug.trim();
      const providerArguments = args.arguments as Record<string, unknown>;
      const verification = args.verification as { toolSlug?: unknown; arguments?: unknown; expected?: unknown };
      if (typeof verification.toolSlug !== "string" || !verification.arguments || typeof verification.arguments !== "object" || Array.isArray(verification.arguments)
        || !verification.expected || typeof verification.expected !== "object" || Array.isArray(verification.expected)) {
        throw new Error("Compensation read-back requires a provider tool, arguments object, and expected state object.");
      }
      const verificationPlan = { toolSlug: verification.toolSlug.trim(), arguments: verification.arguments as Record<string, unknown>, expected: verification.expected as Record<string, unknown> };
      const result = await executeCompensation({
        ownerId: userId,
        id,
        approvalId: runtime.approvedApprovalId,
        toolSlug,
        argumentsHash: externalArgumentsHash({ toolSlug, arguments: providerArguments, verification: verificationPlan }),
        execute: async (claimedRecord) => {
          const executed = await runtime.executeMissionCompensation!({
            compensationId: claimedRecord.id,
            ...(claimedRecord.missionId ? { missionId: claimedRecord.missionId } : {}),
            ...(claimedRecord.missionStepId ? { missionStepId: claimedRecord.missionStepId } : {}),
            toolSlug,
            arguments: providerArguments,
            verification: verificationPlan,
            approvedArguments: args,
            approvalId: runtime.approvedApprovalId!,
          });
          return { summary: executed.summary, externalReceiptId: executed.receiptId, verificationId: executed.verificationId, ...(executed.providerReceiptId ? { providerReceiptId: executed.providerReceiptId } : {}) };
        },
      });
      if (!result) throw new Error("Compensation record not found or not owned by you");
      if (result.status === "running") return { ...compensationView(result), message: "Another approved compensation attempt currently holds the execution lease. No duplicate provider action was sent." };
      if (result.status !== "succeeded") return { ...compensationView(result), message: result.error ?? "Compensation did not complete; verify provider state before continuing." };
      await appendTraceEvent({ ownerId: userId, kind: "receipt", type: "mission.compensation.succeeded", at: Date.now(), correlationId: result.id, summary: `Compensation completed through ${result.executionToolSlug ?? "provider action"} with a durable external-action receipt.`, metadata: { missionId: result.missionId ?? null, receiptId: result.externalReceiptId ?? null, providerReceiptId: result.providerReceiptId ?? null } });
      return compensationView(result);
    }
    case "CHUCK_MISSION_REPAIR": {
      const missionId = text(args.id);
      const existing = await getMission(userId, missionId);
      if (!existing) throw new Error("Mission not found, finished, or not owned by you");
      const diagnosis = diagnoseMissionRepair({ mission: existing, compensations: await listCompensations(userId, ["pending", "failed", "blocked"]) });
      const mission = await repairMission(userId, missionId, { reason: `${text(args.reason, 12000)} [diagnosis: ${diagnosis.causes.join(", ")}]`, nextAction: args.nextAction ? text(args.nextAction, 2000) : diagnosis.safeNextActions.join("; ") });
      if (!mission) throw new Error("Mission not found, finished, or not owned by you");
      return { mission, diagnosis };
    }
    case "CHUCK_CONTEXT_SEARCH": {
      const selection = { query: args.query ? text(args.query) : undefined, scope: args.scope as never, scopeId: args.scopeId ? text(args.scopeId) : undefined, purpose: args.purpose as never, limit: args.limit === undefined ? undefined : Number(args.limit) };
      return { nodes: await selectContext(userId, selection), prompt: await contextPrompt(userId, selection) };
    }
    case "CHUCK_CONVERSATION_SEARCH": {
      if (runtime.sharedConversation) throw new Error("Conversation search is unavailable in shared conversations; use shared-scope context instead.");
      const scope = (args.scope ? text(args.scope) : "personal") as "personal" | "conversation" | "organization" | "project" | "meeting" | "channel";
      const scopeId = args.scopeId ? text(args.scopeId, 180) : undefined;
      if (scope === "conversation" && scopeId && runtime.conversationId && scopeId !== runtime.conversationId) throw new Error("Conversation scope does not match the authenticated conversation.");
      if (scope === "organization" && scopeId && runtime.organizationId && scopeId !== runtime.organizationId) throw new Error("Organization scope does not match the authenticated organization.");
      if (scope === "meeting" && scopeId && runtime.meetingId && scopeId !== runtime.meetingId) throw new Error("Meeting scope does not match the authenticated meeting.");
      return { results: await searchConversationMessages(userId, text(args.query, 500), { scope, scopeId, after: args.after === undefined ? undefined : Number(args.after), before: args.before === undefined ? undefined : Number(args.before), limit: args.limit === undefined ? 8 : Number(args.limit) }) };
    }
    case "CHUCK_CONVERSATION_GET": {
      if (runtime.sharedConversation) throw new Error("Conversation retrieval is unavailable in shared conversations; use shared-scope context instead.");
      const scope = (args.scope ? text(args.scope) : "personal") as "personal" | "conversation" | "organization" | "project" | "meeting" | "channel";
      const scopeId = args.scopeId ? text(args.scopeId, 180) : undefined;
      const message = await getConversationMessage(userId, text(args.messageId, 180), { scope, scopeId });
      return message ? { message } : { message: undefined, notFound: true };
    }
    case "CHUCK_CONTEXT_SAVE": {
      return upsertContextNode(userId, { scope: text(args.scope) as never, scopeId: args.scopeId ? text(args.scopeId) : undefined, kind: text(args.kind) as never, key: text(args.key), value: text(args.value), source: args.source ? text(args.source) : undefined, sourceRef: args.sourceRef ? text(args.sourceRef) : undefined, sensitivity: text(args.sensitivity) as "normal" | "sensitive", confidence: args.confidence === undefined ? undefined : Number(args.confidence), tags: Array.isArray(args.tags) ? args.tags.filter((value: unknown): value is string => typeof value === "string") : undefined, reviewAt: args.reviewAt === undefined ? undefined : Number(args.reviewAt), expiresAt: args.expiresAt === undefined ? undefined : Number(args.expiresAt) });
    }
    case "CHUCK_DEPARTMENT_HANDOFF": {
      return createDepartmentHandoff(userId, { department: text(args.department), objective: text(args.objective), inputs: args.inputs && typeof args.inputs === "object" ? args.inputs as Record<string, unknown> : {}, constraints: Array.isArray(args.constraints) ? args.constraints.filter((value: unknown): value is string => typeof value === "string") : [], evidenceRequired: Array.isArray(args.evidenceRequired) ? args.evidenceRequired.filter((value: unknown): value is string => typeof value === "string") : [], ...(args.outputSchema && typeof args.outputSchema === "object" ? { outputSchema: args.outputSchema as Record<string, unknown> } : {}), ...(args.toAgent ? { toAgent: text(args.toAgent) } : {}), ...(args.deadline ? { deadline: Number(args.deadline) } : {}), ...(args.approvalBoundary ? { approvalBoundary: text(args.approvalBoundary) } : {}) });
    }
    case "CHUCK_OUTCOME_LIST": return listOutcomePackages();
    case "CHUCK_OUTCOME_PLAN": return planOutcome(text(args.slug), args.input && typeof args.input === "object" ? args.input as Record<string, unknown> : {});
    case "CHUCK_LEAD_CAMPAIGN": return leadCampaignTool(userId, args, runtime);
    case "CHUCK_MISSION_REPLAN": {
      const missionSteps = stripSupervisorOwnedMissionStepTools(args.steps);
      const invalidSteps = validateMissionStepsPayload(missionSteps, { requireNonEmpty: true });
      if (invalidSteps) throw new Error(invalidSteps);
      const steps = Array.isArray(missionSteps) ? missionSteps.map((step: Record<string, unknown>) => ({
        id: typeof step.id === "string" ? text(step.id, 160) : undefined,
        title: text(step.title, 240),
        objective: text(step.objective, 4000),
        dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter((value: unknown): value is string => typeof value === "string") : undefined,
        retryLimit: step.retryLimit === undefined ? undefined : Number(step.retryLimit),
        allowedTools: Array.isArray(step.allowedTools) ? step.allowedTools.filter((value: unknown): value is string => typeof value === "string") : undefined,
      })) : [];
      const missionId = text(args.id);
      const existing = await getMission(userId, missionId);
      if (!existing) throw new Error("Mission not found or not owned by you");
      const rejected = (mission: NonNullable<typeof existing>, completedStepIds: string[], reason: string) => ({
        operation: "mission_replan" as const,
        status: "rejected" as const,
        reason,
        completedStepIds,
        nextAction: completedStepIds.length
          ? "Include every completed step unchanged, then replan only unfinished work."
          : "Inspect the current mission proof and continue through its normal resume or closeout path.",
        mission,
      });
      if (["completed", "cancelled"].includes(existing.status)) {
        return rejected(existing, existing.steps.filter((step) => step.status === "completed").map((step) => step.id), `This ${existing.status} mission can no longer be replanned.`);
      }
      const completedStepIds = existing.steps.filter((step) => step.status === "completed").map((step) => step.id).sort();
      const proposedStepIds = new Set(steps.flatMap((step) => step.id ? [step.id] : []));
      const omittedCompletedStepIds = completedStepIds.filter((stepId) => !proposedStepIds.has(stepId));
      if (omittedCompletedStepIds.length) {
        return rejected(existing, omittedCompletedStepIds, "Completed mission steps are immutable and must be preserved.");
      }
      try {
        const mission = await replanMissionAndSchedule(userId, missionId, steps, text(args.reason, 2000), runtime.enqueueMissionTask ?? enqueueTaskWorkflow, runtime.taskId);
        if (mission) return mission;
        const latest = await getMission(userId, missionId);
        if (latest && ["completed", "cancelled"].includes(latest.status)) {
          return rejected(latest, latest.steps.filter((step) => step.status === "completed").map((step) => step.id), `This ${latest.status} mission can no longer be replanned.`);
        }
        throw new Error("Mission changed before replanning; inspect its current state and retry only if it remains unfinished.");
      } catch (error) {
        if (!(error instanceof MissionReplanConflictError)) throw error;
        return rejected(await getMission(userId, missionId) ?? existing, error.completedStepIds, "Completed mission steps are immutable and must be preserved.");
      }
    }
    case "CHUCK_MISSION_BLOCK": {
      const mission = await blockMission(userId, text(args.id), text(args.reason, 12000), args.nextAction ? text(args.nextAction, 2000) : undefined);
      if (!mission) throw new Error("Only unfinished missions you own can be blocked");
      return mission;
    }
    case "CHUCK_MISSION_COMPLETE": {
      const missionId = text(args.id);
      const existing = await getMission(userId, missionId);
      if (!existing) throw new Error("Mission not found or not owned by you");
      if (existing.status === "completed") return { ...existing, closeout: { status: "completed", alreadyCompleted: true, blockers: [] } };
      const unfinishedSteps = existing.steps.filter((step) => step.status !== "completed");
      if (unfinishedSteps.length) {
        return {
          ...existing,
          closeout: {
            status: "not_ready",
            blockers: unfinishedSteps.slice(0, 20).map((step) => `Step “${step.title}” is ${step.status}.`),
            nextAction: existing.nextAction ?? "Complete and verify the remaining mission steps before closing it.",
          },
        };
      }
      const finalized = await finalizeMissionIfReady(userId, missionId, { blockOnUnresolved: true, result: text(args.result, 12000) }) ?? existing;
      const blockers = finalized.status === "completed" ? [] : finalized.verification?.unresolved?.length
        ? finalized.verification.unresolved
        : [finalized.error ?? `Mission is ${finalized.status}; resume it only after resolving its recorded blocker.`];
      return {
        ...finalized,
        closeout: {
          status: finalized.status === "completed" ? "completed" : finalized.status === "blocked" ? "blocked" : "not_ready",
          blockers,
          ...(finalized.status !== "completed" && finalized.nextAction ? { nextAction: finalized.nextAction } : {}),
        },
      };
    }
    case "CHUCK_DAYTONA_WORKSPACE": return daytonaCall(runtime, () => daytonaEngine.workspace(userId, (args.action as "get" | "create" | "status" | "pause" | "archive") ?? "status"));
    case "CHUCK_DAYTONA_SANDBOX": return daytonaCall(runtime, () => daytonaEngine.sandbox(userId, args));
    case "CHUCK_DAYTONA_VOLUME": return daytonaCall(runtime, () => daytonaEngine.volume(userId, args));
    case "CHUCK_DAYTONA_EXECUTE": return daytonaCall(runtime, () => daytonaEngine.execute(userId, daytonaCommand(args.command), args.cwd ? text(args.cwd) : undefined, args.timeoutSeconds === undefined ? undefined : Number(args.timeoutSeconds), runtime.signal));
    case "CHUCK_DAYTONA_LIST_FILES": return daytonaCall(runtime, () => daytonaEngine.listFiles(userId, args.path ? text(args.path) : undefined, args.depth === undefined ? undefined : Number(args.depth)));
    case "CHUCK_DAYTONA_READ_FILE": return daytonaCall(runtime, () => daytonaEngine.readFile(userId, text(args.path), args.maxChars === undefined ? undefined : Number(args.maxChars)));
    case "CHUCK_DAYTONA_WRITE_FILE": return daytonaCall(runtime, () => daytonaEngine.writeFile(userId, text(args.path), fileContent(args.content)));
    case "CHUCK_ARTIFACT_QA": return daytonaCall(runtime, () => daytonaEngine.qaArtifact(userId, { ...args, _runId: runtime.currentRunId }));
    case "CHUCK_FILE_BRIDGE": throw new Error("CHUCK_FILE_BRIDGE must be executed by the authenticated agent Composio-session dispatcher; it cannot run outside an active connected-app session.");
    case "CHUCK_DAYTONA_REPLACE_FILES": return daytonaCall(runtime, () => daytonaEngine.replaceFiles(userId, args.files, args.pattern, args.newValue));
    case "CHUCK_DAYTONA_SET_FILE_PERMISSIONS": return daytonaCall(runtime, () => daytonaEngine.setFilePermissions(userId, args.path, args.permissions));
    case "CHUCK_DAYTONA_FIND_FILES": return daytonaCall(runtime, () => daytonaEngine.findFiles(userId, args.path ? text(args.path) : undefined, text(args.pattern)));
    case "CHUCK_DAYTONA_SEARCH_FILES": return daytonaCall(runtime, () => daytonaEngine.searchFiles(userId, args.path ? text(args.path) : undefined, text(args.pattern)));
    case "CHUCK_DAYTONA_FILE_DETAILS": return daytonaCall(runtime, () => daytonaEngine.fileDetails(userId, text(args.path)));
    case "CHUCK_DAYTONA_CREATE_FOLDER": return daytonaCall(runtime, () => daytonaEngine.createFolder(userId, text(args.path)));
    case "CHUCK_DAYTONA_MOVE_FILES": return daytonaCall(runtime, () => daytonaEngine.moveFiles(userId, text(args.source), text(args.destination)));
    case "CHUCK_DAYTONA_DELETE_FILE": return daytonaCall(runtime, () => daytonaEngine.deleteFile(userId, text(args.path), args.recursive === true));
    case "CHUCK_DAYTONA_DELETE_WORKSPACE": return daytonaCall(runtime, () => daytonaEngine.deleteWorkspace(userId));
    case "CHUCK_DAYTONA_PREVIEW": return daytonaCall(runtime, () => daytonaEngine.preview(userId, Number(args.port)));
    case "CHUCK_DAYTONA_APP": return daytonaCall(runtime, () => daytonaEngine.app(userId, { ...args, _runId: runtime.currentRunId }));
    case "CHUCK_DAYTONA_CREATE_SNAPSHOT": return daytonaCall(runtime, () => daytonaEngine.createSnapshot(userId, text(args.name)));
    case "CHUCK_DAYTONA_COMPUTER": return daytonaCall(runtime, () => daytonaEngine.computer(userId, { ...args, _runId: runtime.currentRunId }));
    case "CHUCK_DAYTONA_PAUSE": return daytonaCall(runtime, () => daytonaEngine.pause(userId));
    case "CHUCK_DAYTONA_PTY": return (async () => {
      const result = await daytonaCall(runtime, () => daytonaEngine.pty(userId, args));
      if (runtime.registerCancellationCleanup && args.action === "create" && result && typeof result === "object" && typeof (result as { sessionId?: unknown }).sessionId === "string") {
        const ptyId = (result as { sessionId: string }).sessionId;
        runtime.registerCancellationCleanup(async () => { await daytonaEngine.pty(userId, { action: "kill", id: ptyId }); });
      }
      return result;
    })();
    case "CHUCK_DAYTONA_SESSION": return daytonaCall(runtime, () => daytonaEngine.session(userId, args, async (stream, chunk) => {
      if (args.action === "stream_logs") await runtime.onStatus?.(`Daytona ${stream}: ${chunk.slice(0, 1400)}`);
    }));
    case "CHUCK_DAYTONA_CODE": return daytonaCall(runtime, () => daytonaEngine.code(userId, args));
    case "CHUCK_DAYTONA_LSP": return daytonaCall(runtime, () => daytonaEngine.lsp(userId, args));
    case "CHUCK_DAYTONA_GIT": return daytonaCall(runtime, () => daytonaEngine.git(userId, args));
    case "CHUCK_BROWSER_PLAN": {
      const origin = args.origin ? normalizeBrowserOrigin(text(args.origin)) : undefined;
      const playbook = origin ? await findBrowserPlaybook(userId, origin, args.accountAlias ? normalizeBrowserAlias(args.accountAlias) : "default") : undefined;
      const plan = createBrowserOperationPlan(text(args.goal), origin, playbook);
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "plan_created", ...(origin ? { origin } : {}), ...(playbook ? { service: playbook.service, playbookId: playbook.id } : {}), action: plan.action, status: "started", summary: `Planned ${plan.action.replaceAll("_", " ")} browser work`, createdAt: Date.now() });
      return { ...plan, ...(playbook ? { playbook: { id: playbook.id, service: playbook.service, accountAlias: playbook.accountAlias, version: playbook.version } } : {}) };
    }
    case "CHUCK_BROWSER_NEXT": {
      const goal = text(args.goal, 1500);
      const browser = automatedBrowserEngine("state");
      const inspected = await abortableToolCall(runtime, () => browser.browser(userId, { action: "state", ...(args.maxDepth === undefined ? {} : { maxDepth: Number(args.maxDepth) }) }, { ownerPrivateRun: runtime.ownerPrivateRun, ownerApprovedAction: Boolean(runtime.approvedApprovalId) }));
      const state = inspected && typeof inspected === "object" ? inspected as Record<string, unknown> : {};
      const page = state.page && typeof state.page === "object" ? state.page as Record<string, unknown> : state;
      const accessibility = state.accessibility ?? state.snapshot ?? page.accessibility;
      const currentUrl = typeof state.observedUrl === "string" ? state.observedUrl : typeof page.observedUrl === "string" ? page.observedUrl : undefined;
      const observation = buildBrowserCandidates({
        accessibility,
        goal,
        currentUrl,
        title: typeof state.title === "string" ? state.title : typeof page.title === "string" ? page.title : undefined,
        loadState: typeof state.loadState === "string" ? state.loadState : undefined,
        sessionStatus: typeof args.sessionStatus === "string" ? args.sessionStatus : undefined,
      }, args.maxCandidates === undefined ? 12 : Number(args.maxCandidates));
      const decision = await routeBrowserNext({ observation, signal: runtime.signal, sessionId: runtime.currentRunId ?? runtime.missionId });
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: decision.source === "jev" ? "decision_proposed" : "decision_fallback", ...(observation.origin ? { origin: observation.origin } : {}), status: decision.candidate?.requiresApproval ? "waiting" : "succeeded", summary: decision.candidate ? `Browser next-step proposal: ${decision.candidate.kind}` : "Browser next-step proposal had no safe candidate", createdAt: Date.now() });
      return { source: decision.source, mode: decision.mode, ...(decision.fallbackReason ? { fallbackReason: decision.fallbackReason } : {}), confidence: decision.confidence, observation: { origin: observation.origin, path: observation.path, title: observation.title, loadState: observation.loadState, sessionStatus: observation.sessionStatus, goal: observation.goal }, candidates: observation.candidates.map(({ id, kind, role, name, action, risk, description, requiresApproval, execution }) => ({ id, kind, role, name, action, risk, description, requiresApproval, execution })), ...(decision.candidate ? { next: decision.candidate } : {}) };
    }
    case "CHUCK_BROWSER_SESSION_HEALTH": {
      const service = args.service ? text(args.service) : undefined;
      const origin = args.origin ? normaliseVaultOrigin(text(args.origin)) : undefined;
      const health = await browserSessionHealth(userId, service, origin);
      const expired = health.filter((item) => item.status === "expired" || item.status === "needs_reauth");
      for (const item of expired) {
        try {
          await logoutVault(userId, item.service, item.accountAlias, item.origin);
          await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "session_revoked", service: item.service, origin: item.origin, status: "succeeded", summary: `Expired ${item.service} browser identity was revoked`, createdAt: Date.now() });
        } catch {
          await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "session_revoked", service: item.service, origin: item.origin, status: "failed", summary: `Expired ${item.service} browser session needs manual revocation`, createdAt: Date.now() });
        }
      }
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "session_health_checked", ...(service ? { service } : {}), status: "succeeded", summary: `Checked ${health.length} saved browser session${health.length === 1 ? "" : "s"}`, createdAt: Date.now() });
      return health;
    }
    case "CHUCK_BROWSER_PLAYBOOK_SAVE": {
      assertSafeBrowserRecipe(args.login);
      assertSafeBrowserRecipe(args.tasks);
      const service = text(args.service).toLowerCase();
      const origin = normalizeBrowserOrigin(text(args.origin));
      const accountAlias = normalizeBrowserAlias(args.accountAlias);
      if (!args.login || typeof args.login !== "object" || Array.isArray(args.login)) throw new Error("login must be an object");
      const playbook = normalizePlaybook({ userId, service, origin, accountAlias, login: args.login as BrowserPlaybookRecord["login"], tasks: Array.isArray(args.tasks) ? args.tasks as BrowserPlaybookRecord["tasks"] : [] });
      await saveBrowserPlaybook(userId, playbook);
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "playbook_saved", service, origin, playbookId: playbook.id, status: "succeeded", summary: `Saved browser recipe for ${service}`, createdAt: Date.now() });
      return { id: playbook.id, service, origin, accountAlias, version: playbook.version, taskCount: playbook.tasks.length, lastVerifiedAt: playbook.login.lastVerifiedAt };
    }
    case "CHUCK_BROWSER_PLAYBOOK_LIST": {
      const origin = args.origin ? normalizeBrowserOrigin(text(args.origin)) : undefined;
      const playbooks = (await listBrowserPlaybooks(userId, args.limit === undefined ? 25 : Number(args.limit))).filter((item) => !origin || item.origin === origin);
      return playbooks.map((item) => ({ id: item.id, service: item.service, origin: item.origin, accountAlias: item.accountAlias, version: item.version, taskCount: item.tasks.length, successCount: item.successCount, failureCount: item.failureCount, lastUsedAt: item.lastUsedAt, loginLastVerifiedAt: item.login.lastVerifiedAt }));
    }
    case "CHUCK_BROWSER_PLAYBOOK_REMOVE": {
      const id = text(args.id);
      const removed = await removeBrowserPlaybook(userId, id);
      if (!removed) throw new Error("Browser playbook not found or not owned by you");
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "browser_action", playbookId: id, status: "succeeded", summary: "Removed a saved browser playbook", createdAt: Date.now() });
      return { id, removed: true };
    }
    case "CHUCK_BROWSER_AUDIT_LIST": return listBrowserAudit(userId, args.limit === undefined ? 50 : Number(args.limit));
    case "CHUCK_BROWSER_VERIFY": {
      if (!Array.isArray(args.detectors)) throw new Error("detectors must be an array");
      const handoffId = args.handoffId ? text(args.handoffId) : undefined;
      if (handoffId && args.detectors.length === 0) throw new Error("A browser handoff requires at least one required verification detector");
      const handoff = handoffId ? await getBrowserHandoff(userId, handoffId) : undefined;
      if (handoffId && !handoff) throw new Error("Browser handoff not found or not owned by you");
      if (handoff && !["waiting", "awaiting_verification"].includes(handoff.status)) throw new Error(`Browser handoff is ${handoff.status} and cannot be verified`);
      const detectors = args.detectors as Parameters<typeof verifyBrowserResult>[0]["detectors"];
      if (!detectors?.length || !detectors.some((detector) => detector.urlIncludes || detector.urlExcludes || detector.titleIncludes || detector.titleExcludes || detector.textIncludes || detector.textExcludes)) {
        throw new Error("Provide at least one detector with a URL, title, or page-text condition");
      }
      if (handoff && !detectors.some((detector) => detector.required !== false && (detector.urlIncludes || detector.urlExcludes || detector.titleIncludes || detector.titleExcludes || detector.textIncludes || detector.textExcludes))) {
        throw new Error("A browser handoff requires at least one non-optional verification detector");
      }
      if (!handoff && Number(args.waitMs ?? 0) > 0) {
        const result = await verifyLiveBrowser({ userId, runtime, detectors, waitMs: Number(args.waitMs), pollMs: Number(args.pollMs ?? 500) });
        await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: result.passed ? "verification_passed" : "verification_failed", status: result.passed ? "succeeded" : "failed", summary: result.passed ? "Browser result verification passed after bounded polling" : "Browser result verification remained incomplete after bounded polling", createdAt: Date.now() });
        return result;
      }
      // Never let model-authored metadata authorize a retained website session.
      // Read the live retained desktop and verify only its observed state.
      const browser = automatedBrowserEngine("state");
      const observed = await abortableToolCall(runtime, () => browser.browser(userId, { action: "state", maxDepth: 8 }, { ownerPrivateRun: runtime.ownerPrivateRun })) as {
        provider?: unknown; observedUrl?: unknown; title?: unknown; accessibility?: unknown; pageContent?: unknown; observationMethod?: unknown;
      };
      const currentUrl = typeof observed.observedUrl === "string" ? observed.observedUrl : undefined;
      const title = typeof observed.title === "string" ? observed.title : undefined;
      const liveText = `${JSON.stringify(observed.accessibility ?? "")} ${typeof observed.pageContent === "string" ? observed.pageContent : ""}`.slice(0, 12_000);
      const trustedLiveUrl = isTrustedBrowserUrlObservation(observed.provider, observed.observationMethod);
      if (handoff && (!currentUrl || !trustedLiveUrl)) {
        throw new Error("The automated browser could not observe the live browser URL; the handoff remains unverified");
      }
      const result = verifyBrowserResult({
        currentUrl,
        title,
        text: liveText,
        detectors,
      });
      if (handoff?.origin && currentUrl) {
        let verifiedOrigin: string;
        try { verifiedOrigin = new URL(currentUrl).origin; } catch { throw new Error("E2B returned an invalid browser URL; the handoff remains unverified"); }
        if (verifiedOrigin !== handoff.origin) {
          await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "verification_failed", origin: verifiedOrigin, status: "failed", summary: "Private browser handoff verification stopped because the live page origin did not match", createdAt: Date.now() });
          throw new Error("The live verification page is outside the website origin bound to this handoff");
        }
      }
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: result.passed ? "verification_passed" : "verification_failed", status: result.passed ? "succeeded" : "failed", summary: result.passed ? "Browser result verification passed" : "Browser result verification needs review", createdAt: Date.now() });
      if (handoffId && result.passed) {
        const linkedVaultLogin = Boolean(handoff && (handoff.credentialId || (handoff.reason === "login" && handoff.service)));
        if (!linkedVaultLogin) {
          await updateBrowserHandoff(userId, handoffId, "completed", Date.now());
          await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "handoff_completed", ...(handoff?.service ? { service: handoff.service } : {}), ...(handoff?.origin ? { origin: handoff.origin } : {}), status: "succeeded", summary: "Private browser handoff passed same-origin verification", createdAt: Date.now() });
          return { ...result, handoffId, handoffCompleted: true };
        }
        const credentials = await listVault(userId);
        const matches = credentials.filter((credential) => credential.session?.workspaceId === handoff!.workspaceId && credential.session.status === "awaiting_user_interaction"
          && (handoff!.credentialId ? credential.id === handoff!.credentialId : (!handoff!.service || credential.service === handoff!.service)));
        const saved = matches.length === 1 ? matches[0] : undefined;
        if (!saved?.session) throw new Error("The retained browser session is not awaiting verification. Inspect the same browser and start a fresh vault login if necessary.");
        const session = await recordVaultSession(userId, { credentialId: saved.id, service: saved.service, accountAlias: saved.accountAlias, origin: saved.origin, workspaceId: saved.session.workspaceId, status: "authenticated", lastAuthenticatedAt: Date.now(), lastUsedAt: Date.now() });
        await updateBrowserHandoff(userId, handoffId, "completed", Date.now());
        await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "handoff_completed", service: saved.service, origin: saved.origin, status: "succeeded", summary: "Private browser handoff passed verification", createdAt: Date.now() });
        return { ...result, handoffId, handoffCompleted: true, session: { id: session.id, workspaceId: session.workspaceId, status: session.status, origin: session.origin } };
      }
      return result;
    }
    case "CHUCK_BROWSER_OBSERVE": {
      const browser = automatedBrowserEngine("observe");
      return abortableToolCall(runtime, () => browser.browser(userId, {
        action: "observe",
        includeScreenshot: args.includeScreenshot === true,
        includeForms: args.includeForms !== false,
        includePageContent: args.includePageContent === true,
      }, { ownerPrivateRun: runtime.ownerPrivateRun, visualFeedback: true, signal: runtime.signal }));
    }
    case "CHUCK_BROWSER_ACT": {
      const browser = automatedBrowserEngine("act");
      const step = { ...args, action: args.action };
      return abortableToolCall(runtime, () => browser.browser(userId, { action: "act", step }, { ownerPrivateRun: runtime.ownerPrivateRun, ownerApprovedAction: Boolean(runtime.approvedApprovalId), visualFeedback: true, signal: runtime.signal }));
    }
    case "CHUCK_BROWSER_EXTRACT": {
      const browser = automatedBrowserEngine("extract");
      return abortableToolCall(runtime, () => browser.browser(userId, { action: "extract", schema: args.schema }, { ownerPrivateRun: runtime.ownerPrivateRun, visualFeedback: true, signal: runtime.signal }));
    }
    case "CHUCK_BROWSER_AGENT": {
      const browser = automatedBrowserEngine("agent");
      return abortableToolCall(runtime, () => browser.browser(userId, {
        action: "agent",
        steps: args.steps,
        maxSteps: args.maxSteps,
        maxActions: args.maxActions,
        maxDurationMs: args.maxDurationMs,
        noProgressLimit: args.noProgressLimit,
        completionAssertions: args.completionAssertions,
        sessionId: args.sessionId,
      }, { ownerPrivateRun: runtime.ownerPrivateRun, ownerApprovedAction: Boolean(runtime.approvedApprovalId), visualFeedback: true, signal: runtime.signal }));
    }
    case "CHUCK_BROWSER": {
      const action = classifyBrowserIntent({ label: typeof args.label === "string" ? args.label : String(args.action ?? "browse"), url: typeof args.url === "string" ? args.url : undefined });
      const origin = typeof args.url === "string" ? (() => { try { return new URL(args.url).origin; } catch { return undefined; } })() : undefined;
      try {
        const browser = automatedBrowserEngine(args.action);
        const result = await abortableToolCall(runtime, () => browser.browser(userId, args, { ownerPrivateRun: runtime.ownerPrivateRun, ownerApprovedAction: Boolean(runtime.approvedApprovalId), visualFeedback: true, signal: runtime.signal }));
        if (runtime.registerCancellationCleanup && args.action === "session_acquire" && result && typeof result === "object" && typeof (result as { sessionId?: unknown }).sessionId === "string") {
          const sessionId = (result as { sessionId: string }).sessionId;
          runtime.registerCancellationCleanup(async () => { await browser.browser(userId, { action: "session_release", sessionId }); });
        }
        await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "browser_action", ...(origin ? { origin } : {}), action, status: "succeeded", summary: `Browser ${String(args.action ?? "operation").replaceAll("_", " ")} completed`, createdAt: Date.now() });
        if (result && typeof result === "object" && (result as { needsUserInteraction?: unknown }).needsUserInteraction === true && (result as { challenge?: unknown }).challenge) {
          const challenge = (result as { challenge?: { type?: unknown } }).challenge;
          const reason = challenge?.type === "two_factor" ? "two_factor" : challenge?.type === "captcha" ? "captcha" : "site_challenge";
          const observedUrl = typeof (result as { observedUrl?: unknown }).observedUrl === "string" ? (result as { observedUrl: string }).observedUrl : undefined;
          let observedOrigin: string | undefined;
          if (observedUrl) { try { const current = new URL(observedUrl); if (current.protocol === "https:") observedOrigin = current.origin; } catch { /* use request origin fallback */ } }
          const handoff = await createBrowserHandoffRecord(userId, { reason, origin: observedOrigin ?? origin }, runtime.ownerPrivateRun === true);
          return { ...(result as Record<string, unknown>), browserHandoff: handoff, next: "Open the private browser link delivered to you, complete the challenge there, return and say continue, then call CHUCK_BROWSER_HANDOFF_COMPLETE followed by CHUCK_BROWSER_VERIFY." };
        }
        return result;
      } catch (error) {
        if (error instanceof E2BBrowserHandoffWaitingError) {
          await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "browser_action", ...(origin ? { origin } : {}), action, status: "waiting", summary: "Browser action paused until the owner completes the private handoff", createdAt: Date.now() });
          return browserHandoffWaitingResult(error, action);
        }
        await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "browser_action", ...(origin ? { origin } : {}), action, status: "failed", summary: `Browser ${String(args.action ?? "operation").replaceAll("_", " ")} failed`, createdAt: Date.now() });
        throw error;
      }
    }
    case "CHUCK_BROWSER_HANDOFF": return abortableToolCall(runtime, () => createBrowserHandoffRecord(userId, args, runtime.ownerPrivateRun === true));
    case "CHUCK_BROWSER_HANDOFF_STATUS": {
      const id = args.id ? text(args.id) : undefined;
      const records = id ? [await getBrowserHandoff(userId, id)] : await listBrowserHandoffs(userId, args.limit === undefined ? 10 : Number(args.limit));
      const visible = records.filter((record): record is NonNullable<typeof record> => Boolean(record)).map((record) => ({ id: record.id, workspaceId: record.workspaceId, ...(record.service ? { service: record.service } : {}), ...(record.origin ? { origin: record.origin } : {}), reason: record.reason, provider: normalizeChallengeProvider(record.provider), challengeType: normalizeChallengeType(record.challengeType ?? record.reason), resolutionState: record.resolutionState ?? (record.status === "completed" ? "verified" : record.status === "expired" ? "expired" : "handoff_required"), status: record.status, createdAt: record.createdAt, expiresAt: record.expiresAt, ...(record.completedAt ? { completedAt: record.completedAt } : {}) }));
      return id ? visible[0] ?? { id, status: "not_found" } : visible;
    }
    case "CHUCK_BROWSER_HANDOFF_COMPLETE": {
      const id = text(args.id);
      const handoff = await getBrowserHandoff(userId, id);
      if (!handoff) throw new Error("Browser handoff not found or not owned by you");
      if (handoff.status === "expired") throw new Error("This browser handoff has expired. Request a new private handoff.");
      if (handoff.status === "cancelled") throw new Error("This browser handoff was cancelled. Request a new private handoff.");
      if (handoff.status === "completed") return { id, status: "completed", alreadyCompleted: true };
      const updated = await updateBrowserHandoff(userId, id, "awaiting_verification");
      return { id, status: updated?.status ?? "awaiting_verification", next: "Inspect the retained browser, then call CHUCK_BROWSER_VERIFY with this handoffId and required detectors before taking any further action." };
    }
    case "CHUCK_BROWSER_HANDOFF_RESUME": return abortableToolCall(runtime, () => resumeBrowserHandoff(userId, text(args.id), runtime.ownerPrivateRun === true));
    case "CHUCK_VAULT_SAVE": return beginVaultSetup(userId, args as any);
    case "CHUCK_VAULT_LIST": return listVault(userId);
    case "CHUCK_VAULT_STATUS": return vaultStatus(userId, args.service ? text(args.service) : undefined, args.accountAlias ? normalizeBrowserAlias(args.accountAlias) : undefined, args.origin ? normaliseVaultOrigin(text(args.origin)) : undefined);
    case "CHUCK_VAULT_LOGIN": return daytonaCall(runtime, async () => {
      const service = normaliseVaultService(text(args.service));
      const accountAlias = args.accountAlias ? normalizeBrowserAlias(args.accountAlias) : "default";
      const origin = args.origin ? normaliseVaultOrigin(text(args.origin)) : undefined;
      const saved = (await listVault(userId)).filter((credential) => credential.service === service && credential.accountAlias === accountAlias && (!origin || credential.origin === origin));
      const loginRecipe = saved.length === 1 ? await findBrowserPlaybook(userId, saved[0]!.origin, accountAlias) : undefined;
      // E2B owns normal Playwright login and the retained headed Chromium
      // session exposed by the E2B handoff when a CAPTCHA/2FA challenge needs
      // the owner. Daytona is never a browser or vault-login backend.
      const browser = automatedBrowserEngine("open");
      const login = await loginWithVault(userId, service, { workspaceId: (owner) => browser.workspaceId(owner), login: (owner, input) => browser.vaultLogin(owner, input) }, accountAlias, origin, loginRecipe?.login);
      const { credentialId, ...safeLogin } = login;
      if (loginRecipe) {
        const verifiedAt = login.authenticated ? Date.now() : loginRecipe.login.lastVerifiedAt;
        await saveBrowserPlaybook(userId, normalizePlaybook({ ...loginRecipe, login: { ...loginRecipe.login, ...(verifiedAt ? { lastVerifiedAt: verifiedAt } : {}) }, successCount: login.authenticated ? loginRecipe.successCount + 1 : loginRecipe.successCount, failureCount: login.authenticated ? loginRecipe.failureCount : loginRecipe.failureCount + 1, lastUsedAt: Date.now() })).catch(() => undefined);
        await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "playbook_used", service, origin: login.origin, playbookId: loginRecipe.id, status: login.authenticated ? "succeeded" : login.needsUserInteraction ? "waiting" : "failed", summary: login.authenticated ? `Reused the verified ${service} login playbook` : `The ${service} login playbook needs review`, createdAt: Date.now() });
      }
      // A CAPTCHA, 2FA prompt, or an unfamiliar login form must not fail the
      // entire sign-in or expose credentials. Give the owner a short-lived
      // direct browser handoff and retain the same browser session instead.
      if (!login.needsUserInteraction) return safeLogin;
      return {
        ...safeLogin,
        browserHandoff: await createBrowserHandoffRecord(userId, { reason: "login", service, origin: login.handoffOrigin ?? login.origin, credentialId }, runtime.ownerPrivateRun === true),
      };
    });
    case "CHUCK_VAULT_LOGOUT": return (async () => {
      const service = normaliseVaultService(text(args.service));
      const accountAlias = args.accountAlias ? normalizeBrowserAlias(args.accountAlias) : undefined;
      const origin = args.origin ? normaliseVaultOrigin(text(args.origin)) : undefined;
      const saved = (await listVault(userId)).find((credential) => credential.service === service && (!accountAlias || credential.accountAlias === accountAlias) && (!origin || credential.origin === origin));
      let browserLogout: { attempted: boolean; completed?: boolean; note?: string } = { attempted: false, note: "No site logout URL was configured." };
      if (saved?.logoutUrl) {
        try {
          await automatedBrowserEngine("open").browser(userId, { action: "open", url: saved.logoutUrl });
          browserLogout = { attempted: true, completed: true };
        } catch (error) {
          browserLogout = { attempted: true, completed: false, note: error instanceof Error ? error.message : "The site logout page could not be opened." };
        }
      }
      const result = await logoutVault(userId, service, accountAlias, origin);
      await addBrowserAudit(userId, { id: `ba_${randomUUID()}`, userId, event: "session_revoked", service, ...(saved?.origin ? { origin: saved.origin } : {}), status: "succeeded", summary: `Revoked the ${service}${accountAlias ? ` (${accountAlias})` : ""} browser session`, createdAt: Date.now() });
      return { ...result, browserLogout, workspacePaused: false, note: "The selected saved session is revoked. Other browser identities and workspace processes remain available." };
    })();
    case "CHUCK_LINK_CONNECT":
    case "CHUCK_LINK_WALLET_CONNECT": return beginLinkOAuth(userId);
    case "CHUCK_LINK_STATUS":
    case "CHUCK_LINK_WALLET_STATUS": return linkWalletStatus(userId);
    case "CHUCK_LINK_PAYMENT_METHODS": return linkPaymentMethods(userId);
    case "CHUCK_LINK_CREATE_SPEND_REQUEST": return createLinkSpendRequest(userId, args);
    case "CHUCK_LINK_INSPECT_CHECKOUT": return inspectLinkPayTokenCheckout(userId, args);
    case "CHUCK_LINK_MPP_DISCOVER": return discoverLinkMppPayment(userId, args);
    case "CHUCK_LINK_MPP_PAY": return payLinkMppRequest(userId, args);
    case "CHUCK_LINK_UCP_SEARCH": return searchLinkUcpCatalog(userId, args);
    case "CHUCK_LINK_UCP_CREATE_CHECKOUT": return createLinkUcpCheckout(userId, args);
    case "CHUCK_LINK_UCP_COMPLETE_CHECKOUT": return completeLinkUcpCheckout(userId, args);
    case "CHUCK_LINK_CONFIRM_ORDER": return confirmLinkMerchantOrder(userId, args);
    case "CHUCK_LINK_WAIT_FOR_APPROVAL": return waitForLinkSpendApproval(userId, args);
    case "CHUCK_LINK_EXECUTE_PAYMENT": return executeLinkPayment(userId, args);
    case "CHUCK_LINK_RECEIPT": return linkSpendReceipt(userId, text(args.spendRequestId));
    case "CHUCK_LINK_REPORT_OUTCOME": return reportLinkOutcome(userId, args);
    case "CHUCK_LINK_SPEND_STATUS": return linkSpendStatus(userId, text(args.spendRequestId));
    case "CHUCK_LINK_SPEND_LIST": return listLinkSpendRequestViews(userId, args.limit === undefined ? 20 : Number(args.limit));
    case "CHUCK_LINK_SPEND_CANCEL": return cancelLinkSpendRequest(userId, text(args.spendRequestId));
    case "CHUCK_LINK_COMPLETE_CHECKOUT": return completeApprovedLinkCheckout(userId, args);
    case "CHUCK_LINK_WALLET_DISCONNECT": return disconnectLinkWallet(userId);
    case "CHUCK_BROWSER_SESSION_REVOKE": return nativeTool(userId, "CHUCK_VAULT_LOGOUT", args, runtime);
    case "CHUCK_SHOPPING_START": return startShopping(userId, args);
    case "CHUCK_SHOPPING_LIST": return listShopping(userId, args.limit === undefined ? undefined : Number(args.limit));
    case "CHUCK_SHOPPING_SELECT_RETAILER": return selectShoppingRetailer(userId, args);
    case "CHUCK_SHOPPING_UPDATE": return updateShopping(userId, args);
    case "CHUCK_SHOPPING_CANCEL": return cancelShopping(userId, text(args.id));
    case "CHUCK_SHOPPING_PAUSE": return pauseShopping(userId, args);
    case "CHUCK_SHOPPING_RESUME": return resumeShopping(userId, text(args.id));
    case "CHUCK_SHOPPING_SAVE_SITE": return saveShoppingSitePreference(userId, args);
    case "CHUCK_SHOPPING_LIST_SITES": return listSavedShoppingSites(userId, args.limit === undefined ? undefined : Number(args.limit));
    case "CHUCK_SHOPPING_REMOVE_SITE": return removeSavedShoppingSite(userId, text(args.id));
    case "CHUCK_CREATE_PDF": return daytonaCall(runtime, () => daytonaEngine.createPdf(userId, { ...args, _runId: runtime.currentRunId }));
    case "CHUCK_CREATE_PRESENTATION": return daytonaCall(runtime, () => daytonaEngine.createPresentation(userId, { ...args, _runId: runtime.currentRunId }));
    case "CHUCK_CREATE_DOCUMENT": return daytonaCall(runtime, () => daytonaEngine.createDocument(userId, { ...args, _runId: runtime.currentRunId }));
    case "CHUCK_CREATE_SPREADSHEET": return daytonaCall(runtime, () => daytonaEngine.createSpreadsheet(userId, { ...args, _runId: runtime.currentRunId }));
    case "CHUCK_ARTIFACT": return daytonaCall(runtime, () => daytonaEngine.artifact(userId, { ...args, _runId: runtime.currentRunId }));
    case "CHUCK_DELEGATE_SUBAGENT":
      return runPlannedDelegation(userId, args as any, runtime);
    case "CHUCK_HANDOFF_SUBAGENT":
      if (runtime.worker && !runtime.workerBinding) throw new Error("A specialist without a worker capability binding cannot hand off work");
      return runDelegationWithDurableContinuation(userId, {
        worker: args.targetWorker as any,
        objective: text(args.objective),
        context: (args.context as any) ?? {},
        expectedOutput: args.expectedOutput ? String(args.expectedOutput) : undefined,
        allowedTools: runtime.workerBinding ? runtime.workerBinding.allowedTools.filter((tool) =>
          WORKER_CAPABILITIES[args.targetWorker as keyof typeof WORKER_CAPABILITIES]?.allowedTools.includes(tool) && tool !== "CHUCK_HANDOFF_SUBAGENT"
        ) : undefined,
        allowedComposioTools: runtime.workerBinding?.allowedComposioTools.filter((slug) => isComposioToolAllowedForWorker(args.targetWorker as any, slug)),
        timeoutSeconds: runtime.workerBinding ? Math.min(60, runtime.workerBinding.timeoutSeconds) : undefined,
        maxToolCalls: runtime.workerBinding ? Math.min(20, runtime.workerBinding.maxToolCalls) : 20,
        duration: runtime.workerBinding?.duration ?? "30m",
        budgetSeconds: runtime.workerBinding?.budgetSeconds === undefined ? 300 : Math.min(300, runtime.workerBinding.budgetSeconds),
        maxTotalToolCalls: runtime.workerBinding?.maxTotalToolCalls,
      }, runtime);
    case "CHUCK_PLAN_DELEGATION":
      if (runtime.worker) throw new Error("CHUCK_PLAN_DELEGATION is reserved for Chusky, the supervisor.");
      return planDelegationObjective(text(args.objective), Array.isArray(args.allowedTools) ? args.allowedTools.map((item) => String(item)) : []);
    case "CHUCK_REQUEST_ADDITIONAL_TOOLS":
      return {
        requested: true,
        intent: text(args.intent),
        reason: text(args.reason),
        preferredToolkit: args.preferredToolkit ? text(args.preferredToolkit) : undefined,
        note: "Request recorded for Chusky. It does not grant or execute any additional tool.",
      };
    case "CHUCK_RESOLVE_SUBAGENT_TOOL_REQUEST":
      return resolveSubagentToolRequest(userId, text(args.handoffId), stringList(args.allowedComposioTools, "allowedComposioTools"));
    case "CHUCK_REVIEW_SUBAGENT_ACTION":
      return reviewSubagentAction(userId, args);
    case "CHUCK_LIST_SUBAGENTS": {
      const limit = args.limit === undefined ? 20 : Math.max(1, Math.min(50, Math.floor(Number(args.limit))));
      const records = await listHandoffRecords(userId);
      return records.slice(0, limit).map((r) => ({
        id: r.id, worker: r.to, objective: r.objective, status: r.status,
        taskId: r.taskId, timestamp: r.timestamp,
      }));
    }
    case "CHUCK_GET_SUBAGENT_STATUS": {
      const id = text(args.id);
      const records = await listHandoffRecords(userId);
      const record = records.find((r) => r.id === id);
      if (!record) throw new Error("Handoff record not found or not owned by you");
      const task = record.taskId ? await getTask(userId, record.taskId) : undefined;
      return { ...record, task };
    }
    case "CHUCK_CANCEL_SUBAGENT": {
      const id = text(args.id);
      const reason = args.reason ? String(args.reason) : "Cancelled by supervisor";
      const records = await listHandoffRecords(userId);
      const record = records.find((r) => r.id === id);
      if (!record) throw new Error("Handoff record not found or not owned by you");
      const updated = await requestDelegationCancellation(userId, id, reason);
      if (!updated) return { cancellationRequested: false, cancelled: false, status: record.status, id, worker: record.to, reason: "This delegation has already finished and was not cancelled.", taskId: record.taskId };
      return { cancellationRequested: true, cancelled: false, status: updated.status, id, worker: record.to, reason, taskId: updated.taskId, note: "Cancellation was requested; the worker may need a short time to stop and settle its durable task." };
    }
    default: throw new Error(`Unknown native tool: ${slug}`);
  }
}
