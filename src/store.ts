/**
 * Persistent store — Redis (preferred) or in-memory fallback.
 * Handles: message history, model selection, rate limiting, composio session IDs.
 */
import Redis from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

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
  telegramChatId?: number;
  triggerIds: string[];
  reminders: ReminderRecord[];
  jobs: JobRecord[];
  scratchpad: Record<string, ScratchpadEntry>;
  memories: MemoryFact[];
  summaries: string[];
  approvals: ApprovalRecord[];
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
  toolSlug: string;
  args: Record<string, unknown>;
  request: string;
  history: Message[];
  model: string;
  status: "pending" | "approved" | "consumed" | "denied" | "expired";
  createdAt: number;
  expiresAt: number;
}

interface Backend {
  getSession(userId: number): Promise<UserSession>;
  saveSession(userId: number, s: UserSession): Promise<void>;
  incrRate(userId: number): Promise<number>;
  acquireLock(userId: number, token: string, leaseSeconds: number): Promise<boolean>;
  releaseLock(userId: number, token: string): Promise<void>;
}

// ── Redis ─────────────────────────────────────────────────────────────────────
class RedisBackend implements Backend {
  constructor(private r: Redis) {}
  private sk = (id: number) => `chuck:session:${id}`;
  private rk = (id: number) => `chuck:rate:${id}`;

  async getSession(userId: number): Promise<UserSession> {
    const raw = await this.r.get(this.sk(userId));
    if (raw) {
      try { return JSON.parse(raw) as UserSession; } catch { /* fallthrough */ }
    }
    return fresh();
  }

  async saveSession(userId: number, s: UserSession): Promise<void> {
    await this.r.setex(this.sk(userId), config.sessionTtl, JSON.stringify(s));
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
  async releaseLock(userId: number, token: string): Promise<void> {
    await this.r.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, `chuck:lock:${userId}`, token);
  }
}

// ── Memory ────────────────────────────────────────────────────────────────────
class MemoryBackend implements Backend {
  private sessions = new Map<number, UserSession>();
  private rates = new Map<number, { n: number; exp: number }>();
  private locks = new Map<number, { token: string; exp: number }>();

  async getSession(userId: number) { return this.sessions.get(userId) ?? fresh(); }
  async saveSession(userId: number, s: UserSession) { this.sessions.set(userId, s); }

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
  async releaseLock(userId: number, token: string): Promise<void> {
    if (this.locks.get(userId)?.token === token) this.locks.delete(userId);
  }
}

function fresh(): UserSession {
  const now = Date.now();
  return { model: config.defaultModel, history: [], totalMessages: 0, totalCost: 0, triggerIds: [], reminders: [], jobs: [], scratchpad: {}, memories: [], summaries: [], approvals: [], createdAt: now, updatedAt: now };
}

let backend: Backend;

export async function initStore(): Promise<void> {
  if (config.redisUrl) {
    try {
      const r = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
      await r.connect();
      await r.ping();
      backend = new RedisBackend(r);
      logger.info("Store: Redis connected");
      return;
    } catch (e) {
      logger.warn({ err: e }, "Store: Redis failed, using memory");
    }
  } else {
    logger.info("Store: using in-memory (set REDIS_URL for persistence)");
  }
  backend = new MemoryBackend();
}

export async function getSession(uid: number): Promise<UserSession> {
  const s = await backend.getSession(uid);
  return { ...fresh(), ...s, triggerIds: s.triggerIds ?? [], reminders: s.reminders ?? [], jobs: s.jobs ?? [], scratchpad: s.scratchpad ?? {}, memories: s.memories ?? [], summaries: s.summaries ?? [], approvals: s.approvals ?? [] };
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

export async function setComposioSessionId(uid: number, id: string): Promise<void> {
  const s = await getSession(uid);
  s.composioSessionId = id;
  await saveSession(uid, s);
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

export async function releaseUserLock(uid: number, token: string): Promise<void> {
  return backend.releaseLock(uid, token);
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
  if (!approval || (status === "approved" && (approval.status !== "pending" || approval.expiresAt <= Date.now()))) return false;
  approval.status = status;
  await saveSession(uid, s);
  return true;
}
