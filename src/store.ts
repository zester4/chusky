/**
 * Persistent store — Redis (preferred) or in-memory fallback.
 * Handles: message history, model selection, rate limiting, composio session IDs.
 */
import Redis from "ioredis";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { recordFailure } from "./monitoring.js";
import type { ChannelProvider, InboundMessage, ChannelTemplate } from "./channels/contracts.js";
import type { ApprovalPolicy, HandoffRecord, WorkerDuration } from "./subagents/contracts.js";
import type { CapabilityWorkerName } from "./memory/types.js";
import { UpstashKnowledgeStore, vectorConfigured } from "./lib/knowledge/vector.js";
import { deleteR2Object, putR2Object, r2Configured, signR2Download } from "./lib/storage/r2.js";

export interface Message {
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
}

export interface UserSession {
  model: string;
  history: Message[];
  totalMessages: number;
  totalCost: number;
  composioSessionId?: string; // persisted Composio ToolRouter session ID
  daytonaWorkspaceId?: string;
  telegramChatId?: number;
  voiceReplies?: boolean;
  triggerIds: string[];
  reminders: ReminderRecord[];
  jobs: JobRecord[];
  scratchpad: Record<string, ScratchpadEntry>;
  memories: MemoryFact[];
  imageAssets: ImageAsset[];
  summaries: string[];
  approvals: ApprovalRecord[];
  sdkThreads?: SdkThreadRecord[];
  sdkFiles?: SdkFileRecord[];
  artifacts?: ArtifactRecord[];
  sdkIdempotency?: Record<string, { fingerprint: string; response: unknown; createdAt: number }>;
  sdkAudit?: Array<{ id: string; action: string; requestId: string; status: number; at: number }>;
  sdkWebhooks?: Array<{ id: string; url: string; secretCiphertext: string; createdAt: number; disabledAt?: number }>;
  sdkProjects?: SdkProjectRecord[];
  faceTimeCalls?: FaceTimeCallRecord[];
  videoJobs?: VideoJobRecord[];
  handoffRecords?: HandoffRecord[];
  createdAt: number;
  updatedAt: number;
}

