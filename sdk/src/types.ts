export type JsonObject = Record<string, unknown>;

export interface RequestOptions {
  /** Cancels this request without cancelling other Chusky work. */
  signal?: AbortSignal | null;
  /** Required for POST operations that create or change durable state. */
  idempotencyKey?: string;
  /** Additional headers, useful for tracing or a staged API version. */
  headers?: HeadersInit;
}

export interface Page<T> {
  data: T[];
  nextCursor?: string;
}
export interface FileUpload { id: string; name: string; contentType: string; size: number; status: "pending" | "available" | "rejected"; uploadUrl: string; expiresAt: string; }
export interface FileDownload { id: string; name: string; contentType: string; size: number; status: "pending" | "available" | "rejected"; downloadUrl: string; expiresAt: string; }
export interface FileRecord { id: string; name: string; contentType: string; size: number; status: "pending" | "available" | "rejected"; }
export interface AuditEvent { id: string; action: string; requestId: string; status: number; at: number; }
export interface CompanyRunSummary { id: string; status: Run["status"]; agentId?: string; agentName?: string; cost?: number; errorCode?: string; createdAt: string; updatedAt: string; }
export interface CompanyAuditEvent { id: string; action: string; requestId: string; status: number; at: string; }
export interface CompanyUsagePeriod { month: string; completedRuns: number; costUsd: number; }
export interface CompanyUsage { currentMonth: CompanyUsagePeriod; periods: CompanyUsagePeriod[]; runs: { indexed: number; active: number }; }
export interface Webhook { id: string; url: string; createdAt: string; secret?: string; }
export interface WebhookDelivery { id: string; status: "queued" | "delivering" | "delivered" | "failed"; attempts: number; lastError?: string; createdAt: string; deliveredAt?: string; }
export interface DeveloperProject { id: string; name: string; keyPrefix: string; scopes: string[]; createdAt: string; revokedAt?: string; key?: string; }
export interface Usage { messages: number; cost: number; files: { count: number; declaredBytes: number; available: number }; runs: { count: number; active: number }; tasks: { count: number }; }
export type AutonomyMode = "notify" | "check_in" | "act" | "wait_until";
export type AutonomyLinks = { taskId?: string; missionId?: string; missionStepId?: string; openLoopId?: string; attentionCandidateId?: string; projectId?: string; meetingId?: string; conversationId?: string };
export interface AutonomyContextSnapshot { capturedAt: number; objective: string; summary?: string; nextAction?: string; links?: AutonomyLinks; freshnessMs?: number; source?: "live" | "checkpoint" | "user" | "system"; }
export interface Reminder { id: string; text: string; runAt: string; status: "scheduled" | "waiting" | "paused" | "sent" | "cancelled" | "failed"; workflowRunId?: string; mode?: AutonomyMode; links?: AutonomyLinks; contextSnapshot?: AutonomyContextSnapshot; preconditions?: string[]; postconditions?: string[]; nextAction?: string; pollEverySeconds?: number; deliveryTarget?: Record<string, unknown>; deliveryError?: string; createdAt: string; }
export interface RecurringJob { id: string; text: string; cron: string; status?: "active" | "paused" | "cancelled"; workflowRunId?: string; mode?: AutonomyMode; links?: AutonomyLinks; contextSnapshot?: AutonomyContextSnapshot; preconditions?: string[]; postconditions?: string[]; nextAction?: string; deliveryTarget?: Record<string, unknown>; deliveryError?: string; createdAt: string; [key: string]: unknown; }
export interface JobOccurrence { id: string; userId?: number; jobId: string; occurrenceId: string; status: string; mode: AutonomyMode; idempotencyKey: string; context?: AutonomyContextSnapshot; result?: string; nextAction?: string; waitReason?: string; error?: string; cost?: number; toolCalls?: number; startedAt?: string; completedAt?: string; createdAt: string; updatedAt: string; version: number; }
export interface ScratchpadEntry { key: string; content: string; updatedAt: string; }
export type MemoryCategory = "profile" | "personal" | "preference" | "business" | "relationship" | "project" | "procedural" | "episodic" | "document" | "negative" | "fact" | "instruction" | "asset";
export interface MemoryFact { id: string; category: MemoryCategory; key: string; value: string; confidence: number; source: string; sensitivity: "normal" | "sensitive"; status?: string; projectId?: string; personKey?: string; createdAt: string; updatedAt: string; expiresAt?: string; reviewAt?: string; }
export interface CliDevice { id: string; name: string; createdAt: string; lastSeenAt: string; }
export interface AppConnection { id: string; toolkit?: string; accountId?: string; name?: string; status?: string; [key: string]: unknown; }
export interface CompanyBranding { organizationId: string; displayName?: string; logoUrl?: string; accentColor?: string; backgroundColor?: string; customDomain?: string; customDomainStatus?: string; updatedAt?: string; }

