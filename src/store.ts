/**
 * Persistent store — Redis (preferred) or in-memory fallback.
 * Handles: message history, model selection, rate limiting, composio session IDs.
 */
import Redis from "ioredis";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { ChannelProvider, InboundMessage } from "./channels/contracts.js";

export interface Message {
  role: "user" | "assistant";
  content: string;
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
  summaries: string[];
  approvals: ApprovalRecord[];
  sdkThreads?: SdkThreadRecord[];
  sdkFiles?: SdkFileRecord[];
  artifacts?: ArtifactRecord[];
  sdkIdempotency?: Record<string, { fingerprint: string; response: unknown; createdAt: number }>;
  sdkAudit?: Array<{ id: string; action: string; requestId: string; status: number; at: number }>;
  sdkWebhooks?: Array<{ id: string; url: string; secretCiphertext: string; createdAt: number; disabledAt?: number }>;
  sdkProjects?: SdkProjectRecord[];
  createdAt: number;
  updatedAt: number;
}
export interface SdkProjectRecord { id: string; name: string; keyPrefix: string; keyHash: string; scopes: string[]; createdAt: number; revokedAt?: number; }

export interface SdkRunRecord {
  id: string;
  status: "queued" | "running" | "requires_approval" | "completed" | "failed" | "cancelled";
  input: string;
  output?: string;
  approvalId?: string;
  error?: { code: string; message: string };
  events: Array<{ id: string; type: string; at: number; text?: string }>;
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
export type ArtifactType = "website" | "report" | "presentation" | "pdf" | "spreadsheet" | "image" | "video" | "zip" | "project";
export interface ArtifactRecord { id: string; userId: number; sandboxId: string; name: string; type: ArtifactType; path: string; contentType: string; size: number; status: "available"; createdAt: number; updatedAt: number; }

export interface DaytonaWorkspaceRecord {
  sandboxId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastKnownState?: string;
  ptySessions?: Array<{ id: string; createdAt: number }>;
  browser?: { lastUrl?: string; updatedAt: number };
}

export type TaskStatus = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

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
  type: "created" | "scheduled" | "claimed" | "checkpointed" | "blocked" | "completed" | "failed" | "cancelled" | "retried";
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
}

export interface ReminderRecord {
  id: string;
  userId: number;
  text: string;
  runAt: number;
  workflowRunId?: string;
  status: "scheduled" | "sent" | "cancelled" | "failed";
  createdAt: number;
}

export interface JobRecord {
  id: string;
  userId: number;
  text: string;
  cron: string;
  scheduleId: string;
  status: "active" | "cancelled";
  createdAt: number;
}

export interface ScratchpadEntry {
  content: string;
  updatedAt: number;
}

export interface MemoryFact {
  id: string;
  category: "preference" | "profile" | "fact" | "instruction";
  key: string;
  value: string;
  confidence: number;
  updatedAt: number;
}

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

export interface OutboxRecord {
  id: string;
  idempotencyKey: string;
  accountId: string;
  userId: number;
  provider: ChannelProvider;
  conversationId: string;
  threadId?: string;
  workspaceId?: string;
  text?: string;
  blocks?: unknown[];
  interactive?: {
    kind: "buttons";
    body: string;
    buttons: Array<{ id: string; title: string }>;
  };
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
  history: Message[];
  summaries: string[];
  createdAt: number;
  updatedAt: number;
}

