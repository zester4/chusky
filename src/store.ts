/**
 * Persistent store — Redis (preferred) or in-memory fallback.
 * Handles: message history, model selection, rate limiting, composio session IDs.
 */
import Redis from "ioredis";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { normalizeVoiceCallProfile, type VoiceCallProfile } from "./calls/voiceProfile.js";
import { logger } from "./logger.js";
import { recordFailure, recordVectorFailure } from "./monitoring.js";
import type { ChannelProvider, InboundMessage, ChannelTemplate } from "./channels/contracts.js";
import type { ApprovalPolicy, HandoffRecord, WorkerDuration } from "./subagents/contracts.js";
import type { CapabilityWorkerName } from "./memory/types.js";
import { UpstashKnowledgeStore, vectorConfigured } from "./lib/knowledge/vector.js";
import { deleteR2Object, putR2Object, r2Configured, signR2Download } from "./lib/storage/r2.js";
import type { ShoppingRun, ShoppingSite } from "./shopping/types.js";
import type { CompanyAgentProfile, CompanyPolicy } from "./companyPlatform.js";
import type { RecallChatCommand } from "./meetings/recall.js";
import { defaultMeetingRepresentativeProfile, normalizeMeetingRepresentativeProfile, type MeetingRepresentativeProfile } from "./meetings/representative.js";
import { normalizeMeetingMission, type MeetingMission } from "./meetings/mission.js";
import { isBlandVoiceId, isFluxTtsVoice, normalizeLiveVoicePreferences, type FluxTtsVoiceId, type LiveVoicePreferences, type LiveVoiceProvider } from "./voiceSettings.js";
import type { EncryptedCredential } from "./vault/crypto.js";
import type { BrowserAuditRecord, BrowserHandoffRecord, BrowserPlaybookRecord } from "./vault/browserOps.js";

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
  /** Per-account voices for the three live call transports, independent of Telegram audio replies. */
  voicePreferences?: LiveVoicePreferences;
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
  phoneCalls?: PhoneCallRecord[];
  recallMeetings?: RecallMeetingRecord[];
  calendarMeetingPreparations?: CalendarMeetingPreparation[];
  meetingRepresentativeProfile?: MeetingRepresentativeProfile;
  videoJobs?: VideoJobRecord[];
  shoppingRuns?: ShoppingRun[];
  shoppingSites?: ShoppingSite[];
  /** Per-user third-party MCP connections. Credentials are encrypted at rest. */
  mcpConnections?: McpConnectionRecord[];
  /** Short-lived encrypted MCP OAuth/PKCE handshakes. Never expose this to clients. */
  mcpOAuthStates?: McpOAuthStateRecord[];
  workflowComposers?: WorkflowComposerRecord[];
  /** Per-origin browser operating recipes; never contains credentials or cookies. */
  browserPlaybooks?: BrowserPlaybookRecord[];
  /** Bounded, owner-visible browser operation history with safe summaries only. */
  browserAudit?: BrowserAuditRecord[];
  /** Durable owner-scoped CAPTCHA/2FA handoff state; never contains the handoff URL or challenge data. */
  browserHandoffs?: BrowserHandoffRecord[];
  /** Organization-owned meeting rooms live in the control session (uid 0). */
  meetingRooms?: MeetingRoomRecord[];
  handoffRecords?: HandoffRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface McpConnectionRecord {
  serverId: string;
  credential?: EncryptedCredential;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface McpOAuthStateRecord {
  state: string;
  serverId: string;
  redirectUri: string;
  secret: EncryptedCredential;
  createdAt: number;
  expiresAt: number;
}

/** Contact information a participant shared for an agreed meeting follow-up. Kept outside general memory. */
export interface MeetingContactRecord {
  id: string;
  userId: number;
  meetingId: string;
  participantName: string;
  email?: string;
  phone?: string;
  contactPreference: "email" | "phone" | "unspecified";
  interest: string;
  nextStep?: string;
  followUpAt?: number;
  followUpTaskId?: string;
  createdAt: number;
  updatedAt: number;
}

export type MeetingRoomVisibility = "private" | "team" | "organization";
export type MeetingRoomMode = "addressed" | "copilot" | "representative";

export interface MeetingRoomPolicy {
  defaultMode: MeetingRoomMode;
  visibility: MeetingRoomVisibility;
  transcriptRetentionDays?: 1 | 7 | 30;
  allowScreenUnderstanding: boolean;
  requireApprovalForExternalActions: boolean;
  allowedComposioTools: string[];
  allowedNativeTools: string[];
}

/** Organization-owned meeting policy. Live provider state remains in the owner session. */
export interface MeetingRoomRecord {
  id: string;
  organizationId: string;
  teamId?: string;
  projectId?: string;
  name: string;
  description?: string;
  createdByWebAuthUserId: string;
  policy: MeetingRoomPolicy;
  meetingPointers?: Array<{ meetingId: string; ownerUserId: number; createdAt: number }>;
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
/** Safe call metadata. Provider credentials and media are never persisted here. */
export interface PhoneCallRecord {
  id: string;
  userId: number;
  /** Explicit provider keeps shared safe call storage transport-aware. */
  provider?: "legacy" | "twilio" | "bland";
  direction?: "inbound" | "outbound";
  /** Separates a private personal call brief from a company/business brief. */
  callProfile?: "personal" | "business";
  /** Inbound business calls advance public -> identified -> verified. */
  callVerification?: "public" | "identified" | "verified";
  phoneNumber: string;
  purpose: string;
  /** Approved representation details and read-only capability scope. */
  voiceProfile?: VoiceCallProfile;
  status: "starting" | "bridging" | "active" | "ended" | "failed";
  providerCallId?: string;
  error?: string;
  /** Bland's post-call analysis, safely bounded and scoped to this owner. */
  summary?: string;
  callLengthSeconds?: number;
  postCallProcessedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type RecallMeetingStatus = "creating" | "scheduled" | "joining" | "waiting_room" | "in_call" | "leaving" | "ended" | "failed";

export interface RecallMeetingOutcome {
  title: string;
  summary: string;
  decisions: string[];
  actionItems: { task: string; owner: string; dueDate?: string }[];
  openQuestions: string[];
}

export interface RecallMeetingFollowThrough {
  notionSaved?: boolean;
  notionTool?: string;
  notionUrl?: string;
  completedTools?: string[];
}

/** Bounded, meeting-only attendee state. Display names are not identity proof or general memory. */
export interface RecallMeetingParticipant {
  id: string;
  name: string;
  /** Recall supplied a non-empty display name, or the platform did not expose one. */
  identityStatus?: "named" | "unknown";
  isHost?: boolean;
  status: "present" | "left";
  updatedAt: number;
}

/** Short-lived Recall speaker transitions; contains no transcript or email. */
export interface RecallMeetingSpeakerEvent {
  type: "speech_on" | "speech_off";
  participantId?: string;
  at: number;
}

/** A final, normalized Recall transcript segment; it contains no provider payload. */
export interface RecallTranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  speakerName?: string;
}

export interface RecallTranscriptRecord {
  segments: RecallTranscriptSegment[];
  truncated: boolean;
}

interface StoredRecallTranscriptSegment {
  id: string;
  startMs: number;
  sealed: string;
}

/** Owner-scoped meeting metadata and bounded text context. Never stores a meeting URL or media. */
export interface RecallMeetingRecord {
  id: string;
  userId: number;
  /** Optional workspace scope; absent means a private owner meeting. */
  roomId?: string;
  organizationId?: string;
  teamId?: string;
  projectId?: string;
  visibility?: MeetingRoomVisibility;
  roomAllowedComposioTools?: string[];
  roomAllowedNativeTools?: string[];
  platform: "zoom" | "google_meet" | "microsoft_teams" | "webex";
  /** addressed is conservative default; copilot is explicit per-meeting opt-in. */
  interactionMode?: "addressed" | "copilot" | "representative";
  /** Explicit owner opt-in to transient shared-screen PNG context for supported platforms. */
  visualContextEnabled?: boolean;
  /** Explicit owner opt-in; omitted means the transcript is deleted after outcome processing. */
  transcriptRetentionDays?: 1 | 7 | 30;
  /** Absolute expiry for a deliberately retained transcript; never set for default ephemeral transcripts. */
  transcriptExpiresAt?: number;
  /** Sanitized provider artifact state for diagnosing failures in the optional live transcript path. */
  transcriptStatus?: "processing" | "ready" | "failed";
  transcriptErrorCode?: string;
  status: RecallMeetingStatus;
  providerBotId?: string;
  /** SHA-256 of the link, used only to suppress concurrent duplicate joins. */
  meetingUrlHash: string;
  /** Hash of URL plus scheduled instance; legacy records omit it. */
  meetingInstanceHash?: string;
  /** Internal ownership marker for a bot scheduled from this exact Calendar event. */
  calendarPreparationId?: string;
  title?: string;
  /** Explicit owner-selected client context. Never contains a meeting URL or raw provider payload. */
  mission?: MeetingMission;
  joinAt?: string;
  error?: string;
  providerStatusAt?: number;
  /** Live roster is available only while this meeting is active and is cleared at completion. */
  participantRoster?: RecallMeetingParticipant[];
  /** Bounded active-speaker timing for the current live meeting; cleared at completion. */
  speakerEvents?: RecallMeetingSpeakerEvent[];
  history: Message[];
  /** Temporary, account-private source for the outcome job; erased on completion. */
  outcomeTranscript?: Array<{ role: "participant" | "chusky"; content: string; speakerName?: string }>;
  outcomeTranscriptCapturedAt?: number;
  /** Owner-private structured follow-through; never contains the raw provider payload. */
  outcome?: RecallMeetingOutcome;
  outcomeFollowThrough?: RecallMeetingFollowThrough;
  outcomeStatus?: "pending" | "completed";
  /** At-most-once owner notification ledger; claimed survives a workflow crash. */
  outcomeNotificationStatus?: "pending" | "claimed" | "delivered";
  createdAt: number;
  updatedAt: number;
}

/** Owner-private calendar meeting dossier. The meeting URL is AES-GCM sealed at rest. */
export interface CalendarMeetingPreparation {
  id: string;
  userId: number;
  sourceTriggerEventId: string;
  calendarEventId?: string;
  lifecycle: "created" | "updated" | "sync" | "starting_soon" | "attendee_response" | "cancelled";
  status: "prepared" | "cancelled" | "joined" | "expired";
  /** Owned Chusky meeting record created for this calendar event, if any. */
  meetingId?: string;
  /** Distinguishes owner-requested joins from calendar-autopilot joins for safe cancellation. */
  automatic?: boolean;
  /** Whether the latest verified Calendar event still has a supported meeting link. */
  meetingUrlAvailable?: boolean;
  title?: string;
  startAt?: string;
  endAt?: string;
  participants: string[];
  /** Never return this field through a user-facing tool. */
  sealedMeetingUrl?: string;
  createdAt: number;
  updatedAt: number;
}

/** Short-lived, account-scoped queue item for an explicitly addressed meeting-chat event. */
export interface RecallChatEventRecord {
  eventId: string;
  userId: number;
  meetingId: string;
  providerBotId: string;
  command?: RecallChatCommand;
  /** Temporary signed-provider display name, cleared when webhook work completes. */
  senderName?: string;
  replyToParticipantId?: string;
  /** Ephemeral prepared reply; cleared after delivery along with command text. */
  reply?: string;
  replyCost?: number;
  status: "queued" | "running" | "completed" | "failed";
  workflowRunId?: string;
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
  /** Better Auth organization that owns this project; Composio remains the connection manager. */
  organizationId?: string;
  /** Policy and agent definitions are project-scoped and never stored in a user conversation. */
  companyPolicy?: CompanyPolicy;
  companyAgents?: CompanyAgentProfile[];
  /** Project-scoped replay protection for agent-profile creation. */
  agentIdempotency?: Record<string, { fingerprint: string; response: unknown; createdAt: number }>;
  /** Telegram owner for keys generated through Chusky's private Telegram UI. */
  ownerTelegramUserId?: number;
  rotatedAt?: number;
  revokedAt?: number;
}

export interface SdkRunArtifact {
  /** Safe metadata only; the artifact path, sandbox, and bytes never leave the server. */
  id: string;
  name: string;
  type: ArtifactType;
  contentType: string;
  size: number;
}

export interface SdkRunRecord {
  id: string;
  /** Set only for runs submitted through a project key; used for company-level status reporting. */
  companyProjectId?: string;
  status: "queued" | "running" | "requires_approval" | "completed" | "failed" | "cancelled";
  input: string;
  model?: string;
  agentId?: string;
  agentName?: string;
  /** Private snapshot used when an approval or durable run resumes. Never expose in runView. */
  agentInstructions?: string;
  /** Verified R2 uploads used for this run. Keys are intentionally never exposed. */
  attachments?: Array<{ id: string; name: string; contentType: string; size: number }>;
  /** Generated artifacts made available by this run. Only safe metadata is persisted. */
  artifacts?: SdkRunArtifact[];
  output?: string;
  cost?: number;
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

export interface CompanyRunSummary {
  id: string;
  status: SdkRunRecord["status"];
  agentId?: string;
  agentName?: string;
  cost?: number;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyAuditEvent {
  id: string;
  requestId: string;
  action: string;
  status: number;
  at: number;
}

export interface CompanyUsagePeriod {
  month: string;
  completedRuns: number;
  costUsd: number;
}

export interface CompanyBranding {
  organizationId: string;
  displayName: string;
  logoUrl?: string;
  accentColor: string;
  backgroundColor: string;
  customDomain?: string;
  customDomainStatus: "not_configured" | "pending_dns";
  updatedAt: number;
}

function usageMonth(at: number, offset = 0): string {
  const date = new Date(at);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - offset, 1)).toISOString().slice(0, 7);
}

function companyProjectDigest(projectId: string): string {
  return createHash("sha256").update(projectId).digest("hex");
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
  sdkInstructions?: string;
  /** Narrow delayed meeting follow-up context; deliberately excludes general chat history and arbitrary tools. */
  meetingFollowUp?: {
    meetingId: string;
    contactId: string;
    emailTool: string;
    state: "scheduled" | "claimed" | "completed" | "ambiguous";
  };
  /** Link a durable task to one independently executable Composer stage. */
  composerWorkflowId?: string;
  composerStageId?: string;
  composerBudgetSeconds?: number;
}

export type ComposerStageStatus = "pending" | "running" | "completed" | "blocked" | "failed" | "cancelled";
export interface ComposerStage {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  status: ComposerStageStatus;
  requiresApproval: boolean;
  retryLimit: number;
  budgetSeconds?: number;
  taskId?: string;
  approvalId?: string;
  result?: string;
}
export interface WorkflowComposerRecord {
  id: string;
  name: string;
  description?: string;
  stages: ComposerStage[];
  status: "draft" | "queued" | "running" | "completed" | "failed" | "cancelled";
  taskId?: string;
  workflowRunId?: string;
  createdAt: number;
  updatedAt: number;
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
  /** Standard recurring work or the owner-enabled attention governor. */
  kind?: "standard" | "attention_pulse";
  attentionPulse?: { lastDigestKey?: string; lastDeliveredAt?: number; lastDeliveredDayUtc?: string; deliveriesToday?: number };
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
  /** Scope of the conversation that originally requested the approval. */
  channelScope?: "private" | "shared";
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
  saveCompanyRun(projectId: string, run: CompanyRunSummary): Promise<void>;
  completeCompanyRun(projectId: string, run: CompanyRunSummary, completedAt: number): Promise<boolean>;
  listCompanyRuns(projectId: string, limit: number): Promise<CompanyRunSummary[]>;
  appendCompanyAudit(projectId: string, event: CompanyAuditEvent): Promise<void>;
  listCompanyAudit(projectId: string, limit: number): Promise<CompanyAuditEvent[]>;
  listCompanyUsage(projectId: string, periods: number, now: number): Promise<CompanyUsagePeriod[]>;
  getCompanyBranding(organizationId: string): Promise<CompanyBranding | undefined>;
  saveCompanyBranding(record: CompanyBranding): Promise<void>;
  findCompanyBrandingByDomain(hostname: string): Promise<CompanyBranding | undefined>;
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
  claimDeliveryLease(key: string, token: string, leaseMs: number): Promise<"acquired" | "completed" | "busy">;
  completeDeliveryLease(key: string, token: string, ttlSeconds: number): Promise<boolean>;
  releaseDeliveryLease(key: string, token: string): Promise<boolean>;
  linkBlandProviderCall(providerCallId: string, userId: number, callId: string): Promise<boolean>;
  getBlandProviderCall(providerCallId: string): Promise<{ userId: number; callId: string } | undefined>;
  claimRecallMeetingCreation(userId: number, instanceHash: string, token: string, leaseMs: number): Promise<boolean>;
  releaseRecallMeetingCreation(userId: number, instanceHash: string, token: string): Promise<boolean>;
  putRecallVisualFrame(userId: number, meetingId: string, encryptedFrame: string, ttlSeconds: number, minIntervalSeconds: number): Promise<boolean>;
  readRecallVisualFrame(userId: number, meetingId: string): Promise<string | undefined>;
  appendRecallTranscriptSegment(userId: number, meetingId: string, segment: StoredRecallTranscriptSegment, ttlSeconds: number): Promise<"stored" | "duplicate" | "full">;
  readRecallTranscript(userId: number, meetingId: string): Promise<{ segments: StoredRecallTranscriptSegment[]; truncated: boolean } | undefined>;
  setRecallTranscriptTtl(userId: number, meetingId: string, ttlSeconds: number): Promise<boolean>;
  deleteRecallTranscript(userId: number, meetingId: string): Promise<boolean>;
  claimRecallCopilotEvaluation(userId: number, meetingId: string, minIntervalSeconds: number, nowMs?: number): Promise<"allowed" | "interval">;
  createRecallChatEvent(record: RecallChatEventRecord): Promise<RecallChatEventRecord>;
  getRecallChatEvent(eventId: string, userId?: number): Promise<RecallChatEventRecord | undefined>;
  updateRecallChatEvent(eventId: string, patch: Partial<RecallChatEventRecord>): Promise<RecallChatEventRecord | undefined>;
  upsertMeetingContact(record: MeetingContactRecord): Promise<MeetingContactRecord>;
  listMeetingContacts(userId: number, limit: number): Promise<MeetingContactRecord[]>;
  deleteMeetingContact(userId: number, id: string): Promise<boolean>;
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
  listOutbox(statuses?: OutboxRecord["status"][], limit?: number, userId?: number): Promise<OutboxRecord[]>;
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
const RECALL_TRANSCRIPT_MAX_SEGMENTS = 8_000;
const RECALL_TRANSCRIPT_MAX_BYTES = 200_000;
const RECALL_TRANSCRIPT_EPHEMERAL_TTL_SECONDS = 6 * 60 * 60;

function validRecallTranscriptSegment(value: unknown): value is RecallTranscriptSegment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const segment = value as Record<string, unknown>;
  return typeof segment.id === "string" && /^[a-f0-9]{64}$/.test(segment.id)
    && Number.isSafeInteger(segment.startMs) && Number(segment.startMs) >= 0 && Number(segment.startMs) <= 7_200_000
    && Number.isSafeInteger(segment.endMs) && Number(segment.endMs) >= Number(segment.startMs) && Number(segment.endMs) <= 7_200_000
    && typeof segment.text === "string" && segment.text.trim().length > 0 && segment.text.length <= 2_000
    && (segment.speakerId === undefined || typeof segment.speakerId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(segment.speakerId))
    && (segment.speakerName === undefined || typeof segment.speakerName === "string" && segment.speakerName.trim().length > 0 && segment.speakerName.length <= 160);
}

function recallTranscriptEncryptionKey(): Buffer {
  const secret = config.recallTranscriptEncryptionKey || config.recallMediaBridgeSecret;
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) throw new Error("Recall transcript encryption is not configured");
  return createHmac("sha256", secret).update("chusky:recall:transcript:key:v1", "utf8").digest();
}

function recallTranscriptAad(userId: number, meetingId: string, id: string, startMs: number): Buffer {
  return Buffer.from(`chusky-recall-transcript-v1\0${userId}\0${meetingId}\0${id}\0${startMs}`, "utf8");
}

function sealRecallTranscriptSegment(userId: number, meetingId: string, segment: RecallTranscriptSegment): StoredRecallTranscriptSegment {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", recallTranscriptEncryptionKey(), iv);
  cipher.setAAD(recallTranscriptAad(userId, meetingId, segment.id, segment.startMs));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(segment), "utf8"), cipher.final()]);
  return { id: segment.id, startMs: segment.startMs, sealed: `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}` };
}