export type CallProvider = "twilio" | "bland" | "legacy";
export type CallStatus = "starting" | "bridging" | "active" | "ended" | "failed";
export interface VoiceOption { id: string; name: string; accent?: string; description?: string; }
export interface VoiceOptions { fluxVoices: VoiceOption[]; blandVoices: VoiceOption[]; blandAvailable: boolean; blandCatalogueAvailable: boolean; }
export interface LiveVoicePreference {
  provider: "twilio" | "meetings" | "bland";
  voice?: string | VoiceOption | null;
}
export interface AccountPreferences {
  model: string;
  voiceReplies: boolean;
  voicePreferences: Record<string, string | VoiceOption>;
}
export type VoiceCallMode = "general" | "sales" | "onboarding" | "support" | "scheduling";
export type VoiceCallTone = "professional" | "warm" | "direct" | "consultative";
export type VoiceCallCapability = "memory_lookup" | "scratchpad_lookup" | "schedule_lookup" | "task_lookup" | "call_history";
export interface VoiceCallProfile {
  identity: string;
  organization?: string;
  mode: VoiceCallMode;
  tone: VoiceCallTone;
  opening?: string;
  facts: string[];
  guardrails: string[];
  capabilities: VoiceCallCapability[];
}
export interface CallRecord {
  id: string;
  provider?: CallProvider;
  direction?: "inbound" | "outbound";
  phoneNumber: string;
  purpose: string;
  status: CallStatus;
  error?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}
export interface CallsResponse { available: boolean; provider: CallProvider | null; data: CallRecord[]; }

export type MeetingPlatform = "zoom" | "google_meet" | "microsoft_teams" | "webex";
export type MeetingInteractionMode = "addressed" | "copilot" | "representative";
export type MeetingStatus = "creating" | "scheduled" | "joining" | "waiting_room" | "in_call" | "leaving" | "ended" | "failed";
export interface MeetingMission {
  clientName: string;
  objective: string;
  brief: string;
  sourceMemoryIds: string[];
  preparedAt: number;
}
export interface MeetingMissionSummary { clientName: string; objective: string; preparedAt: string; }
export interface MeetingParticipant { id: string; name: string; identityStatus?: "named" | "unknown"; isHost?: boolean; status: "present" | "left"; updatedAt: string; }
export interface MeetingSpeakerEvent { type: "speech_on" | "speech_off"; participantId?: string; at: string; }
export interface MeetingOutcomeActionItem { task: string; owner: string; dueDate?: string; }
export interface MeetingOutcome { title: string; summary: string; decisions: string[]; actionItems: MeetingOutcomeActionItem[]; openQuestions: string[]; }
export interface MeetingOutcomeFollowThrough { notionSaved?: boolean; notionTool?: string; notionUrl?: string; completedTools?: string[]; }
export interface MeetingRecord {
  id: string;
  platform: MeetingPlatform;
  status: MeetingStatus;
  interactionMode: MeetingInteractionMode;
  screenShareUnderstanding: boolean;
  searchableTranscript: boolean;
  transcriptStatus?: "processing" | "ready" | "failed";
  transcriptErrorCode?: string;
  transcriptExpiresAt?: string;
  title?: string;
  joinAt?: string;
  error?: string;
  mission?: MeetingMissionSummary;
  participantRoster?: MeetingParticipant[];
  speakerEvents?: MeetingSpeakerEvent[];
  history?: Array<{ role: "user" | "assistant"; content: string; createdAt?: string }>;
  outcome?: MeetingOutcome;
  outcomeFollowThrough?: MeetingOutcomeFollowThrough;
  outcomeStatus?: "pending" | "completed";
  outcomeNotificationStatus?: "pending" | "claimed" | "delivered";
  providerStatusAt?: string;
  createdAt: string;
  updatedAt: string;
  alreadyActive?: boolean;
}
export interface MeetingPreparation {
  id: string;
  title?: string;
  startAt?: string;
  endAt?: string;
  status?: "prepared" | "auto_scheduled" | "cancelled" | "joined" | "expired";
  meetingUrlAvailable?: boolean;
  brief?: string;
  briefStatus?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}