interface Backend {
  getSession(userId: number): Promise<UserSession>;
  saveSession(userId: number, s: UserSession): Promise<void>;
  incrRate(userId: number): Promise<number>;
  acquireLock(userId: number, token: string, leaseSeconds: number): Promise<boolean>;
  renewLock(userId: number, token: string, leaseSeconds: number): Promise<boolean>;
  releaseLock(userId: number, token: string): Promise<void>;
  claimTelegramUpdate(updateId: number, ttlSeconds: number): Promise<boolean>;
  createTriggerEvent(record: TriggerEventRecord): Promise<TriggerEventRecord>;
  getTriggerEvent(eventId: string): Promise<TriggerEventRecord | undefined>;
  updateTriggerEvent(eventId: string, patch: Partial<TriggerEventRecord>): Promise<TriggerEventRecord | undefined>;
  getDaytonaWorkspace(userId: number): Promise<DaytonaWorkspaceRecord | undefined>;
  saveDaytonaWorkspace(userId: number, workspace: DaytonaWorkspaceRecord): Promise<void>;
  clearDaytonaWorkspace(userId: number): Promise<void>;
  getTasks(userId: number): Promise<TaskRecord[]>;
  saveTasks(userId: number, tasks: TaskRecord[]): Promise<void>;
  claimTask(userId: number, id: string, workerId: string, leaseMs: number): Promise<TaskRecord | undefined>;
  settleTask(userId: number, id: string, leaseToken: string, patch: Partial<TaskRecord>, event: TaskEvent): Promise<TaskRecord | undefined>;
  createCliPairing(record: CliPairingRecord): Promise<void>;
  consumeCliPairing(codeHash: string): Promise<CliPairingRecord | undefined>;
  saveCliDevice(record: CliDeviceRecord): Promise<void>;
  getCliDevice(tokenHash: string): Promise<CliDeviceRecord | undefined>;
  revokeCliDevice(userId: number, tokenHash: string): Promise<boolean>;
  listCliDevices(userId: number): Promise<CliDeviceRecord[]>;
  claimApproval(userId: number, id: string): Promise<ApprovalRecord | undefined>;
  getChannelIdentity(provider: ChannelProvider, externalUserId: string, workspaceId?: string): Promise<ChannelIdentityRecord | undefined>;
  listChannelIdentities(userId: number): Promise<ChannelIdentityRecord[]>;
  saveChannelIdentity(record: ChannelIdentityRecord): Promise<boolean>;
  getChannelInstallation(provider: ChannelInstallationRecord["provider"], workspaceId: string): Promise<ChannelInstallationRecord | undefined>;
  saveChannelInstallation(record: ChannelInstallationRecord): Promise<void>;
  createChannelOAuthState(record: ChannelOAuthStateRecord): Promise<void>;
  consumeChannelOAuthState(stateHash: string): Promise<ChannelOAuthStateRecord | undefined>;
  createChannelLinkCode(record: ChannelLinkCodeRecord): Promise<void>;
  consumeChannelLinkCode(provider: ChannelProvider, codeHash: string): Promise<ChannelLinkCodeRecord | undefined>;
  claimChannelEvent(provider: ChannelProvider, eventId: string, ttlSeconds: number): Promise<boolean>;
  completeChannelEvent(provider: ChannelProvider, eventId: string, ttlSeconds: number): Promise<void>;
  releaseChannelEvent(provider: ChannelProvider, eventId: string): Promise<void>;
  createOutbox(record: OutboxRecord): Promise<OutboxRecord>;
  getOutbox(id: string): Promise<OutboxRecord | undefined>;
  claimOutbox(id: string, leaseMs: number): Promise<OutboxRecord | undefined>;
  updateOutbox(id: string, patch: Partial<OutboxRecord>): Promise<OutboxRecord | undefined>;
  getOutboxByProviderMessageId(provider: ChannelProvider, providerMessageId: string): Promise<OutboxRecord | undefined>;
  listOutbox(statuses?: OutboxRecord["status"][], limit?: number): Promise<OutboxRecord[]>;
  getChannelConversation(id: string): Promise<ChannelConversationRecord | undefined>;
  saveChannelConversation(record: ChannelConversationRecord): Promise<void>;
  enqueueChannelDebounce(key: string, message: InboundMessage, ttlSeconds: number): Promise<void>;
  takeChannelDebounce(key: string): Promise<InboundMessage[]>;
}