export type VideoJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface VideoJobRecord {
  id: string;
  userId: number;
  prompt: string;
  destination: "telegram" | "daytona" | "both";
  workspacePath?: string;
  workflowRunId?: string;
  status: VideoJobStatus;
  pollCount: number;
  error?: string;
  resultPath?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
/** Safe control-plane record. It deliberately excludes Agora credentials and media. */
export interface FaceTimeCallRecord {
  id: string;
  userId: number;
  /** Explicit provider keeps shared safe call storage transport-aware. */
  provider?: "facetime" | "twilio";
  direction?: "inbound" | "outbound";
  phoneNumber: string;
  purpose: string;
  status: "starting" | "bridging" | "active" | "ended" | "failed";
  bridgeSessionId?: string;
  providerCallId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
export interface SdkProjectRecord {
  id: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  createdAt: number;
  /** Better Auth user that owns a self-service dashboard project. Root-created projects have no owner. */
  ownerWebAuthUserId?: string;
  rotatedAt?: number;
  revokedAt?: number;
}

export interface SdkRunRecord {
  id: string;
  status: "queued" | "running" | "requires_approval" | "completed" | "failed" | "cancelled";
  input: string;
  model?: string;
  /** Verified R2 uploads used for this run. Keys are intentionally never exposed. */
  attachments?: Array<{ id: string; name: string; contentType: string; size: number }>;
  output?: string;
  approvalId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  budget?: { duration?: string; maxToolCalls?: number; maxCost?: number };
  tools?: { allow?: string[]; deny?: string[]; requireApproval?: string[] };
  skills?: string[];
  error?: { code: string; message: string };
  events: Array<{ id: string; type: string; at: number; text?: string }>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Durable execution state for a supervisor or specialist run.  This record is
 * deliberately separate from UserSession so a long-running run never rewrites
 * chat history, memories, or SDK metadata on every checkpoint.
 */
export type AgentRunStatus = "queued" | "running" | "waiting_approval" | "waiting_tools" | "paused" | "cancel_requested" | "interrupted" | "completed" | "failed" | "cancelled";
export interface AgentRunEvent {
  id: string;
  type: string;
  at: number;
  data?: Record<string, unknown>;
}
export interface AgentRunRecord {
  id: string;
  userId: number;
  parentRunId?: string;
  kind: "supervisor" | "worker";
  worker?: string;
  objective: string;
  model?: string;
  status: AgentRunStatus;
  budget?: { duration?: string; timeoutSeconds?: number; maxToolCalls?: number; maxCost?: number; startedAt?: number };
  /** JSON-serializable model state; bounded by saveAgentRun(). */
  state?: { messages?: unknown[]; toolCallsExecuted?: number; round?: number; output?: string; toolResults?: Record<string, string>; checkpoint?: string; nextAction?: string };
  version: number;
  events: AgentRunEvent[];
  createdAt: number;
  updatedAt: number;
}

export interface SdkThreadRecord {
  id: string;
  externalId: string;
  metadata: Record<string, unknown>;
  history: Message[];
  runs: SdkRunRecord[];
  createdAt: number;
  updatedAt: number;
}
export interface SdkFileRecord { id: string; key: string; name: string; contentType: string; size: number; status: "pending" | "available" | "rejected"; createdAt: number; }
export type ArtifactType = "website" | "report" | "docx" | "presentation" | "pdf" | "spreadsheet" | "image" | "video" | "zip" | "project";
export interface ArtifactRecord { id: string; userId: number; sandboxId: string; name: string; type: ArtifactType; path: string; contentType: string; size: number; status: "available"; createdAt: number; updatedAt: number; }

export interface DaytonaWorkspaceRecord {
  sandboxId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastKnownState?: string;
  ptySessions?: Array<{ id: string; createdAt: number }>;
  /** Bounded control-plane records for web apps running in the owned workspace. */
  apps?: DaytonaAppRecord[];
  browser?: { lastUrl?: string; updatedAt: number };
}

export type DaytonaAppFramework = "vite-react" | "nextjs";
/**
 * A web app is a durable project, not just a process ID. These states are
 * intentionally conservative: a project cannot be marked release-ready until
 * its current source has passed both executable and visual verification.
 */
export type DaytonaAppStatus = "scaffolded" | "verified" | "running" | "ready_for_review" | "ready_to_publish" | "stopped" | "failed";
export interface DaytonaAppCheck {
  name: "typecheck" | "lint" | "test" | "build" | "health";
  status: "passed" | "failed" | "skipped";
  output: string;
  completedAt: number;
}
export interface DaytonaAppVerification {
  status: "passed" | "failed" | "pending";
  checks: DaytonaAppCheck[];
  verifiedAt?: number;
  visual?: { status: "captured" | "passed" | "failed"; summary?: string; capturedAt: number; reviewedAt?: number };
}
export interface DaytonaAppRecord {
  id: string;
  framework: DaytonaAppFramework;
  path: string;
  port: number;
  status: DaytonaAppStatus;
  /** Isolated local Git branch; remote push remains an approval-gated action. */
  branch?: string;
  verification?: DaytonaAppVerification;
  release?: { status: "not_requested" | "awaiting_approval" | "published"; requestedAt?: number; target?: string };
  ptySessionId?: string;
  /** Last bounded server output, retained for diagnosis when a PTY reconnect has no historical buffer. */
  lastOutput?: string;
  previewUrl?: string;
  previewExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type TaskStatus = "queued" | "running" | "blocked" | "completed" | "failed" | "cancel_requested" | "cancelled";

export interface TaskStep {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "blocked" | "failed" | "cancelled";
  result?: string;
  updatedAt: number;
}

export interface TaskLease {
  token: string;
  workerId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface TaskEvent {
  id: string;
  type: "created" | "scheduled" | "claimed" | "checkpointed" | "blocked" | "completed" | "failed" | "cancel_requested" | "cancelled" | "retried";
  message: string;
  at: number;
  attempt: number;
}

/**
 * A task lives outside the expiring chat session so a paused Daytona workspace
 * and its recovery instructions remain available after session/history TTL.
 */
export interface TaskRecord {
  id: string;
  userId: number;
  title: string;
  objective: string;
  status: TaskStatus;
  steps: TaskStep[];
  checkpoint?: string;
  nextAction?: string;
  workspaceId?: string;
  result?: string;
  error?: string;
  attempt: number;
  maxAttempts: number;
  runAt?: number;
  workflowRunId?: string;
  lease?: TaskLease;
  events: TaskEvent[];
  createdAt: number;
  updatedAt: number;
  /** Optional SDK run linkage for asynchronous API executions. */
  sdkRunId?: string;
  sdkThreadId?: string;
  sdkInput?: string;
  sdkAttachments?: Array<{ id: string; name: string; contentType: string; size: number }>;
  sdkModel?: string;
  sdkTools?: { allow?: string[]; deny?: string[]; requireApproval?: string[] };
  sdkBudget?: { duration?: string; maxToolCalls?: number; maxCost?: number };
  sdkStartedAt?: number;
  sdkSkills?: string[];
}

export interface ReminderRecord {
  id: string;
  userId: number;
  text: string;
  runAt: number;
  workflowRunId?: string;
  status: "scheduled" | "sent" | "cancelled" | "failed";
  /** Durable channel destination captured when the reminder is created. */
  deliveryTarget?: ReminderDeliveryTarget;
  deliveryError?: string;
  createdAt: number;
}

export interface ReminderDeliveryTarget {
  provider: ChannelProvider;
  conversationId: string;
  threadId?: string;
  workspaceId?: string;
  /** Only durable routing metadata belongs here; message handles are excluded. */
  metadata?: Record<string, string>;
}

/**
 * Optional execution identity for recurring jobs created by a specialist.
 * Legacy jobs omit this and continue through Chusky's normal agent loop.
 */
export interface ScheduledWorkerBinding {
  worker: Exclude<CapabilityWorkerName, "chusky">;
  objective: string;
  expectedOutput: string;
  model?: string;
  allowedTools: string[];
  allowedComposioTools: string[];
  approvalPolicy: ApprovalPolicy;
  timeoutSeconds: number;
  maxToolCalls: number;
  duration?: WorkerDuration;
  budgetSeconds?: number;
}

export interface JobRecord {
  id: string;
  userId: number;
  text: string;
  cron: string;
  scheduleId: string;
  status: "active" | "cancelled";
  workerBinding?: ScheduledWorkerBinding;
  /** Durable provider-neutral destination captured when the job is created. */
  deliveryTarget?: ReminderDeliveryTarget;
  deliveryError?: string;
  createdAt: number;
}

export interface ScratchpadEntry {
  content: string;
  updatedAt: number;
}

export interface MemoryFact {
  id: string;
  category: "profile" | "personal" | "preference" | "business" | "relationship" | "project" | "procedural" | "episodic" | "document" | "negative" | "fact" | "instruction" | "asset";
  key: string;
  value: string;
  confidence: number;
  source: string;
  sensitivity: "normal" | "sensitive";
  status?: "active" | "superseded" | "deleted";
  supersedesId?: string;
  projectId?: string;
  personKey?: string;
  reviewAt?: number;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ImageAsset {
  id: string;
  userId: number;
  name: string;
  purpose: string;
  description: string;
  tags: string[];
  r2Key: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  size: number;
  createdAt: number;
  updatedAt: number;
}

export type AttentionEntityKind =
  | "observation"
  | "open_loop"
  | "attention_candidate"
  | "standing_order"
  | "delivery_preference"
  | "relationship"
  | "project_state";
export type AttentionCollection =
  | "observations"
  | "open-loops"
  | "attention-candidates"
  | "standing-orders"
  | "delivery-preferences"
  | "relationships"
  | "project-states";
export type AttentionMetadata = Record<string, string | number | boolean | null>;

export interface ObservationRecord {
  id: string; userId: number; source: string; eventType: string; summary: string;
  entityId?: string; dedupeKey?: string; metadata?: AttentionMetadata;
  occurredAt: number; importance: number; novelty: number; confidence: number;
  privacyScope: "private" | "shared"; status: "new" | "processed" | "ignored";
  createdAt: number; updatedAt: number;
}
export interface OpenLoopRecord {
  id: string; userId: number; title: string; objective?: string; source?: string;
  priority: number; confidence: number; dueAt?: number; snoozedUntil?: number;
  nextAction?: string; waitingFor?: string; relatedEntityIds?: string[];
  status: "open" | "waiting" | "blocked" | "snoozed" | "completed" | "dismissed";
  createdAt: number; updatedAt: number;
}
export interface AttentionCandidateRecord {
  id: string; userId: number; candidateType: "nudge" | "digest" | "prepare" | "ask" | "act";
  status: "pending" | "delivered" | "accepted" | "dismissed" | "snoozed" | "expired";
  observationId?: string; openLoopId?: string; score: number; reason: string;
  proposedAction?: string; channel?: ChannelProvider; availableAt?: number; expiresAt?: number;
  createdAt: number; updatedAt: number;
}
export interface StandingOrderRecord {
  id: string; userId: number; name: string; instruction: string; scope: string[];
  authority: "observe" | "prepare" | "execute_reversible"; constraints?: AttentionMetadata;
  status: "active" | "paused" | "revoked"; expiresAt?: number; lastUsedAt?: number;
  createdAt: number; updatedAt: number;
}
export interface DeliveryPreferenceRecord {
  id: string; userId: number; provider: ChannelProvider; conversationId?: string;
  enabled: boolean; mode: "immediate" | "digest" | "silent";
  quietHoursUtc?: { startMinute: number; endMinute: number };
  maxPerDay?: number; minScore?: number; createdAt: number; updatedAt: number;
}
export interface RelationshipRecord {
  id: string; userId: number; personKey: string; name?: string; role?: string; notes?: string;
  importance: number; lastInteractionAt?: number; preferredChannel?: ChannelProvider;
  confidence: number; createdAt: number; updatedAt: number;
}
export interface ProjectStateRecord {
  id: string; userId: number; projectKey: string; name: string; status: "active" | "paused" | "completed" | "archived";
  summary: string; currentPhase?: string; nextAction?: string; blockers?: string[];
  lastActivityAt?: number; confidence: number; createdAt: number; updatedAt: number;
}
export type AttentionRecord = ObservationRecord | OpenLoopRecord | AttentionCandidateRecord | StandingOrderRecord | DeliveryPreferenceRecord | RelationshipRecord | ProjectStateRecord;
export interface AttentionListOptions { query?: string; status?: string; limit?: number; }

export interface ApprovalRecord {
  id: string;
  userId: number;
  accountId?: string;
  channelProvider?: ChannelProvider;
  channelConversationId?: string;
  triggerEventId?: string;
  toolSlug: string;
  args: Record<string, unknown>;
  request: string;
  history: Message[];
  model: string;
  status: "pending" | "approved" | "consumed" | "denied" | "expired";
  createdAt: number;
  expiresAt: number;
  /** Present for a specialist proposal; the Chusky supervisor resolves it. */
  handoffId?: string;
}

export interface TriggerEventRecord {
  eventId: string;
  userId: number;
  triggerId?: string;
  triggerSlug: string;
  summary: string;
  status: "queued" | "running" | "awaiting_approval" | "completed" | "failed";
  workflowRunId?: string;
  approvalId?: string;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CliPairingRecord {
  codeHash: string;
  userId: number;
  expiresAt: number;
  used: boolean;
}

export interface CliDeviceRecord {
  tokenHash: string;
  userId: number;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface ChannelIdentityRecord {
  accountId: string;
  userId: number;
  provider: ChannelProvider;
  externalUserId: string;
  workspaceId?: string;
  displayName?: string;
  verifiedAt: number;
  createdAt: number;
  updatedAt: number;
  disabledAt?: number;
  /** WhatsApp proactive delivery is opt-in; legacy/Slack identities default on. */
  proactiveOptIn?: boolean;
  quietHoursUtc?: { startMinute: number; endMinute: number };
}

export interface ChannelInstallationRecord {
  provider: "slack" | "whatsapp";
  workspaceId: string;
  botToken?: string;
  appId?: string;
  teamName?: string;
  installedByUserId?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelOAuthStateRecord {
  provider: "slack";
  stateHash: string;
  userId: number;
  expiresAt: number;
  used: boolean;
}

export interface ChannelLinkCodeRecord {
  codeHash: string;
  userId: number;
  provider: ChannelProvider;
  expiresAt: number;
  used: boolean;
}

export interface SendblueGroupAuthorizationRecord {
  provider: "sendblue";
  groupId: string;
  workspaceId: string;
  accountId: string;
  userId: number;
  ownerExternalUserId: string;
  participantPolicy: "all" | "owner";
  createdAt: number;
  updatedAt: number;
  disabledAt?: number;
}

export interface SendblueGroupLinkCodeRecord {
  codeHash: string;
  userId: number;
  provider: "sendblue";
  expiresAt: number;
  used: boolean;
}

/** A one-time proof that an authenticated web account may join a Telegram account. */
export interface WebTelegramLinkCodeRecord {
  codeHash: string;
  webAuthUserId: string;
  expiresAt: number;
  used: boolean;
}

export type WebTelegramLinkResult = "linked" | "already_linked" | "conflict" | "invalid";

export interface OutboxRecord {
  id: string;
  idempotencyKey: string;
  accountId: string;
  userId: number;
  provider: ChannelProvider;
  conversationId: string;
  threadId?: string;
  workspaceId?: string;
  /** Provider-specific reply routing data needed when an outbox item is retried. */
  targetMetadata?: Record<string, string>;
  text?: string;
  blocks?: unknown[];
  interactive?: {
    kind: "buttons";
    body: string;
    buttons: Array<{ id: string; title: string }>;
  };
  template?: ChannelTemplate;
  attachments?: InboundMessage["attachments"];
  correlationId?: string;
  kind: "message" | "approval" | "notification" | "receipt";
  status: "queued" | "delivering" | "delivered" | "failed";
  attempts: number;
  leaseToken?: string;
  leaseExpiresAt?: number;
  providerMessageId?: string;
  providerStatus?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  /** SDK webhooks reuse the durable outbox but are not channel messages. */
  webhook?: { webhookId: string; url: string; secretCiphertext: string; payload: unknown };
}

export interface ChannelConversationRecord {
  id: string;
  accountId: string;
  userId: number;
  provider: ChannelProvider;
  scope: "private" | "shared";
  /** Per-group model override. Undefined means use config.groupDefaultModel. */
  model?: string;
  history: Message[];
  summaries: string[];
  /** Turns received before this instant must not be appended after a group reset. */
  historyClearedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelInboundEventRecord {
  eventId: string;
  provider: ChannelProvider;
  message: InboundMessage;
  status: "received" | "queued" | "running" | "completed" | "failed";
  workflowRunId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

interface Backend {
  getSession(userId: number): Promise<UserSession>;
  saveSession(userId: number, s: UserSession): Promise<void>;
  getAgentRun(userId: number, id: string): Promise<AgentRunRecord | undefined>;
  saveAgentRun(record: AgentRunRecord, expectedVersion?: number): Promise<AgentRunRecord>;
  listAgentRuns(userId: number, limit?: number): Promise<AgentRunRecord[]>;
  getHandoffRecord(userId: number, id: string): Promise<HandoffRecord | undefined>;
  saveHandoffRecord(record: HandoffRecord & { userId: number }): Promise<HandoffRecord>;
  listHandoffRecords(userId: number, limit?: number): Promise<HandoffRecord[]>;
  incrRate(userId: number): Promise<number>;
  acquireLock(userId: number, token: string, leaseSeconds: number): Promise<boolean>;
  renewLock(userId: number, token: string, leaseSeconds: number): Promise<boolean>;
  releaseLock(userId: number, token: string): Promise<void>;
  claimTelegramUpdate(updateId: number, ttlSeconds: number): Promise<boolean>;
  hasAgentUpgrade(userId: number, upgradeId: string): Promise<boolean>;
  claimAgentUpgrade(userId: number, upgradeId: string): Promise<boolean>;
  claimDelivery(key: string, leaseMs: number): Promise<boolean>;
  completeDelivery(key: string, ttlSeconds: number): Promise<void>;
  createTriggerEvent(record: TriggerEventRecord): Promise<TriggerEventRecord>;
  getTriggerEvent(eventId: string): Promise<TriggerEventRecord | undefined>;
  updateTriggerEvent(eventId: string, patch: Partial<TriggerEventRecord>): Promise<TriggerEventRecord | undefined>;
  getDaytonaWorkspace(userId: number): Promise<DaytonaWorkspaceRecord | undefined>;
  saveDaytonaWorkspace(userId: number, workspace: DaytonaWorkspaceRecord): Promise<void>;
  clearDaytonaWorkspace(userId: number): Promise<void>;
  getTasks(userId: number): Promise<TaskRecord[]>;
  saveTasks(userId: number, tasks: TaskRecord[]): Promise<void>;
  getReminders(userId: number): Promise<ReminderRecord[]>;
  saveReminders(userId: number, reminders: ReminderRecord[]): Promise<void>;
  getJobs(userId: number): Promise<JobRecord[]>;
  saveJobs(userId: number, jobs: JobRecord[]): Promise<void>;
  getAttentionRecords(userId: number, collection: AttentionCollection): Promise<AttentionRecord[]>;
  mutateAttentionRecords(userId: number, collection: AttentionCollection, mutate: (records: AttentionRecord[]) => AttentionRecord[]): Promise<AttentionRecord[]>;
  claimTask(userId: number, id: string, workerId: string, leaseMs: number): Promise<TaskRecord | undefined>;
  settleTask(userId: number, id: string, leaseToken: string, patch: Partial<TaskRecord>, event: TaskEvent): Promise<TaskRecord | undefined>;
  createCliPairing(record: CliPairingRecord): Promise<void>;
  consumeCliPairing(codeHash: string): Promise<CliPairingRecord | undefined>;
  saveCliDevice(record: CliDeviceRecord): Promise<void>;
  getCliDevice(tokenHash: string): Promise<CliDeviceRecord | undefined>;
  revokeCliDevice(userId: number, tokenHash: string): Promise<boolean>;
  listCliDevices(userId: number): Promise<CliDeviceRecord[]>;
  claimApproval(userId: number, id: string): Promise<ApprovalRecord | undefined>;
  getApproval(userId: number, id: string): Promise<ApprovalRecord | undefined>;
  saveApproval(record: ApprovalRecord): Promise<ApprovalRecord>;
  listApprovals(userId: number, limit?: number): Promise<ApprovalRecord[]>;
  getChannelIdentity(provider: ChannelProvider, externalUserId: string, workspaceId?: string): Promise<ChannelIdentityRecord | undefined>;
  listChannelIdentities(userId: number): Promise<ChannelIdentityRecord[]>;
  saveChannelIdentity(record: ChannelIdentityRecord): Promise<boolean>;
  getChannelInstallation(provider: ChannelInstallationRecord["provider"], workspaceId: string): Promise<ChannelInstallationRecord | undefined>;
  saveChannelInstallation(record: ChannelInstallationRecord): Promise<void>;
  createChannelOAuthState(record: ChannelOAuthStateRecord): Promise<void>;
  consumeChannelOAuthState(stateHash: string): Promise<ChannelOAuthStateRecord | undefined>;
  createChannelLinkCode(record: ChannelLinkCodeRecord): Promise<void>;
  consumeChannelLinkCode(provider: ChannelProvider, codeHash: string): Promise<ChannelLinkCodeRecord | undefined>;
  createSendblueGroupLinkCode(record: SendblueGroupLinkCodeRecord): Promise<void>;
  consumeSendblueGroupLinkCode(codeHash: string): Promise<SendblueGroupLinkCodeRecord | undefined>;
  getSendblueGroupAuthorization(groupId: string, workspaceId: string): Promise<SendblueGroupAuthorizationRecord | undefined>;
  saveSendblueGroupAuthorization(record: SendblueGroupAuthorizationRecord): Promise<void>;
  revokeSendblueGroupAuthorization(groupId: string, workspaceId: string, userId: number): Promise<boolean>;
  createWebTelegramLinkCode(record: WebTelegramLinkCodeRecord): Promise<void>;
  redeemWebTelegramLinkCode(codeHash: string, telegramUserId: number): Promise<WebTelegramLinkResult>;
  getTelegramUserIdForWebAuth(webAuthUserId: string): Promise<number | undefined>;
  claimChannelEvent(provider: ChannelProvider, eventId: string, ttlSeconds: number): Promise<boolean>;
  completeChannelEvent(provider: ChannelProvider, eventId: string, ttlSeconds: number): Promise<void>;
  releaseChannelEvent(provider: ChannelProvider, eventId: string): Promise<void>;
  createChannelInboundEvent(record: ChannelInboundEventRecord): Promise<ChannelInboundEventRecord>;
  getChannelInboundEvent(eventId: string): Promise<ChannelInboundEventRecord | undefined>;
  claimChannelInboundEvent(eventId: string): Promise<boolean>;
  updateChannelInboundEvent(eventId: string, patch: Partial<ChannelInboundEventRecord>): Promise<ChannelInboundEventRecord | undefined>;
  createOutbox(record: OutboxRecord): Promise<OutboxRecord>;
  getOutbox(id: string): Promise<OutboxRecord | undefined>;
  claimOutbox(id: string, leaseMs: number): Promise<OutboxRecord | undefined>;
  updateOutbox(id: string, patch: Partial<OutboxRecord>): Promise<OutboxRecord | undefined>;
  getOutboxByProviderMessageId(provider: ChannelProvider, providerMessageId: string): Promise<OutboxRecord | undefined>;
  listOutbox(statuses?: OutboxRecord["status"][], limit?: number): Promise<OutboxRecord[]>;
  getChannelConversation(id: string): Promise<ChannelConversationRecord | undefined>;
  saveChannelConversation(record: ChannelConversationRecord): Promise<void>;
  setChannelConversationModel(id: string, model: string | undefined): Promise<ChannelConversationRecord | undefined>;
  clearChannelConversationHistory(input: Omit<ChannelConversationRecord, "history" | "summaries" | "createdAt" | "updatedAt" | "historyClearedAt">): Promise<ChannelConversationRecord>;
  enqueueChannelDebounce(key: string, message: InboundMessage, ttlSeconds: number): Promise<void>;
  takeChannelDebounce(key: string): Promise<InboundMessage[]>;
}

// A supervisor run is an audit/status record, not a conversation store.  Worker
// runs may need to resume after a durable Workflow wait, so they keep a longer
// (but still bounded) checkpoint window.
const SUPERVISOR_RUN_TTL_SECONDS = 7 * 24 * 60 * 60;
const WORKER_RUN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AGENT_RUN_MAX_BYTES = 2 * 1024 * 1024;
const RECOVERABLE_OUTBOX_STATUSES = ["queued", "failed", "delivering"] as const;

function isRecoverableOutboxStatus(status: OutboxRecord["status"]): status is typeof RECOVERABLE_OUTBOX_STATUSES[number] {
  return (RECOVERABLE_OUTBOX_STATUSES as readonly string[]).includes(status);
}

function isDataUrl(value: string): boolean {
  return /^data:[^,]+,/i.test(value);
}

function omittedMediaMarker(value: string): string {
  const mime = /^data:([^;,]+)/i.exec(value)?.[1] ?? "binary media";
  // Base64 is approximately four thirds the original byte length. This is
  // intentionally only a diagnostic estimate; raw media never belongs in Redis.
  const payloadLength = value.indexOf(",") >= 0 ? value.length - value.indexOf(",") - 1 : 0;
  const bytes = Math.floor((payloadLength * 3) / 4);
  return `[${mime} (${bytes} bytes) omitted from durable checkpoint; use a saved asset or request re-upload.]`;
}

function compactCheckpointText(value: string, maxLength = 20_000): string {
  // Model/tool payloads occasionally embed a data URL inside JSON or prose.
  // Remove every occurrence, rather than only handling a content part whose
  // whole value is a data URL.
  return value
    .replace(/data:[^,\s]+,[A-Za-z0-9+/_=-]+/gi, (dataUrl) => omittedMediaMarker(dataUrl))
    .slice(0, maxLength);
}

function compactCheckpointValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    if (isDataUrl(value)) return omittedMediaMarker(value);
    return compactCheckpointText(value);
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= 6) return "[nested checkpoint data elided]";
  if (Array.isArray(value)) return value.slice(0, 24).map((entry) => compactCheckpointValue(entry, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, compactCheckpointValue(entry, depth + 1)]));
}

function compactCheckpointContentPart(part: unknown): unknown {
  if (!part || typeof part !== "object") return compactCheckpointValue(part);
  const entry = part as Record<string, unknown>;
  const imageUrl = entry.image_url as Record<string, unknown> | undefined;
  const videoUrl = entry.video_url as Record<string, unknown> | undefined;
  const file = entry.file as Record<string, unknown> | undefined;
  const rawMedia = [imageUrl?.url, videoUrl?.url, file?.file_data].find((value): value is string => typeof value === "string" && isDataUrl(value));
  // OpenRouter expects a real URL for image/video/file parts. A diagnostic text
  // part keeps a resumed worker's context valid instead of replaying a fake URL.
  if (rawMedia) return { type: "text", text: omittedMediaMarker(rawMedia) };
  return compactCheckpointValue(part);
}

function compactWorkerMessages(messages: unknown[]): unknown[] {
  // Keep the system instruction even after trimming old turns; otherwise a
  // resumed worker could lose its capability and safety contract.
  const firstSystem = messages.find((message) => message && typeof message === "object" && (message as Record<string, unknown>).role === "system");
  const recent = messages.slice(-39);
  const selected = firstSystem && !recent.includes(firstSystem) ? [firstSystem, ...recent] : recent;
  return selected.map((message) => {
    if (!message || typeof message !== "object") return compactCheckpointValue(message);
    const item = message as Record<string, unknown>;
    if (!Array.isArray(item.content)) return compactCheckpointValue(item);
    return {
      ...compactCheckpointValue({ ...item, content: undefined }) as Record<string, unknown>,
      content: item.content.slice(0, 24).map((part) => compactCheckpointContentPart(part)),
    };
  });
}

function agentRunTtlSeconds(record: AgentRunRecord): number {
  return record.kind === "worker" ? WORKER_RUN_TTL_SECONDS : SUPERVISOR_RUN_TTL_SECONDS;
}

function boundedAgentRun(record: AgentRunRecord): AgentRunRecord {
  // Only worker checkpoints are used to resume a durable subagent workflow.
  // Supervisor runs always rebuild context from the bounded session/history, so
  // retaining their full OpenRouter message list would duplicate user data.
  const boundedMessages = record.kind === "worker" && Array.isArray(record.state?.messages)
    ? compactWorkerMessages(record.state.messages)
    : undefined;
  const state = record.state
    ? (() => {
        const { messages: _messages, ...rest } = record.state;
        return {
        ...rest,
        ...(boundedMessages ? { messages: boundedMessages } : {}),
        toolResults: record.state.toolResults
          ? Object.fromEntries(Object.entries(record.state.toolResults).slice(-120).map(([key, value]) => [key, compactCheckpointText(String(value))]))
          : undefined,
        output: record.state.output ? compactCheckpointText(record.state.output) : undefined,
        checkpoint: record.state.checkpoint ? compactCheckpointText(record.state.checkpoint, 4_000) : undefined,
        nextAction: record.state.nextAction ? compactCheckpointText(record.state.nextAction, 2_000) : undefined,
        };
      })()
    : undefined;
  const next: AgentRunRecord = { ...record, objective: compactCheckpointText(record.objective), state, events: record.events.slice(-200), updatedAt: Date.now() };
  const encoded = JSON.stringify(next);
  if (encoded.length > AGENT_RUN_MAX_BYTES) throw new Error("Agent run checkpoint exceeds the 2 MB durable state limit; compact the run before continuing.");
  return next;
}

// ── Redis ─────────────────────────────────────────────────────────────────────
class RedisBackend implements Backend {
  constructor(private r: Redis) {}
  /** Avoid a Redis EXISTS call before every idle recovery pass after startup. */
  private pendingOutboxIndexesReady = false;
  private sk = (id: number) => `chuck:session:${id}`;
  private runKey = (id: string) => `chuck:run:${id}`;
  private runIndexKey = (id: number) => `chuck:user:${id}:runs`;
  private handoffKey = (id: string) => `chuck:handoff:${id}`;
  private handoffIndexKey = (id: number) => `chuck:user:${id}:handoffs`;
  private approvalKey = (id: string) => `chuck:approval:${id}`;
  private approvalIndexKey = (id: number) => `chuck:user:${id}:approvals`;
  private rk = (id: number) => `chuck:rate:${id}`;
  private dk = (id: number) => `chuck:daytona:${id}`;
  private taskk = (id: number) => `chuck:tasks:${id}`;
  private reminderk = (id: number) => `chuck:reminders:${id}`;
  private jobk = (id: number) => `chuck:jobs:${id}`;
  private attentionKey = (id: number, collection: AttentionCollection) => `chuck:attention:${collection}:${id}`;
  private pk = (hash: string) => `chuck:cli:pairing:${hash}`;
  private tk = (hash: string) => `chuck:cli:device:${hash}`;
  private uk = (id: number) => `chuck:user:${id}:devices`;
  private telegramUpdateKey = (id: number) => `chuck:telegram:update:${id}`;
  private agentUpgradeKey = (userId: number, upgradeId: string) => `chuck:agent-upgrade:${userId}:${createHash("sha256").update(upgradeId).digest("hex")}`;
  private triggerEventKey = (id: string) => `chuck:trigger:event:${createHash("sha256").update(id).digest("hex")}`;
  private channelIdentityKey = (provider: ChannelProvider, externalUserId: string, workspaceId?: string) => `chuck:channel:identity:${provider}:${createHash("sha256").update(`${workspaceId ?? "-"}:${externalUserId}`).digest("hex")}`;
  private channelIdentityUserKey = (userId: number) => `chuck:user:${userId}:channel-identities`;
  private channelInstallationKey = (provider: ChannelInstallationRecord["provider"], workspaceId: string) => `chuck:channel:installation:${provider}:${workspaceId}`;
  private channelOAuthKey = (stateHash: string) => `chuck:channel:oauth:${stateHash}`;
  private channelLinkKey = (provider: ChannelProvider, codeHash: string) => `chuck:channel:link:${provider}:${codeHash}`;
  private sendblueGroupLinkKey = (codeHash: string) => `chuck:sendblue:group-link:${codeHash}`;
  private sendblueGroupKey = (groupId: string, workspaceId: string) => `chuck:sendblue:group:${createHash("sha256").update(`${workspaceId}:${groupId}`).digest("hex")}`;
  private webTelegramLinkKey = (codeHash: string) => `chuck:web-telegram:code:${codeHash}`;
  private webTelegramUserKey = (webAuthUserId: string) => `chuck:web-telegram:web:${createHash("sha1").update(webAuthUserId).digest("hex")}`;
  private telegramWebUserKey = (telegramUserId: number) => `chuck:web-telegram:telegram:${telegramUserId}`;
  private channelEventKey = (provider: ChannelProvider, eventId: string) => `chuck:channel:event:${provider}:${createHash("sha256").update(eventId).digest("hex")}`;
  private channelEventDoneKey = (provider: ChannelProvider, eventId: string) => `chuck:channel:event:done:${provider}:${createHash("sha256").update(eventId).digest("hex")}`;
  private channelInboundEventKey = (eventId: string) => `chuck:channel:inbound:${createHash("sha256").update(eventId).digest("hex")}`;
  private outboxKey = (id: string) => `chuck:outbox:${id}`;
  private outboxIdempotencyKey = (key: string) => `chuck:outbox:idempotency:${createHash("sha256").update(key).digest("hex")}`;
  private outboxProviderKey = (provider: ChannelProvider, providerMessageId: string) => `chuck:outbox:provider:${provider}:${createHash("sha256").update(providerMessageId).digest("hex")}`;
  /** Status-specific indexes keep idle recovery from scanning delivered audit records. */
  private outboxPendingIndexKey = (status: typeof RECOVERABLE_OUTBOX_STATUSES[number]) => `chuck:outbox:pending:${status}`;
  private outboxPendingIndexReadyKey = "chuck:outbox:pending:index-v1";
  private outboxPendingIndexMigrationLockKey = "chuck:outbox:pending:index-v1:lock";
  private channelConversationKey = (id: string) => `chuck:channel:conversation:${createHash("sha256").update(id).digest("hex")}`;
  private channelDebounceKey = (id: string) => `chuck:channel:debounce:${createHash("sha256").update(id).digest("hex")}`;

  async getSession(userId: number): Promise<UserSession> {
    const raw = await this.r.get(this.sk(userId));
    if (raw) {
      try { const session = JSON.parse(raw) as UserSession; session.approvals = await this.listApprovals(userId, 20); return session; } catch { /* fallthrough */ }
    }
    const session = fresh(); session.approvals = await this.listApprovals(userId, 20); return session;
  }

  async saveSession(userId: number, s: UserSession): Promise<void> {
    // User 0 is the SDK control plane (projects, hashes, and admin audit), not a conversation.
    // It must survive the normal chat-session TTL just like durable tasks and CLI devices.
    if (userId === 0) { await this.r.set(this.sk(userId), JSON.stringify(s)); return; }
    // Approval records live in their own short-lived keyspace. Keep an empty
    // legacy field for old readers without copying approval payloads into the
    // hot session blob on every unrelated write.
    await this.r.setex(this.sk(userId), config.sessionTtl, JSON.stringify({ ...s, approvals: [] }));
  }
  async getApproval(userId: number, id: string): Promise<ApprovalRecord | undefined> {
    const raw = await this.r.get(this.approvalKey(id));
    if (!raw) return undefined;
    try { const approval = JSON.parse(raw) as ApprovalRecord; return approval.userId === userId ? approval : undefined; } catch { return undefined; }
  }
  async saveApproval(record: ApprovalRecord): Promise<ApprovalRecord> {
    await this.r.setex(this.approvalKey(record.id), Math.max(60, Math.ceil((record.expiresAt - Date.now()) / 1000)), JSON.stringify(record));
    await this.r.zadd(this.approvalIndexKey(record.userId), record.createdAt, record.id);
    await this.r.expire(this.approvalIndexKey(record.userId), 24 * 60 * 60);
    return record;
  }
  async listApprovals(userId: number, limit = 50): Promise<ApprovalRecord[]> {
    const ids = await this.r.zrevrange(this.approvalIndexKey(userId), 0, Math.max(0, limit - 1));
    const records = await Promise.all(ids.map((id) => this.getApproval(userId, id)));
    return records.filter((record): record is ApprovalRecord => Boolean(record));
  }
  async getAgentRun(userId: number, id: string): Promise<AgentRunRecord | undefined> {
    const raw = await this.r.get(this.runKey(id));
    if (!raw) return undefined;
    try {
      const record = JSON.parse(raw) as AgentRunRecord;
      return record.userId === userId ? record : undefined;
    } catch { return undefined; }
  }
  async saveAgentRun(input: AgentRunRecord, expectedVersion?: number): Promise<AgentRunRecord> {
    const record = boundedAgentRun({ ...input, version: expectedVersion === undefined ? input.version : expectedVersion + 1 });
    const key = this.runKey(record.id);
    const ttlSeconds = agentRunTtlSeconds(record);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.r.watch(key);
      const currentRaw = await this.r.get(key);
      const current = currentRaw ? JSON.parse(currentRaw) as AgentRunRecord : undefined;
      if (expectedVersion !== undefined && (!current || current.userId !== record.userId || current.version !== expectedVersion)) {
        await this.r.unwatch();
        throw new Error("Agent run changed concurrently; reload its checkpoint and retry.");
      }
      const next = current && expectedVersion === undefined ? { ...record, version: current.version + 1 } : record;
      const result = await this.r.multi()
        .set(key, JSON.stringify(next), "EX", ttlSeconds)
        .zadd(this.runIndexKey(next.userId), next.updatedAt, next.id)
        .expire(this.runIndexKey(next.userId), ttlSeconds)
        .exec();
      if (result) return next;
    }
    throw new Error("Could not persist agent run checkpoint after concurrent updates.");
  }
  async listAgentRuns(userId: number, limit = 50): Promise<AgentRunRecord[]> {
    const ids = await this.r.zrevrange(this.runIndexKey(userId), 0, Math.max(0, limit - 1));
    const records = await Promise.all(ids.map((id) => this.getAgentRun(userId, id)));
    return records.filter((record): record is AgentRunRecord => Boolean(record));
  }
  async getHandoffRecord(userId: number, id: string): Promise<HandoffRecord | undefined> {
    const raw = await this.r.get(this.handoffKey(id));
    if (!raw) return undefined;
    try {
      const record = JSON.parse(raw) as HandoffRecord & { userId?: number };
      return (record.userId === undefined || record.userId === userId) ? record : undefined;
    } catch { return undefined; }
  }
  async saveHandoffRecord(input: HandoffRecord & { userId: number }): Promise<HandoffRecord> {
    const record = { ...input, context: input.context ?? {} };
    await this.r.multi()
      .set(this.handoffKey(record.id), JSON.stringify(record), "EX", WORKER_RUN_TTL_SECONDS)
      .zadd(this.handoffIndexKey(record.userId), record.timestamp, record.id)
      .expire(this.handoffIndexKey(record.userId), WORKER_RUN_TTL_SECONDS)
      .exec();
    return record;
  }
  async listHandoffRecords(userId: number, limit = 100): Promise<HandoffRecord[]> {
    const ids = await this.r.zrevrange(this.handoffIndexKey(userId), 0, Math.max(0, limit - 1));
    const records = await Promise.all(ids.map((id) => this.getHandoffRecord(userId, id)));
    return records.filter((record): record is HandoffRecord => Boolean(record));
  }

  async createTriggerEvent(record: TriggerEventRecord): Promise<TriggerEventRecord> {
    const key = this.triggerEventKey(record.eventId);
    await this.r.set(key, JSON.stringify(record), "EX", 30 * 24 * 60 * 60, "NX");
    return (await this.getTriggerEvent(record.eventId)) ?? record;
  }
  async getTriggerEvent(eventId: string): Promise<TriggerEventRecord | undefined> {
    const raw = await this.r.get(this.triggerEventKey(eventId));
    if (!raw) return undefined;
    try { return JSON.parse(raw) as TriggerEventRecord; } catch { return undefined; }
  }
  async updateTriggerEvent(eventId: string, patch: Partial<TriggerEventRecord>): Promise<TriggerEventRecord | undefined> {
    const current = await this.getTriggerEvent(eventId);
    if (!current) return undefined;
    const next = { ...current, ...patch, eventId: current.eventId, updatedAt: Date.now() };
    await this.r.set(this.triggerEventKey(eventId), JSON.stringify(next), "EX", 30 * 24 * 60 * 60);
    return next;
  }

  async incrRate(userId: number): Promise<number> {
    const k = this.rk(userId);
    const n = await this.r.incr(k);
    if (n === 1) await this.r.expire(k, config.rateWindowSeconds);
    return n;
  }

  async acquireLock(userId: number, token: string, leaseSeconds: number): Promise<boolean> {
    return (await this.r.set(`chuck:lock:${userId}`, token, "EX", leaseSeconds, "NX")) === "OK";
  }
  async renewLock(userId: number, token: string, leaseSeconds: number): Promise<boolean> {
    const result = await this.r.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('expire',KEYS[1],ARGV[2]) else return 0 end", 1, `chuck:lock:${userId}`, token, leaseSeconds);
    return Number(result) === 1;
  }
  async releaseLock(userId: number, token: string): Promise<void> {
    await this.r.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, `chuck:lock:${userId}`, token);
  }
  async claimTelegramUpdate(updateId: number, ttlSeconds: number): Promise<boolean> {
    return (await this.r.set(this.telegramUpdateKey(updateId), "1", "EX", ttlSeconds, "NX")) === "OK";
  }
  async hasAgentUpgrade(userId: number, upgradeId: string): Promise<boolean> {
    return (await this.r.exists(this.agentUpgradeKey(userId, upgradeId))) === 1;
  }
  async claimAgentUpgrade(userId: number, upgradeId: string): Promise<boolean> {
    return (await this.r.set(this.agentUpgradeKey(userId, upgradeId), "1", "EX", 365 * 24 * 60 * 60, "NX")) === "OK";
  }
  async claimDelivery(key: string, leaseMs: number): Promise<boolean> {
    const digest = createHash("sha256").update(key).digest("hex");
    if (await this.r.exists(`chuck:delivery:done:${digest}`)) return false;
    return (await this.r.set(`chuck:delivery:claim:${digest}`, "1", "PX", leaseMs, "NX")) === "OK";
  }
  async completeDelivery(key: string, ttlSeconds: number): Promise<void> {
    const digest = createHash("sha256").update(key).digest("hex");
    await this.r.multi().set(`chuck:delivery:done:${digest}`, "1", "EX", ttlSeconds).del(`chuck:delivery:claim:${digest}`).exec();
  }
  async getDaytonaWorkspace(userId: number): Promise<DaytonaWorkspaceRecord | undefined> {
    const raw = await this.r.get(this.dk(userId));
    if (!raw) return undefined;
    try { return JSON.parse(raw) as DaytonaWorkspaceRecord; } catch { return undefined; }
  }
  async saveDaytonaWorkspace(userId: number, workspace: DaytonaWorkspaceRecord): Promise<void> {
    await this.r.set(this.dk(userId), JSON.stringify(workspace));
  }
  async clearDaytonaWorkspace(userId: number): Promise<void> {
    await this.r.del(this.dk(userId));
  }
  async getTasks(userId: number): Promise<TaskRecord[]> {
    const raw = await this.r.get(this.taskk(userId));
    if (!raw) return [];
    try { return JSON.parse(raw) as TaskRecord[]; } catch { return []; }
  }
  async saveTasks(userId: number, tasks: TaskRecord[]): Promise<void> {
    // Intentionally no expiry: task recovery must outlive conversational context.
    await this.r.set(this.taskk(userId), JSON.stringify(tasks));
  }
  async getReminders(userId: number): Promise<ReminderRecord[]> {
    const raw = await this.r.get(this.reminderk(userId));
    if (raw) {
      try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    }
    // Lazy migration keeps existing reminders created before dedicated keys
    // were introduced, without extending the session key's expiry.
    const legacy = (await this.getSession(userId)).reminders ?? [];
    if (legacy.length) await this.saveReminders(userId, legacy);
    return legacy;
  }
  async saveReminders(userId: number, reminders: ReminderRecord[]): Promise<void> {
    // Scheduling state must outlive the conversational session TTL.
    await this.r.set(this.reminderk(userId), JSON.stringify(reminders.slice(-100)));
  }
  async getJobs(userId: number): Promise<JobRecord[]> {
    const raw = await this.r.get(this.jobk(userId));
    if (raw) {
      try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    }
    const legacy = (await this.getSession(userId)).jobs ?? [];
    if (legacy.length) await this.saveJobs(userId, legacy);
    return legacy;
  }
  async saveJobs(userId: number, jobs: JobRecord[]): Promise<void> {
    // Scheduling state must outlive the conversational session TTL.
    await this.r.set(this.jobk(userId), JSON.stringify(jobs.slice(-100)));
  }
  async getAttentionRecords(userId: number, collection: AttentionCollection): Promise<AttentionRecord[]> {
    const raw = await this.r.get(this.attentionKey(userId, collection));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((record) => record && typeof record === "object" && (record as Record<string, unknown>).userId === userId) as AttentionRecord[] : [];
    } catch { return []; }
  }
  async mutateAttentionRecords(userId: number, collection: AttentionCollection, mutate: (records: AttentionRecord[]) => AttentionRecord[]): Promise<AttentionRecord[]> {
    const key = this.attentionKey(userId, collection);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.r.watch(key);
      const raw = await this.r.get(key);
      let records: AttentionRecord[] = [];
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        records = Array.isArray(parsed) ? parsed.filter((record) => record && typeof record === "object" && (record as Record<string, unknown>).userId === userId) as AttentionRecord[] : [];
      } catch { records = []; }
      const next = mutate(records);
      const result = await this.r.multi().set(key, JSON.stringify(next)).exec();
      if (result) return next;
    }
    throw new Error("Attention state changed concurrently; please retry");
  }
  async claimTask(userId: number, id: string, workerId: string, leaseMs: number): Promise<TaskRecord | undefined> {
    const key = this.taskk(userId);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.r.watch(key);
      const raw = await this.r.get(key);
      const tasks = raw ? JSON.parse(raw) as TaskRecord[] : [];
      const index = tasks.findIndex((task) => task.id === id);
      const task = index < 0 ? undefined : normalizeTask(tasks[index]);
      const now = Date.now();
      if (!task || task.status !== "queued" || (task.runAt && task.runAt > now) || (task.lease && task.lease.expiresAt > now)) { await this.r.unwatch(); return undefined; }
      const lease: TaskLease = { token: randomUUID(), workerId, acquiredAt: now, expiresAt: now + leaseMs };
      const next = normalizeTask({ ...task, status: "running", lease, attempt: task.attempt + 1, updatedAt: now, events: [...task.events, taskEvent("claimed", `Claimed by ${workerId}`, task.attempt + 1, now)].slice(-100) });
      tasks[index] = next;
      const result = await this.r.multi().set(key, JSON.stringify(tasks)).exec();
      if (result) return next;
    }
    return undefined;
  }
  async settleTask(userId: number, id: string, leaseToken: string, patch: Partial<TaskRecord>, event: TaskEvent): Promise<TaskRecord | undefined> {
    const key = this.taskk(userId);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.r.watch(key);
      const raw = await this.r.get(key);
      const tasks = raw ? JSON.parse(raw) as TaskRecord[] : [];
      const index = tasks.findIndex((task) => task.id === id);
      const task = index < 0 ? undefined : normalizeTask(tasks[index]);
      if (!task || task.lease?.token !== leaseToken) { await this.r.unwatch(); return undefined; }
      const next = normalizeTask({ ...task, ...patch, id: task.id, userId: task.userId, createdAt: task.createdAt, lease: undefined, updatedAt: Date.now(), events: [...task.events, event].slice(-100) });
      tasks[index] = next;
      const result = await this.r.multi().set(key, JSON.stringify(tasks)).exec();
      if (result) return next;
    }
    return undefined;
  }
  async createCliPairing(record: CliPairingRecord): Promise<void> {
    const ttl = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
    await this.r.set(this.pk(record.codeHash), JSON.stringify(record), "EX", ttl, "NX");
  }
  async consumeCliPairing(codeHash: string): Promise<CliPairingRecord | undefined> {
    const key = this.pk(codeHash);
    const raw = await this.r.get(key);
    if (!raw) return undefined;
    const record = JSON.parse(raw) as CliPairingRecord;
    if (record.used || record.expiresAt <= Date.now()) { await this.r.del(key); return undefined; }
    const claimed = await this.r.eval("local v=redis.call('get',KEYS[1]); if not v then return nil end; local r=cjson.decode(v); if r.used or r.expiresAt <= tonumber(ARGV[1]) then redis.call('del',KEYS[1]); return nil end; r.used=true; redis.call('del',KEYS[1]); return cjson.encode(r)", 1, key, Date.now()) as string | null;
    return claimed ? JSON.parse(claimed) as CliPairingRecord : undefined;
  }
  async saveCliDevice(record: CliDeviceRecord): Promise<void> {
    await this.r.set(this.tk(record.tokenHash), JSON.stringify(record));
    await this.r.sadd(this.uk(record.userId), record.tokenHash);
  }
  async getCliDevice(tokenHash: string): Promise<CliDeviceRecord | undefined> {
    const raw = await this.r.get(this.tk(tokenHash));
    if (!raw) return undefined;
    try { return JSON.parse(raw) as CliDeviceRecord; } catch { return undefined; }
  }
  async revokeCliDevice(userId: number, tokenHash: string): Promise<boolean> {
    const key = this.tk(tokenHash);
    const raw = await this.r.get(key);
    if (!raw) return false;
    const record = JSON.parse(raw) as CliDeviceRecord;
    if (record.userId !== userId) return false;
    record.revokedAt = Date.now();
    await this.r.set(key, JSON.stringify(record));
    return true;
  }
  async listCliDevices(userId: number): Promise<CliDeviceRecord[]> {
    const hashes = await this.r.smembers(this.uk(userId));
    const records = await Promise.all(hashes.map((hash) => this.getCliDevice(hash)));
    return records.filter((r): r is CliDeviceRecord => Boolean(r));
  }
  async claimApproval(userId: number, id: string): Promise<ApprovalRecord | undefined> {
    const key = this.approvalKey(id);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.r.watch(key);
      const raw = await this.r.get(key);
      if (!raw) { await this.r.unwatch(); return undefined; }
      const approval = JSON.parse(raw) as ApprovalRecord;
      if (approval.userId !== userId || approval.status !== "pending" || approval.expiresAt <= Date.now()) { await this.r.unwatch(); return undefined; }
      const next = { ...approval, status: "approved" as const };
      const result = await this.r.multi().setex(key, Math.max(60, Math.ceil((next.expiresAt - Date.now()) / 1000)), JSON.stringify(next)).exec();
      if (result) return next;
    }
    return undefined;
  }

  async getChannelIdentity(provider: ChannelProvider, externalUserId: string, workspaceId?: string): Promise<ChannelIdentityRecord | undefined> {
    const raw = await this.r.get(this.channelIdentityKey(provider, externalUserId, workspaceId));
    if (!raw) return undefined;
    try {
      const record = JSON.parse(raw) as ChannelIdentityRecord;
      return record.disabledAt ? undefined : record;
    } catch { return undefined; }
  }
  async listChannelIdentities(userId: number): Promise<ChannelIdentityRecord[]> {
    const keys = await this.r.smembers(this.channelIdentityUserKey(userId));
    const records = await Promise.all(keys.map(async (key) => {
      const raw = await this.r.get(key);
      if (!raw) return undefined;
      try { return JSON.parse(raw) as ChannelIdentityRecord; } catch { return undefined; }
    }));
    return records.filter((record): record is ChannelIdentityRecord => Boolean(record && !record.disabledAt));
  }
  async saveChannelIdentity(record: ChannelIdentityRecord): Promise<boolean> {
    const key = this.channelIdentityKey(record.provider, record.externalUserId, record.workspaceId);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.r.watch(key);
      const existingRaw = await this.r.get(key);
      if (existingRaw) {
        try {
          const existing = JSON.parse(existingRaw) as ChannelIdentityRecord;
          if (existing.userId !== record.userId || existing.accountId !== record.accountId) { await this.r.unwatch(); return false; }
        } catch { /* replace corrupt record */ }
      }
      const result = await this.r.multi().set(key, JSON.stringify(record)).sadd(this.channelIdentityUserKey(record.userId), key).exec();
      if (result) return true;
    }
    return false;
  }
  async getChannelInstallation(provider: ChannelInstallationRecord["provider"], workspaceId: string): Promise<ChannelInstallationRecord | undefined> {
    const raw = await this.r.get(this.channelInstallationKey(provider, workspaceId));
    if (!raw) return undefined;
    try { return JSON.parse(raw) as ChannelInstallationRecord; } catch { return undefined; }
  }
  async saveChannelInstallation(record: ChannelInstallationRecord): Promise<void> {
    await this.r.set(this.channelInstallationKey(record.provider, record.workspaceId), JSON.stringify(record));
  }
  async createChannelOAuthState(record: ChannelOAuthStateRecord): Promise<void> {
    const ttl = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
    await this.r.set(this.channelOAuthKey(record.stateHash), JSON.stringify(record), "EX", ttl, "NX");
  }
  async consumeChannelOAuthState(stateHash: string): Promise<ChannelOAuthStateRecord | undefined> {
    const key = this.channelOAuthKey(stateHash);
    const raw = await this.r.get(key);
    if (!raw) return undefined;
    const record = JSON.parse(raw) as ChannelOAuthStateRecord;
    if (record.used || record.expiresAt <= Date.now()) { await this.r.del(key); return undefined; }
    const claimed = await this.r.eval("local v=redis.call('get',KEYS[1]); if not v then return nil end; local r=cjson.decode(v); if r.used or r.expiresAt <= tonumber(ARGV[1]) then redis.call('del',KEYS[1]); return nil end; r.used=true; redis.call('del',KEYS[1]); return cjson.encode(r)", 1, key, Date.now()) as string | null;
    return claimed ? JSON.parse(claimed) as ChannelOAuthStateRecord : undefined;
  }
  async createChannelLinkCode(record: ChannelLinkCodeRecord): Promise<void> {
    const ttl = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
    await this.r.set(this.channelLinkKey(record.provider, record.codeHash), JSON.stringify(record), "EX", ttl, "NX");
  }
  async consumeChannelLinkCode(provider: ChannelProvider, codeHash: string): Promise<ChannelLinkCodeRecord | undefined> {
    const key = this.channelLinkKey(provider, codeHash);
    const raw = await this.r.get(key);
    if (!raw) return undefined;
    const record = JSON.parse(raw) as ChannelLinkCodeRecord;
    if (record.used || record.expiresAt <= Date.now()) { await this.r.del(key); return undefined; }
    const claimed = await this.r.eval("local v=redis.call('get',KEYS[1]); if not v then return nil end; local r=cjson.decode(v); if r.used or r.expiresAt <= tonumber(ARGV[1]) then redis.call('del',KEYS[1]); return nil end; r.used=true; redis.call('del',KEYS[1]); return cjson.encode(r)", 1, key, Date.now()) as string | null;
    return claimed ? JSON.parse(claimed) as ChannelLinkCodeRecord : undefined;
  }
  async createSendblueGroupLinkCode(record: SendblueGroupLinkCodeRecord): Promise<void> {
    const ttl = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
    await this.r.set(this.sendblueGroupLinkKey(record.codeHash), JSON.stringify(record), "EX", ttl, "NX");
  }
  async consumeSendblueGroupLinkCode(codeHash: string): Promise<SendblueGroupLinkCodeRecord | undefined> {
    const key = this.sendblueGroupLinkKey(codeHash);
    const raw = await this.r.get(key);
    if (!raw) return undefined;
    const record = JSON.parse(raw) as SendblueGroupLinkCodeRecord;
    if (record.used || record.expiresAt <= Date.now()) { await this.r.del(key); return undefined; }
    const claimed = await this.r.eval("local v=redis.call('get',KEYS[1]); if not v then return nil end; local r=cjson.decode(v); if r.used or r.expiresAt <= tonumber(ARGV[1]) then redis.call('del',KEYS[1]); return nil end; r.used=true; redis.call('del',KEYS[1]); return cjson.encode(r)", 1, key, Date.now()) as string | null;
    return claimed ? JSON.parse(claimed) as SendblueGroupLinkCodeRecord : undefined;
  }
  async getSendblueGroupAuthorization(groupId: string, workspaceId: string): Promise<SendblueGroupAuthorizationRecord | undefined> {
    const raw = await this.r.get(this.sendblueGroupKey(groupId, workspaceId));
    if (!raw) return undefined;
    try { const record = JSON.parse(raw) as SendblueGroupAuthorizationRecord; return record.disabledAt ? undefined : record; } catch { return undefined; }
  }
  async saveSendblueGroupAuthorization(record: SendblueGroupAuthorizationRecord): Promise<void> {
    await this.r.set(this.sendblueGroupKey(record.groupId, record.workspaceId), JSON.stringify(record));
  }
  async revokeSendblueGroupAuthorization(groupId: string, workspaceId: string, userId: number): Promise<boolean> {
    const record = await this.getSendblueGroupAuthorization(groupId, workspaceId);
    if (!record || record.userId !== userId) return false;
    record.disabledAt = Date.now();
    record.updatedAt = Date.now();
    await this.saveSendblueGroupAuthorization(record);
    return true;
  }
  async createWebTelegramLinkCode(record: WebTelegramLinkCodeRecord): Promise<void> {
    const ttl = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
    await this.r.set(this.webTelegramLinkKey(record.codeHash), JSON.stringify(record), "EX", ttl, "NX");
  }
  async redeemWebTelegramLinkCode(codeHash: string, telegramUserId: number): Promise<WebTelegramLinkResult> {
    const codeKey = this.webTelegramLinkKey(codeHash);
    const result = await this.r.eval(
      "local raw=redis.call('get',KEYS[1]); if not raw then return 'invalid' end; local record=cjson.decode(raw); if record.used or record.expiresAt <= tonumber(ARGV[1]) then redis.call('del',KEYS[1]); return 'invalid' end; redis.call('del',KEYS[1]); local webKey='chuck:web-telegram:web:' .. redis.sha1hex(record.webAuthUserId); local currentTelegram=redis.call('get',webKey); local currentWeb=redis.call('get',KEYS[2]); if (currentTelegram and currentTelegram ~= ARGV[2]) or (currentWeb and currentWeb ~= record.webAuthUserId) then return 'conflict' end; if currentTelegram and currentWeb then return 'already_linked' end; redis.call('set',webKey,ARGV[2]); redis.call('set',KEYS[2],record.webAuthUserId); return 'linked'",
      2,
      codeKey,
      this.telegramWebUserKey(telegramUserId),
      Date.now(),
      String(telegramUserId),
    ) as WebTelegramLinkResult;
    return result;
  }
  async getTelegramUserIdForWebAuth(webAuthUserId: string): Promise<number | undefined> {
    const raw = await this.r.get(this.webTelegramUserKey(webAuthUserId));
    const userId = Number(raw);
    return Number.isSafeInteger(userId) && userId > 0 ? userId : undefined;
  }
  async claimChannelEvent(provider: ChannelProvider, eventId: string, ttlSeconds: number): Promise<boolean> {
    if (await this.r.exists(this.channelEventDoneKey(provider, eventId))) return false;
    return (await this.r.set(this.channelEventKey(provider, eventId), "1", "EX", Math.max(30, Math.min(15 * 60, ttlSeconds)), "NX")) === "OK";
  }
  async completeChannelEvent(provider: ChannelProvider, eventId: string, ttlSeconds: number): Promise<void> {
    await this.r.multi().set(this.channelEventDoneKey(provider, eventId), "1", "EX", ttlSeconds).del(this.channelEventKey(provider, eventId)).exec();
  }
  async releaseChannelEvent(provider: ChannelProvider, eventId: string): Promise<void> {
    await this.r.del(this.channelEventKey(provider, eventId));
  }
  async createChannelInboundEvent(record: ChannelInboundEventRecord): Promise<ChannelInboundEventRecord> {
    const existing = await this.getChannelInboundEvent(record.eventId);
    if (existing) return existing;
    await this.r.set(this.channelInboundEventKey(record.eventId), JSON.stringify(record), "EX", 24 * 60 * 60, "NX");
    return (await this.getChannelInboundEvent(record.eventId)) ?? record;
  }
  async getChannelInboundEvent(eventId: string): Promise<ChannelInboundEventRecord | undefined> {
    const raw = await this.r.get(this.channelInboundEventKey(eventId));
    return raw ? JSON.parse(raw) as ChannelInboundEventRecord : undefined;
  }
  async claimChannelInboundEvent(eventId: string): Promise<boolean> {
    const key = this.channelInboundEventKey(eventId);
    const claimed = await this.r.eval("local v=redis.call('get',KEYS[1]); if not v then return 0 end; local r=cjson.decode(v); if r.status ~= 'received' then return 0 end; r.status='queued'; r.updatedAt=tonumber(ARGV[1]); redis.call('set',KEYS[1],cjson.encode(r),'EX',86400); return 1", 1, key, Date.now());
    return Number(claimed) === 1;
  }
  async updateChannelInboundEvent(eventId: string, patch: Partial<ChannelInboundEventRecord>): Promise<ChannelInboundEventRecord | undefined> {
    const current = await this.getChannelInboundEvent(eventId);
    if (!current) return undefined;
    const next = { ...current, ...patch, eventId: current.eventId, updatedAt: Date.now() };
    await this.r.set(this.channelInboundEventKey(eventId), JSON.stringify(next), "EX", 24 * 60 * 60);
    return next;
  }
  async createOutbox(record: OutboxRecord): Promise<OutboxRecord> {
    const idempotencyKey = this.outboxIdempotencyKey(record.idempotencyKey);
    const existingId = await this.r.get(idempotencyKey);
    if (existingId) {
      const existing = await this.getOutbox(existingId);
      if (existing) return existing;
      await this.r.del(idempotencyKey);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.r.watch(idempotencyKey);
      const existingIdNow = await this.r.get(idempotencyKey);
      if (existingIdNow) {
        await this.r.unwatch();
        const existing = await this.getOutbox(existingIdNow);
        if (existing) return existing;
        continue;
      }
      const result = await this.r.multi()
        .set(this.outboxKey(record.id), JSON.stringify(record), "EX", 30 * 24 * 60 * 60)
        .set(idempotencyKey, record.id, "EX", 30 * 24 * 60 * 60)
        .zadd(this.outboxPendingIndexKey("queued"), record.createdAt, record.id)
        .exec();
      if (result) return record;
    }
    throw new Error("Could not reserve outbound delivery idempotency key");
  }
  async getOutbox(id: string): Promise<OutboxRecord | undefined> {
    const raw = await this.r.get(this.outboxKey(id));
    if (!raw) return undefined;
    try { return JSON.parse(raw) as OutboxRecord; } catch { return undefined; }
  }
  async claimOutbox(id: string, leaseMs: number): Promise<OutboxRecord | undefined> {
    const key = this.outboxKey(id);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.r.watch(key);
      const raw = await this.r.get(key);
      if (!raw) { await this.r.unwatch(); return undefined; }
      const record = JSON.parse(raw) as OutboxRecord;
      const now = Date.now();
      if (record.status === "delivered" || (record.status === "delivering" && (record.leaseExpiresAt ?? 0) > now)) { await this.r.unwatch(); return undefined; }
      const next = { ...record, status: "delivering" as const, attempts: record.attempts + 1, leaseToken: randomUUID(), leaseExpiresAt: now + leaseMs, updatedAt: now };
      const result = await this.r.multi()
        .set(key, JSON.stringify(next), "EX", 30 * 24 * 60 * 60)
        .zrem(this.outboxPendingIndexKey(record.status as typeof RECOVERABLE_OUTBOX_STATUSES[number]), id)
        .zadd(this.outboxPendingIndexKey("delivering"), next.createdAt, id)
        .exec();
      if (result) return next;
    }
    return undefined;
  }
  async updateOutbox(id: string, patch: Partial<OutboxRecord>): Promise<OutboxRecord | undefined> {
    const current = await this.getOutbox(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id: current.id, idempotencyKey: current.idempotencyKey, updatedAt: Date.now() };
    const transaction = this.r.multi().set(this.outboxKey(id), JSON.stringify(next), "EX", 30 * 24 * 60 * 60);
    for (const status of RECOVERABLE_OUTBOX_STATUSES) transaction.zrem(this.outboxPendingIndexKey(status), id);
    if (isRecoverableOutboxStatus(next.status)) transaction.zadd(this.outboxPendingIndexKey(next.status), next.createdAt, id);
    if (next.providerMessageId) transaction.set(this.outboxProviderKey(next.provider, next.providerMessageId), id, "EX", 30 * 24 * 60 * 60);
    await transaction.exec();
    return next;
  }
  async getOutboxByProviderMessageId(provider: ChannelProvider, providerMessageId: string) {
    const id = await this.r.get(this.outboxProviderKey(provider, providerMessageId));
    return id ? this.getOutbox(id) : undefined;
  }
  /**
   * Add retryable legacy records to the new status indexes once. This is the
   * only compatibility scan; every new or updated record maintains its index
   * atomically, so idle recovery never reads delivered records again.
   */
  private async ensurePendingOutboxIndexes(): Promise<void> {
    if (this.pendingOutboxIndexesReady) return;
    if (await this.r.exists(this.outboxPendingIndexReadyKey)) {
      this.pendingOutboxIndexesReady = true;
      return;
    }
    const locked = await this.r.set(this.outboxPendingIndexMigrationLockKey, "1", "EX", 120, "NX");
    if (locked !== "OK") return;
    try {
      let cursor = "0";
      do {
        const [next, keys] = await this.r.scan(cursor, "MATCH", "chuck:outbox:out_*", "COUNT", 200);
        cursor = next;
        if (!keys.length) continue;
        const values = await this.r.mget(...keys);
        const byStatus = new Map<typeof RECOVERABLE_OUTBOX_STATUSES[number], Array<[number, string]>>();
        for (const [index, raw] of values.entries()) {
          if (!raw) continue;
          try {
            const record = JSON.parse(raw) as OutboxRecord;
            if (!isRecoverableOutboxStatus(record.status)) continue;
            const entries = byStatus.get(record.status) ?? [];
            entries.push([record.createdAt, record.id]);
            byStatus.set(record.status, entries);
          } catch { /* corrupt legacy records cannot be recovered safely */ }
        }
        for (const [status, entries] of byStatus) {
          const members = entries.flatMap(([score, id]) => [score, id]);
          if (members.length) await this.r.zadd(this.outboxPendingIndexKey(status), ...members);
        }
      } while (cursor !== "0");
      await this.r.set(this.outboxPendingIndexReadyKey, "1");
      this.pendingOutboxIndexesReady = true;
    } finally {
      await this.r.del(this.outboxPendingIndexMigrationLockKey);
    }
  }

  private async listRecoverableOutbox(statuses: typeof RECOVERABLE_OUTBOX_STATUSES[number][], limit: number): Promise<OutboxRecord[]> {
    await this.ensurePendingOutboxIndexes();
    const idGroups = await Promise.all(statuses.map((status) => this.r.zrange(this.outboxPendingIndexKey(status), 0, limit - 1)));
    const ids = [...new Set(idGroups.flat())];
    if (!ids.length) return [];
    const values = await this.r.mget(...ids.map((id) => this.outboxKey(id)));
    const records: OutboxRecord[] = [];
    const staleIds: string[] = [];
    for (const [index, raw] of values.entries()) {
      if (!raw) { staleIds.push(ids[index]); continue; }
      try {
        const record = JSON.parse(raw) as OutboxRecord;
        if (statuses.includes(record.status as typeof RECOVERABLE_OUTBOX_STATUSES[number])) records.push(record);
        else staleIds.push(record.id);
      } catch { staleIds.push(ids[index]); }
    }
    if (staleIds.length) {
      const cleanup = this.r.multi();
      for (const status of RECOVERABLE_OUTBOX_STATUSES) cleanup.zrem(this.outboxPendingIndexKey(status), ...staleIds);
      await cleanup.exec();
    }
    return records.sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
  }

  async listOutbox(statuses?: OutboxRecord["status"][], limit = 100): Promise<OutboxRecord[]> {
    if (statuses?.length && statuses.every(isRecoverableOutboxStatus)) {
      return this.listRecoverableOutbox([...new Set(statuses)], limit);
    }
    const records: OutboxRecord[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await this.r.scan(cursor, "MATCH", "chuck:outbox:out_*", "COUNT", Math.min(200, limit));
      cursor = next;
      for (const key of keys.slice(0, Math.max(0, limit - records.length))) {
        const raw = await this.r.get(key);
        if (!raw) continue;
        try {
          const record = JSON.parse(raw) as OutboxRecord;
          if (!statuses?.length || statuses.includes(record.status)) records.push(record);
        } catch { /* corrupt records cannot be delivered safely */ }
      }
    } while (cursor !== "0" && records.length < limit);
    return records.sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
  }
  async getChannelConversation(id: string): Promise<ChannelConversationRecord | undefined> {
    const raw = await this.r.get(this.channelConversationKey(id));
    if (!raw) return undefined;
    try { return JSON.parse(raw) as ChannelConversationRecord; } catch { return undefined; }
  }
  async saveChannelConversation(record: ChannelConversationRecord): Promise<void> {
    await this.r.set(this.channelConversationKey(record.id), JSON.stringify(record), "EX", 365 * 24 * 60 * 60);
  }
  async setChannelConversationModel(id: string, model: string | undefined): Promise<ChannelConversationRecord | undefined> {
    const current = await this.getChannelConversation(id);
    if (!current) return undefined;
    const next = { ...current, ...(model ? { model } : { model: undefined }), updatedAt: Date.now() };
    await this.saveChannelConversation(next);
    return next;
  }
  async clearChannelConversationHistory(input: Omit<ChannelConversationRecord, "history" | "summaries" | "createdAt" | "updatedAt" | "historyClearedAt">): Promise<ChannelConversationRecord> {
    const current = await this.getChannelConversation(input.id);
    const now = Date.now();
    const next: ChannelConversationRecord = {
      ...input,
      ...(current?.model ? { model: current.model } : {}),
      history: [], summaries: [], historyClearedAt: now,
      createdAt: current?.createdAt ?? now, updatedAt: now,
    };
    await this.saveChannelConversation(next);
    return next;
  }
  async enqueueChannelDebounce(key: string, message: InboundMessage, ttlSeconds: number): Promise<void> {
    const redisKey = this.channelDebounceKey(key);
    await this.r.rpush(redisKey, JSON.stringify(message));
    await this.r.expire(redisKey, ttlSeconds);
  }
  async takeChannelDebounce(key: string): Promise<InboundMessage[]> {
    const redisKey = this.channelDebounceKey(key);
    const values = await this.r.eval("local values=redis.call('lrange',KEYS[1],0,-1); redis.call('del',KEYS[1]); return values", 1, redisKey) as string[];
    return (values ?? []).flatMap((value) => { try { return [JSON.parse(value) as InboundMessage]; } catch { return []; } });
  }
}