export interface MeetingContact {
  id: string;
  meetingId?: string;
  name?: string;
  email?: string;
  phone?: string;
  preferredChannel?: string;
  followUpAt?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}
export interface MeetingsResponse { preparations: MeetingPreparation[]; meetings: MeetingRecord[]; contacts: MeetingContact[]; }
export interface MeetingProfile {
  enabled: boolean;
  representativeName: string;
  organizationName: string;
  role: "sales" | "client_onboarding" | "employee_onboarding" | "customer_success" | "custom";
  objective: string;
  communicationStyle: string;
  approvedKnowledge: string;
  authorityBoundaries: string;
  allowedComposioTools: string[];
  composioAccountAliases: Record<string, string>;
  allowedNativeTools: string[];
  allowMeetingScheduling: boolean;
  autoJoinCalendar: boolean;
  updatedAt: number;
}
export interface MeetingBrief { clientName: string; objective?: string; clientContext?: string; }
export interface JoinMeetingParams {
  meetingUrl: string;
  title?: string;
  joinAt?: string;
  interactionMode?: MeetingInteractionMode;
  analyzeScreenShare?: boolean;
  transcriptRetentionDays?: 1 | 7 | 30;
  clientName?: string;
  objective?: string;
  clientContext?: string;
}
export interface MeetingContext { clientName?: string; objective?: string; businessFacts: string[]; relationshipFacts: string[]; note: string; }