// ── Redis ─────────────────────────────────────────────────────────────────────
class RedisBackend implements Backend {
  constructor(private r: Redis) {}
  private sk = (id: number) => `chuck:session:${id}`;
  private rk = (id: number) => `chuck:rate:${id}`;
  private dk = (id: number) => `chuck:daytona:${id}`;
  private taskk = (id: number) => `chuck:tasks:${id}`;
  private pk = (hash: string) => `chuck:cli:pairing:${hash}`;
  private tk = (hash: string) => `chuck:cli:device:${hash}`;
  private uk = (id: number) => `chuck:user:${id}:devices`;
  private telegramUpdateKey = (id: number) => `chuck:telegram:update:${id}`;
  private triggerEventKey = (id: string) => `chuck:trigger:event:${createHash("sha256").update(id).digest("hex")}`;
  private channelIdentityKey = (provider: ChannelProvider, externalUserId: string, workspaceId?: string) => `chuck:channel:identity:${provider}:${createHash("sha256").update(`${workspaceId ?? "-"}:${externalUserId}`).digest("hex")}`;
  private channelIdentityUserKey = (userId: number) => `chuck:user:${userId}:channel-identities`;
  private channelInstallationKey = (provider: ChannelInstallationRecord["provider"], workspaceId: string) => `chuck:channel:installation:${provider}:${workspaceId}`;
  private channelOAuthKey = (stateHash: string) => `chuck:channel:oauth:${stateHash}`;
  private channelLinkKey = (provider: ChannelProvider, codeHash: string) => `chuck:channel:link:${provider}:${codeHash}`;
  private channelEventKey = (provider: ChannelProvider, eventId: string) => `chuck:channel:event:${provider}:${createHash("sha256").update(eventId).digest("hex")}`;
  private channelEventDoneKey = (provider: ChannelProvider, eventId: string) => `chuck:channel:event:done:${provider}:${createHash("sha256").update(eventId).digest("hex")}`;
  private outboxKey = (id: string) => `chuck:outbox:${id}`;
  private outboxIdempotencyKey = (key: string) => `chuck:outbox:idempotency:${createHash("sha256").update(key).digest("hex")}`;
  private outboxProviderKey = (provider: ChannelProvider, providerMessageId: string) => `chuck:outbox:provider:${provider}:${createHash("sha256").update(providerMessageId).digest("hex")}`;
  private channelConversationKey = (id: string) => `chuck:channel:conversation:${createHash("sha256").update(id).digest("hex")}`;
  private channelDebounceKey = (id: string) => `chuck:channel:debounce:${createHash("sha256").update(id).digest("hex")}`;

  async getSession(userId: number): Promise<UserSession> {
    const raw = await this.r.get(this.sk(userId));
    if (raw) {
      try { return JSON.parse(raw) as UserSession; } catch { /* fallthrough */ }
    }
    return fresh();
  }