function openRecallTranscriptSegment(userId: number, meetingId: string, stored: unknown): RecallTranscriptSegment | undefined {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return undefined;
  const record = stored as Record<string, unknown>;
  if (typeof record.id !== "string" || !/^[a-f0-9]{64}$/.test(record.id) || !Number.isSafeInteger(record.startMs)
    || Number(record.startMs) < 0 || typeof record.sealed !== "string" || record.sealed.length > 8_192) return undefined;
  const [version, ivText, tagText, ciphertextText, extra] = record.sealed.split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText || extra !== undefined) return undefined;
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const ciphertext = Buffer.from(ciphertextText, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 2 || ciphertext.length > 4_096) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", recallTranscriptEncryptionKey(), iv);
    decipher.setAAD(recallTranscriptAad(userId, meetingId, record.id, Number(record.startMs)));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const segment = JSON.parse(plaintext) as unknown;
    return validRecallTranscriptSegment(segment) && segment.id === record.id && segment.startMs === record.startMs ? segment : undefined;
  } catch { return undefined; }
}
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
  // Redis hash tags keep every key touched by one project's Lua transaction in the same cluster slot.
  private companyPrefix = (projectId: string) => `chuck:sdk:company:{${companyProjectDigest(projectId)}}`;
  private companyRunsDataKey = (projectId: string) => `${this.companyPrefix(projectId)}:runs:data`;
  private companyRunsIndexKey = (projectId: string) => `${this.companyPrefix(projectId)}:runs:index`;
  private companyAuditKey = (projectId: string) => `${this.companyPrefix(projectId)}:audit`;
  private companyCompletionKey = (projectId: string, runId: string) => `${this.companyPrefix(projectId)}:completion:${createHash("sha256").update(runId).digest("hex")}`;
  private companyUsageKey = (projectId: string, month: string) => `${this.companyPrefix(projectId)}:usage:${month}`;
  private brandingKey = (organizationId: string) => `chuck:organization:branding:${createHash("sha256").update(organizationId).digest("hex")}`;
  private brandingDomainKey = (hostname: string) => `chuck:organization:branding-domain:${createHash("sha256").update(hostname).digest("hex")}`;
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
  private recallChatEventKey = (id: string) => `chuck:recall:chat-event:${createHash("sha256").update(id).digest("hex")}`;
  private recallVisualDigest = (userId: number, meetingId: string) => createHash("sha256").update(`${userId}:${meetingId}`).digest("hex");
  private recallVisualFrameKey = (userId: number, meetingId: string) => `chuck:recall:visual:frame:${this.recallVisualDigest(userId, meetingId)}`;
  private recallVisualRateKey = (userId: number, meetingId: string) => `chuck:recall:visual:rate:${this.recallVisualDigest(userId, meetingId)}`;
  private recallTranscriptKey = (userId: number, meetingId: string) => `chuck:recall:transcript:${this.recallVisualDigest(userId, meetingId)}`;
  private meetingContactsKey = (id: number) => `chuck:meeting-contacts:${id}`;
  private meetingContactsIndexKey = (id: number) => `chuck:meeting-contacts:${id}:index`;
  private recallMeetingCreationKey = (userId: number, instanceHash: string) => `chuck:recall:meeting:create:${createHash("sha256").update(`${userId}:${instanceHash}`).digest("hex")}`;
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

  async saveCompanyRun(projectId: string, run: CompanyRunSummary): Promise<void> {
    await this.r.eval(
      "local prior=redis.call('HGET',KEYS[1],ARGV[1]); if prior and cjson.decode(prior).status=='completed' and cjson.decode(ARGV[3]).status~='completed' then return 0 end; redis.call('HSET',KEYS[1],ARGV[1],ARGV[3]); redis.call('ZADD',KEYS[2],ARGV[2],ARGV[1]); local n=redis.call('ZCARD',KEYS[2]); if n>1000 then local old=redis.call('ZRANGE',KEYS[2],0,n-1001); for _,id in ipairs(old) do redis.call('HDEL',KEYS[1],id) end; redis.call('ZREMRANGEBYRANK',KEYS[2],0,n-1001) end; redis.call('EXPIRE',KEYS[1],7776000); redis.call('EXPIRE',KEYS[2],7776000); return 1",
      2, this.companyRunsDataKey(projectId), this.companyRunsIndexKey(projectId), run.id, String(run.updatedAt), JSON.stringify(run),
    );
  }

  async completeCompanyRun(projectId: string, run: CompanyRunSummary, completedAt: number): Promise<boolean> {
    const month = usageMonth(completedAt);
    const result = await this.r.eval(
      "redis.call('HSET',KEYS[1],ARGV[1],ARGV[3]); redis.call('ZADD',KEYS[2],ARGV[2],ARGV[1]); local n=redis.call('ZCARD',KEYS[2]); if n>1000 then local old=redis.call('ZRANGE',KEYS[2],0,n-1001); for _,id in ipairs(old) do redis.call('HDEL',KEYS[1],id) end; redis.call('ZREMRANGEBYRANK',KEYS[2],0,n-1001) end; redis.call('EXPIRE',KEYS[1],7776000); redis.call('EXPIRE',KEYS[2],7776000); local claimed=redis.call('SET',KEYS[3],'1','EX',31536000,'NX'); if not claimed then return 0 end; redis.call('HINCRBY',KEYS[4],'completedRuns',1); redis.call('HINCRBYFLOAT',KEYS[4],'costUsd',ARGV[5]); redis.call('EXPIRE',KEYS[4],34560000); return 1",
      4,
      this.companyRunsDataKey(projectId), this.companyRunsIndexKey(projectId), this.companyCompletionKey(projectId, run.id), this.companyUsageKey(projectId, month),
      run.id, String(run.updatedAt), JSON.stringify(run), String(completedAt), String(Math.max(0, run.cost ?? 0)),
    );
    return Number(result) === 1;
  }

  async listCompanyRuns(projectId: string, limit: number): Promise<CompanyRunSummary[]> {
    const ids = await this.r.zrevrange(this.companyRunsIndexKey(projectId), 0, Math.max(0, limit - 1));
    if (!ids.length) return [];
    const values = await this.r.hmget(this.companyRunsDataKey(projectId), ...ids);
    return values.flatMap((value) => {
      if (!value) return [];
      try { return [JSON.parse(value) as CompanyRunSummary]; } catch { return []; }
    });
  }

  async appendCompanyAudit(projectId: string, event: CompanyAuditEvent): Promise<void> {
    await this.r.eval(
      "redis.call('LPUSH',KEYS[1],ARGV[1]); redis.call('LTRIM',KEYS[1],0,499); redis.call('EXPIRE',KEYS[1],34560000); return 1",
      1, this.companyAuditKey(projectId), JSON.stringify(event),
    );
  }

  async listCompanyAudit(projectId: string, limit: number): Promise<CompanyAuditEvent[]> {
    const values = await this.r.lrange(this.companyAuditKey(projectId), 0, Math.max(0, limit - 1));
    return values.flatMap((value) => {
      try { return [JSON.parse(value) as CompanyAuditEvent]; } catch { return []; }
    });
  }

  async listCompanyUsage(projectId: string, periods: number, now: number): Promise<CompanyUsagePeriod[]> {
    return Promise.all(Array.from({ length: periods }, async (_value, offset) => {
      const month = usageMonth(now, offset);
      const record = await this.r.hgetall(this.companyUsageKey(projectId, month));
      const completedRuns = Number(record.completedRuns ?? 0);
      const costUsd = Number(record.costUsd ?? 0);
      return { month, completedRuns: Number.isSafeInteger(completedRuns) && completedRuns >= 0 ? completedRuns : 0, costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : 0 };
    }));
  }
  async getCompanyBranding(organizationId: string): Promise<CompanyBranding | undefined> {
    const raw = await this.r.get(this.brandingKey(organizationId));
    if (!raw) return undefined;
    try { return JSON.parse(raw) as CompanyBranding; } catch { return undefined; }
  }
  async saveCompanyBranding(record: CompanyBranding): Promise<void> {
    const key = this.brandingKey(record.organizationId);
    const previous = await this.getCompanyBranding(record.organizationId);
    if (previous?.customDomain && previous.customDomain !== record.customDomain) await this.r.del(this.brandingDomainKey(previous.customDomain));
    await this.r.set(key, JSON.stringify(record));
    if (record.customDomain) await this.r.set(this.brandingDomainKey(record.customDomain), record.organizationId);
  }
  async findCompanyBrandingByDomain(hostname: string): Promise<CompanyBranding | undefined> {
    const organizationId = await this.r.get(this.brandingDomainKey(hostname));
    return organizationId ? this.getCompanyBranding(organizationId) : undefined;
  }
  async linkBlandProviderCall(providerCallId: string, userId: number, callId: string): Promise<boolean> {
    const key = `chuck:bland:provider:${createHash("sha256").update(providerCallId).digest("hex")}`;
    const value = JSON.stringify({ userId, callId });
    const result = await this.r.eval(
      "local prior=redis.call('GET',KEYS[1]); if not prior then redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]); return 1 end; if prior==ARGV[1] then redis.call('EXPIRE',KEYS[1],ARGV[2]); return 1 end; return 0",
      1, key, value, String(30 * 24 * 60 * 60),
    );
    return Number(result) === 1;
  }
  async getBlandProviderCall(providerCallId: string): Promise<{ userId: number; callId: string } | undefined> {
    const key = `chuck:bland:provider:${createHash("sha256").update(providerCallId).digest("hex")}`;
    const raw = await this.r.get(key);
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as { userId?: unknown; callId?: unknown };
      return Number.isSafeInteger(value.userId) && Number(value.userId) > 0 && typeof value.callId === "string"
        ? { userId: Number(value.userId), callId: value.callId } : undefined;
    } catch { return undefined; }
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

  async createRecallChatEvent(record: RecallChatEventRecord): Promise<RecallChatEventRecord> {
    const key = this.recallChatEventKey(record.eventId);
    await this.r.set(key, JSON.stringify(record), "EX", 60 * 60, "NX");
    return (await this.getRecallChatEvent(record.eventId)) ?? record;
  }
  async getRecallChatEvent(eventId: string, userId?: number): Promise<RecallChatEventRecord | undefined> {
    const raw = await this.r.get(this.recallChatEventKey(eventId));
    if (!raw) return undefined;
    try {
      const record = JSON.parse(raw) as RecallChatEventRecord;
      return userId === undefined || record.userId === userId ? record : undefined;
    } catch { return undefined; }
  }
  async updateRecallChatEvent(eventId: string, patch: Partial<RecallChatEventRecord>): Promise<RecallChatEventRecord | undefined> {
    const key = this.recallChatEventKey(eventId);
    const current = await this.getRecallChatEvent(eventId);
    if (!current) return undefined;
    const next = { ...current, ...patch, eventId: current.eventId, updatedAt: Date.now() };
    const ttl = await this.r.ttl(key);
    if (ttl <= 0) return undefined;
    await this.r.setex(key, ttl, JSON.stringify(next));
    return next;
  }

  async upsertMeetingContact(record: MeetingContactRecord): Promise<MeetingContactRecord> {
    const script = [
      "local prior = redis.call('HGET', KEYS[1], ARGV[1])",
      "local next = cjson.decode(ARGV[2])",
      "if prior then local ok, old = pcall(cjson.decode, prior); if ok and old.createdAt then next.createdAt = old.createdAt end end",
      "local encoded = cjson.encode(next)",
      "redis.call('HSET', KEYS[1], ARGV[1], encoded)",
      "redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])",
      "local excess = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[4])",
      "if excess > 0 then local expired = redis.call('ZRANGE', KEYS[2], 0, excess - 1); for _, id in ipairs(expired) do redis.call('HDEL', KEYS[1], id) end; redis.call('ZREMRANGEBYRANK', KEYS[2], 0, excess - 1) end",
      "return encoded",
    ].join("\n");
    const raw = await this.r.eval(script, 2, this.meetingContactsKey(record.userId), this.meetingContactsIndexKey(record.userId), record.id, JSON.stringify(record), record.updatedAt, 200) as string;
    return JSON.parse(raw) as MeetingContactRecord;
  }
  async listMeetingContacts(userId: number, limit: number): Promise<MeetingContactRecord[]> {
    const ids = await this.r.zrevrange(this.meetingContactsIndexKey(userId), 0, Math.max(0, limit - 1));
    const values = await Promise.all(ids.map((id) => this.r.hget(this.meetingContactsKey(userId), id)));
    return values.flatMap((raw) => {
      if (!raw) return [];
      try { const record = JSON.parse(raw) as MeetingContactRecord; return record.userId === userId ? [record] : []; }
      catch { return []; }
    });
  }
  async deleteMeetingContact(userId: number, id: string): Promise<boolean> {
    const removed = await this.r.eval(
      "local n = redis.call('HDEL', KEYS[1], ARGV[1]); redis.call('ZREM', KEYS[2], ARGV[1]); return n",
      2, this.meetingContactsKey(userId), this.meetingContactsIndexKey(userId), id,
    );
    return Number(removed) === 1;
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
  async claimDeliveryLease(key: string, token: string, leaseMs: number): Promise<"acquired" | "completed" | "busy"> {
    const digest = createHash("sha256").update(key).digest("hex");
    const result = await this.r.eval(
      "if redis.call('EXISTS',KEYS[1]) == 1 then return 2 end; " +
      "if redis.call('SET',KEYS[2],ARGV[1],'PX',ARGV[2],'NX') then return 1 else return 0 end",
      2, `chuck:delivery:done:${digest}`, `chuck:delivery:lease-claim:${digest}`, token, String(leaseMs),
    );
    return Number(result) === 1 ? "acquired" : Number(result) === 2 ? "completed" : "busy";
  }
  async completeDeliveryLease(key: string, token: string, ttlSeconds: number): Promise<boolean> {
    const digest = createHash("sha256").update(key).digest("hex");
    const result = await this.r.eval(
      "if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end; " +
      "redis.call('SET',KEYS[2],'1','EX',ARGV[2]); redis.call('DEL',KEYS[1]); return 1",
      2, `chuck:delivery:lease-claim:${digest}`, `chuck:delivery:done:${digest}`, token, String(ttlSeconds),
    );
    return Number(result) === 1;
  }
  async releaseDeliveryLease(key: string, token: string): Promise<boolean> {
    const digest = createHash("sha256").update(key).digest("hex");
    const result = await this.r.eval(
      "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
      1, `chuck:delivery:lease-claim:${digest}`, token,
    );
    return Number(result) === 1;
  }
  async claimRecallMeetingCreation(userId: number, instanceHash: string, token: string, leaseMs: number): Promise<boolean> {
    return (await this.r.set(this.recallMeetingCreationKey(userId, instanceHash), token, "PX", leaseMs, "NX")) === "OK";
  }
  async releaseRecallMeetingCreation(userId: number, instanceHash: string, token: string): Promise<boolean> {
    const result = await this.r.eval(
      "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
      1, this.recallMeetingCreationKey(userId, instanceHash), token,
    );
    return Number(result) === 1;
  }
  async putRecallVisualFrame(userId: number, meetingId: string, encryptedFrame: string, ttlSeconds: number, minIntervalSeconds: number): Promise<boolean> {
    const result = await this.r.eval(
      "if redis.call('SET',KEYS[1],'1','EX',ARGV[2],'NX') then redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[3]); return 1 else return 0 end",
      2, this.recallVisualRateKey(userId, meetingId), this.recallVisualFrameKey(userId, meetingId), encryptedFrame, String(minIntervalSeconds), String(ttlSeconds),
    );
    return Number(result) === 1;
  }
  async readRecallVisualFrame(userId: number, meetingId: string): Promise<string | undefined> {
    const value = await this.r.get(this.recallVisualFrameKey(userId, meetingId));
    return typeof value === "string" ? value : undefined;
  }
  async appendRecallTranscriptSegment(userId: number, meetingId: string, segment: StoredRecallTranscriptSegment, ttlSeconds: number): Promise<"stored" | "duplicate" | "full"> {
    const key = this.recallTranscriptKey(userId, meetingId);
    const meta = `${key}:meta`;
    const member = JSON.stringify(segment);
    const result = Number(await this.r.eval(
      "if redis.call('HGET',KEYS[2],'truncated') == '1' then redis.call('EXPIRE',KEYS[1],ARGV[4]); redis.call('EXPIRE',KEYS[2],ARGV[4]); return -1 end; " +
      "if redis.call('ZSCORE',KEYS[1],ARGV[1]) then return 0 end; " +
      "local count = redis.call('ZCARD',KEYS[1]); local bytes = tonumber(redis.call('HGET',KEYS[2],'bytes') or '0'); local nextBytes = string.len(ARGV[2]); " +
      "if count >= tonumber(ARGV[3]) or bytes + nextBytes > tonumber(ARGV[5]) then redis.call('HSET',KEYS[2],'truncated','1'); redis.call('EXPIRE',KEYS[1],ARGV[4]); redis.call('EXPIRE',KEYS[2],ARGV[4]); return -1 end; " +
      "redis.call('ZADD',KEYS[1],ARGV[6],ARGV[2]); redis.call('HINCRBY',KEYS[2],'bytes',nextBytes); redis.call('EXPIRE',KEYS[1],ARGV[4]); redis.call('EXPIRE',KEYS[2],ARGV[4]); return 1",
      2, key, meta, segment.id, member, String(RECALL_TRANSCRIPT_MAX_SEGMENTS), String(ttlSeconds), String(RECALL_TRANSCRIPT_MAX_BYTES), String(segment.startMs),
    ));
    return result === 1 ? "stored" : result === 0 ? "duplicate" : "full";
  }
  async readRecallTranscript(userId: number, meetingId: string): Promise<{ segments: StoredRecallTranscriptSegment[]; truncated: boolean } | undefined> {
    const key = this.recallTranscriptKey(userId, meetingId);
    const [members, truncated] = await Promise.all([
      this.r.zrange(key, 0, -1),
      this.r.hget(`${key}:meta`, "truncated"),
    ]);
    if (!Array.isArray(members) || members.length === 0) return undefined;
    const segments: StoredRecallTranscriptSegment[] = [];
    for (const member of members) {
      if (typeof member !== "string") continue;
      try {
        const parsed = JSON.parse(member) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const value = parsed as Record<string, unknown>;
          if (typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id) && Number.isSafeInteger(value.startMs)
            && Number(value.startMs) >= 0 && Number(value.startMs) <= 7_200_000 && typeof value.sealed === "string" && value.sealed.length <= 8_192) {
            segments.push({ id: value.id, startMs: Number(value.startMs), sealed: value.sealed });
          }
        }
      } catch { /* Corrupt entries are never exposed. */ }
    }
    return segments.length ? { segments, truncated: String(truncated ?? "0") === "1" } : undefined;
  }
  async setRecallTranscriptTtl(userId: number, meetingId: string, ttlSeconds: number): Promise<boolean> {
    const key = this.recallTranscriptKey(userId, meetingId);
    const ttl = Math.max(1, Math.min(Math.floor(ttlSeconds), 30 * 24 * 60 * 60));
    const result = await this.r.eval(
      "if redis.call('EXISTS',KEYS[1]) == 0 then return 0 end; redis.call('EXPIRE',KEYS[1],ARGV[1]); redis.call('EXPIRE',KEYS[2],ARGV[1]); return 1",
      2, key, `${key}:meta`, String(ttl),
    );
    return Number(result) === 1;
  }
  async deleteRecallTranscript(userId: number, meetingId: string): Promise<boolean> {
    const key = this.recallTranscriptKey(userId, meetingId);
    return Number(await this.r.del(key, `${key}:meta`)) > 0;
  }
  async claimRecallCopilotEvaluation(userId: number, meetingId: string, minIntervalSeconds: number, _nowMs?: number): Promise<"allowed" | "interval"> {
    const digest = createHash("sha256").update(`${userId}:${meetingId}`).digest("hex");
    const ttlSeconds = 24 * 60 * 60;
    const result = Number(await this.r.eval(
      "local last = tonumber(redis.call('GET', KEYS[1]) or '0'); " +
      "local t = redis.call('TIME'); " +
      "local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000); " +
      "if last > 0 and now - last < tonumber(ARGV[1]) then return 0 end; " +
      "redis.call('SET', KEYS[1], tostring(now), 'EX', ARGV[2]); " +
      "return 1",
      1,
      `chuck:meeting:copilot:${digest}:last`,
      String(minIntervalSeconds * 1000),
      String(ttlSeconds),
    ));
    return result === 1 ? "allowed" : "interval";
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

  private async listRecoverableOutbox(statuses: typeof RECOVERABLE_OUTBOX_STATUSES[number][], limit: number, userId?: number): Promise<OutboxRecord[]> {
    await this.ensurePendingOutboxIndexes();
    const idGroups = await Promise.all(statuses.map((status) => this.r.zrange(this.outboxPendingIndexKey(status), 0, userId === undefined ? limit - 1 : -1)));
    const ids = [...new Set(idGroups.flat())];
    if (!ids.length) return [];
    const values = await this.r.mget(...ids.map((id) => this.outboxKey(id)));
    const records: OutboxRecord[] = [];
    const staleIds: string[] = [];
    for (const [index, raw] of values.entries()) {
      if (!raw) { staleIds.push(ids[index]); continue; }
      try {
        const record = JSON.parse(raw) as OutboxRecord;
        if (statuses.includes(record.status as typeof RECOVERABLE_OUTBOX_STATUSES[number]) && (userId === undefined || record.userId === userId)) records.push(record);
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

  async listOutbox(statuses?: OutboxRecord["status"][], limit = 100, userId?: number): Promise<OutboxRecord[]> {
    if (statuses?.length && statuses.every(isRecoverableOutboxStatus)) {
      return this.listRecoverableOutbox([...new Set(statuses)], limit, userId);
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
          if ((!statuses?.length || statuses.includes(record.status)) && (userId === undefined || record.userId === userId)) records.push(record);
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
  private companyRuns = new Map<string, Map<string, CompanyRunSummary>>();
  private companyAudits = new Map<string, CompanyAuditEvent[]>();
  private companyCompletions = new Set<string>();
  private companyUsage = new Map<string, CompanyUsagePeriod>();
  private companyBranding = new Map<string, CompanyBranding>();
  private companyBrandingDomains = new Map<string, string>();
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
  private deliveryLeaseClaims = new Map<string, { token: string; expiresAt: number }>();
  private recallMeetingCreationClaims = new Map<string, { token: string; expiresAt: number }>();
  private recallCopilotEvaluations = new Map<string, { lastAt: number; expiresAt: number }>();
  private recallChatEvents = new Map<string, { record: RecallChatEventRecord; expiresAt: number }>();
  private recallVisualFrames = new Map<string, { encryptedFrame: string; expiresAt: number }>();
  private recallVisualFrameRates = new Map<string, number>();
  private recallTranscripts = new Map<string, { segments: Map<string, StoredRecallTranscriptSegment>; bytes: number; truncated: boolean; expiresAt: number }>();
  private meetingContacts = new Map<number, Map<string, MeetingContactRecord>>();
  private attention = new Map<string, AttentionRecord[]>();
  private reminders = new Map<number, ReminderRecord[]>();
  private jobs = new Map<number, JobRecord[]>();
  private approvals = new Map<string, ApprovalRecord>();
  private blandProviderCalls = new Map<string, { userId: number; callId: string; expiresAt: number }>();

  async getSession(userId: number) { return this.sessions.get(userId) ?? fresh(); }
  async saveSession(userId: number, s: UserSession) { this.sessions.set(userId, s); }
  async saveCompanyRun(projectId: string, run: CompanyRunSummary) {
    const records = this.companyRuns.get(projectId) ?? new Map<string, CompanyRunSummary>();
    const previous = records.get(run.id);
    records.set(run.id, structuredClone(previous?.status === "completed" && run.status !== "completed" ? previous : run));
    if (records.size > 1000) {
      for (const [id] of [...records.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt).slice(0, records.size - 1000)) records.delete(id);
    }
    this.companyRuns.set(projectId, records);
  }
  async completeCompanyRun(projectId: string, run: CompanyRunSummary, completedAt: number) {
    await this.saveCompanyRun(projectId, run);
    const completionKey = `${projectId}:${run.id}`;
    if (this.companyCompletions.has(completionKey)) return false;
    this.companyCompletions.add(completionKey);
    const month = usageMonth(completedAt);
    const usageKey = `${projectId}:${month}`;
    const previous = this.companyUsage.get(usageKey) ?? { month, completedRuns: 0, costUsd: 0 };
    this.companyUsage.set(usageKey, { month, completedRuns: previous.completedRuns + 1, costUsd: previous.costUsd + Math.max(0, run.cost ?? 0) });
    return true;
  }
  async listCompanyRuns(projectId: string, limit: number) {
    return [...(this.companyRuns.get(projectId)?.values() ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((run) => structuredClone(run));
  }
  async appendCompanyAudit(projectId: string, event: CompanyAuditEvent) {
    const events = this.companyAudits.get(projectId) ?? [];
    events.unshift(structuredClone(event));
    this.companyAudits.set(projectId, events.slice(0, 500));
  }
  async listCompanyAudit(projectId: string, limit: number) {
    return (this.companyAudits.get(projectId) ?? []).slice(0, limit).map((event) => structuredClone(event));
  }
  async listCompanyUsage(projectId: string, periods: number, now: number) {
    return Array.from({ length: periods }, (_value, offset) => {
      const month = usageMonth(now, offset);
      const record = this.companyUsage.get(`${projectId}:${month}`);
      return record ? structuredClone(record) : { month, completedRuns: 0, costUsd: 0 };
    });
  }
  async getCompanyBranding(organizationId: string) { return this.companyBranding.get(organizationId); }
  async saveCompanyBranding(record: CompanyBranding) {
    const previous = this.companyBranding.get(record.organizationId);
    if (previous?.customDomain && previous.customDomain !== record.customDomain) this.companyBrandingDomains.delete(previous.customDomain);
    this.companyBranding.set(record.organizationId, structuredClone(record));
    if (record.customDomain) this.companyBrandingDomains.set(record.customDomain, record.organizationId);
  }
  async findCompanyBrandingByDomain(hostname: string) {
    const organizationId = this.companyBrandingDomains.get(hostname);
    return organizationId ? this.companyBranding.get(organizationId) : undefined;
  }
  async linkBlandProviderCall(providerCallId: string, userId: number, callId: string) {
    const prior = this.blandProviderCalls.get(providerCallId);
    if (prior && prior.expiresAt > Date.now()) return prior.userId === userId && prior.callId === callId;
    this.blandProviderCalls.set(providerCallId, { userId, callId, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
    return true;
  }
  async getBlandProviderCall(providerCallId: string) {
    const value = this.blandProviderCalls.get(providerCallId);
    if (!value || value.expiresAt <= Date.now()) { this.blandProviderCalls.delete(providerCallId); return undefined; }
    return { userId: value.userId, callId: value.callId };
  }
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
  async createRecallChatEvent(record: RecallChatEventRecord) {
    const existing = await this.getRecallChatEvent(record.eventId);
    if (existing) return existing;
    this.recallChatEvents.set(record.eventId, { record, expiresAt: Date.now() + 60 * 60 * 1000 });
    return record;
  }
  async getRecallChatEvent(eventId: string, userId?: number) {
    const value = this.recallChatEvents.get(eventId);
    if (!value || value.expiresAt <= Date.now()) { this.recallChatEvents.delete(eventId); return undefined; }
    return userId === undefined || value.record.userId === userId ? value.record : undefined;
  }
  async updateRecallChatEvent(eventId: string, patch: Partial<RecallChatEventRecord>) {
    const current = await this.getRecallChatEvent(eventId);
    if (!current) return undefined;
    const next = { ...current, ...patch, eventId: current.eventId, updatedAt: Date.now() };
    const existing = this.recallChatEvents.get(eventId)!;
    this.recallChatEvents.set(eventId, { record: next, expiresAt: existing.expiresAt });
    return next;
  }
  async upsertMeetingContact(record: MeetingContactRecord): Promise<MeetingContactRecord> {
    const contacts = this.meetingContacts.get(record.userId) ?? new Map<string, MeetingContactRecord>();
    const prior = contacts.get(record.id);
    const next = { ...record, createdAt: prior?.createdAt ?? record.createdAt };
    contacts.set(record.id, next);
    while (contacts.size > 200) {
      const oldest = [...contacts.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!oldest) break;
      contacts.delete(oldest.id);
    }
    this.meetingContacts.set(record.userId, contacts);
    return next;
  }
  async listMeetingContacts(userId: number, limit: number): Promise<MeetingContactRecord[]> {
    return [...(this.meetingContacts.get(userId)?.values() ?? [])]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }
  async deleteMeetingContact(userId: number, id: string): Promise<boolean> {
    return this.meetingContacts.get(userId)?.delete(id) ?? false;
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
  async claimDeliveryLease(key: string, token: string, leaseMs: number): Promise<"acquired" | "completed" | "busy"> {
    const now = Date.now();
    if ((this.completedDeliveries.get(key) ?? 0) > now) return "completed";
    const claim = this.deliveryLeaseClaims.get(key);
    if (claim && claim.expiresAt > now) return "busy";
    this.deliveryLeaseClaims.set(key, { token, expiresAt: now + leaseMs });
    return "acquired";
  }
  async completeDeliveryLease(key: string, token: string, ttlSeconds: number): Promise<boolean> {
    const claim = this.deliveryLeaseClaims.get(key);
    if (claim?.token !== token || claim.expiresAt <= Date.now()) return false;
    this.deliveryLeaseClaims.delete(key);
    this.completedDeliveries.set(key, Date.now() + ttlSeconds * 1000);
    return true;
  }
  async releaseDeliveryLease(key: string, token: string): Promise<boolean> {
    const claim = this.deliveryLeaseClaims.get(key);
    if (claim?.token !== token || claim.expiresAt <= Date.now()) return false;
    this.deliveryLeaseClaims.delete(key);
    return true;
  }
  async claimRecallMeetingCreation(userId: number, instanceHash: string, token: string, leaseMs: number): Promise<boolean> {
    const key = `${userId}:${instanceHash}`;
    const now = Date.now();
    const claim = this.recallMeetingCreationClaims.get(key);
    if (claim && claim.expiresAt > now) return false;
    this.recallMeetingCreationClaims.set(key, { token, expiresAt: now + leaseMs });
    return true;
  }
  async releaseRecallMeetingCreation(userId: number, instanceHash: string, token: string): Promise<boolean> {
    const key = `${userId}:${instanceHash}`;
    if (this.recallMeetingCreationClaims.get(key)?.token !== token) return false;
    this.recallMeetingCreationClaims.delete(key);
    return true;
  }
  async putRecallVisualFrame(userId: number, meetingId: string, encryptedFrame: string, ttlSeconds: number, minIntervalSeconds: number): Promise<boolean> {
    const key = `${userId}:${meetingId}`;
    const now = Date.now();
    if ((this.recallVisualFrameRates.get(key) ?? 0) > now) return false;
    this.recallVisualFrameRates.set(key, now + minIntervalSeconds * 1000);
    this.recallVisualFrames.set(key, { encryptedFrame, expiresAt: now + ttlSeconds * 1000 });
    return true;
  }
  async readRecallVisualFrame(userId: number, meetingId: string): Promise<string | undefined> {
    const key = `${userId}:${meetingId}`;
    const value = this.recallVisualFrames.get(key);
    return value && value.expiresAt > Date.now() ? value.encryptedFrame : undefined;
  }
  async appendRecallTranscriptSegment(userId: number, meetingId: string, segment: StoredRecallTranscriptSegment, ttlSeconds: number): Promise<"stored" | "duplicate" | "full"> {
    const key = `${userId}:${meetingId}`;
    const now = Date.now();
    let record = this.recallTranscripts.get(key);
    if (!record || record.expiresAt <= now) {
      record = { segments: new Map(), bytes: 0, truncated: false, expiresAt: now + ttlSeconds * 1000 };
      this.recallTranscripts.set(key, record);
    }
    record.expiresAt = Math.max(record.expiresAt, now + ttlSeconds * 1000);
    if (record.segments.has(segment.id)) return "duplicate";
    const bytes = Buffer.byteLength(JSON.stringify(segment), "utf8");
    if (record.truncated) return "full";
    if (record.segments.size >= RECALL_TRANSCRIPT_MAX_SEGMENTS || record.bytes + bytes > RECALL_TRANSCRIPT_MAX_BYTES) {
      record.truncated = true;
      return "full";
    }
    record.segments.set(segment.id, structuredClone(segment));
    record.bytes += bytes;
    return "stored";
  }
  async readRecallTranscript(userId: number, meetingId: string): Promise<{ segments: StoredRecallTranscriptSegment[]; truncated: boolean } | undefined> {
    const key = `${userId}:${meetingId}`;
    const record = this.recallTranscripts.get(key);
    if (!record || record.expiresAt <= Date.now()) {
      this.recallTranscripts.delete(key);
      return undefined;
    }
    return {
      segments: [...record.segments.values()].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id)).map((segment) => structuredClone(segment)),
      truncated: record.truncated,
    };
  }
  async setRecallTranscriptTtl(userId: number, meetingId: string, ttlSeconds: number): Promise<boolean> {
    const key = `${userId}:${meetingId}`;
    const record = this.recallTranscripts.get(key);
    if (!record || record.expiresAt <= Date.now()) return false;
    record.expiresAt = Date.now() + ttlSeconds * 1000;
    return true;
  }
  async deleteRecallTranscript(userId: number, meetingId: string): Promise<boolean> {
    return this.recallTranscripts.delete(`${userId}:${meetingId}`);
  }
  async claimRecallCopilotEvaluation(userId: number, meetingId: string, minIntervalSeconds: number, nowMs = Date.now()): Promise<"allowed" | "interval"> {
    const key = `${userId}:${meetingId}`;
    let state = this.recallCopilotEvaluations.get(key);
    if (state && state.expiresAt <= nowMs) {
      this.recallCopilotEvaluations.delete(key);
      state = undefined;
    }
    if (state && nowMs - state.lastAt < minIntervalSeconds * 1000) return "interval";
    this.recallCopilotEvaluations.set(key, {
      lastAt: nowMs,
      expiresAt: nowMs + 24 * 60 * 60 * 1000,
    });
    return "allowed";
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
  async listOutbox(statuses?: OutboxRecord["status"][], limit = 100, userId?: number): Promise<OutboxRecord[]> {
    return [...this.outbox.values()].filter((record) => (!statuses?.length || statuses.includes(record.status)) && (userId === undefined || record.userId === userId)).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
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
  return { model: config.defaultModel, history: [], totalMessages: 0, totalCost: 0, triggerIds: [], reminders: [], jobs: [], scratchpad: {}, memories: [], imageAssets: [], summaries: [], approvals: [], artifacts: [], phoneCalls: [], videoJobs: [], shoppingRuns: [], shoppingSites: [], mcpConnections: [], mcpOAuthStates: [], workflowComposers: [], recallMeetings: [], calendarMeetingPreparations: [], meetingRooms: [], createdAt: now, updatedAt: now };
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

function normalizeMeetingRoom(value: unknown): MeetingRoomRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" && /^room_[A-Za-z0-9_-]{1,96}$/.test(item.id) ? item.id : "";
  // Better Auth IDs are deployment-configurable and are not required to carry
  // a Chusky-specific prefix. Keep the control-plane identifier bounded and
  // opaque rather than rejecting valid organization/team IDs.
  const organizationId = typeof item.organizationId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(item.organizationId) ? item.organizationId : "";
  const createdByWebAuthUserId = typeof item.createdByWebAuthUserId === "string" && item.createdByWebAuthUserId.length <= 200 ? item.createdByWebAuthUserId : "";
  const policy = item.policy && typeof item.policy === "object" && !Array.isArray(item.policy) ? item.policy as Record<string, unknown> : {};
  const defaultMode = policy.defaultMode === "copilot" || policy.defaultMode === "representative" ? policy.defaultMode : "addressed";
  const visibility = policy.visibility === "team" || policy.visibility === "organization" ? policy.visibility : "private";
  const retention = [1, 7, 30].includes(Number(policy.transcriptRetentionDays)) ? Number(policy.transcriptRetentionDays) as 1 | 7 | 30 : undefined;
  const safeSlugs = (input: unknown, max: number) => Array.isArray(input) ? [...new Set(input.filter((entry): entry is string => typeof entry === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,150}$/.test(entry)).slice(0, max))] : [];
  if (!id || !organizationId || !createdByWebAuthUserId || typeof item.name !== "string" || !item.name.trim()) return undefined;
  return {
    id,
    organizationId,
    ...(typeof item.teamId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.teamId) ? { teamId: item.teamId } : {}),
    ...(typeof item.projectId === "string" && /^proj_[A-Za-z0-9_-]{1,120}$/.test(item.projectId) ? { projectId: item.projectId } : {}),
    name: item.name.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 120),
    ...(typeof item.description === "string" && item.description.trim() ? { description: item.description.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 1_000) } : {}),
    createdByWebAuthUserId,
    policy: {
      defaultMode,
      visibility,
      ...(retention ? { transcriptRetentionDays: retention } : {}),
      allowScreenUnderstanding: policy.allowScreenUnderstanding === true,
      requireApprovalForExternalActions: policy.requireApprovalForExternalActions !== false,
      allowedComposioTools: safeSlugs(policy.allowedComposioTools, 100),
      allowedNativeTools: safeSlugs(policy.allowedNativeTools, 50),
    },
    meetingPointers: Array.isArray(item.meetingPointers) ? item.meetingPointers.filter((pointer): pointer is { meetingId: string; ownerUserId: number; createdAt: number } => Boolean(pointer) && typeof pointer === "object" && /^mtg_[A-Za-z0-9_-]{1,80}$/.test(String((pointer as Record<string, unknown>).meetingId ?? "")) && Number.isSafeInteger((pointer as Record<string, unknown>).ownerUserId) && Number((pointer as Record<string, unknown>).ownerUserId) > 0).slice(-100).map((pointer) => ({ meetingId: pointer.meetingId, ownerUserId: pointer.ownerUserId, createdAt: Number.isFinite(pointer.createdAt) ? pointer.createdAt : Date.now() })) : [],
    createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
    updatedAt: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
  };
}

function normalizeMeetingRoster(value: unknown): RecallMeetingParticipant[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const identityStatus = item.identityStatus === "unknown" ? "unknown" as const : "named" as const;
      const name = typeof item.name === "string" ? item.name.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) : "";
      return {
      id: typeof item.id === "string" ? item.id : "",
      name: name || (identityStatus === "unknown" ? "Unknown participant" : ""),
      ...(identityStatus === "unknown" ? { identityStatus } : {}),
      ...(typeof item.isHost === "boolean" ? { isHost: item.isHost } : {}),
      status: item.status === "left" ? "left" as const : "present" as const,
      updatedAt: typeof item.updatedAt === "number" && Number.isSafeInteger(item.updatedAt) ? item.updatedAt : Date.now(),
      };
    })
    .filter((item) => /^[A-Za-z0-9_-]{1,128}$/.test(item.id) && Boolean(item.name))
    .slice(0, 40);
}

function normalizeRecallSpeakerEvents(value: unknown): RecallMeetingSpeakerEvent[] {
  if (!Array.isArray(value)) return [];
  const recentAfter = Date.now() - 15 * 60_000;
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .filter((item) => item.type === "speech_on" || item.type === "speech_off")
    .map((item) => ({
      type: item.type as "speech_on" | "speech_off",
      ...(typeof item.participantId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.participantId) ? { participantId: item.participantId } : {}),
      at: typeof item.at === "number" && Number.isSafeInteger(item.at) ? item.at : 0,
    }))
    .filter((item) => item.at >= recentAfter && Boolean(item.participantId))
    .slice(-200);
}

export async function getSession(uid: number): Promise<UserSession> {
  const raw = await backend.getSession(uid) as UserSession & { faceTimeCalls?: Array<Record<string, unknown>> };
  // Read and migrate the old persisted field once, without carrying the obsolete
  // key or provider secrets/bridge session identifiers into the current model.
  const { faceTimeCalls: legacyCalls, ...s } = raw;
  const savedCalls = Array.isArray(s.phoneCalls) ? s.phoneCalls as unknown[] : Array.isArray(legacyCalls) ? legacyCalls : [];
  const phoneCalls = savedCalls.flatMap((value): PhoneCallRecord[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || item.userId !== uid || typeof item.phoneNumber !== "string" || typeof item.purpose !== "string") return [];
    const status = ["starting", "bridging", "active", "ended", "failed"].includes(String(item.status)) ? item.status as PhoneCallRecord["status"] : "failed";
    return [{
      id: item.id.slice(0, 128), userId: uid,
      provider: item.provider === "twilio" || item.provider === "bland" ? item.provider : "legacy",
      direction: item.direction === "inbound" ? "inbound" : "outbound",
      ...(item.callProfile === "business" || item.callProfile === "personal" ? { callProfile: item.callProfile } : {}),
      ...(item.callVerification === "public" || item.callVerification === "identified" || item.callVerification === "verified" ? { callVerification: item.callVerification } : {}),
      phoneNumber: item.phoneNumber.slice(0, 32), purpose: item.purpose.slice(0, 1000), status,
      ...(item.voiceProfile && typeof item.voiceProfile === "object" && !Array.isArray(item.voiceProfile) ? { voiceProfile: normalizeVoiceCallProfile(item.voiceProfile) } : {}),
      ...(typeof item.providerCallId === "string" ? { providerCallId: item.providerCallId.slice(0, 100) } : {}),
      ...(typeof item.error === "string" ? { error: item.error.slice(0, 500) } : {}),
      ...(typeof item.summary === "string" ? { summary: item.summary.slice(0, 2000) } : {}),
      ...(typeof item.callLengthSeconds === "number" && Number.isFinite(item.callLengthSeconds) && item.callLengthSeconds >= 0 ? { callLengthSeconds: Math.min(item.callLengthSeconds, 86_400) } : {}),
      ...(typeof item.postCallProcessedAt === "number" && Number.isFinite(item.postCallProcessedAt) ? { postCallProcessedAt: item.postCallProcessedAt } : {}),
      createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      updatedAt: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
    }];
  }).slice(0, 50);
  const approvals = (Array.isArray(s.approvals) ? s.approvals : []).map((approval) => ({
    ...approval,
    toolSlug: approval.toolSlug === "CHUCK_START_FACETIME_CALL" ? "CHUCK_START_PHONE_CALL" : approval.toolSlug === "CHUCK_LIST_FACETIME_CALLS" ? "CHUCK_LIST_PHONE_CALLS" : approval.toolSlug,
  }));
  const browserPlaybooks = Array.isArray(s.browserPlaybooks) ? s.browserPlaybooks.filter((item): item is BrowserPlaybookRecord => Boolean(item) && typeof item === "object" && item.userId === uid && typeof item.id === "string" && typeof item.origin === "string").slice(0, 50) : [];
  const browserAudit = Array.isArray(s.browserAudit) ? s.browserAudit.filter((item): item is BrowserAuditRecord => Boolean(item) && typeof item === "object" && item.userId === uid && typeof item.id === "string" && typeof item.summary === "string").slice(-200) : [];
  const now = Date.now();
  const browserHandoffs = Array.isArray(s.browserHandoffs) ? s.browserHandoffs.filter((item): item is BrowserHandoffRecord => {
    if (!item || typeof item !== "object" || item.userId !== uid || typeof item.id !== "string" || !/^bh_[A-Za-z0-9_-]{1,120}$/.test(item.id) || typeof item.workspaceId !== "string" || !item.workspaceId || typeof item.reason !== "string" || !["captcha", "two_factor", "age_verification", "site_challenge", "login", "user_requested"].includes(item.reason) || typeof item.status !== "string" || !["waiting", "awaiting_verification", "completed", "expired", "cancelled"].includes(item.status) || !Number.isFinite(item.createdAt) || !Number.isFinite(item.expiresAt)) return false;
    if (item.status === "waiting" && item.expiresAt <= now) item.status = "expired";
    return true;
  }).slice(-20) : [];
  return { ...fresh(), ...s, voicePreferences: normalizeLiveVoicePreferences(s.voicePreferences), triggerIds: s.triggerIds ?? [], reminders: s.reminders ?? [], jobs: s.jobs ?? [], scratchpad: s.scratchpad ?? {}, memories: (s.memories ?? []).map(normalizeMemory), imageAssets: s.imageAssets ?? [], summaries: s.summaries ?? [], approvals, handoffRecords: s.handoffRecords ?? [], sdkProjects: s.sdkProjects ?? [], sdkFiles: s.sdkFiles ?? [], artifacts: s.artifacts ?? [], phoneCalls, mcpConnections: Array.isArray(s.mcpConnections) ? s.mcpConnections.filter((item): item is McpConnectionRecord => Boolean(item) && typeof item === "object" && typeof item.serverId === "string" && /^[A-Za-z0-9_-]{1,48}$/.test(item.serverId) && typeof item.enabled === "boolean" && Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt) && (!item.credential || typeof item.credential === "object")).slice(0, 50) : [], browserPlaybooks, browserAudit, browserHandoffs, meetingRooms: uid === 0 && Array.isArray(s.meetingRooms) ? s.meetingRooms.map(normalizeMeetingRoom).filter((item): item is MeetingRoomRecord => Boolean(item)).slice(0, 100) : [], meetingRepresentativeProfile: s.meetingRepresentativeProfile ? normalizeMeetingRepresentativeProfile(s.meetingRepresentativeProfile) : defaultMeetingRepresentativeProfile(), recallMeetings: Array.isArray(s.recallMeetings) ? s.recallMeetings.slice(0, 20).map((meeting) => ({ ...meeting, ...(typeof meeting.roomId === "string" && /^room_[A-Za-z0-9_-]{1,96}$/.test(meeting.roomId) ? { roomId: meeting.roomId } : { roomId: undefined }), ...(typeof meeting.organizationId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(meeting.organizationId) ? { organizationId: meeting.organizationId } : { organizationId: undefined }), ...(typeof meeting.teamId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(meeting.teamId) ? { teamId: meeting.teamId } : { teamId: undefined }), ...(typeof meeting.projectId === "string" && /^proj_[A-Za-z0-9_-]{1,120}$/.test(meeting.projectId) ? { projectId: meeting.projectId } : { projectId: undefined }), ...(Array.isArray(meeting.roomAllowedComposioTools) ? { roomAllowedComposioTools: meeting.roomAllowedComposioTools.filter((tool): tool is string => typeof tool === "string").slice(0, 100) } : {}), ...(Array.isArray(meeting.roomAllowedNativeTools) ? { roomAllowedNativeTools: meeting.roomAllowedNativeTools.filter((tool): tool is string => typeof tool === "string").slice(0, 50) } : {}), visibility: meeting.visibility === "team" || meeting.visibility === "organization" ? meeting.visibility : undefined, interactionMode: meeting.interactionMode === "copilot" || meeting.interactionMode === "representative" ? meeting.interactionMode : "addressed" as const, visualContextEnabled: meeting.visualContextEnabled === true, transcriptRetentionDays: [1, 7, 30].includes(meeting.transcriptRetentionDays as number) ? meeting.transcriptRetentionDays as 1 | 7 | 30 : undefined, transcriptExpiresAt: Number.isSafeInteger(meeting.transcriptExpiresAt) && Number(meeting.transcriptExpiresAt) > 0 ? Number(meeting.transcriptExpiresAt) : undefined, transcriptStatus: ["processing", "ready", "failed"].includes(meeting.transcriptStatus as string) ? meeting.transcriptStatus as "processing" | "ready" | "failed" : undefined, transcriptErrorCode: typeof meeting.transcriptErrorCode === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(meeting.transcriptErrorCode) ? meeting.transcriptErrorCode : undefined, mission: normalizeMeetingMission(meeting.mission), participantRoster: normalizeMeetingRoster(meeting.participantRoster), speakerEvents: ["ended", "failed"].includes(meeting.status) ? [] : normalizeRecallSpeakerEvents(meeting.speakerEvents), history: Array.isArray(meeting.history) ? meeting.history.slice(-20) : [] })) : [], calendarMeetingPreparations: Array.isArray(s.calendarMeetingPreparations) ? s.calendarMeetingPreparations.slice(0, 30).filter((item) => item && Number.isSafeInteger(item.userId) && item.userId === uid && /^cmp_[A-Za-z0-9_-]{1,96}$/.test(item.id) && typeof item.sourceTriggerEventId === "string").map((item) => ({ ...item, lifecycle: ["created", "updated", "sync", "starting_soon", "attendee_response", "cancelled"].includes(item.lifecycle) ? item.lifecycle : "sync" as const, status: ["prepared", "cancelled", "joined", "expired"].includes(item.status) ? item.status : "expired" as const, title: typeof item.title === "string" ? item.title.slice(0, 180) : undefined, startAt: typeof item.startAt === "string" ? item.startAt.slice(0, 180) : undefined, endAt: typeof item.endAt === "string" ? item.endAt.slice(0, 80) : undefined, participants: Array.isArray(item.participants) ? item.participants.filter((name): name is string => typeof name === "string").slice(0, 30).map((name) => name.slice(0, 160)) : [], sealedMeetingUrl: typeof item.sealedMeetingUrl === "string" && item.sealedMeetingUrl.length <= 4096 ? item.sealedMeetingUrl : undefined })) : [], videoJobs: s.videoJobs ?? [], shoppingRuns: Array.isArray(s.shoppingRuns) ? s.shoppingRuns.slice(0, 50) : [], shoppingSites: Array.isArray(s.shoppingSites) ? s.shoppingSites.slice(0, 100) : [], sdkIdempotency: s.sdkIdempotency ?? {}, sdkAudit: s.sdkAudit ?? [], sdkWebhooks: s.sdkWebhooks ?? [], sdkThreads: (s.sdkThreads ?? []).map((thread) => ({ ...thread, history: thread.history ?? [], runs: (thread.runs ?? []).map((run) => ({ ...run, events: run.events ?? [] })) })) };
}

