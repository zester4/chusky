import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import catalogDocument from "./mcp.json";
import { decryptCredential, encryptCredential, type EncryptedCredential } from "../vault/crypto.js";
import { getSession, saveSession, type McpConnectionRecord } from "../store.js";

const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_SCHEMA_CHARS = 40_000;
const MAX_ARGUMENT_BYTES = 128_000;
const SERVER_ID = /^[A-Za-z0-9_-]{1,48}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

export type McpAuth =
  | { type: "none" }
  | { type: "bearer"; tokenEnv?: string }
  | { type: "oauth" };

export interface McpCatalogEntry {
  id: string;
  name: string;
  url: string;
  auth: "none" | "bearer" | "oauth";
  scopes?: string[];
  enabled?: boolean;
  allowedTools?: string[];
  requireApproval?: boolean;
}

export interface McpCredential {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
}

/** Server-side registry entry. Never serialize the resolved bearer token. */
export interface McpServerDefinition {
  id: string;
  name: string;
  url: string;
  ownerIds: number[];
  enabled?: boolean;
  auth?: McpAuth;
  scopes?: string[];
  /** Empty means all discovered tools; prefer an explicit allowlist in production. */
  allowedTools?: string[];
  /** Unknown/side-effecting MCP actions require Chusky approval by default. */
  requireApproval?: boolean;
}

export interface McpOpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface McpToolRef {
  serverId: string;
  toolName: string;
  description: string;
  requireApproval: boolean;
  inputSchema: Record<string, unknown>;
}

type RegistryResult = { servers: McpServerDefinition[]; errors: string[] };

/**
 * Built-in catalog entries are available to any account that explicitly
 * connects them. The ownerIds field is only meaningful for the legacy
 * environment-variable registry, where entries are server-side allowlists.
 */
export function isMcpServerAllowedForUser(server: Pick<McpServerDefinition, "ownerIds">, userId: number, legacyRegistry: boolean): boolean {
  return !legacyRegistry || server.ownerIds.includes(userId);
}

function safeString(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max) : "";
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/[\[\]]/g, "");
  if (host === "localhost" || host === "metadata.google.internal" || host === "metadata.google.com") return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