  async saveSession(userId: number, s: UserSession): Promise<void> {
    // User 0 is the SDK control plane (projects, hashes, and admin audit), not a conversation.
    // It must survive the normal chat-session TTL just like durable tasks and CLI devices.
    if (userId === 0) { await this.r.set(this.sk(userId), JSON.stringify(s)); return; }
    await this.r.setex(this.sk(userId), config.sessionTtl, JSON.stringify(s));
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
    const key = this.sk(userId);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.r.watch(key);
      const raw = await this.r.get(key);
      if (!raw) { await this.r.unwatch(); return undefined; }
      const s = JSON.parse(raw) as UserSession;
      const approval = s.approvals?.find((a) => a.id === id);
      if (!approval || approval.status !== "pending" || approval.expiresAt <= Date.now()) { await this.r.unwatch(); return undefined; }
      approval.status = "approved";
      const result = await this.r.multi().setex(key, config.sessionTtl, JSON.stringify(s)).exec();
      if (result) return approval;
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
      const result = await this.r.multi().set(key, JSON.stringify(next), "EX", 30 * 24 * 60 * 60).exec();
      if (result) return next;
    }
    return undefined;
  }
  async updateOutbox(id: string, patch: Partial<OutboxRecord>): Promise<OutboxRecord | undefined> {
    const current = await this.getOutbox(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id: current.id, idempotencyKey: current.idempotencyKey, updatedAt: Date.now() };
    await this.r.set(this.outboxKey(id), JSON.stringify(next), "EX", 30 * 24 * 60 * 60);
    if (next.providerMessageId) await this.r.set(this.outboxProviderKey(next.provider, next.providerMessageId), id, "EX", 30 * 24 * 60 * 60);
    return next;
  }
  async getOutboxByProviderMessageId(provider: ChannelProvider, providerMessageId: string) {
    const id = await this.r.get(this.outboxProviderKey(provider, providerMessageId));
    return id ? this.getOutbox(id) : undefined;
  }
  async listOutbox(statuses?: OutboxRecord["status"][], limit = 100): Promise<OutboxRecord[]> {
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
  private rates = new Map<number, { n: number; exp: number }>();
  private locks = new Map<number, { token: string; exp: number }>();
  private pairings = new Map<string, CliPairingRecord>();
  private devices = new Map<string, CliDeviceRecord>();
  private telegramUpdates = new Map<number, number>();
  private channelIdentities = new Map<string, ChannelIdentityRecord>();
  private channelIdentityUsers = new Map<number, Set<string>>();
  private channelInstallations = new Map<string, ChannelInstallationRecord>();
  private channelOAuthStates = new Map<string, ChannelOAuthStateRecord>();
  private channelLinkCodes = new Map<string, ChannelLinkCodeRecord>();
  private channelEvents = new Map<string, number>();
  private completedChannelEvents = new Map<string, number>();
  private outbox = new Map<string, OutboxRecord>();
  private triggerEvents = new Map<string, TriggerEventRecord>();
  private outboxByIdempotency = new Map<string, string>();
  private channelConversations = new Map<string, ChannelConversationRecord>();
  private outboxByProvider = new Map<string, string>();
  private channelDebounce = new Map<string, InboundMessage[]>();

  async getSession(userId: number) { return this.sessions.get(userId) ?? fresh(); }
  async saveSession(userId: number, s: UserSession) { this.sessions.set(userId, s); }
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
  private daytona = new Map<number, DaytonaWorkspaceRecord>();
  private tasks = new Map<number, TaskRecord[]>();
  async getDaytonaWorkspace(userId: number) { return this.daytona.get(userId); }
  async saveDaytonaWorkspace(userId: number, workspace: DaytonaWorkspaceRecord) { this.daytona.set(userId, workspace); }
  async clearDaytonaWorkspace(userId: number) { this.daytona.delete(userId); }
  async getTasks(userId: number) { return this.tasks.get(userId) ?? []; }
  async saveTasks(userId: number, tasks: TaskRecord[]) { this.tasks.set(userId, tasks); }
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
    const s = this.sessions.get(userId);
    const approval = s?.approvals?.find((a) => a.id === id);
    if (!approval || approval.status !== "pending" || approval.expiresAt <= Date.now()) return undefined;
    approval.status = "approved";
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
  async enqueueChannelDebounce(key: string, message: InboundMessage, _ttlSeconds: number) { this.channelDebounce.set(key, [...(this.channelDebounce.get(key) ?? []), message].slice(-20)); }
  async takeChannelDebounce(key: string) { const messages = this.channelDebounce.get(key) ?? []; this.channelDebounce.delete(key); return messages; }
}

function fresh(): UserSession {
  const now = Date.now();
  return { model: config.defaultModel, history: [], totalMessages: 0, totalCost: 0, triggerIds: [], reminders: [], jobs: [], scratchpad: {}, memories: [], summaries: [], approvals: [], artifacts: [], createdAt: now, updatedAt: now };
}

let backend: Backend;