export async function saveSession(uid: number, s: UserSession): Promise<void> {
  s.updatedAt = Date.now();
  return backend.saveSession(uid, s);
}

function assertMeetingRoomId(id: string): void {
  if (!/^room_[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error("Meeting room ID is invalid");
}

export async function createMeetingRoom(record: MeetingRoomRecord): Promise<MeetingRoomRecord> {
  const normalized = normalizeMeetingRoom(record);
  if (!normalized) throw new Error("Meeting room is invalid");
  const control = await getSession(0);
  const rooms = control.meetingRooms ?? [];
  if (rooms.some((room) => room.id === normalized.id)) throw new Error("Meeting room already exists");
  if (rooms.filter((room) => room.organizationId === normalized.organizationId).length >= 100) throw new Error("This workspace has reached its meeting room limit");
  control.meetingRooms = [normalized, ...rooms].slice(0, 200);
  await saveSession(0, control);
  return normalized;
}

export async function getMeetingRoom(id: string): Promise<MeetingRoomRecord | undefined> {
  assertMeetingRoomId(id);
  return (await getSession(0)).meetingRooms?.find((room) => room.id === id);
}

export async function listMeetingRooms(organizationId: string, limit = 50): Promise<MeetingRoomRecord[]> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(organizationId)) throw new Error("Organization ID is invalid");
  return (await getSession(0)).meetingRooms?.filter((room) => room.organizationId === organizationId).slice(0, Math.max(1, Math.min(100, Math.floor(limit)))) ?? [];
}