export function validateMcpUrl(raw: string, production = process.env.NODE_ENV === "production"): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("MCP server URL must be a valid URL"); }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && !production && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))) {
    throw new Error("MCP server URL must use HTTPS (HTTP localhost is allowed only in development)");
  }
  const localDevelopmentUrl = !production && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (isPrivateHost(parsed.hostname) && !localDevelopmentUrl)) {
    throw new Error("MCP server URL contains a disallowed host or credential/query component");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeDefinition(value: unknown, index: number, production: boolean): McpServerDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MCP registry entry ${index + 1} must be an object`);
  const item = value as Record<string, unknown>;
  const id = safeString(item.id, 48);
  const name = safeString(item.name, 120);
  if (!SERVER_ID.test(id)) throw new Error(`MCP registry entry ${index + 1} has an invalid id`);
  if (!name) throw new Error(`MCP registry entry ${index + 1} needs a name`);
  const ownerIds = Array.isArray(item.ownerIds) ? [...new Set(item.ownerIds.filter((id): id is number => Number.isSafeInteger(id) && id > 0))] : [];
  if (!ownerIds.length) throw new Error(`MCP server ${id} must have at least one positive ownerId`);
  const authValue = item.auth && typeof item.auth === "object" && !Array.isArray(item.auth) ? item.auth as Record<string, unknown> : { type: "none" };
  const authType = authValue.type === "bearer" || authValue.type === "oauth" ? authValue.type : authValue.type === "none" || authValue.type === undefined ? "none" : "invalid";
  if (authType === "invalid") throw new Error(`MCP server ${id} has unsupported authentication; use none, bearer, or oauth`);
  const auth: McpAuth = authType === "bearer"
    ? { type: "bearer", ...(typeof authValue.tokenEnv === "string" ? { tokenEnv: safeString(authValue.tokenEnv, 120) } : {}) }
    : authType === "oauth" ? { type: "oauth" } : { type: "none" };
  if (auth.type === "bearer" && auth.tokenEnv !== undefined && !/^[A-Z][A-Z0-9_]{1,119}$/.test(auth.tokenEnv)) throw new Error(`MCP server ${id} needs a valid bearer tokenEnv`);
  const scopes = Array.isArray(item.scopes) ? [...new Set(item.scopes.map((scope) => safeString(scope, 120)).filter((scope) => /^[A-Za-z0-9._:-]{1,120}$/.test(scope)))].slice(0, 30) : [];
  const allowedTools = Array.isArray(item.allowedTools) ? [...new Set(item.allowedTools.map((tool) => safeString(tool, 128)).filter((tool) => TOOL_NAME.test(tool)))] : [];
  return {
    id,
    name,
    url: validateMcpUrl(safeString(item.url, 4096), production),
    ownerIds,
    enabled: item.enabled !== false,
    auth,
    ...(scopes.length ? { scopes } : {}),
    ...(allowedTools.length ? { allowedTools } : {}),
    requireApproval: item.requireApproval !== false,
  };
}

function catalogRegistry(): RegistryResult {
  const entries = Array.isArray((catalogDocument as { servers?: unknown }).servers) ? (catalogDocument as { servers: unknown[] }).servers : [];
  return parseMcpRegistry(JSON.stringify(entries.map((entry) => {
    const item = entry as Record<string, unknown>;
    return { ...item, ownerIds: [1], auth: item.auth === "oauth" ? { type: "oauth" } : item.auth === "bearer" ? { type: "bearer" } : { type: "none" } };
  })));
}

export function parseMcpRegistry(raw: string, production = process.env.NODE_ENV === "production"): RegistryResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "[]"); } catch { return { servers: [], errors: ["MCP_SERVERS_JSON is not valid JSON"] }; }
  if (!Array.isArray(parsed)) return { servers: [], errors: ["MCP_SERVERS_JSON must be a JSON array"] };
  const servers: McpServerDefinition[] = [];
  const errors: string[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    try { servers.push(normalizeDefinition(parsed[index], index, production)); } catch (error) { errors.push(error instanceof Error ? error.message : `Invalid MCP registry entry ${index + 1}`); }
  }
  const seen = new Set<string>();
  return { servers: servers.filter((server) => {
    if (seen.has(server.id)) { errors.push(`Duplicate MCP server id: ${server.id}`); return false; }
    seen.add(server.id); return true;
  }).slice(0, config.mcpMaxServers), errors };
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 10); }

export function namespaceMcpTool(serverId: string, toolName: string): string {
  const server = serverId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  const tool = toolName.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);
  return `MCP_${server}_${tool}_${hash(`${serverId}:${toolName}`)}`;
}

function boundedSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "object", properties: {}, additionalProperties: true };
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_SCHEMA_CHARS) return { type: "object", properties: {}, additionalProperties: true, description: "The server schema was too large; provide only the arguments described by the tool." };
  return value as Record<string, unknown>;
}

export function toOpenAITool(server: McpServerDefinition, tool: Record<string, unknown>): { tool: McpOpenAITool; ref: McpToolRef } | undefined {
  const originalName = safeString(tool.name, 128);
  if (!TOOL_NAME.test(originalName)) return undefined;
  if (server.allowedTools?.length && !server.allowedTools.includes(originalName)) return undefined;
  const description = safeString(tool.description ?? tool.title ?? `${server.name} MCP action`, MAX_DESCRIPTION_CHARS) || `${server.name} MCP action`;
  const inputSchema = boundedSchema(tool.inputSchema);
  const ref = { serverId: server.id, toolName: originalName, description, requireApproval: server.requireApproval !== false, inputSchema };
  return { tool: { type: "function", function: { name: namespaceMcpTool(server.id, originalName), description: `[${server.name}] ${description}`, parameters: inputSchema } }, ref };
}

function validateValue(value: unknown, schema: Record<string, unknown>, path = "arguments"): void {
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
    const object = value as Record<string, unknown>;
    for (const required of Array.isArray(schema.required) ? schema.required : []) if (typeof required === "string" && !(required in object)) throw new Error(`${path}.${required} is required`);
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties as Record<string, unknown> : {};
    for (const [key, child] of Object.entries(object)) if (properties[key] && typeof properties[key] === "object") validateValue(child, properties[key] as Record<string, unknown>, `${path}.${key}`);
    return;
  }
  if (type === "string" && typeof value !== "string") throw new Error(`${path} must be a string`);
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${path} must be a number`);
  if (type === "integer" && (!Number.isInteger(value))) throw new Error(`${path} must be an integer`);
  if (type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) throw new Error(`${path} has an unsupported value`);
}