export async function initStore(options: { memoryOnly?: boolean } = {}): Promise<void> {
  if (config.webhookUrl && !config.redisUrl && !options.memoryOnly) {
    throw new Error("REDIS_URL is required in webhook/production mode; refusing in-memory persistence");
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
      if (config.webhookUrl) throw new Error("Redis is unavailable in webhook/production mode; refusing in-memory persistence");
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

export async function getSession(uid: number): Promise<UserSession> {
  const s = await backend.getSession(uid);
  return { ...fresh(), ...s, triggerIds: s.triggerIds ?? [], reminders: s.reminders ?? [], jobs: s.jobs ?? [], scratchpad: s.scratchpad ?? {}, memories: s.memories ?? [], summaries: s.summaries ?? [], approvals: s.approvals ?? [], sdkProjects: s.sdkProjects ?? [], sdkFiles: s.sdkFiles ?? [], artifacts: s.artifacts ?? [], sdkIdempotency: s.sdkIdempotency ?? {}, sdkAudit: s.sdkAudit ?? [], sdkWebhooks: s.sdkWebhooks ?? [], sdkThreads: (s.sdkThreads ?? []).map((thread) => ({ ...thread, history: thread.history ?? [], runs: (thread.runs ?? []).map((run) => ({ ...run, events: run.events ?? [] })) })) };
}

export async function saveSession(uid: number, s: UserSession): Promise<void> {
  s.updatedAt = Date.now();
  return backend.saveSession(uid, s);
}

export async function appendMessages(uid: number, msgs: Message[]): Promise<void> {
  const s = await getSession(uid);
  s.history.push(...msgs);
  s.totalMessages += msgs.filter((m) => m.role === "user").length;
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

export async function createTask(userId: number, input: Pick<TaskRecord, "title" | "objective"> & Partial<Pick<TaskRecord, "steps" | "workspaceId" | "runAt" | "maxAttempts">>): Promise<TaskRecord> {
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
  if (!task || ["completed", "cancelled"].includes(task.status)) return undefined;
  return updateTask(userId, id, { status: "running", checkpoint, nextAction, error: undefined });
}

export async function blockTask(userId: number, id: string, error: string, nextAction?: string): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || ["completed", "cancelled"].includes(task.status)) return undefined;
  return updateTask(userId, id, { status: "blocked", error, nextAction });
}

export async function completeTask(userId: number, id: string, result: string): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || task.status === "cancelled") return undefined;
  return updateTask(userId, id, { status: "completed", result, nextAction: undefined, error: undefined });
}

export async function cancelTask(userId: number, id: string): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || ["completed", "cancelled"].includes(task.status)) return undefined;
  return updateTask(userId, id, { status: "cancelled", nextAction: undefined });
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

export async function settleTaskRun(userId: number, id: string, leaseToken: string, outcome: { status: "completed" | "blocked" | "failed" | "queued"; message: string; checkpoint?: string; nextAction?: string; result?: string }): Promise<TaskRecord | undefined> {
  const task = await getTask(userId, id);
  if (!task || task.lease?.token !== leaseToken) return undefined;
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
  const s = await getSession(uid);
  s.reminders = [...s.reminders.filter((r) => r.id !== reminder.id), reminder].slice(-100);
  await saveSession(uid, s);
}

export async function listReminders(uid: number): Promise<ReminderRecord[]> {
  return (await getSession(uid)).reminders.filter((r) => r.status === "scheduled").sort((a, b) => a.runAt - b.runAt);
}

export async function getReminder(uid: number, id: string): Promise<ReminderRecord | undefined> {
  return (await getSession(uid)).reminders.find((r) => r.id === id);
}

export async function updateReminder(uid: number, id: string, patch: Partial<ReminderRecord>): Promise<boolean> {
  const s = await getSession(uid);
  const r = s.reminders.find((item) => item.id === id);
  if (!r) return false;
  Object.assign(r, patch);
  await saveSession(uid, s);
  return true;
}

export async function addJob(uid: number, job: JobRecord): Promise<void> {
  const s = await getSession(uid);
  s.jobs = [...s.jobs.filter((j) => j.id !== job.id), job].slice(-100);
  await saveSession(uid, s);
}

export async function listJobs(uid: number): Promise<JobRecord[]> {
  return (await getSession(uid)).jobs.filter((j) => j.status === "active");
}

export async function getJob(uid: number, id: string): Promise<JobRecord | undefined> {
  return (await getSession(uid)).jobs.find((j) => j.id === id);
}