export async function updateMeetingRoom(id: string, patch: Partial<Pick<MeetingRoomRecord, "name" | "description" | "teamId" | "projectId" | "policy">>): Promise<MeetingRoomRecord | undefined> {
  assertMeetingRoomId(id);
  const control = await getSession(0);
  const room = control.meetingRooms?.find((candidate) => candidate.id === id);
  if (!room) return undefined;
  const next = normalizeMeetingRoom({ ...room, ...patch, id, updatedAt: Date.now(), policy: patch.policy ? { ...room.policy, ...patch.policy } : room.policy });
  if (!next) throw new Error("Meeting room update is invalid");
  Object.assign(room, next);
  await saveSession(0, control);
  return room;
}

export async function attachMeetingToRoom(roomId: string, meetingId: string, ownerUserId: number): Promise<MeetingRoomRecord | undefined> {
  assertMeetingRoomId(roomId);
  if (!/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId) || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new Error("Meeting room pointer is invalid");
  const control = await getSession(0);
  const room = control.meetingRooms?.find((candidate) => candidate.id === roomId);
  if (!room) return undefined;
  room.meetingPointers = [{ meetingId, ownerUserId, createdAt: Date.now() }, ...(room.meetingPointers ?? []).filter((pointer) => pointer.meetingId !== meetingId)].slice(0, 100);
  room.updatedAt = Date.now();
  await saveSession(0, control);
  return room;
}