export interface Thread {
  id: string;
  externalId?: string;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface CreateThreadParams {
  externalId?: string;
  metadata?: JsonObject;
}

export interface RunArtifact {
  id: string;
  name: string;
  type: Artifact["type"];
  contentType: string;
  size: number;
}

export interface Run {
  id: string;
  threadId: string;
  status: "queued" | "running" | "requires_approval" | "completed" | "failed" | "cancelled";
  input: string;
  agentId?: string;
  agentName?: string;
  model?: string;
  attachments?: Array<{ id: string; name: string; contentType: string; size: number }>;
  /** Generated file metadata. Download through the artifacts resource using this id. */
  artifacts?: RunArtifact[];
  output?: string;
  cost?: number;
  taskId?: string;
  approvalId?: string;
  metadata?: JsonObject;
  budget?: RunBudget;
  tools?: RunToolPolicy;
  skills?: string[];
  events?: RunEvent[];
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunParams {
  input: string;
  /** Optional model override. The server validates it against available models. */
  model?: string;
  metadata?: JsonObject;
  attachments?: string[];
  budget?: RunBudget;
  tools?: RunToolPolicy;
  skills?: string[];
  /** Wait for a terminal result. Use stream() for token-level progress. */
  wait?: boolean;
  /** Saved company agent ID or one of the built-in template slugs. */
  agentId?: string;
}

export interface CompanyAgentTemplate {
  slug: string;
  name: string;
  outcome: string;
  allowedTools: string[];
  requireApproval: string[];
}
export interface CompanyAgent {
  id: string;
  name: string;
  template: string;
  instructions: string;
  tools: RunToolPolicy;
  budget: RunBudget;
  createdAt: string;
  updatedAt: string;
}
export interface CompanyAgentCreateParams {
  template: string;
  name?: string;
  instructions?: string;
  policy?: { tools?: RunToolPolicy; budget?: RunBudget };
}

export type DurationBudget = "5m" | "30m" | "1h" | "3h" | "6h" | "3d" | "1w";
export interface RunBudget { duration?: DurationBudget; maxToolCalls?: number; maxCost?: number; }
export interface RunToolPolicy { allow?: string[]; deny?: string[]; requireApproval?: string[]; }

export interface Task {
  id: string;
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  title: string;
  objective: string;
  checkpoint?: string;
  nextAction?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  attempt?: number;
  maxAttempts?: number;
  sdkRunId?: string;
  sdkThreadId?: string;
  sdkModel?: string;
  sdkBudget?: RunBudget;
  sdkSkills?: string[];
  events?: Array<{ id: string; type: string; message: string; at: number; attempt: number }>;
}

export interface MissionEvidence { id: string; kind: "source" | "tool_receipt" | "artifact" | "assertion" | "before_after" | "human_confirmation" | string; summary: string; source?: string; ref?: string; hash?: string; verified: boolean; verifiedAt?: number; verifiedBy?: "agent" | "system" | "human"; }
export interface MissionStep { id: string; title: string; objective: string; status: "pending" | "running" | "completed" | "blocked" | "failed" | "cancelled" | string; dependsOn: string[]; result?: string; evidence?: MissionEvidence[]; evidenceRequired?: string[]; parallelGroup?: string; taskId?: string; attempts?: number; retryLimit?: number; input?: JsonObject; outputSchema?: JsonObject; compensationObjective?: string; retryBackoffSeconds?: number; updatedAt?: number; }
export interface MissionVerification { mode?: "legacy" | "strict"; requiredEvidence?: string[]; verified: boolean; verifiedAt?: number; verifiedBy?: "agent" | "system" | "human" | string; confidence?: number; unresolved?: string[]; evidenceIds?: string[]; reason?: string; }
export interface Mission { id: string; title: string; objective: string; definitionOfDone: string; status: "queued" | "running" | "waiting" | "paused" | "blocked" | "completed" | "failed" | "cancelled"; currentStepId?: string; activeStepIds?: string[]; rootTaskId?: string; checkpoint?: string; nextAction?: string; waiting?: { kind: string; key?: string; stepId?: string; provider?: string; providerEventId?: string; runAt?: number; expiresAt?: number }; budget: { maxDurationSeconds: number; maxSteps: number; maxToolCalls: number; maxCost: number }; consumedSteps: number; toolCalls: number; cost: number; steps: MissionStep[]; evidence?: MissionEvidence[]; verification?: MissionVerification; events: Array<{ id: string; type: string; message: string; at: number; stepId?: string; provider?: string; providerEventId?: string }>; result?: string; error?: string; startedAt?: number; completedAt?: number; version?: number; createdAt: number; updatedAt: number; }
export interface MissionProof { missionId: string; objective: string; definitionOfDone: string; status: Mission["status"]; nextAction?: string; checkpoint?: string; budget: Mission["budget"] & { consumedSteps?: number; toolCalls?: number; cost?: number }; verification?: MissionVerification; steps: MissionStep[]; evidence: MissionEvidence[]; events: Mission["events"]; }
export interface MissionCreateParams { title: string; objective: string; definitionOfDone: string; steps?: Array<Partial<MissionStep> & { title: string; objective: string }>; requiredEvidence?: string[]; verificationMode?: "legacy" | "strict"; maxDurationSeconds?: number; maxSteps?: number; maxToolCalls?: number; maxCost?: number; }
export interface ContextNode { id: string; scope: string; scopeId?: string; kind: string; key: string; value: string; source?: string; sourceRef?: string; confidence: number; sensitivity: "normal" | "sensitive"; tags?: string[]; reviewAt?: number; expiresAt?: number; createdAt: number; updatedAt: number; }
export interface DepartmentCatalogItem { slug: string; name: string; worker: string; objective: string; }
export interface DepartmentSpace { id: string; department: string; name: string; mission?: string; objectives: string[]; policies: string[]; approvedTools: string[]; escalationOwner?: string; contextNodeIds?: string[]; activeMissionIds?: string[]; decisionNodeIds?: string[]; budget?: JsonObject; createdAt: number; updatedAt: number; }
export interface WorkPacket { id: string; department: string; objective: string; status: string; fromAgent?: string; toAgent?: string; inputs?: JsonObject; constraints?: string[]; outputSchema?: JsonObject; deadline?: number; approvalBoundary?: string; evidenceRequired: string[]; result?: JsonObject; evidence?: MissionEvidence[]; createdAt: number; updatedAt: number; }
export interface OutcomePackage { slug: string; name: string; department: string; description: string; requiredInputs: string[]; allowedTools: string[]; successCriteria: string[]; evidenceRequired: string[]; escalationRules: string[]; approvalPolicy: "draft_only" | "approve_external_action" | "approve_every_write"; budget: Record<string, unknown>; slaSeconds: number; deliverable: string; }
export interface OutcomePlan { package: OutcomePackage; missingInputs: string[]; objective: string; definitionOfDone: string; steps: Array<{ id: string; title: string; objective: string; dependsOn?: string[]; evidenceRequired: string[] }>; }

export interface Approval {
  id: string;
  status: "pending" | "approved" | "denied" | "consumed";
  toolSlug: string;
  args: JsonObject;
  expiresAt: string;
  createdAt?: string;
  request?: string;
  channelProvider?: string;
  handoffId?: string;
}
export interface ApprovalDecision { id: string; status: "denied" | "consumed"; text?: string; }

export interface Skill { name: string; description: string; path: string; bytes?: number; updatedAt?: string; files?: number; }
export interface SkillFile { name?: string; path: string; bytes: number; binary: boolean; content?: string; truncated?: boolean; }
export interface Tool { slug: string; description: string; source: "native" | "composio"; approval?: "auto" | "approval_required"; toolkit?: string; connected?: boolean; }
export interface Artifact { id: string; name: string; type: "website" | "report" | "docx" | "presentation" | "pdf" | "spreadsheet" | "image" | "video" | "zip" | "project"; path: string; contentType: string; size: number; status: "available"; sandboxId: string; createdAt: string; updatedAt: string; downloadUrl?: string; }
export interface VideoJob { id: string; prompt: string; destination: "telegram" | "daytona" | "both"; workspacePath?: string; workflowRunId?: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; pollCount: number; error?: string; resultPath?: string; createdAt: string; updatedAt: string; completedAt?: string; }
export interface Worker { id: string; worker: string; from: string; objective: string; expectedOutput: string; status: string; taskId?: string; workflowRunId?: string; timestamp: string; delegation?: JsonObject; context?: JsonObject; }
export interface ChannelConnection { provider: string; externalUserId: string; workspaceId?: string; displayName?: string; verifiedAt: string; proactiveOptIn: boolean; }
export type LinkableChannelProvider = "slack" | "whatsapp" | "sendblue";
export interface Activity { now: number; approvals: Approval[]; tasks: Task[]; reminders: JsonObject[]; jobs: JsonObject[]; }
export interface Delivery { id: string; provider: string; status: string; kind: string; attempts: number; providerStatus?: string; lastError?: string; createdAt: string; updatedAt: string; deliveredAt?: string; }

export type RunStreamEvent =
  | { type: "run.queued"; run: Run }
  | { type: "run.started"; run: Run }
  /** Policy-owned human progress text shared with Telegram and the dashboard. */
  | { type: "run.status"; runId: string; text: string }
  | { type: "run.delta"; runId: string; text: string }
  | { type: "run.tool_started"; runId: string; toolSlug: string }
  | { type: "run.approval_required"; run: Run; approval: Approval }
  | { type: "run.completed"; run: Run }
  | { type: "run.failed"; run: Run; error: { code: string; message: string } }
  | { type: "run.cancelled"; run: Run };

export interface RunEvent { id: string; type: string; at: number; text?: string; }

export interface ChuskyClientOptions {
  apiKey: string;
  /** Stable developer-owned identifier for the end user whose Chusky state is used. */
  userId: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  userAgent?: string;
  /** Default model for runs created by this client. A run-level model overrides it. */
  model?: string;
}