export async function updateJob(uid: number, id: string, patch: Partial<JobRecord>): Promise<boolean> {
  const s = await getSession(uid);
  const j = s.jobs.find((item) => item.id === id);
  if (!j) return false;
  Object.assign(j, patch);
  await saveSession(uid, s);
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

export async function upsertMemory(uid: number, memory: Omit<MemoryFact, "id" | "updatedAt"> & { id?: string }): Promise<MemoryFact> {
  const s = await getSession(uid);
  const existing = s.memories.find((m) => (memory.id && m.id === memory.id) || (!memory.id && m.key === memory.key));
  const value: MemoryFact = { id: existing?.id ?? memory.id ?? `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, category: memory.category, key: memory.key, value: memory.value, confidence: Math.max(0, Math.min(1, memory.confidence)), updatedAt: Date.now() };
  s.memories = [...s.memories.filter((m) => m.id !== value.id && m.key !== value.key), value].slice(-200);
  await saveSession(uid, s);
  return value;
}

export async function searchMemories(uid: number, query?: string): Promise<MemoryFact[]> {
  const memories = (await getSession(uid)).memories;
  if (!query?.trim()) return memories;
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  return memories.map((m) => ({ m, score: tokens.reduce((n, t) => n + (`${m.category} ${m.key} ${m.value}`.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt).map((x) => x.m);
}

export async function forgetMemory(uid: number, key: string): Promise<boolean> {
  const s = await getSession(uid);
  const before = s.memories.length;
  s.memories = s.memories.filter((m) => m.key !== key && m.id !== key);
  if (s.memories.length === before) return false;
  await saveSession(uid, s);
  return true;
}

export async function addHistorySummary(uid: number, summary: string): Promise<void> {
  const s = await getSession(uid);
  s.summaries = [...s.summaries, summary].slice(-10);
  await saveSession(uid, s);
}

export async function createApproval(record: Omit<ApprovalRecord, "id" | "status" | "createdAt" | "expiresAt">, ttlMs = 15 * 60 * 1000): Promise<ApprovalRecord> {
  const s = await getSession(record.userId);
  const approval: ApprovalRecord = { ...record, id: `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, status: "pending", createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
  s.approvals = [...s.approvals.filter((a) => a.status === "pending" ? a.expiresAt > Date.now() : true), approval].slice(-20);
  await saveSession(record.userId, s);
  return approval;
}

export async function getApproval(uid: number, id: string): Promise<ApprovalRecord | undefined> {
  return (await getSession(uid)).approvals.find((a) => a.id === id);
}

export async function setApprovalStatus(uid: number, id: string, status: ApprovalRecord["status"]): Promise<boolean> {
  const s = await getSession(uid);
  const approval = s.approvals.find((a) => a.id === id);
  if (!approval) return false;
  if ((status === "approved" || status === "denied") && (approval.status !== "pending" || approval.expiresAt <= Date.now())) return false;
  if (status === "consumed" && approval.status !== "approved") return false;
  approval.status = status;
  await saveSession(uid, s);
  return true;
}

export async function claimApproval(uid: number, id: string): Promise<ApprovalRecord | undefined> {
  return backend.claimApproval(uid, id);
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
  const history = [...(current?.history ?? []), ...input.messages];
  const cap = config.maxHistory * 2;
  const overflow = history.length > cap ? history.slice(0, history.length - cap) : [];
  const summaries = [...(current?.summaries ?? []), ...(overflow.length ? [overflow.map((m) => `${m.role}: ${m.content}`).join(" ").slice(0, 1800)] : [])].slice(-10);
  const record: ChannelConversationRecord = {
    id: input.id,
    accountId: input.accountId,
    userId: input.userId,
    provider: input.provider,
    scope: input.scope,
    history: history.slice(-cap),
    summaries,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  await backend.saveChannelConversation(record);
  return record;
}

export async function enqueueChannelDebounce(key: string, message: InboundMessage, ttlSeconds = 30): Promise<void> {
  if (!key.trim()) throw new Error("Debounce key is required");
  await backend.enqueueChannelDebounce(key, message, Math.max(5, Math.min(300, ttlSeconds)));
}

export async function takeChannelDebounce(key: string): Promise<InboundMessage[]> {
  return backend.takeChannelDebounce(key);
}