// ── Memory ────────────────────────────────────────────────────────────────────
class MemoryBackend implements Backend {
  private sessions = new Map<number, UserSession>();
  private agentRuns = new Map<string, AgentRunRecord>();
  private handoffs = new Map<string, HandoffRecord & { userId: number }>();
  private rates = new Map<number, { n: number; exp: number }>();
  private locks = new Map<number, { token: string; exp: number }>();
  private pairings = new Map<string, CliPairingRecord>();
  private devices = new Map<string, CliDeviceRecord>();
  private telegramUpdates = new Map<number, number>();
  private agentUpgrades = new Set<string>();
  private channelIdentities = new Map<string, ChannelIdentityRecord>();
  private channelIdentityUsers = new Map<number, Set<string>>();
  private channelInstallations = new Map<string, ChannelInstallationRecord>();
  private channelOAuthStates = new Map<string, ChannelOAuthStateRecord>();
  private channelLinkCodes = new Map<string, ChannelLinkCodeRecord>();
  private sendblueGroupLinkCodes = new Map<string, SendblueGroupLinkCodeRecord>();
  private sendblueGroupAuthorizations = new Map<string, SendblueGroupAuthorizationRecord>();
  private webTelegramLinkCodes = new Map<string, WebTelegramLinkCodeRecord>();
  private telegramUserByWebAuth = new Map<string, number>();
  private webAuthByTelegramUser = new Map<number, string>();
  private channelEvents = new Map<string, number>();
  private completedChannelEvents = new Map<string, number>();
  private channelInboundEvents = new Map<string, ChannelInboundEventRecord>();
  private outbox = new Map<string, OutboxRecord>();
  private triggerEvents = new Map<string, TriggerEventRecord>();
  private outboxByIdempotency = new Map<string, string>();
  private channelConversations = new Map<string, ChannelConversationRecord>();
  private outboxByProvider = new Map<string, string>();
  private channelDebounce = new Map<string, InboundMessage[]>();
  private deliveryClaims = new Map<string, number>();
  private completedDeliveries = new Map<string, number>();
  private attention = new Map<string, AttentionRecord[]>();
  private reminders = new Map<number, ReminderRecord[]>();
  private jobs = new Map<number, JobRecord[]>();
  private approvals = new Map<string, ApprovalRecord>();