export function validateMcpArguments(args: Record<string, unknown>, schema: Record<string, unknown>): void {
  const serialized = JSON.stringify(args);
  if (serialized.length > MAX_ARGUMENT_BYTES) throw new Error("MCP tool arguments are too large");
  validateValue(args, schema);
}

export function normalizeMcpResult(value: unknown, maxChars = config.mcpMaxResultChars): string {
  let output: string;
  try { output = typeof value === "string" ? value : JSON.stringify(value); } catch { output = "MCP tool returned a non-serializable result"; }
  if (output.length <= maxChars) return output;
  return `${output.slice(0, maxChars)}\n[MCP tool output truncated by Chusky]`;
}

function publicCatalog(registry: RegistryResult): McpCatalogEntry[] {
  return registry.servers.map((server) => ({ id: server.id, name: server.name, url: server.url, auth: server.auth?.type === "oauth" ? "oauth" : server.auth?.type === "bearer" ? "bearer" : "none", ...(server.scopes?.length ? { scopes: server.scopes } : {}), ...(server.enabled === false ? { enabled: false } : {}), ...(server.allowedTools?.length ? { allowedTools: server.allowedTools } : {}), requireApproval: server.requireApproval !== false }));
}

function normalizeMcpCredential(value: McpCredential | undefined): McpCredential | undefined {
  if (!value) return undefined;
  if (typeof value.accessToken !== "string" || !value.accessToken || value.accessToken.length > 4096 || /[\u0000-\u001F\u007F]/.test(value.accessToken)) throw new Error("MCP accessToken is invalid");
  if (value.refreshToken !== undefined && (typeof value.refreshToken !== "string" || value.refreshToken.length > 4096 || /[\u0000-\u001F\u007F]/.test(value.refreshToken))) throw new Error("MCP refreshToken is invalid");
  if (value.tokenType !== undefined && (typeof value.tokenType !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(value.tokenType))) throw new Error("MCP tokenType is invalid");
  if (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0)) throw new Error("MCP expiresAt is invalid");
  return { accessToken: value.accessToken, ...(value.refreshToken ? { refreshToken: value.refreshToken } : {}), ...(value.tokenType ? { tokenType: value.tokenType } : {}), ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}) };
}

export function listMcpCatalog(): { servers: McpCatalogEntry[]; errors: string[] } {
  const registry = catalogRegistry();
  return { servers: publicCatalog(registry), errors: registry.errors };
}