export async function deleteMeetingRoom(id: string): Promise<boolean> {
  assertMeetingRoomId(id);
  const control = await getSession(0);
  const rooms = control.meetingRooms ?? [];
  const next = rooms.filter((room) => room.id !== id);
  if (next.length === rooms.length) return false;
  control.meetingRooms = next;
  await saveSession(0, control);
  return true;
}

/** Find meetings registered to a workspace without exposing private provider state. */
export async function listWorkspaceMeetingPointers(organizationId: string, limit = 50): Promise<Array<{ meetingId: string; ownerUserId: number; roomId: string; organizationId: string; teamId?: string; projectId?: string; visibility: MeetingRoomVisibility }>> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(organizationId)) throw new Error("Organization ID is invalid");
  const control = await getSession(0);
  const rooms = new Map((control.meetingRooms ?? []).filter((room) => room.organizationId === organizationId).map((room) => [room.id, room]));
  const pointers: Array<{ meetingId: string; ownerUserId: number; roomId: string; organizationId: string; teamId?: string; projectId?: string; visibility: MeetingRoomVisibility }> = [];
  for (const room of rooms.values()) for (const pointer of room.meetingPointers ?? []) pointers.push({ meetingId: pointer.meetingId, ownerUserId: pointer.ownerUserId, roomId: room.id, organizationId, ...(room.teamId ? { teamId: room.teamId } : {}), ...(room.projectId ? { projectId: room.projectId } : {}), visibility: room.policy.visibility });
  return pointers.sort((a, b) => b.meetingId.localeCompare(a.meetingId)).slice(0, Math.max(1, Math.min(100, Math.floor(limit))));
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

export async function addPhoneCall(uid: number, record: PhoneCallRecord): Promise<PhoneCallRecord> {
  const s = await getSession(uid);
  s.phoneCalls = [record, ...(s.phoneCalls ?? [])].slice(0, 50);
  await saveSession(uid, s);
  return record;
}

type PhoneCallPatch = Partial<Pick<PhoneCallRecord, "status" | "providerCallId" | "error" | "summary" | "callLengthSeconds">>;

function nextPhoneCallStatus(current: PhoneCallRecord["status"], next: PhoneCallRecord["status"], provider?: PhoneCallRecord["provider"]): PhoneCallRecord["status"] {
  if (provider !== "bland") return next;
  if (current === "failed") return current;
  if (current === "ended") return next === "failed" ? next : current;
  const rank: Record<PhoneCallRecord["status"], number> = { starting: 0, bridging: 1, active: 2, ended: 3, failed: 3 };
  return rank[next] >= rank[current] ? next : current;
}

function applyPhoneCallPatch(current: PhoneCallRecord, patch: PhoneCallPatch): void {
  if (patch.providerCallId && current.providerCallId && patch.providerCallId !== current.providerCallId) {
    throw new Error("Bland provider call ID does not match the saved call");
  }
  Object.assign(current, patch, {
    ...(patch.status ? { status: nextPhoneCallStatus(current.status, patch.status, current.provider) } : {}),
    updatedAt: Date.now(),
  });
}

function appendSessionHistory(session: UserSession, messages: Message[]): void {
  const stamped = messages.map((message) => ({
    ...message,
    createdAt: typeof message.createdAt === "number" && Number.isFinite(message.createdAt) && message.createdAt >= 0 ? message.createdAt : Date.now(),
  }));
  session.history.push(...stamped);
  session.totalMessages += stamped.filter((message) => message.role === "user").length;
  const cap = config.maxHistory * 2;
  if (session.history.length > cap) {
    const overflow = session.history.slice(0, session.history.length - cap);
    const compact = overflow.map((message) => `${message.role}: ${message.content}`).join(" ").slice(0, 1800);
    session.summaries = [...session.summaries, compact].slice(-10);
    session.history = session.history.slice(session.history.length - cap);
  }
}

export async function updatePhoneCall(uid: number, id: string, patch: PhoneCallPatch): Promise<PhoneCallRecord | undefined> {
  const s = await getSession(uid);
  const current = (s.phoneCalls ?? []).find((item) => item.id === id && item.userId === uid);
  if (!current) return undefined;
  applyPhoneCallPatch(current, patch);
  if (current.provider === "bland" && current.providerCallId && !(await backend.linkBlandProviderCall(current.providerCallId, uid, id))) {
    throw new Error("Bland provider call ID is already linked to another Chusky call");
  }
  await saveSession(uid, s);
  return current;
}

/** Atomically commit Bland's final result, transcript roles, and replay marker in the owner session. */
export async function finalizeBlandPhoneCall(
  uid: number,
  id: string,
  patch: PhoneCallPatch,
  transcriptMessages: Message[],
): Promise<"processed" | "already_processed" | "not_found"> {
  const session = await getSession(uid);
  const current = (session.phoneCalls ?? []).find((item) => item.id === id && item.userId === uid && item.provider === "bland");
  if (!current) return "not_found";
  const alreadyProcessed = typeof current.postCallProcessedAt === "number";
  applyPhoneCallPatch(current, patch);
  if (current.providerCallId && !(await backend.linkBlandProviderCall(current.providerCallId, uid, id))) {
    throw new Error("Bland provider call ID is already linked to another Chusky call");
  }
  if (!alreadyProcessed) {
    current.postCallProcessedAt = Date.now();
    if (transcriptMessages.length) appendSessionHistory(session, transcriptMessages);
  }
  await saveSession(uid, session);
  return alreadyProcessed ? "already_processed" : "processed";
}

export async function listPhoneCalls(uid: number): Promise<PhoneCallRecord[]> {
  return (await getSession(uid)).phoneCalls ?? [];
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

export async function getPhoneCall(uid: number, id: string): Promise<PhoneCallRecord | undefined> {
  return (await getSession(uid)).phoneCalls?.find((item) => item.id === id && item.userId === uid);
}

/** Resolve Bland's provider call ID through a short-lived, owner-checked index. */
export async function getBlandPhoneCallByProviderId(providerCallId: string): Promise<PhoneCallRecord | undefined> {
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(providerCallId)) return undefined;
  const identity = await backend.getBlandProviderCall(providerCallId);
  if (!identity) return undefined;
  const call = await getPhoneCall(identity.userId, identity.callId);
  return call?.provider === "bland" && call.providerCallId === providerCallId ? call : undefined;
}