  async getSession(userId: number) { return this.sessions.get(userId) ?? fresh(); }
  async saveSession(userId: number, s: UserSession) { this.sessions.set(userId, s); }
  async getApproval(userId: number, id: string) { const approval = this.approvals.get(id); return approval?.userId === userId ? approval : undefined; }
  async saveApproval(record: ApprovalRecord) { this.approvals.set(record.id, record); const session = this.sessions.get(record.userId) ?? fresh(); session.approvals = [...session.approvals.filter((item) => item.id !== record.id), record].slice(-20); this.sessions.set(record.userId, session); return record; }
  async listApprovals(userId: number, limit = 50) { return [...this.approvals.values()].filter((item) => item.userId === userId).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit); }
  async getAgentRun(userId: number, id: string) {
    const record = this.agentRuns.get(id);
    return record?.userId === userId ? record : undefined;
  }
  async saveAgentRun(input: AgentRunRecord, expectedVersion?: number) {
    const current = this.agentRuns.get(input.id);
    if (current && current.userId !== input.userId) throw new Error("Agent run is owned by another user.");
    if (expectedVersion !== undefined && (!current || current.version !== expectedVersion)) throw new Error("Agent run changed concurrently; reload its checkpoint and retry.");
    const next = boundedAgentRun({ ...input, version: current ? current.version + 1 : input.version });
    this.agentRuns.set(next.id, next);
    return next;
  }
  async listAgentRuns(userId: number, limit = 50) {
    return [...this.agentRuns.values()].filter((record) => record.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }
  async getHandoffRecord(userId: number, id: string) {
    const record = this.handoffs.get(id);
    return record?.userId === userId ? record : undefined;
  }
  async saveHandoffRecord(record: HandoffRecord & { userId: number }) {
    const prior = this.handoffs.get(record.id);
    const latest = [...this.handoffs.values()].filter((item) => item.userId === record.userId && item.id !== record.id).reduce((max, item) => Math.max(max, item.timestamp), 0);
    const next = { ...record, context: record.context ?? {}, timestamp: prior ? record.timestamp : Math.max(record.timestamp, latest + 1) };
    this.handoffs.set(record.id, next);
    return next;
  }
  async listHandoffRecords(userId: number, limit = 100) {
    return [...this.handoffs.values()].filter((record) => record.userId === userId).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
  async getReminders(userId: number) {
    const existing = this.reminders.get(userId);
    if (existing) return existing;
    const legacy = (this.sessions.get(userId) ?? fresh()).reminders ?? [];
    this.reminders.set(userId, legacy);
    return legacy;
  }
  async saveReminders(userId: number, reminders: ReminderRecord[]) { this.reminders.set(userId, reminders.slice(-100)); }
  async getJobs(userId: number) {
    const existing = this.jobs.get(userId);
    if (existing) return existing;
    const legacy = (this.sessions.get(userId) ?? fresh()).jobs ?? [];
    this.jobs.set(userId, legacy);
    return legacy;
  }
  async saveJobs(userId: number, jobs: JobRecord[]) { this.jobs.set(userId, jobs.slice(-100)); }
  async createTriggerEvent(record: TriggerEventRecord) { return this.triggerEvents.get(record.eventId) ?? (this.triggerEvents.set(record.eventId, record), record); }
  async getTriggerEvent(eventId: string) { return this.triggerEvents.get(eventId); }
  async updateTriggerEvent(eventId: string, patch: Partial<TriggerEventRecord>) {
    const current = this.triggerEvents.get(eventId);
    if (!current) return undefined;
    const next = { ...current, ...patch, eventId: current.eventId, updatedAt: Date.now() };
    this.triggerEvents.set(eventId, next);
    return next;
  }

  async incrRate(userId: number): Promise<number> {
    const now = Date.now();
    const r = this.rates.get(userId);
    if (!r || now > r.exp) {
      this.rates.set(userId, { n: 1, exp: now + config.rateWindowSeconds * 1000 });
      return 1;
    }
    r.n++;
    return r.n;
  }

  async acquireLock(userId: number, token: string, leaseSeconds: number): Promise<boolean> {
    const lock = this.locks.get(userId);
    if (lock && lock.exp > Date.now()) return false;
    this.locks.set(userId, { token, exp: Date.now() + leaseSeconds * 1000 });
    return true;
  }
  async renewLock(userId: number, token: string, leaseSeconds: number): Promise<boolean> {
    const lock = this.locks.get(userId);
    if (!lock || lock.token !== token || lock.exp <= Date.now()) return false;
    lock.exp = Date.now() + leaseSeconds * 1000;
    return true;
  }
  async releaseLock(userId: number, token: string): Promise<void> {
    if (this.locks.get(userId)?.token === token) this.locks.delete(userId);
  }
  async claimTelegramUpdate(updateId: number, ttlSeconds: number): Promise<boolean> {
    const expiresAt = this.telegramUpdates.get(updateId);
    if (expiresAt && expiresAt > Date.now()) return false;
    this.telegramUpdates.set(updateId, Date.now() + ttlSeconds * 1000);
    return true;
  }
  async hasAgentUpgrade(userId: number, upgradeId: string): Promise<boolean> {
    return this.agentUpgrades.has(`${userId}:${upgradeId}`);
  }
  async claimAgentUpgrade(userId: number, upgradeId: string): Promise<boolean> {
    const key = `${userId}:${upgradeId}`;
    if (this.agentUpgrades.has(key)) return false;
    this.agentUpgrades.add(key);
    return true;
  }
  async claimDelivery(key: string, leaseMs: number): Promise<boolean> {
    const now = Date.now();
    const done = this.completedDeliveries.get(key);
    if (done && done > now) return false;
    const claim = this.deliveryClaims.get(key);
    if (claim && claim > now) return false;
    this.deliveryClaims.set(key, now + leaseMs);
    return true;
  }
  async completeDelivery(key: string, ttlSeconds: number): Promise<void> {
    this.deliveryClaims.delete(key);
    this.completedDeliveries.set(key, Date.now() + ttlSeconds * 1000);
  }
  private daytona = new Map<number, DaytonaWorkspaceRecord>();
  private tasks = new Map<number, TaskRecord[]>();
  async getDaytonaWorkspace(userId: number) { return this.daytona.get(userId); }
  async saveDaytonaWorkspace(userId: number, workspace: DaytonaWorkspaceRecord) { this.daytona.set(userId, workspace); }
  async clearDaytonaWorkspace(userId: number) { this.daytona.delete(userId); }
  async getTasks(userId: number) { return this.tasks.get(userId) ?? []; }
  async saveTasks(userId: number, tasks: TaskRecord[]) { this.tasks.set(userId, tasks); }
  private attentionKey(userId: number, collection: AttentionCollection): string { return `${userId}:${collection}`; }
  async getAttentionRecords(userId: number, collection: AttentionCollection) {
    return this.attention.get(this.attentionKey(userId, collection)) ?? [];
  }
  async mutateAttentionRecords(userId: number, collection: AttentionCollection, mutate: (records: AttentionRecord[]) => AttentionRecord[]) {
    const key = this.attentionKey(userId, collection);
    const next = mutate(this.attention.get(key) ?? []);
    this.attention.set(key, next);
    return next;
  }
  async claimTask(userId: number, id: string, workerId: string, leaseMs: number) {
    const tasks = this.tasks.get(userId) ?? [];
    const index = tasks.findIndex((task) => task.id === id);
    const task = index < 0 ? undefined : normalizeTask(tasks[index]);
    const now = Date.now();
    if (!task || task.status !== "queued" || (task.runAt && task.runAt > now) || (task.lease && task.lease.expiresAt > now)) return undefined;
    const next = normalizeTask({ ...task, status: "running", lease: { token: randomUUID(), workerId, acquiredAt: now, expiresAt: now + leaseMs }, attempt: task.attempt + 1, updatedAt: now, events: [...task.events, taskEvent("claimed", `Claimed by ${workerId}`, task.attempt + 1, now)].slice(-100) });
    tasks[index] = next;
    this.tasks.set(userId, tasks);
    return next;
  }
  async settleTask(userId: number, id: string, leaseToken: string, patch: Partial<TaskRecord>, event: TaskEvent) {
    const tasks = this.tasks.get(userId) ?? [];
    const index = tasks.findIndex((task) => task.id === id);
    const task = index < 0 ? undefined : normalizeTask(tasks[index]);
    if (!task || task.lease?.token !== leaseToken) return undefined;
    const next = normalizeTask({ ...task, ...patch, id: task.id, userId: task.userId, createdAt: task.createdAt, lease: undefined, updatedAt: Date.now(), events: [...task.events, event].slice(-100) });
    tasks[index] = next;
    this.tasks.set(userId, tasks);
    return next;
  }
  async createCliPairing(record: CliPairingRecord) { this.pairings.set(record.codeHash, record); }
  async consumeCliPairing(codeHash: string) {
    const record = this.pairings.get(codeHash);
    if (!record || record.used || record.expiresAt <= Date.now()) { this.pairings.delete(codeHash); return undefined; }
    record.used = true;
    this.pairings.delete(codeHash);
    return record;
  }
  async saveCliDevice(record: CliDeviceRecord) { this.devices.set(record.tokenHash, record); }
  async getCliDevice(tokenHash: string) { return this.devices.get(tokenHash); }
  async revokeCliDevice(userId: number, tokenHash: string) {
    const record = this.devices.get(tokenHash);
    if (!record || record.userId !== userId) return false;
    record.revokedAt = Date.now();
    return true;
  }
  async listCliDevices(userId: number) { return [...this.devices.values()].filter((d) => d.userId === userId); }
  async claimApproval(userId: number, id: string) {
    const approval = await this.getApproval(userId, id);
    if (!approval || approval.status !== "pending" || approval.expiresAt <= Date.now()) return undefined;
    approval.status = "approved";
    this.approvals.set(approval.id, approval);
    const s = this.sessions.get(userId);
    if (s) { const index = s.approvals.findIndex((item) => item.id === approval.id); if (index >= 0) s.approvals[index] = approval; }
    return approval;
  }

  private identityKey(provider: ChannelProvider, externalUserId: string, workspaceId?: string): string { return `${provider}:${workspaceId ?? "-"}:${externalUserId}`; }
  async getChannelIdentity(provider: ChannelProvider, externalUserId: string, workspaceId?: string) {
    const record = this.channelIdentities.get(this.identityKey(provider, externalUserId, workspaceId));
    return record?.disabledAt ? undefined : record;
  }
  async listChannelIdentities(userId: number) {
    const keys = this.channelIdentityUsers.get(userId) ?? new Set<string>();
    return [...keys].map((key) => this.channelIdentities.get(key)).filter((record): record is ChannelIdentityRecord => Boolean(record && !record.disabledAt));
  }
  async saveChannelIdentity(record: ChannelIdentityRecord) {
    const key = this.identityKey(record.provider, record.externalUserId, record.workspaceId);
    const existing = this.channelIdentities.get(key);
    if (existing && (existing.userId !== record.userId || existing.accountId !== record.accountId)) return false;
    this.channelIdentities.set(key, record);
    const userKeys = this.channelIdentityUsers.get(record.userId) ?? new Set<string>();
    userKeys.add(key);
    this.channelIdentityUsers.set(record.userId, userKeys);
    return true;
  }
  private installationKey(provider: ChannelInstallationRecord["provider"], workspaceId: string): string { return `${provider}:${workspaceId}`; }
  async getChannelInstallation(provider: ChannelInstallationRecord["provider"], workspaceId: string) { return this.channelInstallations.get(this.installationKey(provider, workspaceId)); }
  async saveChannelInstallation(record: ChannelInstallationRecord) { this.channelInstallations.set(this.installationKey(record.provider, record.workspaceId), record); }
  async createChannelOAuthState(record: ChannelOAuthStateRecord) { this.channelOAuthStates.set(record.stateHash, record); }
  async consumeChannelOAuthState(stateHash: string) {
    const record = this.channelOAuthStates.get(stateHash);
    if (!record || record.used || record.expiresAt <= Date.now()) { this.channelOAuthStates.delete(stateHash); return undefined; }
    record.used = true;
    this.channelOAuthStates.delete(stateHash);
    return record;
  }
  async createChannelLinkCode(record: ChannelLinkCodeRecord) { this.channelLinkCodes.set(`${record.provider}:${record.codeHash}`, record); }
  async consumeChannelLinkCode(provider: ChannelProvider, codeHash: string) {
    const key = `${provider}:${codeHash}`;
    const record = this.channelLinkCodes.get(key);
    if (!record || record.used || record.expiresAt <= Date.now()) { this.channelLinkCodes.delete(key); return undefined; }
    record.used = true;
    this.channelLinkCodes.delete(key);
    return record;
  }
  private sendblueGroupKey(groupId: string, workspaceId: string) { return `${workspaceId}:${groupId}`; }
  async createSendblueGroupLinkCode(record: SendblueGroupLinkCodeRecord) { this.sendblueGroupLinkCodes.set(record.codeHash, record); }
  async consumeSendblueGroupLinkCode(codeHash: string) {
    const record = this.sendblueGroupLinkCodes.get(codeHash);
    if (!record || record.used || record.expiresAt <= Date.now()) { this.sendblueGroupLinkCodes.delete(codeHash); return undefined; }
    record.used = true;
    this.sendblueGroupLinkCodes.delete(codeHash);
    return record;
  }
  async getSendblueGroupAuthorization(groupId: string, workspaceId: string) {
    const record = this.sendblueGroupAuthorizations.get(this.sendblueGroupKey(groupId, workspaceId));
    return record?.disabledAt ? undefined : record;
  }
  async saveSendblueGroupAuthorization(record: SendblueGroupAuthorizationRecord) { this.sendblueGroupAuthorizations.set(this.sendblueGroupKey(record.groupId, record.workspaceId), record); }
  async revokeSendblueGroupAuthorization(groupId: string, workspaceId: string, userId: number) {
    const record = await this.getSendblueGroupAuthorization(groupId, workspaceId);
    if (!record || record.userId !== userId) return false;
    record.disabledAt = Date.now();
    record.updatedAt = Date.now();
    await this.saveSendblueGroupAuthorization(record);
    return true;
  }
  async createWebTelegramLinkCode(record: WebTelegramLinkCodeRecord) { this.webTelegramLinkCodes.set(record.codeHash, record); }
  async redeemWebTelegramLinkCode(codeHash: string, telegramUserId: number): Promise<WebTelegramLinkResult> {
    const record = this.webTelegramLinkCodes.get(codeHash);
    if (!record || record.used || record.expiresAt <= Date.now()) { this.webTelegramLinkCodes.delete(codeHash); return "invalid"; }
    this.webTelegramLinkCodes.delete(codeHash);
    const linkedTelegram = this.telegramUserByWebAuth.get(record.webAuthUserId);
    const linkedWeb = this.webAuthByTelegramUser.get(telegramUserId);
    if ((linkedTelegram && linkedTelegram !== telegramUserId) || (linkedWeb && linkedWeb !== record.webAuthUserId)) return "conflict";
    if (linkedTelegram && linkedWeb) return "already_linked";
    this.telegramUserByWebAuth.set(record.webAuthUserId, telegramUserId);
    this.webAuthByTelegramUser.set(telegramUserId, record.webAuthUserId);
    return "linked";
  }
  async getTelegramUserIdForWebAuth(webAuthUserId: string) { return this.telegramUserByWebAuth.get(webAuthUserId); }
  async claimChannelEvent(provider: ChannelProvider, eventId: string, ttlSeconds: number) {
    const key = `${provider}:${eventId}`;
    const completed = this.completedChannelEvents.get(key);
    if (completed && completed > Date.now()) return false;
    const expires = this.channelEvents.get(key);
    if (expires && expires > Date.now()) return false;
    this.channelEvents.set(key, Date.now() + Math.max(30, Math.min(15 * 60, ttlSeconds)) * 1000);
    return true;
  }
  async completeChannelEvent(provider: ChannelProvider, eventId: string, ttlSeconds: number) {
    const key = `${provider}:${eventId}`;
    this.channelEvents.delete(key);
    this.completedChannelEvents.set(key, Date.now() + ttlSeconds * 1000);
  }
  async releaseChannelEvent(provider: ChannelProvider, eventId: string) { this.channelEvents.delete(`${provider}:${eventId}`); }
  async createChannelInboundEvent(record: ChannelInboundEventRecord) { return this.channelInboundEvents.get(record.eventId) ?? (this.channelInboundEvents.set(record.eventId, record), record); }
  async getChannelInboundEvent(eventId: string) { return this.channelInboundEvents.get(eventId); }
  async claimChannelInboundEvent(eventId: string) {
    const current = this.channelInboundEvents.get(eventId);
    if (!current || current.status !== "received") return false;
    current.status = "queued";
    current.updatedAt = Date.now();
    return true;
  }
  async updateChannelInboundEvent(eventId: string, patch: Partial<ChannelInboundEventRecord>) {
    const current = this.channelInboundEvents.get(eventId);
    if (!current) return undefined;
    const next = { ...current, ...patch, eventId: current.eventId, updatedAt: Date.now() };
    this.channelInboundEvents.set(eventId, next);
    return next;
  }
  async createOutbox(record: OutboxRecord) {
    const existingId = this.outboxByIdempotency.get(record.idempotencyKey);
    if (existingId) {
      const existing = this.outbox.get(existingId);
      if (existing) return existing;
    }
    this.outbox.set(record.id, record);
    this.outboxByIdempotency.set(record.idempotencyKey, record.id);
    return record;
  }
  async getOutbox(id: string) { return this.outbox.get(id); }
  async claimOutbox(id: string, leaseMs: number) {
    const record = this.outbox.get(id);
    const now = Date.now();
    if (!record || record.status === "delivered" || (record.status === "delivering" && (record.leaseExpiresAt ?? 0) > now)) return undefined;
    const next = { ...record, status: "delivering" as const, attempts: record.attempts + 1, leaseToken: randomUUID(), leaseExpiresAt: now + leaseMs, updatedAt: now };
    this.outbox.set(id, next);
    return next;
  }
  async updateOutbox(id: string, patch: Partial<OutboxRecord>) {
    const current = this.outbox.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id: current.id, idempotencyKey: current.idempotencyKey, updatedAt: Date.now() };
    this.outbox.set(id, next);
    if (next.providerMessageId) this.outboxByProvider.set(`${next.provider}:${next.providerMessageId}`, id);
    return next;
  }
  async getOutboxByProviderMessageId(provider: ChannelProvider, providerMessageId: string) {
    const id = this.outboxByProvider.get(`${provider}:${providerMessageId}`);
    return id ? this.outbox.get(id) : undefined;
  }
  async listOutbox(statuses?: OutboxRecord["status"][], limit = 100): Promise<OutboxRecord[]> {
    return [...this.outbox.values()].filter((record) => !statuses?.length || statuses.includes(record.status)).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
  }
  async getChannelConversation(id: string) { return this.channelConversations.get(id); }
  async saveChannelConversation(record: ChannelConversationRecord) { this.channelConversations.set(record.id, record); }
  async setChannelConversationModel(id: string, model: string | undefined) {
    const current = this.channelConversations.get(id);
    if (!current) return undefined;
    const next = { ...current, ...(model ? { model } : { model: undefined }), updatedAt: Date.now() };
    this.channelConversations.set(id, next);
    return next;
  }
  async clearChannelConversationHistory(input: Omit<ChannelConversationRecord, "history" | "summaries" | "createdAt" | "updatedAt" | "historyClearedAt">) {
    const current = this.channelConversations.get(input.id);
    const now = Date.now();
    const next: ChannelConversationRecord = {
      ...input,
      ...(current?.model ? { model: current.model } : {}),
      history: [], summaries: [], historyClearedAt: now,
      createdAt: current?.createdAt ?? now, updatedAt: now,
    };
    this.channelConversations.set(input.id, next);
    return next;
  }
  async enqueueChannelDebounce(key: string, message: InboundMessage, _ttlSeconds: number) { this.channelDebounce.set(key, [...(this.channelDebounce.get(key) ?? []), message].slice(-20)); }
  async takeChannelDebounce(key: string) { const messages = this.channelDebounce.get(key) ?? []; this.channelDebounce.delete(key); return messages; }
}

