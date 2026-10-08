import { createHash, randomUUID } from "node:crypto";
import Redis from "ioredis";

export interface BuilderControl { version: number; agentEnabled: boolean; changedAt?: number }
export interface BuilderAuditEvent { id: string; actorId: string; action: "agent_execution_changed" | "builder_verified" | "user_suspended" | "user_restored" | "user_sessions_revoked" | "user_removed"; at: number; enabled?: boolean; reason?: "incident" | "maintenance" | "release"; version?: number; targetUserId?: string }
export interface BuilderRepository {
  read(): Promise<BuilderControl>;
  change(expected: number, enabled: boolean, event: BuilderAuditEvent): Promise<BuilderControl | undefined>;
  events(): Promise<BuilderAuditEvent[]>;
  record(event: BuilderAuditEvent): Promise<void>;
  verified(token: string): Promise<boolean>;
  verify(token: string): Promise<void>;
  admit(actorId: string): Promise<boolean>;
}
const STATE_KEY = "chuck:builder:{control}:state";
const AUDIT_KEY = "chuck:builder:{control}:audit";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const builderEnabled = () => process.env.CHUSKY_BUILDER_ADMIN_ENABLED === "true";

export function parseBuilderControl(raw: string | null): BuilderControl {
  if (raw === null) return { version: 0, agentEnabled: true };
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("version" in value) || !("agentEnabled" in value)
    || !Number.isSafeInteger(value.version) || (value.version as number) < 0 || typeof value.agentEnabled !== "boolean") {
    throw new Error("Builder control state is invalid.");
  }
  return value as BuilderControl;
}

// Same Redis hash slot: the control change and its audit record commit atomically.
export const CHANGE_BUILDER_CONTROL = `
local raw = redis.call("GET", KEYS[1])
local current = raw and cjson.decode(raw) or {version=0, agentEnabled=true}
if current.version ~= tonumber(ARGV[1]) then return nil end
local next = {version=current.version+1, agentEnabled=ARGV[2]=="true", changedAt=tonumber(ARGV[3])}
local event = cjson.decode(ARGV[4])
event.version = next.version
redis.call("LPUSH", KEYS[2], cjson.encode(event))
redis.call("LTRIM", KEYS[2], 0, 999)
redis.call("SET", KEYS[1], cjson.encode(next))
return cjson.encode(next)
`;

export class RedisBuilderRepository implements BuilderRepository {
  constructor(private readonly redis: Redis) {}
  async read() { return parseBuilderControl(await this.redis.get(STATE_KEY)); }
  async change(expected: number, enabled: boolean, event: BuilderAuditEvent) {
    const raw = await this.redis.eval(CHANGE_BUILDER_CONTROL, 2, STATE_KEY, AUDIT_KEY, expected, String(enabled), event.at, JSON.stringify(event));
    return typeof raw === "string" ? parseBuilderControl(raw) : undefined;
  }
  async events() { return (await this.redis.lrange(AUDIT_KEY, 0, 99)).map((item) => JSON.parse(item) as BuilderAuditEvent); }
  async record(event: BuilderAuditEvent) {
    const result = await this.redis.multi().lpush(AUDIT_KEY, JSON.stringify(event)).ltrim(AUDIT_KEY, 0, 999).exec();
    if (!result || result.some(([error]) => error)) throw new Error("Builder audit persistence failed.");
  }
  async verified(token: string) { return Boolean(await this.redis.get(`chuck:builder:verified:${digest(token)}`)); }
  async verify(token: string) { await this.redis.set(`chuck:builder:verified:${digest(token)}`, "1", "EX", 900); }
  async admit(actorId: string) {
    const value = await this.redis.eval(`local n=redis.call("INCR",KEYS[1]); if n==1 then redis.call("EXPIRE",KEYS[1],60) end; return n`, 1, `chuck:builder:rate:${digest(actorId)}`);
    return typeof value === "number" && value <= 30;
  }
}

let redis: Redis | undefined;
let repository: BuilderRepository | undefined;
export function builderRepository(): BuilderRepository {
  if (!repository) {
    const url = process.env.REDIS_URL?.trim();
    if (!url) throw new Error("Builder controls require Redis.");
    redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5000, commandTimeout: 5000 });
    repository = new RedisBuilderRepository(redis);
  }
  return repository;
}
export async function closeBuilderControl() {
  if (redis) { redis.disconnect(); redis = undefined; }
  repository = undefined;
  invalidateBuilderControl();
}
export class BuilderExecutionGate {
  private cached?: { state: BuilderControl; expiresAt: number };
  private pending?: Promise<void>;
  private generation = 0;
  constructor(private readonly read: () => Promise<BuilderControl>, private readonly now = Date.now) {}
  invalidate() { this.cached = undefined; this.generation += 1; }
  async assertEnabled(): Promise<void> {
    if (!this.cached || this.cached.expiresAt <= this.now()) {
      const generation = this.generation;
      this.pending ??= this.read().then((state) => {
        if (generation === this.generation) this.cached = { state, expiresAt: this.now() + 5000 };
      }).finally(() => { this.pending = undefined; });
      await this.pending;
      // A write invalidated an in-flight read. Re-read rather than using stale controls.
      if (!this.cached) return this.assertEnabled();
    }
    if (!this.cached.state.agentEnabled) throw new Error("Agent execution is temporarily paused by the Chusky operators. Please try again later.");
  }
}
const executionGate = new BuilderExecutionGate(() => builderRepository().read());
export function invalidateBuilderControl() { executionGate.invalidate(); }
export async function assertAgentExecutionEnabled(): Promise<void> {
  if (builderEnabled()) await executionGate.assertEnabled();
}
export const newBuilderEvent = (actorId: string, action: BuilderAuditEvent["action"]): BuilderAuditEvent => ({ id: randomUUID(), actorId, action, at: Date.now() });