function encryptedCredential(record: McpConnectionRecord): McpCredential | undefined {
  if (!record.credential) return undefined;
  if (!config.mcpConnectionEncryptionKey) throw new Error("MCP_CONNECTION_ENCRYPTION_KEY is not configured");
  return normalizeMcpCredential(decryptCredential<Record<string, unknown>>(record.credential, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY") as unknown as McpCredential);
}

function safeConnection(record: McpConnectionRecord, catalog: McpCatalogEntry | undefined) {
  return { serverId: record.serverId, name: catalog?.name ?? record.serverId, auth: catalog?.auth ?? "oauth", enabled: record.enabled, connectedAt: new Date(record.createdAt).toISOString(), updatedAt: new Date(record.updatedAt).toISOString() };
}

export async function listMcpConnections(userId: number): Promise<ReturnType<typeof safeConnection>[]> {
  const catalog = new Map(listMcpCatalog().servers.map((server) => [server.id, server]));
  return (await getSession(userId)).mcpConnections!.filter((connection) => connection.enabled && catalog.has(connection.serverId)).map((connection) => safeConnection(connection, catalog.get(connection.serverId)));
}

export async function connectMcpServer(userId: number, serverId: string, credential?: McpCredential): Promise<ReturnType<typeof safeConnection>> {
  if (!config.mcpEnabled) throw new Error("Third-party MCP is disabled");
  const server = listMcpCatalog().servers.find((entry) => entry.id === serverId && entry.enabled !== false);
  if (!server) throw new Error("MCP server is not in the Chusky catalog");
  const normalizedCredential = normalizeMcpCredential(credential);
  if (server.auth !== "none" && !normalizedCredential) throw new Error("This MCP server requires a valid access token");
  if (normalizedCredential && !config.mcpConnectionEncryptionKey) throw new Error("MCP_CONNECTION_ENCRYPTION_KEY is not configured");
  const now = Date.now();
  const session = await getSession(userId);
  const existing = session.mcpConnections!.find((connection) => connection.serverId === serverId);
  const record: McpConnectionRecord = { serverId, enabled: true, createdAt: existing?.createdAt ?? now, updatedAt: now, ...(normalizedCredential ? { credential: encryptCredential(normalizedCredential as unknown as Record<string, unknown>, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY") } : {}) };
  session.mcpConnections = [...session.mcpConnections!.filter((connection) => connection.serverId !== serverId), record].slice(-50);
  await saveSession(userId, session);
  await mcpClient.invalidate(userId, serverId);
  return safeConnection(record, server);
}

export async function disconnectMcpServer(userId: number, serverId: string): Promise<boolean> {
  const session = await getSession(userId);
  const before = session.mcpConnections!.length;
  session.mcpConnections = session.mcpConnections!.filter((connection) => connection.serverId !== serverId);
  if (session.mcpConnections.length !== before) {
    await saveSession(userId, session);
    await mcpClient.invalidate(userId, serverId);
  }
  return session.mcpConnections.length !== before;
}

type Connection = { userId: number; client: Client; transport: StreamableHTTPClientTransport; tools: Map<string, McpToolRef>; lastUsedAt: number };

/** One bounded, reconnectable MCP client manager for the Chusky process. */
export class McpClientManager {
  private readonly connections = new Map<string, Connection>();
  private readonly pendingConnections = new Map<string, Promise<Connection>>();
  private readonly registry: RegistryResult;
  private readonly legacyRegistry: boolean;

  constructor(rawRegistry = config.mcpServersJson) {
    this.legacyRegistry = Boolean(rawRegistry && rawRegistry !== "[]");
    this.registry = this.legacyRegistry ? parseMcpRegistry(rawRegistry) : catalogRegistry();
  }

  configurationErrors(): string[] {
    const errors = [...this.registry.errors];
    if (!this.legacyRegistry && this.registry.servers.some((server) => server.auth?.type !== "none") && !config.mcpConnectionEncryptionKey) errors.push("MCP_CONNECTION_ENCRYPTION_KEY is required for connected MCP accounts");
    return errors;
  }

  private async definition(userId: number, serverId: string): Promise<{ server: McpServerDefinition; credential?: McpCredential }> {
    if (!config.mcpEnabled) throw new Error("Third-party MCP is disabled");
    const server = this.registry.servers.find((candidate) => candidate.id === serverId && candidate.enabled && isMcpServerAllowedForUser(candidate, userId, this.legacyRegistry));
    if (!server) throw new Error("MCP server is not in the Chusky catalog");
    if (this.legacyRegistry) return { server, credential: undefined };
    const connection = (await getSession(userId)).mcpConnections!.find((item) => item.serverId === serverId && item.enabled);
    if (!connection) throw new Error("MCP server is not connected for this account");
    return { server, credential: encryptedCredential(connection) };
  }

  private async connect(userId: number, server: McpServerDefinition, credential?: McpCredential, signal?: AbortSignal): Promise<Connection> {
    const key = `${userId}:${server.id}`;
    const existing = this.connections.get(key);
    if (existing) { existing.lastUsedAt = Date.now(); return existing; }
    const pending = this.pendingConnections.get(key);
    if (pending) return pending;
    const connectionPromise = this.openConnection(userId, server, key, credential, signal);
    this.pendingConnections.set(key, connectionPromise);
    try { return await connectionPromise; } finally { this.pendingConnections.delete(key); }
  }

  private async openConnection(userId: number, server: McpServerDefinition, key: string, credential?: McpCredential, signal?: AbortSignal): Promise<Connection> {
    const headers: Record<string, string> = {};
    if (server.auth?.type === "bearer" || server.auth?.type === "oauth") {
      const token = credential?.accessToken ?? (server.auth.type === "bearer" && server.auth.tokenEnv ? process.env[server.auth.tokenEnv] : undefined);
      if (!token) throw new Error(`MCP server ${server.id} is missing its configured bearer secret`);
      headers.Authorization = `${credential?.tokenType ?? "Bearer"} ${token}`;
    }
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers, redirect: "error" },
      reconnectionOptions: { initialReconnectionDelay: 250, maxReconnectionDelay: 5_000, reconnectionDelayGrowFactor: 2, maxRetries: 2 },
    });
    const client = new Client({ name: "chusky", version: "3.0.0" }, { capabilities: {} });
    await client.connect(transport, { signal });
    if (signal?.aborted) { await transport.close().catch(() => undefined); throw new Error("MCP connection cancelled"); }
    const tools = new Map<string, McpToolRef>();
    let cursor: string | undefined;
    for (let page = 0; page < 10 && tools.size < config.mcpMaxToolsPerServer; page += 1) {
      const listed = await client.listTools(cursor ? { cursor } : undefined, { signal });
      for (const tool of listed.tools.slice(0, config.mcpMaxToolsPerServer - tools.size)) {
        const normalized = toOpenAITool(server, tool as unknown as Record<string, unknown>);
        if (normalized) tools.set(normalized.tool.function.name, normalized.ref);
      }
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    const connection = { userId, client, transport, tools, lastUsedAt: Date.now() };
    this.connections.set(key, connection);
    transport.onerror = (error) => logger.warn({ serverId: server.id, userId, err: error }, "Third-party MCP transport error");
    return connection;
  }

  async toolsForUser(userId: number, signal?: AbortSignal): Promise<McpOpenAITool[]> {
    if (!config.mcpEnabled) return [];
    await this.closeIdle();
    const result: McpOpenAITool[] = [];
    const connectedIds = this.legacyRegistry ? undefined : new Set((await getSession(userId)).mcpConnections!.filter((connection) => connection.enabled).map((connection) => connection.serverId));
    for (const server of this.registry.servers.filter((candidate) => candidate.enabled && (this.legacyRegistry ? candidate.ownerIds.includes(userId) : connectedIds!.has(candidate.id)))) {
      try {
        const connectionInfo = await this.definition(userId, server.id);
        const connection = await this.connect(userId, server, connectionInfo.credential, signal);
        for (const [name, ref] of connection.tools) result.push({ type: "function", function: { name, description: `[${server.name}] ${ref.description}`, parameters: ref.inputSchema } });
      } catch (error) {
        logger.warn({ userId, serverId: server.id, err: error }, "Third-party MCP discovery failed");
      }
    }
    return result;
  }

  requiresApproval(name: string, userId: number): boolean {
    for (const connection of this.connections.values()) {
      const ref = connection.tools.get(name);
      if (ref && connection.userId === userId && name.startsWith("MCP_")) return ref.requireApproval;
    }
    return true;
  }

  async callTool(userId: number, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const existing = [...this.connections.values()].find((candidate) => candidate.userId === userId && candidate.tools.has(name));
    if (!existing) throw new Error("MCP tool is no longer available; refresh discovery and retry");
    const ref = existing.tools.get(name)!;
    const connectionInfo = await this.definition(userId, ref.serverId);
    const connection = await this.connect(userId, connectionInfo.server, connectionInfo.credential, signal);
    if (!ref) throw new Error("MCP tool is no longer available; refresh discovery and retry");
    validateMcpArguments(args, ref.inputSchema);
    const result = await connection.client.callTool({ name: ref.toolName, arguments: args }, undefined, { signal, timeout: config.mcpToolTimeoutMs });
    connection.lastUsedAt = Date.now();
    return normalizeMcpResult(result);
  }

  async closeIdle(maxIdleMs = 10 * 60_000): Promise<void> {
    const cutoff = Date.now() - maxIdleMs;
    for (const [key, connection] of this.connections) if (connection.lastUsedAt < cutoff) { await connection.transport.close().catch(() => undefined); this.connections.delete(key); }
  }

  async invalidate(userId: number, serverId: string): Promise<void> {
    const key = `${userId}:${serverId}`;
    const connection = this.connections.get(key);
    if (!connection) return;
    await connection.transport.close().catch(() => undefined);
    this.connections.delete(key);
  }

  async close(): Promise<void> { for (const [key, connection] of this.connections) { await connection.transport.close().catch(() => undefined); this.connections.delete(key); } }
}

export const mcpClient = new McpClientManager();