function fresh(): UserSession {
  const now = Date.now();
  return { model: config.defaultModel, history: [], totalMessages: 0, totalCost: 0, triggerIds: [], reminders: [], jobs: [], scratchpad: {}, memories: [], imageAssets: [], summaries: [], approvals: [], artifacts: [], videoJobs: [], createdAt: now, updatedAt: now };
}

let backend: Backend;
const memoryVectorBackfillUsers = new Set<number>();

export async function initStore(options: { memoryOnly?: boolean } = {}): Promise<void> {
  const production = process.env.NODE_ENV === "production";
  if ((config.webhookUrl || production) && !config.redisUrl && !options.memoryOnly) {
    const error = new Error("REDIS_URL is required in webhook/production mode; refusing in-memory persistence");
    recordFailure("redis_failure", error, { phase: "startup", reason: "missing_url" });
    throw error;
  }
  if (config.redisUrl && !options.memoryOnly) {
    try {
      const r = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
      await r.connect();
      await r.ping();
      backend = new RedisBackend(r);
      logger.info("Store: Redis connected");
      return;
    } catch (e) {
      if (config.webhookUrl || production) {
        const error = new Error("Redis is unavailable in webhook/production mode; refusing in-memory persistence");
        recordFailure("redis_failure", e, { phase: "startup", reason: "connection_failed" });
        throw error;
      }
      logger.warn({ err: e }, "Store: Redis failed, using memory");
    }
  } else {
    logger.info("Store: using in-memory (set REDIS_URL for persistence)");
  }
  backend = new MemoryBackend();
}

export function isDurableStore(): boolean {
  return backend instanceof RedisBackend;
}

const memoryCategories: MemoryFact["category"][] = ["profile", "personal", "preference", "business", "relationship", "project", "procedural", "episodic", "document", "negative", "fact", "instruction", "asset"];

function normalizeMemory(memory: Partial<MemoryFact>): MemoryFact {
  const now = Date.now();
  return {
    id: String(memory.id ?? `mem_legacy_${now}`),
    category: memoryCategories.includes(memory.category as MemoryFact["category"]) ? memory.category as MemoryFact["category"] : "fact",
    key: String(memory.key ?? "memory"),
    value: String(memory.value ?? ""),
    confidence: typeof memory.confidence === "number" && Number.isFinite(memory.confidence) ? Math.max(0, Math.min(1, memory.confidence)) : 1,
    source: String(memory.source ?? "legacy"),
    sensitivity: memory.sensitivity === "sensitive" ? "sensitive" : "normal",
    status: memory.status === "superseded" || memory.status === "deleted" ? memory.status : "active",
    supersedesId: typeof memory.supersedesId === "string" ? memory.supersedesId : undefined,
    projectId: typeof memory.projectId === "string" ? memory.projectId.trim() || undefined : undefined,
    personKey: typeof memory.personKey === "string" ? memory.personKey.trim() || undefined : undefined,
    reviewAt: typeof memory.reviewAt === "number" ? memory.reviewAt : undefined,
    expiresAt: typeof memory.expiresAt === "number" ? memory.expiresAt : undefined,
    createdAt: typeof memory.createdAt === "number" ? memory.createdAt : (typeof memory.updatedAt === "number" ? memory.updatedAt : now),
    updatedAt: typeof memory.updatedAt === "number" ? memory.updatedAt : now,
  };
}