const ACTIVE_RECALL_MEETING_STATUSES = new Set<RecallMeetingStatus>(["creating", "scheduled", "joining", "waiting_room", "in_call", "leaving"]);

export async function getMeetingRepresentativeProfile(uid: number): Promise<MeetingRepresentativeProfile> {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("Meeting representative owner is invalid");
  const profile = (await getSession(uid)).meetingRepresentativeProfile;
  return profile ? normalizeMeetingRepresentativeProfile(profile) : defaultMeetingRepresentativeProfile();
}

export async function updateMeetingRepresentativeProfile(uid: number, patch: unknown): Promise<MeetingRepresentativeProfile> {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("Meeting representative owner is invalid");
  const session = await getSession(uid);
  const profile = normalizeMeetingRepresentativeProfile(patch, session.meetingRepresentativeProfile ?? defaultMeetingRepresentativeProfile());
  session.meetingRepresentativeProfile = profile;
  await saveSession(uid, session);
  return profile;
}

function meetingContactText(value: unknown, field: string, maximum: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized && required) throw new Error(`${field} is required`);
  if (normalized.length > maximum) throw new Error(`${field} must be at most ${maximum} characters`);
  return normalized || undefined;
}

/** Persist only the small contact card explicitly captured in an owned representative meeting. */
export async function upsertMeetingContact(userId: number, meetingId: string, input: {
  participantName: unknown; email?: unknown; phone?: unknown; contactPreference?: unknown; interest: unknown; nextStep?: unknown; followUpAt?: unknown;
}): Promise<MeetingContactRecord> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId)) throw new Error("Meeting contact owner or meeting is invalid");
  const participantName = meetingContactText(input.participantName, "participantName", 160, true)!;
  const rawEmail = meetingContactText(input.email, "email", 254);
  const email = rawEmail?.toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email must be a valid email address");
  const rawPhone = meetingContactText(input.phone, "phone", 40);
  const phone = rawPhone?.replace(/[\s().-]/g, "");
  if (phone && !/^\+?[1-9]\d{6,14}$/.test(phone)) throw new Error("phone must be a valid international phone number");
  if (!email && !phone) throw new Error("Provide an email or phone number the participant shared for follow-up");
  const contactPreference = input.contactPreference === undefined ? "unspecified" : input.contactPreference;
  if (contactPreference !== "email" && contactPreference !== "phone" && contactPreference !== "unspecified") throw new Error("contactPreference must be email, phone, or unspecified");
  if (contactPreference === "email" && !email) throw new Error("An email address is required for email contact preference");
  if (contactPreference === "phone" && !phone) throw new Error("A phone number is required for phone contact preference");
  const interest = meetingContactText(input.interest, "interest", 1_000, true)!;
  const nextStep = meetingContactText(input.nextStep, "nextStep", 500);
  let followUpAt: number | undefined;
  if (input.followUpAt !== undefined && input.followUpAt !== null && input.followUpAt !== "") {
    const parsed = typeof input.followUpAt === "number" ? input.followUpAt : typeof input.followUpAt === "string" ? Date.parse(input.followUpAt) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= Date.now() || parsed > Date.now() + 365 * 24 * 60 * 60 * 1000) throw new Error("followUpAt must be a future ISO-8601 timestamp within one year");
    followUpAt = parsed;
  }
  const identity = contactPreference === "phone" && phone ? `phone:${phone}` : email ? `email:${email}` : `phone:${phone}`;
  const id = `mct_${createHash("sha256").update(`${userId}:${meetingId}:${identity}`).digest("hex").slice(0, 32)}`;
  const now = Date.now();
  return backend.upsertMeetingContact({
    id, userId, meetingId, participantName,
    ...(email ? { email } : {}), ...(phone ? { phone } : {}),
    contactPreference, interest, ...(nextStep ? { nextStep } : {}), ...(followUpAt ? { followUpAt } : {}), createdAt: now, updatedAt: now,
  });
}

export async function listMeetingContacts(userId: number, limit = 20, meetingId?: string): Promise<MeetingContactRecord[]> {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Meeting contact owner is invalid");
  if (meetingId !== undefined && !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId)) throw new Error("Meeting ID is invalid");
  const requested = Math.max(1, Math.min(meetingId ? 200 : 50, Math.floor(limit)));
  const records = await backend.listMeetingContacts(userId, meetingId ? 200 : requested);
  return (meetingId ? records.filter((record) => record.meetingId === meetingId).slice(0, requested) : records);
}

export async function deleteMeetingContact(userId: number, id: string): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^mct_[a-f0-9]{32}$/.test(id)) throw new Error("Meeting contact ID is invalid");
  return backend.deleteMeetingContact(userId, id);
}

export async function getMeetingContact(userId: number, id: string, meetingId?: string): Promise<MeetingContactRecord | undefined> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^mct_[a-f0-9]{32}$/.test(id)) return undefined;
  const contacts = await backend.listMeetingContacts(userId, 200);
  return contacts.find((contact) => contact.id === id && contact.userId === userId && (!meetingId || contact.meetingId === meetingId));
}

export async function updateMeetingContact(userId: number, id: string, patch: Partial<Pick<MeetingContactRecord, "followUpTaskId" | "followUpAt">>): Promise<MeetingContactRecord | undefined> {
  const existing = await getMeetingContact(userId, id);
  if (!existing) return undefined;
  const next = { ...existing, ...patch, updatedAt: Date.now() };
  return backend.upsertMeetingContact(next);
}

export async function addRecallMeeting(uid: number, record: RecallMeetingRecord): Promise<RecallMeetingRecord> {
  if (!Number.isSafeInteger(uid) || uid <= 0 || record.userId !== uid) throw new Error("Meeting owner does not match the authenticated account");
  const session = await getSession(uid);
  const meetings = session.recallMeetings ?? [];
  const duplicate = meetings.find((meeting) => meeting.userId === uid
    && ACTIVE_RECALL_MEETING_STATUSES.has(meeting.status)
    && (meeting.meetingInstanceHash && record.meetingInstanceHash
      ? meeting.meetingInstanceHash === record.meetingInstanceHash
      : meeting.meetingUrlHash === record.meetingUrlHash && meeting.joinAt === record.joinAt));
  if (duplicate) return duplicate;
  const existing = meetings.filter((meeting) => meeting.id !== record.id);
  const active = existing.filter((meeting) => ACTIVE_RECALL_MEETING_STATUSES.has(meeting.status));
  if (active.length >= 20) throw new Error("Too many active meeting assistants to safely create another");
  const finished = existing.filter((meeting) => !ACTIVE_RECALL_MEETING_STATUSES.has(meeting.status));
  // Never evict an in-flight meeting record just to retain a newer history row:
  // webhooks and owner-scoped controls still need that record to clean it up.
  session.recallMeetings = [
    { ...record, history: (record.history ?? []).slice(-20) },
    ...active,
    ...finished.slice(0, Math.max(0, 19 - active.length)),
  ];
  await saveSession(uid, session);
  return record;
}

export async function getRecallMeeting(uid: number, id: string): Promise<RecallMeetingRecord | undefined> {
  const session = await getSession(uid);
  const meeting = session.recallMeetings?.find((candidate) => candidate.id === id && candidate.userId === uid);
  if (meeting?.outcomeTranscript && meeting.outcomeTranscriptCapturedAt && Date.now() - meeting.outcomeTranscriptCapturedAt > 24 * 60 * 60_000) {
    meeting.outcomeTranscript = undefined;
    meeting.outcomeTranscriptCapturedAt = undefined;
    await saveSession(uid, session);
  }
  return meeting;
}

function recallTranscriptRetentionSeconds(meeting: RecallMeetingRecord): number {
  if (!meeting.transcriptRetentionDays || ![1, 7, 30].includes(meeting.transcriptRetentionDays)) return RECALL_TRANSCRIPT_EPHEMERAL_TTL_SECONDS;
  return meeting.transcriptExpiresAt
    ? Math.max(1, Math.ceil((meeting.transcriptExpiresAt - Date.now()) / 1000))
    : meeting.transcriptRetentionDays * 24 * 60 * 60;
}

/** Append one verified, normalized Recall segment to a short-lived owner+meeting transcript. */
export async function appendRecallTranscriptSegment(
  uid: number,
  id: string,
  segment: RecallTranscriptSegment,
): Promise<"stored" | "duplicate" | "expired" | "full"> {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(id) || !validRecallTranscriptSegment(segment)) return "expired";
  const meeting = await getRecallMeeting(uid, id);
  if (!meeting || (meeting.interactionMode !== "copilot" && meeting.interactionMode !== "representative" && !meeting.transcriptRetentionDays)) return "expired";
  if (meeting.transcriptRetentionDays && meeting.transcriptExpiresAt && meeting.transcriptExpiresAt <= Date.now()) return "expired";
  if (!ACTIVE_RECALL_MEETING_STATUSES.has(meeting.status)) {
    const endedAt = meeting.providerStatusAt ?? meeting.updatedAt;
    if (meeting.status !== "ended" || Date.now() - endedAt > 15 * 60_000) return "expired";
  }
  const ttlSeconds = recallTranscriptRetentionSeconds(meeting);
  return backend.appendRecallTranscriptSegment(uid, id, sealRecallTranscriptSegment(uid, id, segment), ttlSeconds);
}

/** Read an owner-scoped transient transcript for end-of-meeting analysis. */
export async function readRecallTranscript(uid: number, id: string): Promise<RecallTranscriptRecord | undefined> {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(id)) return undefined;
  const meeting = await getRecallMeeting(uid, id);
  if (!meeting || !meeting.providerBotId) return undefined;
  const stored = await backend.readRecallTranscript(uid, id);
  if (!stored) return undefined;
  const segments = stored.segments.flatMap((segment) => {
    const opened = openRecallTranscriptSegment(uid, id, segment);
    return opened ? [opened] : [];
  }).sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  return segments.length ? { segments, truncated: stored.truncated } : undefined;
}

/** Delete a transcript for the authenticated owner and disable further retention/search access. */
export async function deleteRecallMeetingTranscript(uid: number, id: string): Promise<boolean> {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(id)) return false;
  const meeting = await getRecallMeeting(uid, id);
  if (!meeting || meeting.status !== "ended" || !meeting.transcriptRetentionDays) return false;
  await backend.deleteRecallTranscript(uid, id);
  await updateRecallMeeting(uid, id, { transcriptRetentionDays: undefined, transcriptExpiresAt: undefined });
  return true;
}

/** Delete default, non-searchable transcript working data once its structured outcome is durably saved. */
export async function deleteEphemeralRecallTranscriptAfterOutcome(uid: number, id: string): Promise<void> {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(id)) return;
  const meeting = await getRecallMeeting(uid, id);
  if (!meeting || meeting.transcriptRetentionDays) return;
  await backend.deleteRecallTranscript(uid, id);
}

/** Search only the owner's latest 10 retained meeting transcripts; default ephemeral transcripts are never discoverable. */
export async function searchRecallMeetingTranscripts(
  uid: number,
  query: string,
  meetingId?: string,
  limit = 5,
): Promise<Array<{ meetingId: string; title: string; platform: RecallMeetingRecord["platform"]; expiresAt: number; speakerName?: string; excerpt: string }>> {
  if (!Number.isSafeInteger(uid) || uid <= 0) return [];
  const cleanQuery = query.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 200);
  const terms = [...new Set(cleanQuery.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 2))].slice(0, 8);
  if (!terms.length) return [];
  const session = await getSession(uid);
  const now = Date.now();
  const meetings = (session.recallMeetings ?? [])
    .filter((meeting) => meeting.userId === uid && meeting.status === "ended" && meeting.transcriptRetentionDays
      && typeof meeting.transcriptExpiresAt === "number" && meeting.transcriptExpiresAt > now
      && (!meetingId || meeting.id === meetingId))
    .slice(0, meetingId ? 1 : 10);
  const output: Array<{ meetingId: string; title: string; platform: RecallMeetingRecord["platform"]; expiresAt: number; speakerName?: string; excerpt: string; score: number; at: number }> = [];
  for (const meeting of meetings) {
    const transcript = await readRecallTranscript(uid, meeting.id);
    if (!transcript) continue;
    for (const segment of transcript.segments) {
      const lowered = segment.text.toLocaleLowerCase();
      const matches = terms.reduce((count, term) => count + Number(lowered.includes(term)), 0);
      if (matches === 0) continue;
      const firstMatch = Math.min(...terms.map((term) => lowered.indexOf(term)).filter((index) => index >= 0));
      const excerptStart = Math.max(0, firstMatch - 90);
      const excerpt = `${segment.speakerName ? `${segment.speakerName}: ` : ""}${segment.text.slice(excerptStart, excerptStart + 260)}`;
      output.push({ meetingId: meeting.id, title: meeting.title ?? "Meeting", platform: meeting.platform, expiresAt: meeting.transcriptExpiresAt!, ...(segment.speakerName ? { speakerName: segment.speakerName } : {}), excerpt, score: matches, at: segment.startMs });
    }
  }
  return output.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, Math.max(1, Math.min(10, Math.floor(limit))))
    .map(({ score: _score, at: _at, ...result }) => result);
}

export async function listRecallMeetings(uid: number, limit = 10): Promise<RecallMeetingRecord[]> {
  return (await getSession(uid)).recallMeetings?.slice(0, Math.max(1, Math.min(20, Math.floor(limit)))) ?? [];
}