export async function getSession(uid: number): Promise<UserSession> {
  const s = await backend.getSession(uid);
  return { ...fresh(), ...s, triggerIds: s.triggerIds ?? [], reminders: s.reminders ?? [], jobs: s.jobs ?? [], scratchpad: s.scratchpad ?? {}, memories: (s.memories ?? []).map(normalizeMemory), imageAssets: s.imageAssets ?? [], summaries: s.summaries ?? [], approvals: s.approvals ?? [], handoffRecords: s.handoffRecords ?? [], sdkProjects: s.sdkProjects ?? [], sdkFiles: s.sdkFiles ?? [], artifacts: s.artifacts ?? [], faceTimeCalls: s.faceTimeCalls ?? [], videoJobs: s.videoJobs ?? [], sdkIdempotency: s.sdkIdempotency ?? {}, sdkAudit: s.sdkAudit ?? [], sdkWebhooks: s.sdkWebhooks ?? [], sdkThreads: (s.sdkThreads ?? []).map((thread) => ({ ...thread, history: thread.history ?? [], runs: (thread.runs ?? []).map((run) => ({ ...run, events: run.events ?? [] })) })) };
}

export async function saveSession(uid: number, s: UserSession): Promise<void> {
  s.updatedAt = Date.now();
  return backend.saveSession(uid, s);
}

/** Read one durable execution record without loading the owner's chat session. */
export async function getAgentRun(userId: number, id: string): Promise<AgentRunRecord | undefined> {
  return backend.getAgentRun(userId, id);
}

/** Persist a bounded execution checkpoint with optimistic version protection. */
export async function saveAgentRun(record: AgentRunRecord, expectedVersion?: number): Promise<AgentRunRecord> {
  return backend.saveAgentRun(record, expectedVersion);
}

export async function listAgentRuns(userId: number, limit = 50): Promise<AgentRunRecord[]> {
  return backend.listAgentRuns(userId, Math.max(1, Math.min(100, limit)));
}

export async function addFaceTimeCall(uid: number, record: FaceTimeCallRecord): Promise<FaceTimeCallRecord> {
  const s = await getSession(uid);
  s.faceTimeCalls = [record, ...(s.faceTimeCalls ?? [])].slice(0, 50);
  await saveSession(uid, s);
  return record;
}

export async function updateFaceTimeCall(uid: number, id: string, patch: Partial<Pick<FaceTimeCallRecord, "status" | "bridgeSessionId" | "providerCallId" | "error">>): Promise<FaceTimeCallRecord | undefined> {
  const s = await getSession(uid);
  const current = (s.faceTimeCalls ?? []).find((item) => item.id === id && item.userId === uid);
  if (!current) return undefined;
  Object.assign(current, patch, { updatedAt: Date.now() });
  await saveSession(uid, s);
  return current;
}

export async function listFaceTimeCalls(uid: number): Promise<FaceTimeCallRecord[]> {
  return (await getSession(uid)).faceTimeCalls ?? [];
}

export async function saveHandoffRecord(uid: number, record: HandoffRecord): Promise<HandoffRecord> {
  await backend.saveHandoffRecord({ ...record, userId: uid });
  return record;
}

export async function listHandoffRecords(uid: number): Promise<HandoffRecord[]> {
  const records = await backend.listHandoffRecords(uid, 100);
  if (records.length) return records;
  return (await getSession(uid)).handoffRecords ?? [];
}

export async function getHandoffRecord(uid: number, id: string): Promise<HandoffRecord | undefined> {
  return (await backend.getHandoffRecord(uid, id)) ?? (await getSession(uid)).handoffRecords?.find((record) => record.id === id);
}

export async function getFaceTimeCall(uid: number, id: string): Promise<FaceTimeCallRecord | undefined> {
  return (await getSession(uid)).faceTimeCalls?.find((item) => item.id === id && item.userId === uid);
}

/** Best-effort provider delivery dedupe. The lease prevents concurrent workflow retries;
 * completion keeps an already-delivered occurrence from being sent twice. */
export async function claimDelivery(key: string, leaseMs: number): Promise<boolean> {
  return backend.claimDelivery(key, leaseMs);
}

export async function completeDelivery(key: string, ttlSeconds: number): Promise<void> {
  return backend.completeDelivery(key, ttlSeconds);
}

export async function appendMessages(uid: number, msgs: Message[]): Promise<void> {
  const s = await getSession(uid);
  const stamped = msgs.map((message) => ({
    ...message,
    createdAt: typeof message.createdAt === "number" && Number.isFinite(message.createdAt) && message.createdAt >= 0 ? message.createdAt : Date.now(),
  }));
  s.history.push(...stamped);
  s.totalMessages += stamped.filter((m) => m.role === "user").length;
  const cap = config.maxHistory * 2;
  if (s.history.length > cap) {
    const overflow = s.history.slice(0, s.history.length - cap);
    const compact = overflow.map((m) => `${m.role}: ${m.content}`).join(" ").slice(0, 1800);
    s.summaries = [...s.summaries, compact].slice(-10);
    s.history = s.history.slice(s.history.length - cap);
  }
  await saveSession(uid, s);
}

export async function addUsage(uid: number, cost: number): Promise<void> {
  const s = await getSession(uid);
  s.totalCost = (s.totalCost ?? 0) + cost;
  await saveSession(uid, s);
}

export async function canSpend(uid: number, estimatedCost = 0): Promise<boolean> {
  if (!config.userCostCap || config.userCostCap <= 0) return true;
  const s = await getSession(uid);
  return (s.totalCost ?? 0) + estimatedCost < config.userCostCap;
}

export async function clearHistory(uid: number): Promise<void> {
  const s = await getSession(uid);
  s.history = [];
  await saveSession(uid, s);
}

export async function clearSession(uid: number): Promise<void> {
  const s = await getSession(uid);
  s.history = [];
  s.composioSessionId = undefined;
  await saveSession(uid, s);
}

export async function setModel(uid: number, model: string): Promise<void> {
  const s = await getSession(uid);
  s.model = model;
  await saveSession(uid, s);
}

export async function getModel(uid: number): Promise<string> {
  return (await getSession(uid)).model;
}

export async function createVideoJob(input: Pick<VideoJobRecord, "userId" | "prompt" | "destination"> & Partial<Pick<VideoJobRecord, "workspacePath">>): Promise<VideoJobRecord> {
  const session = await getSession(input.userId);
  const now = Date.now();
  const job: VideoJobRecord = { id: `vid_${randomUUID()}`, userId: input.userId, prompt: input.prompt.slice(0, 4000), destination: input.destination, workspacePath: input.workspacePath, status: "queued", pollCount: 0, createdAt: now, updatedAt: now };
  session.videoJobs = [...(session.videoJobs ?? []), job].slice(-20);
  await saveSession(input.userId, session);
  return job;
}

export async function getVideoJob(userId: number, id: string): Promise<VideoJobRecord | undefined> {
  return (await getSession(userId)).videoJobs?.find((job) => job.id === id);
}

export async function listVideoJobs(userId: number): Promise<VideoJobRecord[]> {
  return [...((await getSession(userId)).videoJobs ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateVideoJob(userId: number, id: string, patch: Partial<Omit<VideoJobRecord, "id" | "userId" | "createdAt">>): Promise<VideoJobRecord | undefined> {
  const session = await getSession(userId);
  const jobs = session.videoJobs ?? [];
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0) return undefined;
  const next = { ...jobs[index]!, ...patch, id, userId, createdAt: jobs[index]!.createdAt, updatedAt: Date.now() };
  jobs[index] = next;
  session.videoJobs = jobs;
  await saveSession(userId, session);
  return next;
}

export async function setVoiceReplies(uid: number, enabled: boolean): Promise<void> {
  const s = await getSession(uid);
  s.voiceReplies = enabled;
  await saveSession(uid, s);
}

export async function setComposioSessionId(uid: number, id: string): Promise<void> {
  const s = await getSession(uid);
  s.composioSessionId = id;
  await saveSession(uid, s);
}

export async function setDaytonaWorkspaceId(uid: number, id: string): Promise<void> {
  const s = await getSession(uid);
  s.daytonaWorkspaceId = id;
  await saveSession(uid, s);
}

export async function clearDaytonaWorkspaceId(uid: number): Promise<void> {
  const s = await getSession(uid);
  delete s.daytonaWorkspaceId;
  await saveSession(uid, s);
}

export async function getDaytonaWorkspace(uid: number): Promise<DaytonaWorkspaceRecord | undefined> {
  const durable = await backend.getDaytonaWorkspace(uid);
  if (durable) return durable;
  const legacy = (await getSession(uid)).daytonaWorkspaceId;
  return legacy ? { sandboxId: legacy, name: `chusky-${uid}`, createdAt: Date.now(), updatedAt: Date.now() } : undefined;
}

export async function saveDaytonaWorkspace(uid: number, workspace: DaytonaWorkspaceRecord): Promise<void> {
  await backend.saveDaytonaWorkspace(uid, workspace);
  const s = await getSession(uid);
  s.daytonaWorkspaceId = workspace.sandboxId;
  await saveSession(uid, s);
}

export async function clearDaytonaWorkspace(uid: number): Promise<void> {
  await backend.clearDaytonaWorkspace(uid);
  await clearDaytonaWorkspaceId(uid);
}

function normalizeTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    steps: (task.steps ?? []).slice(0, 20).map((step) => ({ ...step, updatedAt: step.updatedAt ?? task.updatedAt })),
    attempt: task.attempt ?? 0,
    maxAttempts: Math.max(1, Math.min(10, task.maxAttempts ?? 3)),
    events: (task.events ?? []).slice(-100),
  };
}

function taskEvent(type: TaskEvent["type"], message: string, attempt: number, at = Date.now()): TaskEvent {
  return { id: `taskevt_${randomUUID()}`, type, message: message.slice(0, 1000), at, attempt };
}

export async function createTask(userId: number, input: Pick<TaskRecord, "title" | "objective"> & Partial<Omit<TaskRecord, "id" | "userId" | "title" | "objective" | "createdAt" | "updatedAt" | "status" | "attempt" | "events" | "lease">>): Promise<TaskRecord> {
  const now = Date.now();
  const task: TaskRecord = normalizeTask({
    id: `task_${randomUUID()}`,
    userId,
    title: input.title,
    objective: input.objective,
    status: "queued",
    steps: input.steps ?? [],
    workspaceId: input.workspaceId,
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 3,
    runAt: input.runAt,
    sdkRunId: input.sdkRunId,
    sdkThreadId: input.sdkThreadId,
    sdkInput: input.sdkInput,
    sdkAttachments: input.sdkAttachments,
    sdkModel: input.sdkModel,
    sdkTools: input.sdkTools,
    sdkBudget: input.sdkBudget,
    sdkStartedAt: input.sdkStartedAt,
    sdkSkills: input.sdkSkills,
    events: [taskEvent(input.runAt ? "scheduled" : "created", input.runAt ? "Task scheduled" : "Task created", 0, now)],
    createdAt: now,
    updatedAt: now,
  });
  const tasks = await backend.getTasks(userId);
  await backend.saveTasks(userId, [...tasks.filter((item) => item.id !== task.id), task].slice(-100));
  return task;
}

export async function listTasks(userId: number, statuses?: TaskStatus[]): Promise<TaskRecord[]> {
  const tasks = (await backend.getTasks(userId)).map(normalizeTask);
  return tasks.filter((task) => !statuses?.length || statuses.includes(task.status)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getTask(userId: number, id: string): Promise<TaskRecord | undefined> {
  return (await backend.getTasks(userId)).map(normalizeTask).find((task) => task.id === id);
}

export async function updateTask(userId: number, id: string, patch: Partial<Omit<TaskRecord, "id" | "userId" | "createdAt">>): Promise<TaskRecord | undefined> {
  const tasks = (await backend.getTasks(userId)).map(normalizeTask);
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return undefined;
  const current = tasks[index];
  const next = normalizeTask({ ...current, ...patch, id: current.id, userId: current.userId, createdAt: current.createdAt, updatedAt: Date.now() });
  tasks[index] = next;
  await backend.saveTasks(userId, tasks);
  return next;
}

export async function scheduleTask(userId: number, id: string, runAt: number): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || ["completed", "running"].includes(task.status)) return undefined;
  const next = await updateTask(userId, id, { status: "queued", runAt, error: undefined, nextAction: undefined });
  if (!next) return undefined;
  const tasks = await backend.getTasks(userId);
  const index = tasks.findIndex((item) => item.id === id);
  next.events = [...next.events, taskEvent("scheduled", `Scheduled for ${new Date(runAt).toISOString()}`, next.attempt)].slice(-100);
  tasks[index] = next;
  await backend.saveTasks(userId, tasks);
  return next;
}

export async function setTaskWorkflowRunId(userId: number, id: string, workflowRunId: string): Promise<TaskRecord | undefined> {
  return updateTask(userId, id, { workflowRunId: workflowRunId.slice(0, 200) });
}

export async function checkpointTask(userId: number, id: string, checkpoint: string, nextAction?: string): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || ["completed", "cancel_requested", "cancelled"].includes(task.status)) return undefined;
  return updateTask(userId, id, { status: "running", checkpoint, nextAction, error: undefined });
}

export async function blockTask(userId: number, id: string, error: string, nextAction?: string): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || ["completed", "cancel_requested", "cancelled"].includes(task.status)) return undefined;
  return updateTask(userId, id, { status: "blocked", error, nextAction });
}

export async function completeTask(userId: number, id: string, result: string): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || ["cancel_requested", "cancelled"].includes(task.status)) return undefined;
  return updateTask(userId, id, { status: "completed", result, nextAction: undefined, error: undefined });
}

/** Request cancellation without racing an in-flight worker into a false success. */
export async function requestTaskCancellation(userId: number, id: string, reason = "Cancellation requested by the user."): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || ["completed", "cancelled"].includes(task.status)) return undefined;
  if (["queued", "blocked", "failed"].includes(task.status)) {
    return updateTask(userId, id, { status: "cancelled", error: reason, nextAction: undefined });
  }
  const next = await updateTask(userId, id, { status: "cancel_requested", error: reason, nextAction: "The active worker is stopping at its next cancellation checkpoint." });
  if (!next) return undefined;
  next.events = [...next.events, taskEvent("cancel_requested", reason, next.attempt)].slice(-100);
  const tasks = await backend.getTasks(userId);
  const index = tasks.findIndex((item) => item.id === id);
  if (index >= 0) {
    tasks[index] = next;
    await backend.saveTasks(userId, tasks);
  }
  return next;
}

export async function finalizeTaskCancellation(userId: number, id: string, reason = "Task cancelled."): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || task.status === "completed") return undefined;
  const next = await updateTask(userId, id, { status: "cancelled", error: reason, nextAction: undefined });
  if (!next) return undefined;
  next.events = [...next.events, taskEvent("cancelled", reason, next.attempt)].slice(-100);
  const tasks = await backend.getTasks(userId);
  const index = tasks.findIndex((item) => item.id === id);
  if (index >= 0) {
    tasks[index] = next;
    await backend.saveTasks(userId, tasks);
  }
  return next;
}

export async function cancelTask(userId: number, id: string): Promise<TaskRecord | undefined> {
  return requestTaskCancellation(userId, id);
}

export async function retryTask(userId: number, id: string): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || !["failed", "blocked", "cancelled"].includes(task.status)) return undefined;
  const next = await updateTask(userId, id, { status: "queued", error: undefined, result: undefined, runAt: Date.now() });
  if (!next) return undefined;
  next.events = [...next.events, taskEvent("retried", "Task requeued", next.attempt)].slice(-100);
  const tasks = await backend.getTasks(userId);
  const index = tasks.findIndex((item) => item.id === id);
  tasks[index] = next;
  await backend.saveTasks(userId, tasks);
  return next;
}

export async function claimTask(userId: number, id: string, workerId: string, leaseMs = 120_000): Promise<TaskRecord | undefined> {
  return backend.claimTask(userId, id, workerId.slice(0, 120), Math.max(1_000, Math.min(10 * 60_000, leaseMs)));
}

export async function settleTaskRun(userId: number, id: string, leaseToken: string, outcome: { status: "completed" | "blocked" | "failed" | "queued" | "cancelled"; message: string; checkpoint?: string; nextAction?: string; result?: string }): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || task.lease?.token !== leaseToken) return undefined;
  if (["cancel_requested", "cancelled"].includes(task.status)) {
    return backend.settleTask(userId, id, leaseToken, { status: "cancelled", nextAction: undefined, error: outcome.message }, taskEvent("cancelled", "Cancellation completed before task settlement", task.attempt));
  }
  const retryable = outcome.status === "failed" && task.attempt < task.maxAttempts;
  const status = retryable ? "queued" : outcome.status;
  const delayMs = retryable ? Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, task.attempt - 1)) : undefined;
  const eventType: TaskEvent["type"] = retryable ? "failed" : outcome.status === "queued" ? "retried" : outcome.status;
  return backend.settleTask(userId, id, leaseToken, {
    status,
    checkpoint: outcome.checkpoint ?? task.checkpoint,
    nextAction: outcome.nextAction,
    result: outcome.result,
    error: outcome.status === "failed" ? outcome.message : undefined,
    runAt: retryable ? Date.now() + (delayMs ?? 0) : undefined,
  }, taskEvent(eventType, outcome.message, task.attempt));
}

export async function setTelegramChatId(uid: number, chatId: number): Promise<void> {
  const s = await getSession(uid);
  s.telegramChatId = chatId;
  await saveSession(uid, s);
}

export async function getTelegramChatId(uid: number): Promise<number | undefined> {
  return (await getSession(uid)).telegramChatId;
}

export async function checkRateLimit(uid: number): Promise<boolean> {
  const n = await backend.incrRate(uid);
  return n <= config.rateLimit;
}

export async function acquireUserLock(uid: number, token: string, leaseSeconds = 180): Promise<boolean> {
  return backend.acquireLock(uid, token, leaseSeconds);
}

export async function renewUserLock(uid: number, token: string, leaseSeconds = 180): Promise<boolean> {
  return backend.renewLock(uid, token, leaseSeconds);
}

export async function releaseUserLock(uid: number, token: string): Promise<void> {
  return backend.releaseLock(uid, token);
}

export async function claimTelegramUpdate(updateId: number, ttlSeconds = 24 * 60 * 60): Promise<boolean> {
  if (!Number.isSafeInteger(updateId) || updateId < 0) return true;
  return backend.claimTelegramUpdate(updateId, ttlSeconds);
}

/** Atomically claims a release notice for one user. Redis uses SET NX so concurrent channel requests cannot duplicate it. */
export async function claimAgentUpgrade(userId: number, upgradeId: string): Promise<boolean> {
  return backend.claimAgentUpgrade(userId, upgradeId);
}

export async function hasAgentUpgrade(userId: number, upgradeId: string): Promise<boolean> {
  return backend.hasAgentUpgrade(userId, upgradeId);
}

export function hashCliSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createPairingCode(): string {
  return String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
}

export async function createCliPairing(userId: number, ttlMs = 10 * 60 * 1000): Promise<string> {
  const code = createPairingCode();
  await backend.createCliPairing({ codeHash: hashCliSecret(code), userId, expiresAt: Date.now() + ttlMs, used: false });
  return code;
}

export async function consumeCliPairing(code: string): Promise<CliPairingRecord | undefined> {
  return backend.consumeCliPairing(hashCliSecret(code.trim()));
}

export async function createCliDevice(userId: number, name: string): Promise<{ token: string; device: CliDeviceRecord }> {
  const token = `chusky_${randomBytes(32).toString("base64url")}`;
  const device: CliDeviceRecord = { tokenHash: hashCliSecret(token), userId, name: name.trim().slice(0, 80) || "terminal", createdAt: Date.now(), lastSeenAt: Date.now() };
  await backend.saveCliDevice(device);
  return { token, device };
}

export async function authenticateCliToken(token: string): Promise<CliDeviceRecord | undefined> {
  if (!token.trim()) return undefined;
  const device = await backend.getCliDevice(hashCliSecret(token));
  if (!device || device.revokedAt) return undefined;
  device.lastSeenAt = Date.now();
  await backend.saveCliDevice(device);
  return device;
}

export async function revokeCliDevice(userId: number, token: string): Promise<boolean> {
  return backend.revokeCliDevice(userId, hashCliSecret(token));
}

export async function revokeCliDeviceHash(userId: number, tokenHash: string): Promise<boolean> {
  return backend.revokeCliDevice(userId, tokenHash);
}

export async function listCliDevices(userId: number): Promise<CliDeviceRecord[]> {
  return backend.listCliDevices(userId);
}

export async function revokeCliDeviceByName(userId: number, name: string): Promise<boolean> {
  const wanted = name.trim().toLowerCase();
  const device = (await backend.listCliDevices(userId)).find((item) => item.name.toLowerCase() === wanted && !item.revokedAt);
  return device ? backend.revokeCliDevice(userId, device.tokenHash) : false;
}

const seenTriggerEvents = new Map<string, number>();
export async function claimTriggerEvent(eventId: string, ttlSeconds = 86400): Promise<boolean> {
  const key = `chuck:event:${eventId}`;
  if (config.redisUrl && backend instanceof RedisBackend) {
    const redis = (backend as any).r as Redis;
    return (await redis.set(key, "1", "EX", ttlSeconds, "NX")) === "OK";
  }
  const now = Date.now();
  for (const [id, exp] of seenTriggerEvents) if (exp <= now) seenTriggerEvents.delete(id);
  if (seenTriggerEvents.has(eventId)) return false;
  seenTriggerEvents.set(eventId, now + ttlSeconds * 1000);
  return true;
}
export async function releaseTriggerEvent(eventId: string): Promise<void> {
  const key = `chuck:event:${eventId}`;
  if (config.redisUrl && backend instanceof RedisBackend) {
    await (backend as any).r.del(key);
    return;
  }
  seenTriggerEvents.delete(eventId);
}

export async function createTriggerEvent(record: TriggerEventRecord): Promise<TriggerEventRecord> {
  return backend.createTriggerEvent(record);
}
export async function getTriggerEvent(eventId: string): Promise<TriggerEventRecord | undefined> {
  return backend.getTriggerEvent(eventId);
}
export async function updateTriggerEvent(eventId: string, patch: Partial<TriggerEventRecord>): Promise<TriggerEventRecord | undefined> {
  return backend.updateTriggerEvent(eventId, patch);
}

export async function addReminder(uid: number, reminder: ReminderRecord): Promise<void> {
  const reminders = await backend.getReminders(uid);
  await backend.saveReminders(uid, [...reminders.filter((r) => r.id !== reminder.id), reminder]);
}

export async function listReminders(uid: number): Promise<ReminderRecord[]> {
  return (await backend.getReminders(uid)).filter((r) => r.status === "scheduled").sort((a, b) => a.runAt - b.runAt);
}

export async function getReminder(uid: number, id: string): Promise<ReminderRecord | undefined> {
  return (await backend.getReminders(uid)).find((r) => r.id === id);
}

export async function updateReminder(uid: number, id: string, patch: Partial<ReminderRecord>): Promise<boolean> {
  const reminders = await backend.getReminders(uid);
  const r = reminders.find((item) => item.id === id);
  if (!r) return false;
  Object.assign(r, patch);
  await backend.saveReminders(uid, reminders);
  return true;
}

export async function addJob(uid: number, job: JobRecord): Promise<void> {
  const jobs = await backend.getJobs(uid);
  await backend.saveJobs(uid, [...jobs.filter((j) => j.id !== job.id), job]);
}

export async function listJobs(uid: number): Promise<JobRecord[]> {
  return (await backend.getJobs(uid)).filter((j) => j.status === "active");
}

export async function listAllJobs(uid: number): Promise<JobRecord[]> {
  return backend.getJobs(uid);
}

export async function getJob(uid: number, id: string): Promise<JobRecord | undefined> {
  return (await backend.getJobs(uid)).find((j) => j.id === id);
}

export async function updateJob(uid: number, id: string, patch: Partial<JobRecord>): Promise<boolean> {
  const jobs = await backend.getJobs(uid);
  const j = jobs.find((item) => item.id === id);
  if (!j) return false;
  Object.assign(j, patch);
  await backend.saveJobs(uid, jobs);
  return true;
}

export async function writeScratchpad(uid: number, key: string, content: string): Promise<void> {
  const s = await getSession(uid);
  s.scratchpad[key] = { content, updatedAt: Date.now() };
  await saveSession(uid, s);
}

export async function readScratchpad(uid: number, query?: string): Promise<Record<string, ScratchpadEntry>> {
  const all = (await getSession(uid)).scratchpad;
  if (!query?.trim()) return all;
  const q = query.toLowerCase();
  return Object.fromEntries(Object.entries(all).filter(([key, value]) => `${key} ${value.content}`.toLowerCase().includes(q)));
}

export async function clearScratchpad(uid: number, key?: string): Promise<void> {
  const s = await getSession(uid);
  if (key) delete s.scratchpad[key]; else s.scratchpad = {};
  await saveSession(uid, s);
}

export async function upsertMemory(uid: number, memory: Omit<MemoryFact, "id" | "updatedAt" | "createdAt" | "source" | "sensitivity"> & Partial<Pick<MemoryFact, "id" | "createdAt" | "source" | "sensitivity">>): Promise<MemoryFact> {
  const s = await getSession(uid);
  const now = Date.now();
  const existing = s.memories.find((m) => (memory.id && m.id === memory.id) || (!memory.id && m.category === memory.category && m.key === memory.key));
  const value: MemoryFact = {
    id: existing?.id ?? memory.id ?? `mem_${now}_${Math.random().toString(36).slice(2, 8)}`,
    category: memory.category,
    key: memory.key,
    value: memory.value,
    confidence: Math.max(0, Math.min(1, memory.confidence)),
    source: memory.source || "user",
    sensitivity: memory.sensitivity === "sensitive" ? "sensitive" : "normal",
    projectId: typeof memory.projectId === "string" ? memory.projectId.trim() || undefined : undefined,
    personKey: typeof memory.personKey === "string" ? memory.personKey.trim() || undefined : undefined,
    reviewAt: Number.isFinite(memory.reviewAt) ? memory.reviewAt : undefined,
    expiresAt: Number.isFinite(memory.expiresAt) ? memory.expiresAt : undefined,
    createdAt: existing?.createdAt ?? memory.createdAt ?? now,
    updatedAt: now,
  };
  s.memories = [...s.memories.filter((m) => m.id !== value.id && !(m.category === value.category && m.key === value.key)), value].slice(-200);
  await saveSession(uid, s);
  if (vectorConfigured()) {
    const vector = new UpstashKnowledgeStore();
    void vector.upsertMemory({ userId: String(uid), id: value.id, category: value.category, key: value.key, value: value.value, projectId: value.projectId, personKey: value.personKey }).then(async () => {
      if (existing?.projectId && existing.projectId !== value.projectId) await vector.deleteMemory(String(uid), existing.id, existing.projectId);
    }).catch((error) => logger.warn({ err: error, userId: uid }, "Memory vector indexing unavailable; structured memory retained"));
  }
  return value;
}

export async function updateMemory(uid: number, target: { id?: string; key?: string; category?: MemoryFact["category"] }, patch: Partial<Pick<MemoryFact, "category" | "key" | "value" | "confidence" | "source" | "sensitivity" | "projectId" | "personKey" | "reviewAt" | "expiresAt">>): Promise<MemoryFact | undefined> {
  const session = await getSession(uid);
  const existing = session.memories.find((memory) => target.id ? memory.id === target.id : memory.key === target.key && (!target.category || memory.category === target.category));
  if (!existing) return undefined;
  const changed = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<MemoryFact>;
  return upsertMemory(uid, {
    ...existing,
    ...changed,
    id: existing.id,
    createdAt: existing.createdAt,
    source: changed.source ?? existing.source,
    sensitivity: changed.sensitivity ?? existing.sensitivity,
  });
}