export async function updateRecallMeeting(uid: number, id: string, patch: Partial<Pick<RecallMeetingRecord, "status" | "providerBotId" | "title" | "joinAt" | "error" | "providerStatusAt" | "participantRoster" | "speakerEvents" | "outcomeTranscript" | "outcomeTranscriptCapturedAt" | "outcome" | "outcomeFollowThrough" | "outcomeStatus" | "outcomeNotificationStatus" | "transcriptRetentionDays" | "transcriptExpiresAt" | "transcriptStatus" | "transcriptErrorCode">>): Promise<RecallMeetingRecord | undefined> {
  const session = await getSession(uid);
  const current = session.recallMeetings?.find((meeting) => meeting.id === id && meeting.userId === uid);
  if (!current) return undefined;
  if (patch.providerStatusAt !== undefined && current.providerStatusAt !== undefined && patch.providerStatusAt < current.providerStatusAt) return current;
  if (patch.outcome) {
    if (patch.outcome.title.length > 180 || patch.outcome.summary.length > 2_000 || patch.outcome.decisions.length > 10 || patch.outcome.actionItems.length > 10 || patch.outcome.openQuestions.length > 10) throw new Error("Meeting outcome exceeds storage bounds");
    if ([...patch.outcome.decisions, ...patch.outcome.openQuestions].some((item) => typeof item !== "string" || item.length > 700)
      || patch.outcome.actionItems.some((item) => !item || typeof item.task !== "string" || item.task.length > 500 || typeof item.owner !== "string" || item.owner.length > 120 || (item.dueDate !== undefined && item.dueDate.length > 80))) throw new Error("Meeting outcome contains invalid fields");
  }
  if (patch.outcomeTranscript !== undefined) {
    if (!Array.isArray(patch.outcomeTranscript) || patch.outcomeTranscript.length > 32) throw new Error("Meeting outcome transcript exceeds turn bounds");
    let characters = 0;
    for (const turn of patch.outcomeTranscript) {
      if (!turn || (turn.role !== "participant" && turn.role !== "chusky") || typeof turn.content !== "string" || !turn.content.trim() || turn.content.length > 1_000
        || (turn.speakerName !== undefined && (typeof turn.speakerName !== "string" || turn.speakerName.length > 160))) throw new Error("Meeting outcome transcript contains an invalid turn");
      characters += turn.content.length;
    }
    if (characters > 12_000) throw new Error("Meeting outcome transcript exceeds character bounds");
  }
  if (patch.outcomeTranscriptCapturedAt !== undefined && (!Number.isSafeInteger(patch.outcomeTranscriptCapturedAt) || patch.outcomeTranscriptCapturedAt <= 0)) throw new Error("Meeting outcome transcript timestamp is invalid");
  if (patch.transcriptRetentionDays !== undefined && patch.transcriptRetentionDays !== 1 && patch.transcriptRetentionDays !== 7 && patch.transcriptRetentionDays !== 30) throw new Error("Meeting transcript retention must be 1, 7, or 30 days");
  if (patch.transcriptExpiresAt !== undefined && (!Number.isSafeInteger(patch.transcriptExpiresAt) || patch.transcriptExpiresAt <= 0)) throw new Error("Meeting transcript expiry is invalid");
  if (patch.transcriptStatus !== undefined && !["processing", "ready", "failed"].includes(patch.transcriptStatus)) throw new Error("Meeting transcript status is invalid");
  if (patch.transcriptErrorCode !== undefined && (typeof patch.transcriptErrorCode !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(patch.transcriptErrorCode))) throw new Error("Meeting transcript error code is invalid");
  if (patch.outcomeFollowThrough?.notionTool && (patch.outcomeFollowThrough.notionTool.length > 128 || !/^NOTION_[A-Z0-9_]+$/.test(patch.outcomeFollowThrough.notionTool))) throw new Error("Meeting outcome Notion action is invalid");
  if (patch.outcomeFollowThrough?.notionUrl && (patch.outcomeFollowThrough.notionUrl.length > 2_048 || !/^https:\/\/(?:[\w-]+\.)*notion\.so\//.test(patch.outcomeFollowThrough.notionUrl) && !/^https:\/\/(?:[\w-]+\.)*notion\.site\//.test(patch.outcomeFollowThrough.notionUrl))) throw new Error("Meeting outcome Notion URL is invalid");
  if (patch.participantRoster && (patch.participantRoster.length > 40 || patch.participantRoster.some((participant) => !participant || !/^[A-Za-z0-9_-]{1,128}$/.test(participant.id) || typeof participant.name !== "string" || !participant.name.trim() || participant.name.length > 160 || (participant.identityStatus !== undefined && participant.identityStatus !== "named" && participant.identityStatus !== "unknown") || (participant.isHost !== undefined && typeof participant.isHost !== "boolean") || (participant.status !== "present" && participant.status !== "left") || !Number.isSafeInteger(participant.updatedAt)))) throw new Error("Meeting participant roster is invalid");
  if (patch.speakerEvents && (patch.speakerEvents.length > 200 || patch.speakerEvents.some((event) => !event || (event.type !== "speech_on" && event.type !== "speech_off") || typeof event.participantId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(event.participantId) || !Number.isSafeInteger(event.at) || event.at <= 0))) throw new Error("Meeting speaker timeline is invalid");
  const effectivePatch = { ...patch };
  if (patch.status === "ended" && current.transcriptRetentionDays && !current.transcriptExpiresAt) {
    effectivePatch.transcriptExpiresAt = Date.now() + current.transcriptRetentionDays * 24 * 60 * 60_000;
  }
  Object.assign(current, effectivePatch, { updatedAt: Date.now() });
  if (current.status === "ended" || current.status === "failed") {
    current.participantRoster = [];
    current.speakerEvents = [];
  }
  current.error = current.error?.slice(0, 300);
  await saveSession(uid, session);
  if (current.status === "ended" && current.transcriptRetentionDays && current.transcriptExpiresAt) {
    await backend.setRecallTranscriptTtl(uid, id, Math.max(1, Math.ceil((current.transcriptExpiresAt - Date.now()) / 1000)));
  } else if (current.status === "failed") {
    await backend.deleteRecallTranscript(uid, id);
  }
  return current;
}

export async function appendRecallMeetingMessages(uid: number, id: string, messages: Message[]): Promise<RecallMeetingRecord | undefined> {
  const session = await getSession(uid);
  const meeting = session.recallMeetings?.find((candidate) => candidate.id === id && candidate.userId === uid);
  if (!meeting) return undefined;
  const bounded = messages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => ({
    role: message.role,
    content: String(message.content ?? "").slice(0, 3000),
    createdAt: Date.now(),
  }));
  meeting.history = [...meeting.history, ...bounded].slice(-20);
  meeting.updatedAt = Date.now();
  await saveSession(uid, session);
  return meeting;
}

function calendarMeetingPreparationView(record: CalendarMeetingPreparation) {
  const { sealedMeetingUrl: _sealedMeetingUrl, ...safe } = record;
  return {
    ...safe,
    meetingUrlAvailable: record.meetingUrlAvailable ?? Boolean(record.sealedMeetingUrl),
    ...(record.automatic && record.meetingId && record.status === "prepared" ? { status: "auto_scheduled" as const } : {}),
  };
}

export async function saveCalendarMeetingPreparation(uid: number, record: CalendarMeetingPreparation): Promise<CalendarMeetingPreparation> {
  if (!Number.isSafeInteger(uid) || uid <= 0 || record.userId !== uid || !/^cmp_[A-Za-z0-9_-]{1,96}$/.test(record.id) || !record.sourceTriggerEventId.trim()) throw new Error("Invalid calendar meeting preparation identity");
  if (record.title !== undefined && record.title.length > 180) throw new Error("Calendar meeting title is too long");
  if (record.participants.length > 30 || record.participants.some((name) => typeof name !== "string" || name.length > 160)) throw new Error("Calendar meeting participants are invalid");
  if (record.sealedMeetingUrl !== undefined && (typeof record.sealedMeetingUrl !== "string" || record.sealedMeetingUrl.length > 4096)) throw new Error("Calendar meeting link is invalid");
  if (record.meetingId !== undefined && !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(record.meetingId)) throw new Error("Calendar meeting ID is invalid");
  if (record.automatic !== undefined && typeof record.automatic !== "boolean") throw new Error("Calendar automation flag is invalid");
  if (record.meetingUrlAvailable !== undefined && typeof record.meetingUrlAvailable !== "boolean") throw new Error("Calendar meeting link state is invalid");
  const session = await getSession(uid);
  const existing = session.calendarMeetingPreparations ?? [];
  const match = existing.find((item) => item.id === record.id || (record.calendarEventId && item.calendarEventId === record.calendarEventId));
  const now = Date.now();
  const next: CalendarMeetingPreparation = {
    ...record,
    id: match?.id ?? record.id,
    meetingId: record.meetingId ?? match?.meetingId,
    automatic: record.automatic ?? match?.automatic,
    meetingUrlAvailable: record.meetingUrlAvailable ?? (record.sealedMeetingUrl ? true : match?.meetingUrlAvailable ?? Boolean(match?.sealedMeetingUrl)),
    ...(record.sealedMeetingUrl === undefined && match?.sealedMeetingUrl && (record.meetingUrlAvailable ?? true) ? { sealedMeetingUrl: match.sealedMeetingUrl } : {}),
    createdAt: match?.createdAt ?? record.createdAt ?? now,
    updatedAt: now,
  };
  session.calendarMeetingPreparations = [next, ...existing.filter((item) => item.id !== next.id)].slice(0, 30);
  await saveSession(uid, session);
  return next;
}

export async function getCalendarMeetingPreparation(uid: number, id: string): Promise<CalendarMeetingPreparation | undefined> {
  if (!/^cmp_[A-Za-z0-9_-]{1,96}$/.test(id)) return undefined;
  return (await getSession(uid)).calendarMeetingPreparations?.find((item) => item.id === id && item.userId === uid);
}

export async function getCalendarMeetingPreparationForTrigger(uid: number, triggerEventId: string): Promise<CalendarMeetingPreparation | undefined> {
  return (await getSession(uid)).calendarMeetingPreparations?.find((item) => item.userId === uid && item.sourceTriggerEventId === triggerEventId);
}

export async function listCalendarMeetingPreparations(uid: number, limit = 10): Promise<Array<ReturnType<typeof calendarMeetingPreparationView>>> {
  const now = Date.now();
  const session = await getSession(uid);
  const preparations = session.calendarMeetingPreparations ?? [];
  let changed = false;
  for (const item of preparations) {
    if (item.status === "prepared" && item.startAt && Date.parse(item.startAt) + 24 * 60 * 60_000 < now) { item.status = "expired"; item.updatedAt = now; changed = true; }
  }
  if (changed) await saveSession(uid, session);
  return preparations.slice(0, Math.max(1, Math.min(30, Math.floor(limit)))).map(calendarMeetingPreparationView);
}

export async function updateCalendarMeetingPreparation(uid: number, id: string, patch: Partial<Pick<CalendarMeetingPreparation, "status" | "lifecycle" | "title" | "startAt" | "endAt" | "participants" | "sealedMeetingUrl" | "sourceTriggerEventId" | "meetingId" | "automatic" | "meetingUrlAvailable">>): Promise<CalendarMeetingPreparation | undefined> {
  const session = await getSession(uid);
  const current = session.calendarMeetingPreparations?.find((item) => item.id === id && item.userId === uid);
  if (!current) return undefined;
  if (patch.meetingId !== undefined && !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(patch.meetingId)) throw new Error("Calendar meeting ID is invalid");
  if (patch.automatic !== undefined && typeof patch.automatic !== "boolean") throw new Error("Calendar automation flag is invalid");
  if (patch.meetingUrlAvailable !== undefined && typeof patch.meetingUrlAvailable !== "boolean") throw new Error("Calendar meeting link state is invalid");
  if (patch.sealedMeetingUrl !== undefined && (typeof patch.sealedMeetingUrl !== "string" || patch.sealedMeetingUrl.length > 4096)) throw new Error("Calendar meeting link is invalid");
  Object.assign(current, patch, { updatedAt: Date.now() });
  await saveSession(uid, session);
  return current;
}

export async function createRecallChatEvent(record: RecallChatEventRecord): Promise<RecallChatEventRecord> {
  if (!/^rch_[a-f0-9]{64}$/.test(record.eventId) || !Number.isSafeInteger(record.userId) || record.userId <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(record.meetingId) || !/^[A-Za-z0-9_-]{1,128}$/.test(record.providerBotId) || (record.replyToParticipantId !== undefined && !/^\d{1,32}$/.test(record.replyToParticipantId)) || (record.senderName !== undefined && (record.senderName.length > 160 || /[\u0000-\u001F\u007F]/.test(record.senderName)))) {
    throw new Error("Invalid Recall chat event identity");
  }
  if ((record.command?.kind === "message" || record.command?.kind === "ambient") && (!record.command.text.trim() || record.command.text.length > 900)) throw new Error("Invalid Recall chat event text");
  if (record.reply !== undefined && (typeof record.reply !== "string" || record.reply.length > 4096)) throw new Error("Invalid Recall chat event reply");
  return backend.createRecallChatEvent(record);
}

export async function getRecallChatEvent(eventId: string, userId?: number): Promise<RecallChatEventRecord | undefined> {
  if (!/^rch_[a-f0-9]{64}$/.test(eventId)) return undefined;
  return backend.getRecallChatEvent(eventId, userId);
}

export async function updateRecallChatEvent(eventId: string, patch: Partial<RecallChatEventRecord>): Promise<RecallChatEventRecord | undefined> {
  if (!/^rch_[a-f0-9]{64}$/.test(eventId)) return undefined;
  return backend.updateRecallChatEvent(eventId, patch);
}

/** Best-effort provider delivery dedupe. The lease prevents concurrent workflow retries;
 * completion keeps an already-delivered occurrence from being sent twice. */
export async function claimDelivery(key: string, leaseMs: number): Promise<boolean> {
  return backend.claimDelivery(key, leaseMs);
}

export async function completeDelivery(key: string, ttlSeconds: number): Promise<void> {
  return backend.completeDelivery(key, ttlSeconds);
}

function validateDeliveryLease(key: string, token: string, duration: number, maximum: number): void {
  if (typeof key !== "string" || !key.trim() || key.length > 2048) throw new Error("Invalid delivery lease key");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,200}$/.test(token)) throw new Error("Invalid delivery lease token");
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > maximum) throw new Error("Invalid delivery lease duration");
}

export async function claimDeliveryLease(key: string, token: string, leaseMs: number): Promise<"acquired" | "completed" | "busy"> {
  validateDeliveryLease(key, token, leaseMs, 10 * 60_000);
  return backend.claimDeliveryLease(key, token, leaseMs);
}

export async function completeDeliveryLease(key: string, token: string, ttlSeconds: number): Promise<boolean> {
  validateDeliveryLease(key, token, ttlSeconds, 90 * 24 * 60 * 60);
  return backend.completeDeliveryLease(key, token, ttlSeconds);
}

export async function releaseDeliveryLease(key: string, token: string): Promise<boolean> {
  validateDeliveryLease(key, token, 1, 10 * 60_000);
  return backend.releaseDeliveryLease(key, token);
}

export async function claimRecallMeetingCreation(userId: number, instanceHash: string, token: string, leaseMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^[a-f0-9]{64}$/.test(instanceHash)) throw new Error("Invalid Recall meeting creation identity");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,200}$/.test(token)) throw new Error("Invalid Recall meeting reservation token");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 20 * 60_000) throw new Error("Invalid Recall meeting reservation lease");
  return backend.claimRecallMeetingCreation(userId, instanceHash, token, leaseMs);
}

export async function releaseRecallMeetingCreation(userId: number, instanceHash: string, token: string): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^[a-f0-9]{64}$/.test(instanceHash)) return false;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,200}$/.test(token)) return false;
  return backend.releaseRecallMeetingCreation(userId, instanceHash, token);
}

/**
 * Store only the latest AES-GCM sealed screen frame. It has a short 12s TTL,
 * is owner/meeting scoped, and uses an atomic per-meeting ingress rate gate.
 */
export async function putRecallVisualFrame(userId: number, meetingId: string, encryptedFrame: string): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId)
    || typeof encryptedFrame !== "string" || encryptedFrame.length < 80 || encryptedFrame.length > 2_100_000
    || !/^v1\.\d{13}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/.test(encryptedFrame)) {
    throw new Error("Invalid encrypted Recall visual frame");
  }
  return backend.putRecallVisualFrame(userId, meetingId, encryptedFrame, 12, 2);
}

/** Read only a fresh encrypted frame; the short TTL allows consecutive turns to inspect a static slide. */
export async function readRecallVisualFrame(userId: number, meetingId: string): Promise<string | undefined> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId)) return undefined;
  return backend.readRecallVisualFrame(userId, meetingId);
}

/** Atomically smooth bursty proactive evaluation for one owner-scoped meeting. */
export async function claimRecallCopilotEvaluation(
  userId: number,
  meetingId: string,
  minIntervalSeconds = config.recallCopilotMinIntervalSeconds,
  nowMs?: number,
): Promise<"allowed" | "interval"> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !/^mtg_[A-Za-z0-9_-]{1,80}$/.test(meetingId)) {
    throw new Error("Invalid meeting copilot budget identity");
  }
  return backend.claimRecallCopilotEvaluation(userId, meetingId, minIntervalSeconds, nowMs);
}

export async function appendMessages(uid: number, msgs: Message[]): Promise<void> {
  const s = await getSession(uid);
  appendSessionHistory(s, msgs);
  await saveSession(uid, s);
}

export async function addUsage(uid: number, cost: number): Promise<void> {
  const s = await getSession(uid);
  s.totalCost = (s.totalCost ?? 0) + cost;
  await saveSession(uid, s);
}

function assertCompanyProjectId(projectId: string): void {
  if (!/^proj_[A-Za-z0-9_-]{1,120}$/.test(projectId)) throw new Error("Invalid company project ID.");
}