export async function searchMemories(uid: number, query?: string, options: { category?: MemoryFact["category"]; projectId?: string; personKey?: string; limit?: number } = {}): Promise<MemoryFact[]> {
  const now = Date.now();
  const memories = (await getSession(uid)).memories.filter((m) => !m.expiresAt || m.expiresAt > now)
    .filter((m) => !options.category || m.category === options.category)
    .filter((m) => !options.projectId || m.projectId === options.projectId)
    .filter((m) => !options.personKey || m.personKey === options.personKey);
  const limit = Math.max(1, Math.min(options.limit ?? 8, 20));
  const tokens = (query ?? "").toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!tokens.length) return memories.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  const lexical = memories.map((m) => ({ m, score: tokens.reduce((n, t) => n + (`${m.category} ${m.key} ${m.value}`.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt);
  const ranked = new Map<string, { memory: MemoryFact; score: number }>(lexical.map((item) => [item.m.id, { memory: item.m, score: item.score * 2 }]));
  if (vectorConfigured()) {
    if (!memoryVectorBackfillUsers.has(uid)) {
      memoryVectorBackfillUsers.add(uid);
      const allMemories = (await getSession(uid)).memories;
      void new UpstashKnowledgeStore().upsertMemories(allMemories.map((memory) => ({ userId: String(uid), id: memory.id, category: memory.category, key: memory.key, value: memory.value, projectId: memory.projectId, personKey: memory.personKey }))).catch((error) => {
        memoryVectorBackfillUsers.delete(uid);
        logger.warn({ err: error, userId: uid }, "Memory vector backfill unavailable; structured search remains authoritative");
      });
    }
    try {
        const matches = await new UpstashKnowledgeStore().queryMemories(String(uid), query ?? "", { category: options.category, projectId: options.projectId, personKey: options.personKey, topK: limit });
      for (const [index, match] of matches.entries()) {
        const memoryId = typeof match.metadata?.memoryId === "string" ? match.metadata.memoryId : match.id.replace(/^memory:/, "").replace(/:0$/, "");
        const memory = memories.find((item) => item.id === memoryId);
        if (!memory) continue;
        const semanticScore = typeof match.score === "number" ? match.score : 0;
        const current = ranked.get(memory.id);
        ranked.set(memory.id, { memory, score: (current?.score ?? 0) + semanticScore + Math.max(0, limit - index) / limit });
      }
    } catch (error) { logger.warn({ err: error, userId: uid }, "Semantic memory search unavailable; using structured search"); }
  }
  return [...ranked.values()].sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt).slice(0, limit).map((item) => item.memory);
}

export async function forgetMemory(uid: number, key: string): Promise<boolean> {
  const s = await getSession(uid);
  const before = s.memories.length;
  const removed = s.memories.filter((m) => m.key === key || m.id === key);
  s.memories = s.memories.filter((m) => m.key !== key && m.id !== key);
  if (s.memories.length === before) return false;
  await saveSession(uid, s);
  if (vectorConfigured()) {
    for (const memory of removed) {
      void new UpstashKnowledgeStore().deleteMemory(String(uid), memory.id, memory.projectId).catch((error) => logger.warn({ err: error, userId: uid, memoryId: memory.id }, "Memory vector deletion unavailable; structured memory removed"));
    }
  }
  return true;
}

function imageExtension(contentType: ImageAsset["contentType"]): string { return contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png"; }

export async function registerImageAsset(uid: number, input: { id?: string; name: string; purpose: string; description?: string; tags?: string[]; contentType: ImageAsset["contentType"]; r2Key: string; size: number }): Promise<ImageAsset> {
  if (!r2Configured()) throw new Error("R2 storage is not configured");
  const now = Date.now();
  const id = input.id ?? `img_${now}_${randomUUID().slice(0, 8)}`;
  const asset: ImageAsset = { id, userId: uid, name: input.name.trim().slice(0, 120), purpose: input.purpose.trim().slice(0, 500), description: (input.description ?? "").trim().slice(0, 4000), tags: [...new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 30), r2Key: input.r2Key, contentType: input.contentType, size: input.size, createdAt: now, updatedAt: now };
  const session = await getSession(uid);
  const previous = session.imageAssets.find((item) => item.name === asset.name || item.r2Key === asset.r2Key);
  session.imageAssets = [...session.imageAssets.filter((item) => item.name !== asset.name), asset].slice(-100);
  await saveSession(uid, session);
  if (previous) {
    if (previous.r2Key !== asset.r2Key) void deleteR2Object(previous.r2Key).catch((error) => logger.warn({ err: error, userId: uid, assetId: previous.id }, "Previous image asset cleanup failed"));
    if (vectorConfigured()) void new UpstashKnowledgeStore().deleteDocument(String(uid), `image_asset:${previous.id}`).catch((error) => logger.warn({ err: error, userId: uid, assetId: previous.id }, "Previous image asset vector cleanup failed"));
  }
  if (vectorConfigured()) {
    void new UpstashKnowledgeStore().upsert([{
      id: `image_asset:${asset.id}:0`,
      data: `${asset.name}\n${asset.purpose}\n${asset.description}\n${asset.tags.join(" ")}`,
      metadata: { userId: String(uid), documentId: asset.id, sourceType: "image_asset", contentType: asset.contentType, chunkIndex: 0, visibility: "private", assetId: asset.id, assetName: asset.name, purpose: asset.purpose },
    }]).catch((error) => logger.warn({ err: error, userId: uid, assetId: asset.id }, "Image asset vector indexing unavailable; R2 asset retained"));
  }
  return asset;
}

export async function saveImageAsset(uid: number, input: { name: string; purpose: string; description?: string; tags?: string[]; contentType: ImageAsset["contentType"] }, bytes: Uint8Array): Promise<ImageAsset> {
  if (!r2Configured()) throw new Error("R2 storage is not configured");
  const id = `img_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const r2Key = `images/${uid}/${id}.${imageExtension(input.contentType)}`;
  await putR2Object(r2Key, bytes, input.contentType);
  return registerImageAsset(uid, { ...input, id, r2Key, size: bytes.byteLength });
}

export async function searchImageAssets(uid: number, query?: string, limit = 5): Promise<ImageAsset[]> {
  const session = await getSession(uid);
  const assets = session.imageAssets;
  const bounded = Math.max(1, Math.min(Math.floor(limit) || 5, 10));
  const tokens = (query ?? "").toLowerCase().split(/\s+/).filter((token) => token.length > 1);
  if (!tokens.length) return assets.slice(-bounded).reverse();
  const lexical = assets.map((asset) => ({ asset, score: tokens.reduce((score, token) => score + (`${asset.name} ${asset.purpose} ${asset.description} ${asset.tags.join(" ")}`.toLowerCase().includes(token) ? 1 : 0), 0) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.asset.updatedAt - a.asset.updatedAt);
  const ranked = new Map(lexical.map((item) => [item.asset.id, item.score]));
  if (vectorConfigured()) {
    try {
      const matches = await new UpstashKnowledgeStore().query(uid.toString(), query ?? "", { topK: bounded, filter: "sourceType = 'image_asset'" });
      for (const [index, match] of matches.entries()) {
        const id = typeof match.metadata?.assetId === "string" ? match.metadata.assetId : match.id.replace(/^image_asset:/, "").replace(/:0$/, "");
        if (assets.some((asset) => asset.id === id)) ranked.set(id, (ranked.get(id) ?? 0) + (typeof match.score === "number" ? match.score : 0) + bounded - index);
      }
    } catch (error) { logger.warn({ err: error, userId: uid }, "Image asset semantic search unavailable; using structured search"); }
  }
  return [...ranked.entries()].sort((a, b) => b[1] - a[1]).slice(0, bounded).map(([id]) => assets.find((asset) => asset.id === id)!).filter(Boolean);
}

export async function getImageAsset(uid: number, idOrName: string): Promise<(ImageAsset & { downloadUrl: string }) | undefined> {
  const asset = (await getSession(uid)).imageAssets.find((item) => item.id === idOrName || item.name.toLowerCase() === idOrName.toLowerCase());
  if (!asset || !r2Configured()) return undefined;
  return { ...asset, downloadUrl: await signR2Download(asset.r2Key) };
}

export async function forgetImageAsset(uid: number, idOrName: string): Promise<boolean> {
  const session = await getSession(uid);
  const asset = session.imageAssets.find((item) => item.id === idOrName || item.name.toLowerCase() === idOrName.toLowerCase());
  if (!asset) return false;
  if (r2Configured()) await deleteR2Object(asset.r2Key);
  session.imageAssets = session.imageAssets.filter((item) => item.id !== asset.id);
  await saveSession(uid, session);
  if (vectorConfigured()) void new UpstashKnowledgeStore().deleteDocument(String(uid), `image_asset:${asset.id}`).catch((error) => logger.warn({ err: error, userId: uid, assetId: asset.id }, "Image asset vector deletion unavailable; R2 asset removed"));
  return true;
}

const attentionCollections: Record<AttentionEntityKind, AttentionCollection> = {
  observation: "observations", open_loop: "open-loops", attention_candidate: "attention-candidates",
  standing_order: "standing-orders", delivery_preference: "delivery-preferences",
  relationship: "relationships", project_state: "project-states",
};
const attentionPrefixes: Record<AttentionEntityKind, string> = {
  observation: "obs", open_loop: "loop", attention_candidate: "cand", standing_order: "order",
  delivery_preference: "pref", relationship: "rel", project_state: "proj",
};
const channelProviders: ChannelProvider[] = ["telegram", "slack", "whatsapp", "sendblue", "sms", "xchat", "voice", "cli", "webhook"];

function attentionText(value: unknown, field: string, max = 4000, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (required && !result) throw new Error(`${field} is required`);
  if (result.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return result || undefined;
}
function attentionNumber(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return Math.max(min, Math.min(max, value));
}
function attentionBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}
function attentionTimestamp(value: unknown, field: string, fallback?: number): number | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a timestamp`);
  return Math.round(value);
}
function attentionArray(value: unknown, field: string, maxItems = 20): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be an array of strings`);
  return value.map((item) => item.trim()).filter(Boolean).slice(0, maxItems).map((item) => item.slice(0, 500));
}
function attentionProvider(value: unknown, field: string, fallback?: ChannelProvider): ChannelProvider | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !channelProviders.includes(value as ChannelProvider)) throw new Error(`${field} has an unsupported provider`);
  return value as ChannelProvider;
}
function attentionMetadata(value: unknown): AttentionMetadata | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("metadata must be an object");
  const result: AttentionMetadata = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key)) continue;
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      result[key] = typeof item === "string" ? item.slice(0, 500) : item;
    }
  }
  return result;
}
function attentionStatus(value: unknown, allowed: readonly string[], fallback: string): string {
  const result = value === undefined || value === null ? fallback : String(value);
  if (!allowed.includes(result)) throw new Error(`Unsupported attention status: ${result}`);
  return result;
}
function attentionRecord(collection: AttentionCollection, raw: Record<string, unknown>): AttentionRecord {
  const base = {
    id: attentionText(raw.id, "id", 160, true)!, userId: Number(raw.userId),
    createdAt: attentionTimestamp(raw.createdAt, "createdAt", Date.now())!,
    updatedAt: attentionTimestamp(raw.updatedAt, "updatedAt", Date.now())!,
  };
  if (!Number.isSafeInteger(base.userId) || base.userId < 0) throw new Error("Invalid attention owner");
  switch (collection) {
    case "observations": return {
      ...base, source: attentionText(raw.source, "source", 200, true)!, eventType: attentionText(raw.eventType, "eventType", 200, true)!,
      summary: attentionText(raw.summary, "summary", 4000, true)!, entityId: attentionText(raw.entityId, "entityId", 200), dedupeKey: attentionText(raw.dedupeKey, "dedupeKey", 300),
      metadata: attentionMetadata(raw.metadata), occurredAt: attentionTimestamp(raw.occurredAt, "occurredAt", base.createdAt)!,
      importance: attentionNumber(raw.importance, "importance", 0.5, 0, 1), novelty: attentionNumber(raw.novelty, "novelty", 0.5, 0, 1), confidence: attentionNumber(raw.confidence, "confidence", 0.5, 0, 1),
      privacyScope: raw.privacyScope === "shared" ? "shared" : "private", status: attentionStatus(raw.status, ["new", "processed", "ignored"], "new") as ObservationRecord["status"],
    };
    case "open-loops": return {
      ...base, title: attentionText(raw.title, "title", 300, true)!, objective: attentionText(raw.objective, "objective"), source: attentionText(raw.source, "source", 200),
      priority: attentionNumber(raw.priority, "priority", 0.5, 0, 1), confidence: attentionNumber(raw.confidence, "confidence", 0.5, 0, 1), dueAt: attentionTimestamp(raw.dueAt, "dueAt"), snoozedUntil: attentionTimestamp(raw.snoozedUntil, "snoozedUntil"),
      nextAction: attentionText(raw.nextAction, "nextAction"), waitingFor: attentionText(raw.waitingFor, "waitingFor"), relatedEntityIds: attentionArray(raw.relatedEntityIds, "relatedEntityIds"),
      status: attentionStatus(raw.status, ["open", "waiting", "blocked", "snoozed", "completed", "dismissed"], "open") as OpenLoopRecord["status"],
    };
    case "attention-candidates": return {
      ...base, candidateType: attentionStatus(raw.candidateType, ["nudge", "digest", "prepare", "ask", "act"], "nudge") as AttentionCandidateRecord["candidateType"],
      status: attentionStatus(raw.status, ["pending", "delivered", "accepted", "dismissed", "snoozed", "expired"], "pending") as AttentionCandidateRecord["status"],
      observationId: attentionText(raw.observationId, "observationId", 160), openLoopId: attentionText(raw.openLoopId, "openLoopId", 160), score: attentionNumber(raw.score, "score", 0.5, 0, 1),
      reason: attentionText(raw.reason, "reason", 1000, true)!, proposedAction: attentionText(raw.proposedAction, "proposedAction"), channel: attentionProvider(raw.channel, "channel"),
      availableAt: attentionTimestamp(raw.availableAt, "availableAt"), expiresAt: attentionTimestamp(raw.expiresAt, "expiresAt"),
    };
    case "standing-orders": return {
      ...base, name: attentionText(raw.name, "name", 200, true)!, instruction: attentionText(raw.instruction, "instruction", 4000, true)!, scope: attentionArray(raw.scope, "scope") ?? [],
      authority: attentionStatus(raw.authority, ["observe", "prepare", "execute_reversible"], "observe") as StandingOrderRecord["authority"], constraints: attentionMetadata(raw.constraints),
      status: attentionStatus(raw.status, ["active", "paused", "revoked"], "active") as StandingOrderRecord["status"], expiresAt: attentionTimestamp(raw.expiresAt, "expiresAt"), lastUsedAt: attentionTimestamp(raw.lastUsedAt, "lastUsedAt"),
    };
    case "delivery-preferences": return {
      ...base, provider: attentionProvider(raw.provider, "provider", "telegram")!, conversationId: attentionText(raw.conversationId, "conversationId", 300), enabled: attentionBoolean(raw.enabled, "enabled", true),
      mode: attentionStatus(raw.mode, ["immediate", "digest", "silent"], "silent") as DeliveryPreferenceRecord["mode"],
      maxPerDay: raw.maxPerDay === undefined ? undefined : Math.round(attentionNumber(raw.maxPerDay, "maxPerDay", 10, 0, 1000)), minScore: raw.minScore === undefined ? undefined : attentionNumber(raw.minScore, "minScore", 0.7, 0, 1),
    };
    case "relationships": return {
      ...base, personKey: attentionText(raw.personKey, "personKey", 300, true)!, name: attentionText(raw.name, "name", 300), role: attentionText(raw.role, "role", 300), notes: attentionText(raw.notes, "notes"),
      importance: attentionNumber(raw.importance, "importance", 0.5, 0, 1), lastInteractionAt: attentionTimestamp(raw.lastInteractionAt, "lastInteractionAt"), preferredChannel: attentionProvider(raw.preferredChannel, "preferredChannel"), confidence: attentionNumber(raw.confidence, "confidence", 0.5, 0, 1),
    };
    case "project-states": return {
      ...base, projectKey: attentionText(raw.projectKey, "projectKey", 300, true)!, name: attentionText(raw.name, "name", 300, true)!,
      status: attentionStatus(raw.status, ["active", "paused", "completed", "archived"], "active") as ProjectStateRecord["status"], summary: attentionText(raw.summary, "summary", 4000, true)!,
      currentPhase: attentionText(raw.currentPhase, "currentPhase", 300), nextAction: attentionText(raw.nextAction, "nextAction"), blockers: attentionArray(raw.blockers, "blockers"),
      lastActivityAt: attentionTimestamp(raw.lastActivityAt, "lastActivityAt"), confidence: attentionNumber(raw.confidence, "confidence", 0.5, 0, 1),
    };
  }
}

function safeAttentionRecord(collection: AttentionCollection, raw: unknown): AttentionRecord | undefined {
  try {
    return raw && typeof raw === "object" ? attentionRecord(collection, raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function collectionFor(kind: AttentionEntityKind): AttentionCollection {
  const collection = attentionCollections[kind];
  if (!collection) throw new Error(`Unsupported attention entity: ${String(kind)}`);
  return collection;
}

export async function listAttentionRecords(userId: number, kind: AttentionEntityKind, options: AttentionListOptions = {}): Promise<AttentionRecord[]> {
  const collection = collectionFor(kind);
  const query = options.query?.trim().toLowerCase();
  const records = (await backend.getAttentionRecords(userId, collection)).map((item) => safeAttentionRecord(collection, item)).filter((item): item is AttentionRecord => Boolean(item));
  return records.filter((record) => {
    const status = "status" in record ? record.status : undefined;
    if (options.status && status !== options.status) return false;
    if (!query) return true;
    return JSON.stringify(record).toLowerCase().includes(query);
  }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, Math.min(200, Math.floor(options.limit ?? 50))));
}

export async function getAttentionRecord(userId: number, kind: AttentionEntityKind, id: string): Promise<AttentionRecord | undefined> {
  return (await listAttentionRecords(userId, kind, { limit: 200 })).find((record) => record.id === id);
}

export async function createAttentionRecord(userId: number, kind: AttentionEntityKind, input: Record<string, unknown>): Promise<AttentionRecord> {
  const collection = collectionFor(kind);
  const now = Date.now();
  const raw = { ...input, id: `${attentionPrefixes[kind]}_${randomUUID()}`, userId, createdAt: now, updatedAt: now };
  const created = attentionRecord(collection, raw);
  let result = created;
  await backend.mutateAttentionRecords(userId, collection, (records) => {
    const normalized = records.map((item) => safeAttentionRecord(collection, item)).filter((item): item is AttentionRecord => Boolean(item));
    const dedupeKey = kind === "observation" ? (created as ObservationRecord).dedupeKey : undefined;
    const preference = kind === "delivery_preference" ? created as DeliveryPreferenceRecord : undefined;
    const existing = normalized.find((item) => (dedupeKey && kind === "observation" && (item as ObservationRecord).dedupeKey === dedupeKey) || (preference && kind === "delivery_preference" && (item as DeliveryPreferenceRecord).provider === preference.provider && (item as DeliveryPreferenceRecord).conversationId === preference.conversationId));
    if (existing) { result = existing; return normalized; }
    return [...normalized, created].slice(-200);
  });
  return result;
}

export async function updateAttentionRecord(userId: number, kind: AttentionEntityKind, id: string, patch: Record<string, unknown>): Promise<AttentionRecord | undefined> {
  const collection = collectionFor(kind);
  let result: AttentionRecord | undefined;
  const safePatch = Object.fromEntries(Object.entries(patch).filter(([key, value]) => !["id", "userId", "createdAt", "updatedAt"].includes(key) && value !== undefined));
  await backend.mutateAttentionRecords(userId, collection, (records) => {
    const normalized = records.map((item) => safeAttentionRecord(collection, item)).filter((item): item is AttentionRecord => Boolean(item));
    const index = normalized.findIndex((item) => item.id === id && item.userId === userId);
    if (index < 0) return normalized;
    result = attentionRecord(collection, { ...normalized[index], ...safePatch, id, userId, createdAt: normalized[index].createdAt, updatedAt: Date.now() });
    normalized[index] = result;
    return normalized;
  });
  return result;
}

export async function addHistorySummary(uid: number, summary: string): Promise<void> {
  const s = await getSession(uid);
  s.summaries = [...s.summaries, summary].slice(-10);
  await saveSession(uid, s);
}

export async function createApproval(record: Omit<ApprovalRecord, "id" | "status" | "createdAt" | "expiresAt">, ttlMs = 15 * 60 * 1000): Promise<ApprovalRecord> {
  const approval: ApprovalRecord = { ...record, id: `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, status: "pending", createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
  await backend.saveApproval(approval);
  return approval;
}

export async function getApproval(uid: number, id: string): Promise<ApprovalRecord | undefined> {
  return backend.getApproval(uid, id);
}

export async function setApprovalStatus(uid: number, id: string, status: ApprovalRecord["status"]): Promise<boolean> {
  const approval = await backend.getApproval(uid, id);
  if (!approval) return false;
  if ((status === "approved" || status === "denied") && (approval.status !== "pending" || approval.expiresAt <= Date.now())) return false;
  if (status === "consumed" && approval.status !== "approved") return false;
  approval.status = status;
  await backend.saveApproval(approval);
  return true;
}

export async function claimApproval(uid: number, id: string): Promise<ApprovalRecord | undefined> {
  return backend.claimApproval(uid, id);
}

export async function listApprovals(uid: number, limit = 50): Promise<ApprovalRecord[]> {
  return backend.listApprovals(uid, limit);
}

export async function getChannelIdentity(provider: ChannelProvider, externalUserId: string, workspaceId?: string): Promise<ChannelIdentityRecord | undefined> {
  return backend.getChannelIdentity(provider, externalUserId, workspaceId);
}

export async function listChannelIdentities(userId: number): Promise<ChannelIdentityRecord[]> {
  return backend.listChannelIdentities(userId);
}

export async function saveChannelIdentity(record: ChannelIdentityRecord): Promise<boolean> {
  if (!record.externalUserId.trim() || !record.accountId.trim()) throw new Error("Channel identity requires an account and external user ID");
  return backend.saveChannelIdentity({ ...record, externalUserId: record.externalUserId.trim(), workspaceId: record.workspaceId?.trim() || undefined });
}

export async function getChannelInstallation(provider: ChannelInstallationRecord["provider"], workspaceId: string): Promise<ChannelInstallationRecord | undefined> {
  return backend.getChannelInstallation(provider, workspaceId);
}

export async function saveChannelInstallation(record: ChannelInstallationRecord): Promise<void> {
  if (!record.workspaceId.trim()) throw new Error("Channel installation requires a workspace ID");
  await backend.saveChannelInstallation(record);
}

export async function createChannelOAuthState(userId: number, stateHash: string, ttlMs = 10 * 60 * 1000): Promise<void> {
  await backend.createChannelOAuthState({ provider: "slack", stateHash, userId, expiresAt: Date.now() + ttlMs, used: false });
}

export async function consumeChannelOAuthState(stateHash: string): Promise<ChannelOAuthStateRecord | undefined> {
  return backend.consumeChannelOAuthState(stateHash);
}

export async function createChannelLinkCode(userId: number, provider: ChannelProvider, ttlMs = 10 * 60 * 1000): Promise<string> {
  const code = createPairingCode();
  await backend.createChannelLinkCode({ codeHash: hashCliSecret(code), userId, provider, expiresAt: Date.now() + ttlMs, used: false });
  return code;
}

export async function consumeChannelLinkCode(provider: ChannelProvider, code: string): Promise<ChannelLinkCodeRecord | undefined> {
  return backend.consumeChannelLinkCode(provider, hashCliSecret(code.trim()));
}

export async function createSendblueGroupLinkCode(userId: number, ttlMs = 10 * 60 * 1000): Promise<string> {
  const code = createPairingCode();
  await backend.createSendblueGroupLinkCode({ codeHash: hashCliSecret(code), userId, provider: "sendblue", expiresAt: Date.now() + ttlMs, used: false });
  return code;
}

export async function consumeSendblueGroupLinkCode(code: string): Promise<SendblueGroupLinkCodeRecord | undefined> {
  return backend.consumeSendblueGroupLinkCode(hashCliSecret(code.trim()));
}

export async function getSendblueGroupAuthorization(groupId: string, workspaceId: string): Promise<SendblueGroupAuthorizationRecord | undefined> {
  const group = groupId.trim();
  const workspace = workspaceId.trim();
  return group && workspace ? backend.getSendblueGroupAuthorization(group, workspace) : undefined;
}

export async function saveSendblueGroupAuthorization(record: SendblueGroupAuthorizationRecord): Promise<void> {
  if (!record.groupId.trim() || !record.workspaceId.trim() || !record.ownerExternalUserId.trim()) throw new Error("Sendblue group authorization requires group, workspace, and owner identity");
  await backend.saveSendblueGroupAuthorization({ ...record, groupId: record.groupId.trim(), workspaceId: record.workspaceId.trim(), ownerExternalUserId: record.ownerExternalUserId.trim() });
}

export async function revokeSendblueGroupAuthorization(groupId: string, workspaceId: string, userId: number): Promise<boolean> {
  return backend.revokeSendblueGroupAuthorization(groupId.trim(), workspaceId.trim(), userId);
}

const webTelegramCodePattern = /^web_[A-Za-z0-9_-]{20,}$/;

/** Creates a short-lived proof for a signed-in dashboard user. The raw code is returned once. */
export async function createWebTelegramLinkCode(webAuthUserId: string, ttlMs = 10 * 60 * 1000): Promise<{ code: string; expiresAt: number }> {
  const owner = webAuthUserId.trim();
  if (!owner || owner.length > 200) throw new Error("A valid web account is required");
  const code = `web_${randomBytes(18).toString("base64url")}`;
  const expiresAt = Date.now() + ttlMs;
  await backend.createWebTelegramLinkCode({ codeHash: hashCliSecret(code), webAuthUserId: owner, expiresAt, used: false });
  return { code, expiresAt };
}

/** Redeems a dashboard link proof from the already verified Telegram account. */
export async function redeemWebTelegramLinkCode(code: string, telegramUserId: number): Promise<WebTelegramLinkResult> {
  const clean = code.trim();
  if (!webTelegramCodePattern.test(clean) || !Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return "invalid";
  return backend.redeemWebTelegramLinkCode(hashCliSecret(clean), telegramUserId);
}

export async function getTelegramUserIdForWebAuth(webAuthUserId: string): Promise<number | undefined> {
  const owner = webAuthUserId.trim();
  return owner && owner.length <= 200 ? backend.getTelegramUserIdForWebAuth(owner) : undefined;
}

export async function claimChannelEvent(provider: ChannelProvider, eventId: string, ttlSeconds = 24 * 60 * 60): Promise<boolean> {
  const clean = eventId.trim();
  if (!clean || clean.length > 500) return false;
  return backend.claimChannelEvent(provider, clean, ttlSeconds);
}

export async function completeChannelEvent(provider: ChannelProvider, eventId: string, ttlSeconds = 24 * 60 * 60): Promise<void> {
  if (!eventId.trim()) return;
  await backend.completeChannelEvent(provider, eventId.trim(), ttlSeconds);
}

export async function releaseChannelEvent(provider: ChannelProvider, eventId: string): Promise<void> {
  if (!eventId.trim()) return;
  await backend.releaseChannelEvent(provider, eventId.trim());
}

export async function createChannelInboundEvent(message: InboundMessage): Promise<ChannelInboundEventRecord> {
  const now = Date.now();
  return backend.createChannelInboundEvent({ eventId: `${message.provider}:${message.providerEventId}`, provider: message.provider, message, status: "received", createdAt: now, updatedAt: now });
}

export async function getChannelInboundEvent(eventId: string): Promise<ChannelInboundEventRecord | undefined> {
  return backend.getChannelInboundEvent(eventId);
}

export async function claimChannelInboundEvent(eventId: string): Promise<boolean> {
  return backend.claimChannelInboundEvent(eventId);
}

export async function updateChannelInboundEvent(eventId: string, patch: Partial<ChannelInboundEventRecord>): Promise<ChannelInboundEventRecord | undefined> {
  return backend.updateChannelInboundEvent(eventId, patch);
}

export async function enqueueOutbox(record: Omit<OutboxRecord, "id" | "status" | "attempts" | "createdAt" | "updatedAt">): Promise<OutboxRecord> {
  const now = Date.now();
  const value: OutboxRecord = { ...record, id: `out_${randomUUID()}`, status: "queued", attempts: 0, createdAt: now, updatedAt: now };
  return backend.createOutbox(value);
}

export async function getOutbox(id: string): Promise<OutboxRecord | undefined> {
  return backend.getOutbox(id);
}

export async function claimOutbox(id: string, leaseMs = 30_000): Promise<OutboxRecord | undefined> {
  return backend.claimOutbox(id, Math.max(1_000, Math.min(10 * 60_000, leaseMs)));
}

export async function updateOutbox(id: string, patch: Partial<OutboxRecord>): Promise<OutboxRecord | undefined> {
  return backend.updateOutbox(id, patch);
}

export async function getOutboxByProviderMessageId(provider: ChannelProvider, providerMessageId: string): Promise<OutboxRecord | undefined> {
  return backend.getOutboxByProviderMessageId(provider, providerMessageId);
}

export async function listOutbox(statuses?: OutboxRecord["status"][], limit = 100): Promise<OutboxRecord[]> {
  return backend.listOutbox(statuses, Math.max(1, Math.min(500, limit)));
}

export async function getChannelConversation(id: string): Promise<ChannelConversationRecord | undefined> {
  return backend.getChannelConversation(id);
}

export async function appendChannelConversationMessages(input: Omit<ChannelConversationRecord, "history" | "summaries" | "createdAt" | "updatedAt"> & { messages: Message[] }): Promise<ChannelConversationRecord> {
  const current = await backend.getChannelConversation(input.id);
  const now = Date.now();
  // A group reset may race with a slow agent response. Its incoming message
  // carries the original receive timestamp, so discard that entire stale turn
  // instead of allowing it to recreate context the group explicitly cleared.
  const staleTurn = Boolean(current?.historyClearedAt && input.messages.some((message) => (message.createdAt ?? now) < current.historyClearedAt!));
  const history = staleTurn ? [...(current?.history ?? [])] : [...(current?.history ?? []), ...input.messages];
  const cap = config.maxHistory * 2;
  const overflow = history.length > cap ? history.slice(0, history.length - cap) : [];
  const summaries = [...(current?.summaries ?? []), ...(overflow.length ? [overflow.map((m) => `${m.role}: ${m.content}`).join(" ").slice(0, 1800)] : [])].slice(-10);
  const record: ChannelConversationRecord = {
    id: input.id,
    accountId: input.accountId,
    userId: input.userId,
    provider: input.provider,
    scope: input.scope,
    ...(current?.model ? { model: current.model } : {}),
    history: history.slice(-cap),
    summaries,
    ...(current?.historyClearedAt ? { historyClearedAt: current.historyClearedAt } : {}),
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  await backend.saveChannelConversation(record);
  return record;
}

export async function setChannelConversationModel(id: string, model: string | undefined): Promise<ChannelConversationRecord | undefined> {
  return backend.setChannelConversationModel(id, model);
}

/** Clear only one provider/thread conversation; private account history is unaffected. */
export async function clearChannelConversationHistory(input: Omit<ChannelConversationRecord, "history" | "summaries" | "createdAt" | "updatedAt" | "historyClearedAt">): Promise<ChannelConversationRecord> {
  return backend.clearChannelConversationHistory(input);
}

export async function enqueueChannelDebounce(key: string, message: InboundMessage, ttlSeconds = 30): Promise<void> {
  if (!key.trim()) throw new Error("Debounce key is required");
  await backend.enqueueChannelDebounce(key, message, Math.max(5, Math.min(300, ttlSeconds)));
}

export async function takeChannelDebounce(key: string): Promise<InboundMessage[]> {
  return backend.takeChannelDebounce(key);
}