function cleanCompanyRunSummary(value: CompanyRunSummary): CompanyRunSummary {
  const statuses: SdkRunRecord["status"][] = ["queued", "running", "requires_approval", "completed", "failed", "cancelled"];
  if (!value || typeof value.id !== "string" || !/^run_[A-Za-z0-9_-]{1,120}$/.test(value.id) || !statuses.includes(value.status)) throw new Error("Invalid company run summary.");
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) throw new Error("Invalid company run timestamps.");
  const cost = value.cost;
  return {
    id: value.id,
    status: value.status,
    ...(typeof value.agentId === "string" ? { agentId: value.agentId.slice(0, 128) } : {}),
    ...(typeof value.agentName === "string" ? { agentName: value.agentName.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160) } : {}),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
    ...(typeof value.errorCode === "string" && /^[a-z0-9_-]{1,80}$/i.test(value.errorCode) ? { errorCode: value.errorCode } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export async function saveCompanyRunSummary(projectId: string, run: CompanyRunSummary): Promise<void> {
  assertCompanyProjectId(projectId);
  await backend.saveCompanyRun(projectId, cleanCompanyRunSummary(run));
}

/** Complete accounting is idempotent by (project, run) and shared across workers. */
export async function completeCompanyRunSummary(projectId: string, run: CompanyRunSummary, completedAt = Date.now()): Promise<boolean> {
  assertCompanyProjectId(projectId);
  if (!Number.isSafeInteger(completedAt) || completedAt < 0 || run.status !== "completed") throw new Error("Only a completed run can be accounted.");
  return backend.completeCompanyRun(projectId, cleanCompanyRunSummary(run), completedAt);
}

export async function listCompanyRunSummaries(projectId: string, limit = 50): Promise<CompanyRunSummary[]> {
  assertCompanyProjectId(projectId);
  return backend.listCompanyRuns(projectId, Math.max(1, Math.min(100, Math.floor(limit))));
}

export async function appendCompanyAuditEvent(projectId: string, event: CompanyAuditEvent): Promise<void> {
  assertCompanyProjectId(projectId);
  if (!event || !/^audit_[A-Za-z0-9_-]{1,120}$/.test(event.id) || !/^[A-Za-z0-9_-]{1,120}$/.test(event.requestId) || !Number.isSafeInteger(event.status) || event.status < 100 || event.status > 599 || !Number.isSafeInteger(event.at) || event.at < 0) throw new Error("Invalid company audit event.");
  await backend.appendCompanyAudit(projectId, { ...event, action: String(event.action).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120) });
}

export async function listCompanyAuditEvents(projectId: string, limit = 50): Promise<CompanyAuditEvent[]> {
  assertCompanyProjectId(projectId);
  return backend.listCompanyAudit(projectId, Math.max(1, Math.min(100, Math.floor(limit))));
}

export async function listCompanyUsagePeriods(projectId: string, periods = 12, now = Date.now()): Promise<CompanyUsagePeriod[]> {
  assertCompanyProjectId(projectId);
  return backend.listCompanyUsage(projectId, Math.max(1, Math.min(13, Math.floor(periods))), now);
}

function normalizeHostname(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : undefined;
}

function cleanCompanyBranding(value: CompanyBranding): CompanyBranding {
  if (!value || !/^org_[A-Za-z0-9_-]{1,120}$/.test(value.organizationId)) throw new Error("Invalid organization ID.");
  const displayName = String(value.displayName ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 100);
  if (!displayName) throw new Error("A display name is required.");
  const color = (input: unknown, fallback: string) => typeof input === "string" && /^#[0-9a-f]{6}$/i.test(input) ? input.toLowerCase() : fallback;
  const logoUrl = typeof value.logoUrl === "string" && /^https:\/\//i.test(value.logoUrl) && value.logoUrl.length <= 2_000 ? value.logoUrl : undefined;
  const customDomain = normalizeHostname(value.customDomain);
  return { organizationId: value.organizationId, displayName, ...(logoUrl ? { logoUrl } : {}), accentColor: color(value.accentColor, "#111111"), backgroundColor: color(value.backgroundColor, "#f7f7f4"), ...(customDomain ? { customDomain, customDomainStatus: "pending_dns" as const } : { customDomainStatus: "not_configured" as const }), updatedAt: Number.isSafeInteger(value.updatedAt) ? value.updatedAt : Date.now() };
}

export async function getCompanyBranding(organizationId: string): Promise<CompanyBranding | undefined> {
  if (!/^org_[A-Za-z0-9_-]{1,120}$/.test(organizationId)) return undefined;
  const value = await backend.getCompanyBranding(organizationId);
  return value ? cleanCompanyBranding(value) : undefined;
}

export async function saveCompanyBranding(record: CompanyBranding): Promise<CompanyBranding> {
  const clean = cleanCompanyBranding(record);
  await backend.saveCompanyBranding(clean);
  return clean;
}

export async function findCompanyBrandingByDomain(hostname: string): Promise<CompanyBranding | undefined> {
  const cleanHost = normalizeHostname(hostname);
  if (!cleanHost) return undefined;
  const value = await backend.findCompanyBrandingByDomain(cleanHost);
  return value ? cleanCompanyBranding(value) : undefined;
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

export async function setLiveVoicePreference(
  uid: number,
  provider: LiveVoiceProvider,
  voice?: FluxTtsVoiceId | { id: string; name: string },
): Promise<void> {
  const session = await getSession(uid);
  const preferences = normalizeLiveVoicePreferences(session.voicePreferences) ?? {};
  if (voice === undefined) {
    delete preferences[provider];
  } else if (provider === "bland") {
    if (typeof voice === "string" || !isBlandVoiceId(voice.id)) throw new Error("Invalid Bland voice selection");
    const name = voice.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) throw new Error("Invalid Bland voice selection");
    preferences.bland = { id: voice.id, name };
  } else {
    if (typeof voice !== "string" || !isFluxTtsVoice(voice)) throw new Error("Invalid live voice selection");
    preferences[provider] = voice;
  }
  session.voicePreferences = Object.keys(preferences).length ? preferences : undefined;
  await saveSession(uid, session);
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
  const followUp = task.meetingFollowUp;
  const meetingFollowUp = followUp
    && /^mtg_[A-Za-z0-9_-]{1,80}$/.test(followUp.meetingId)
    && /^mct_[a-f0-9]{32}$/.test(followUp.contactId)
    && /^[A-Z][A-Z0-9_]{2,127}$/.test(followUp.emailTool)
    && /(?:^|_)(?:SEND_EMAIL|EMAIL_SEND)(?:_|$)/.test(followUp.emailTool)
    && ["scheduled", "claimed", "completed", "ambiguous"].includes(followUp.state)
    ? { meetingId: followUp.meetingId, contactId: followUp.contactId, emailTool: followUp.emailTool, state: followUp.state }
    : undefined;
  return {
    ...task,
    steps: (task.steps ?? []).slice(0, 20).map((step) => ({ ...step, updatedAt: step.updatedAt ?? task.updatedAt })),
    attempt: task.attempt ?? 0,
    maxAttempts: Math.max(1, Math.min(10, task.maxAttempts ?? 3)),
    events: (task.events ?? []).slice(-100),
    ...(meetingFollowUp ? { meetingFollowUp } : { meetingFollowUp: undefined }),
  };
}

function taskEvent(type: TaskEvent["type"], message: string, attempt: number, at = Date.now()): TaskEvent {
  return { id: `taskevt_${randomUUID()}`, type, message: message.slice(0, 1000), at, attempt };
}

export async function createTask(userId: number, input: Pick<TaskRecord, "title" | "objective"> & { id?: string } & Partial<Omit<TaskRecord, "id" | "userId" | "title" | "objective" | "createdAt" | "updatedAt" | "status" | "attempt" | "events" | "lease">>): Promise<TaskRecord> {
  if (input.id !== undefined && !/^task_[A-Za-z0-9_-]{1,160}$/.test(input.id)) throw new Error("Task ID is invalid");
  if (input.id) {
    const existing = await getTask(userId, input.id);
    if (existing) return existing;
  }
  const now = Date.now();
  const task: TaskRecord = normalizeTask({
    id: input.id ?? `task_${randomUUID()}`,
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
    sdkInstructions: input.sdkInstructions,
    meetingFollowUp: input.meetingFollowUp,
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

export async function saveBrowserPlaybook(uid: number, playbook: BrowserPlaybookRecord): Promise<BrowserPlaybookRecord> {
  const s = await getSession(uid);
  const next = [playbook, ...(s.browserPlaybooks ?? []).filter((item) => item.id !== playbook.id && !(item.origin === playbook.origin && item.accountAlias === playbook.accountAlias))].slice(0, 50);
  s.browserPlaybooks = next;
  await saveSession(uid, s);
  return playbook;
}

export async function getBrowserPlaybook(uid: number, id: string): Promise<BrowserPlaybookRecord | undefined> {
  return (await getSession(uid)).browserPlaybooks?.find((item) => item.userId === uid && item.id === id);
}

export async function findBrowserPlaybook(uid: number, origin: string, accountAlias = "default"): Promise<BrowserPlaybookRecord | undefined> {
  return (await getSession(uid)).browserPlaybooks?.find((item) => item.userId === uid && item.origin === origin && item.accountAlias === accountAlias);
}

export async function listBrowserPlaybooks(uid: number, limit = 25): Promise<BrowserPlaybookRecord[]> {
  return (await getSession(uid)).browserPlaybooks?.slice(0, Math.max(1, Math.min(50, Math.floor(limit)))) ?? [];
}

export async function removeBrowserPlaybook(uid: number, id: string): Promise<boolean> {
  const s = await getSession(uid);
  const current = s.browserPlaybooks ?? [];
  const next = current.filter((item) => item.userId !== uid || item.id !== id);
  if (next.length === current.length) return false;
  s.browserPlaybooks = next;
  await saveSession(uid, s);
  return true;
}

export async function addBrowserAudit(uid: number, record: BrowserAuditRecord): Promise<BrowserAuditRecord> {
  const s = await getSession(uid);
  const safe: BrowserAuditRecord = { ...record, userId: uid, summary: record.summary.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 500) };
  s.browserAudit = [...(s.browserAudit ?? []).filter((item) => item.id !== safe.id), safe].slice(-200);
  await saveSession(uid, s);
  return safe;
}

export async function listBrowserAudit(uid: number, limit = 50): Promise<BrowserAuditRecord[]> {
  return ((await getSession(uid)).browserAudit ?? []).slice(-Math.max(1, Math.min(200, Math.floor(limit)))).reverse();
}

export async function saveBrowserHandoff(uid: number, record: BrowserHandoffRecord): Promise<BrowserHandoffRecord> {
  const s = await getSession(uid);
  const safe: BrowserHandoffRecord = {
    ...record,
    userId: uid,
    id: record.id.slice(0, 128),
    workspaceId: record.workspaceId.slice(0, 200),
    ...(record.service ? { service: record.service.slice(0, 80) } : {}),
    ...(record.origin ? { origin: record.origin.slice(0, 300) } : {}),
  };
  s.browserHandoffs = [...(s.browserHandoffs ?? []).filter((item) => item.id !== safe.id), safe].slice(-20);
  await saveSession(uid, s);
  return safe;
}

export async function getBrowserHandoff(uid: number, id: string): Promise<BrowserHandoffRecord | undefined> {
  const record = (await getSession(uid)).browserHandoffs?.find((item) => item.userId === uid && item.id === id);
  if (record?.status === "waiting" && record.expiresAt <= Date.now()) {
    record.status = "expired";
    await saveBrowserHandoff(uid, record);
  }
  return record;
}

export async function listBrowserHandoffs(uid: number, limit = 20): Promise<BrowserHandoffRecord[]> {
  const session = await getSession(uid);
  const records = (session.browserHandoffs ?? []).map((record) => record.status === "waiting" && record.expiresAt <= Date.now() ? { ...record, status: "expired" as const } : record);
  if (records.some((record, index) => record.status !== (session.browserHandoffs ?? [])[index]?.status)) {
    session.browserHandoffs = records;
    await saveSession(uid, session);
  }
  return records.slice(-Math.max(1, Math.min(20, Math.floor(limit)))).reverse();
}

export async function updateBrowserHandoff(uid: number, id: string, status: BrowserHandoffRecord["status"], completedAt?: number): Promise<BrowserHandoffRecord | undefined> {
  const record = await getBrowserHandoff(uid, id);
  if (!record) return undefined;
  if (record.status === "expired" || record.status === "cancelled" || record.status === "completed") return record;
  record.status = status;
  if (completedAt) record.completedAt = completedAt;
  await saveBrowserHandoff(uid, record);
  return record;
}

/** Durable private shopping state. Retailer choices and items are stored here;
 * website credentials and cookies remain exclusively in the vault broker. */
export async function createShoppingRun(uid: number, input: Omit<ShoppingRun, "userId" | "createdAt" | "updatedAt">): Promise<ShoppingRun> {
  const s = await getSession(uid);
  const now = Date.now();
  const run: ShoppingRun = { ...input, userId: uid, createdAt: now, updatedAt: now };
  s.shoppingRuns = [run, ...(s.shoppingRuns ?? []).filter((item) => item.id !== run.id)].slice(0, 50);
  await saveSession(uid, s);
  return run;
}

export async function getShoppingRun(uid: number, id: string): Promise<ShoppingRun | undefined> {
  return (await getSession(uid)).shoppingRuns?.find((run) => run.id === id && run.userId === uid);
}

export async function listShoppingRuns(uid: number, limit = 10): Promise<ShoppingRun[]> {
  const capped = Math.max(1, Math.min(50, Math.floor(limit)));
  return ((await getSession(uid)).shoppingRuns ?? []).filter((run) => run.userId === uid).slice(0, capped);
}

export async function updateShoppingRun(uid: number, id: string, patch: Partial<Omit<ShoppingRun, "id" | "userId" | "createdAt">>): Promise<ShoppingRun | undefined> {
  const s = await getSession(uid);
  const index = (s.shoppingRuns ?? []).findIndex((run) => run.id === id && run.userId === uid);
  if (index < 0) return undefined;
  const current = s.shoppingRuns![index]!;
  const updated: ShoppingRun = { ...current, ...patch, id: current.id, userId: uid, createdAt: current.createdAt, updatedAt: Date.now() };
  s.shoppingRuns![index] = updated;
  await saveSession(uid, s);
  return updated;
}

/**
 * A saved shopping site is a convenience preference, not a website identity.
 * Its separate bounded collection keeps credentials, browser cookies, and
 * address/payment information out of the general Chusky session record.
 */
export async function saveShoppingSite(uid: number, input: Omit<ShoppingSite, "userId" | "createdAt" | "updatedAt">): Promise<ShoppingSite> {
  const s = await getSession(uid);
  const now = Date.now();
  const existing = (s.shoppingSites ?? []).find((site) => site.id === input.id || site.origin === input.origin);
  const site: ShoppingSite = { ...existing, ...input, userId: uid, createdAt: existing?.createdAt ?? now, updatedAt: now };
  s.shoppingSites = [site, ...(s.shoppingSites ?? []).filter((item) => item.id !== site.id && item.origin !== site.origin)].slice(0, 100);
  await saveSession(uid, s);
  return site;
}

export async function listShoppingSites(uid: number, limit = 25): Promise<ShoppingSite[]> {
  const capped = Math.max(1, Math.min(100, Math.floor(limit)));
  return ((await getSession(uid)).shoppingSites ?? []).filter((site) => site.userId === uid).slice(0, capped);
}

export async function findShoppingSite(uid: number, input: string): Promise<ShoppingSite | undefined> {
  const query = input.trim().toLowerCase();
  return (await listShoppingSites(uid, 100)).find((site) => site.id === query || site.name.toLowerCase() === query || site.origin.toLowerCase() === query);
}

export async function removeShoppingSite(uid: number, id: string): Promise<boolean> {
  const s = await getSession(uid);
  const current = s.shoppingSites ?? [];
  const next = current.filter((site) => site.userId !== uid || site.id !== id);
  if (next.length === current.length) return false;
  s.shoppingSites = next;
  await saveSession(uid, s);
  return true;
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
    }).catch((error) => { recordVectorFailure(error, { phase: "memory_index", errorClass: "vector_indexing" }); logger.warn({ err: error, userId: uid }, "Memory vector indexing unavailable; structured memory retained"); });
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
        recordVectorFailure(error, { phase: "memory_backfill", errorClass: "vector_backfill" });
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
    } catch (error) { recordVectorFailure(error, { phase: "memory_search", errorClass: "vector_query" }); logger.warn({ err: error, userId: uid }, "Semantic memory search unavailable; using structured search"); }
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

export async function listOutbox(statuses?: OutboxRecord["status"][], limit = 100, userId?: number): Promise<OutboxRecord[]> {
  return backend.listOutbox(statuses, Math.max(1, Math.min(500, limit)), userId);
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
