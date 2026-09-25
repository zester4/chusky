import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
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
// `getSession` deliberately bounds persisted MCP connections to 50 records.
const MAX_MCP_CONNECTIONS = 50;

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
  custom?: boolean;
}

export interface CustomMcpServerInput {
  name: string;
  url: string;
  auth: "none" | "bearer";
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
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal" || host === "metadata.google.com") return true;
  if (/^(0\.|127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || /^198\.(18|19)\./.test(host) || /^(192\.0\.0\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(host)) return true;
  if (isIP(host) === 6) return host === "::" || host === "::1" || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host) || /^ff/i.test(host) || /^2001:db8/i.test(host) || /^::ffff:(0:)?(10\.|127\.|169\.254\.|192\.168\.)/i.test(host);
  return false;
}

function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateHost(normalized)) return false;
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    return octets.length === 4 && octets.every((part) => part >= 0 && part <= 255) && octets[0]! > 0 && octets[0]! < 224;
  }
  if (isIP(normalized) === 6) return /^[23]/i.test(normalized);
  return false;
}

function createSafeDispatcher(url: URL): Agent {
  const localDevelopmentHost = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname.replace(/[\[\]]/g, ""));
  return new Agent({ connect: { lookup: (hostname, options, callback) => {
    void (async () => {
      try {
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
        if (!addresses.length || (!localDevelopmentHost && addresses.some((entry) => !isPublicAddress(entry.address)))) throw new Error("MCP host resolves to a non-public network address");
        const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
        const selected = family ? addresses.filter((entry) => entry.family === family) : addresses;
        if (!selected.length) throw new Error("MCP host has no address for the requested IP family");
        callback(null, options.all ? selected : selected[0]!.address, options.all ? undefined : selected[0]!.family);
      } catch (error) { callback(error as Error, "", 0); }
    })();
  } } });
}

export function validateMcpUrl(raw: string, production = process.env.NODE_ENV === "production"): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("MCP server URL must be a valid URL"); }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && !production && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))) {
    throw new Error("MCP server URL must use HTTPS (HTTP localhost is allowed only in development)");
  }
  const localDevelopmentUrl = !production && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  const literalAddress = parsed.hostname.replace(/[\[\]]/g, "");
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (isPrivateHost(parsed.hostname) && !localDevelopmentUrl) || (isIP(literalAddress) !== 0 && !localDevelopmentUrl && !isPublicAddress(literalAddress))) {
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
  const suffix = `_${hash(`${serverId}:${toolName}`)}`;
  const prefix = `MCP_${server}_`;
  return `${prefix}${tool.slice(0, Math.max(1, 64 - prefix.length - suffix.length))}${suffix}`;
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

function safeConnection(record: McpConnectionRecord, catalog: McpCatalogEntry | undefined, verifiedToolCount?: number) {
  const count = verifiedToolCount ?? record.verifiedToolCount;
  return { serverId: record.serverId, name: catalog?.name ?? record.customServer?.name ?? record.serverId, auth: catalog?.auth ?? record.customServer?.auth ?? "none", enabled: record.enabled, connectedAt: new Date(record.createdAt).toISOString(), updatedAt: new Date(record.updatedAt).toISOString(), ...(count === undefined ? {} : { verifiedToolCount: count }) };
}

function customCatalogEntry(record: McpConnectionRecord): McpCatalogEntry | undefined {
  const custom = record.customServer;
  if (!custom) return undefined;
  return { id: record.serverId, name: custom.name, url: custom.url, auth: custom.auth, ...(custom.allowedTools?.length ? { allowedTools: custom.allowedTools } : {}), requireApproval: custom.requireApproval, custom: true };
}

export async function listMcpCatalogForUser(userId: number): Promise<{ servers: McpCatalogEntry[]; errors: string[] }> {
  const builtIn = listMcpCatalog();
  const session = await getSession(userId);
  const custom = session.mcpConnections!.filter((connection) => connection.enabled).flatMap((connection) => {
    const entry = customCatalogEntry(connection);
    return entry ? [entry] : [];
  });
  return { servers: [...builtIn.servers, ...custom], errors: builtIn.errors };
}

export async function listMcpConnections(userId: number): Promise<ReturnType<typeof safeConnection>[]> {
  const catalog = new Map(listMcpCatalog().servers.map((server) => [server.id, server]));
  return (await getSession(userId)).mcpConnections!.filter((connection) => connection.enabled && (catalog.has(connection.serverId) || Boolean(connection.customServer))).map((connection) => safeConnection(connection, catalog.get(connection.serverId) ?? customCatalogEntry(connection)));
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
  if (!existing && session.mcpConnections!.length >= MAX_MCP_CONNECTIONS) throw new Error(`This account has reached the limit of ${MAX_MCP_CONNECTIONS} connected MCP servers. Disconnect one before adding another.`);
  let verifiedToolCount: number;
  try {
    const definition: McpServerDefinition = { ...server, ownerIds: [userId], auth: server.auth === "bearer" ? { type: "bearer" } : server.auth === "oauth" ? { type: "oauth" } : { type: "none" } };
    verifiedToolCount = await mcpClient.verifyServer(userId, definition, normalizedCredential);
  } catch (error) { throw new Error(`MCP server verification failed: ${safeMcpFailure(error)}`); }
  const record: McpConnectionRecord = { serverId, enabled: true, verifiedToolCount, createdAt: existing?.createdAt ?? now, updatedAt: now, ...(normalizedCredential ? { credential: encryptCredential(normalizedCredential as unknown as Record<string, unknown>, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY") } : {}) };
  session.mcpConnections = [...session.mcpConnections!.filter((connection) => connection.serverId !== serverId), record].slice(-MAX_MCP_CONNECTIONS);
  await saveSession(userId, session);
  await mcpClient.invalidate(userId, serverId);
  return safeConnection(record, server, verifiedToolCount);
}

export async function addCustomMcpServer(userId: number, input: CustomMcpServerInput, credential?: McpCredential): Promise<ReturnType<typeof safeConnection>> {
  if (!config.mcpEnabled) throw new Error("Third-party MCP is disabled");
  const name = safeString(input.name, 120);
  if (!name) throw new Error("MCP server name is required");
  if (input.auth !== "none" && input.auth !== "bearer") throw new Error("Custom MCP supports no-auth or bearer-token authentication");
  if (typeof input.url !== "string" || input.url.length > 4096 || /[\u0000-\u001F\u007F]/.test(input.url)) throw new Error("MCP server URL is invalid");
  if (input.allowedTools !== undefined && !Array.isArray(input.allowedTools)) throw new Error("Allowed MCP tool names must be a list");
  const url = validateMcpUrl(input.url.trim());
  const allowedTools = input.allowedTools === undefined ? undefined : [...new Set(input.allowedTools.map((tool) => safeString(tool, 128)).filter((tool) => TOOL_NAME.test(tool)))].slice(0, config.mcpMaxToolsPerServer);
  if (input.allowedTools !== undefined && (allowedTools!.length !== input.allowedTools.length || input.allowedTools.length > config.mcpMaxToolsPerServer)) throw new Error("Allowed MCP tool names must be valid, unique, and within the configured limit");
  const normalizedCredential = normalizeMcpCredential(credential);
  if (input.auth === "none" && normalizedCredential) throw new Error("Do not provide a bearer token for a no-auth MCP server");
  if (input.auth === "bearer" && !normalizedCredential) throw new Error("This MCP server requires a valid bearer token");
  if (normalizedCredential && !config.mcpConnectionEncryptionKey) throw new Error("MCP_CONNECTION_ENCRYPTION_KEY is not configured");

  const session = await getSession(userId);
  const currentCustom = session.mcpConnections!.filter((connection) => connection.customServer);
  const id = `custom-${createHash("sha256").update(`${userId}:${url}`).digest("hex").slice(0, 24)}`;
  if (currentCustom.filter((connection) => connection.serverId !== id).length >= config.mcpMaxServers) throw new Error(`This account has reached the limit of ${config.mcpMaxServers} custom MCP servers`);
  if (!session.mcpConnections!.some((connection) => connection.serverId === id) && session.mcpConnections!.length >= MAX_MCP_CONNECTIONS) throw new Error(`This account has reached the limit of ${MAX_MCP_CONNECTIONS} connected MCP servers. Disconnect one before adding another.`);
  const customServer = { name, url, auth: input.auth, ...(allowedTools?.length ? { allowedTools } : {}), requireApproval: input.requireApproval !== false } as const;
  const server: McpServerDefinition = { id, name, url, ownerIds: [userId], auth: input.auth === "bearer" ? { type: "bearer" } : { type: "none" }, ...(allowedTools?.length ? { allowedTools } : {}), requireApproval: input.requireApproval !== false };
  let verified: number;
  try { verified = await mcpClient.verifyServer(userId, server, normalizedCredential); }
  catch (error) { throw new Error(`MCP server verification failed: ${safeMcpFailure(error)}`); }
  const now = Date.now();
  const existing = session.mcpConnections!.find((connection) => connection.serverId === id);
  const record: McpConnectionRecord = { serverId: id, customServer, verifiedToolCount: verified, enabled: true, createdAt: existing?.createdAt ?? now, updatedAt: now, ...(normalizedCredential ? { credential: encryptCredential(normalizedCredential as unknown as Record<string, unknown>, config.mcpConnectionEncryptionKey, "MCP_CONNECTION_ENCRYPTION_KEY") } : {}) };
  session.mcpConnections = [...session.mcpConnections!.filter((connection) => connection.serverId !== id), record].slice(-MAX_MCP_CONNECTIONS);
  await saveSession(userId, session);
  return safeConnection(record, customCatalogEntry(record), verified);
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

type McpTransport = StreamableHTTPClientTransport | SSEClientTransport;
type Connection = { userId: number; client: Client; transport: McpTransport; dispatcher: Agent; tools: Map<string, McpToolRef>; lastUsedAt: number };

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
    const connection = (await getSession(userId)).mcpConnections!.find((item) => item.serverId === serverId && item.enabled);
    if (connection?.customServer) {
      const custom = connection.customServer;
      const server = { id: connection.serverId, name: custom.name, url: custom.url, ownerIds: [userId], auth: custom.auth === "bearer" ? { type: "bearer" as const } : { type: "none" as const }, ...(custom.allowedTools ? { allowedTools: custom.allowedTools } : {}), requireApproval: custom.requireApproval };
      return { server, credential: encryptedCredential(connection) };
    }
    if (!this.legacyRegistry && !connection) throw new Error("MCP server is not connected for this account");
    const server = !this.legacyRegistry && connection
      ? this.registry.servers.find((candidate) => candidate.id === serverId && candidate.enabled)
      : this.registry.servers.find((candidate) => candidate.id === serverId && candidate.enabled && isMcpServerAllowedForUser(candidate, userId, true));
    if (!server) throw new Error("MCP server is no longer available for this account");
    return { server, credential: connection ? encryptedCredential(connection) : undefined };
  }

  async verifyServer(userId: number, server: McpServerDefinition, credential?: McpCredential): Promise<number> {
    const key = `${userId}:${server.id}`;
    await this.invalidate(userId, server.id);
    try {
      const connection = await this.openConnection(userId, server, key, credential);
      const count = connection.tools.size;
      await connection.transport.close().catch(() => undefined);
      await connection.dispatcher.close().catch(() => undefined);
      this.connections.delete(key);
      if (count === 0) throw new Error("MCP server initialized but did not expose any tools");
      return count;
    } catch (error) {
      await this.invalidate(userId, server.id);
      throw error;
    }
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
    const serverUrl = new URL(server.url);
    const dispatcher = createSafeDispatcher(serverUrl);
    const safeFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: Agent });
    let transport: McpTransport = new StreamableHTTPClientTransport(serverUrl, {
      requestInit: { headers, redirect: "error" },
      fetch: safeFetch,
      reconnectionOptions: { initialReconnectionDelay: 250, maxReconnectionDelay: 5_000, reconnectionDelayGrowFactor: 2, maxRetries: 2 },
    });
    let client = new Client({ name: "chusky", version: "3.0.0" }, { capabilities: {} });
    try {
      try { await client.connect(transport, { signal }); }
      catch (error) {
        await transport.close().catch(() => undefined);
        if (!(error instanceof StreamableHTTPError) || (error.code !== 404 && error.code !== 405)) throw error;
        transport = new SSEClientTransport(serverUrl, { requestInit: { headers, redirect: "error" }, fetch: safeFetch });
        client = new Client({ name: "chusky", version: "3.0.0" }, { capabilities: {} });
        await client.connect(transport, { signal });
      }
      if (signal?.aborted) throw new Error("MCP connection cancelled");
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
      const connection = { userId, client, transport, dispatcher, tools, lastUsedAt: Date.now() };
      this.connections.set(key, connection);
      transport.onerror = (error) => logger.warn({ serverId: server.id, userId, errorClass: error.name }, "Third-party MCP transport error");
      return connection;
    } catch (error) {
      await transport.close().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
      throw error;
    }
  }

  async toolsForUser(userId: number, signal?: AbortSignal): Promise<McpOpenAITool[]> {
    return (await this.discoverToolsForUser(userId, signal)).tools;
  }

  async discoverToolsForUser(userId: number, signal?: AbortSignal): Promise<{ tools: McpOpenAITool[]; failures: Array<{ serverId: string; message: string }> }> {
    if (!config.mcpEnabled) return { tools: [], failures: [] };
    await this.closeIdle();
    const result: McpOpenAITool[] = [];
    const failures: Array<{ serverId: string; message: string }> = [];
    const session = await getSession(userId);
    const connectedIds = new Set(session.mcpConnections!.filter((connection) => connection.enabled && !connection.customServer).map((connection) => connection.serverId));
    const customServers = session?.mcpConnections!.flatMap((connection) => {
      const item = connection.customServer;
      return connection.enabled && item ? [{ id: connection.serverId, name: item.name, url: item.url, ownerIds: [userId], auth: item.auth === "bearer" ? { type: "bearer" as const } : { type: "none" as const }, ...(item.allowedTools ? { allowedTools: item.allowedTools } : {}), requireApproval: item.requireApproval }] : [];
    }) ?? [];
    const servers = [...this.registry.servers.filter((candidate) => candidate.enabled && (this.legacyRegistry ? candidate.ownerIds.includes(userId) : connectedIds.has(candidate.id))), ...customServers];
    for (const server of servers) {
      try {
        const connectionInfo = await this.definition(userId, server.id);
        const connection = await this.connect(userId, server, connectionInfo.credential, signal);
        for (const [name, ref] of connection.tools) result.push({ type: "function", function: { name, description: `[${server.name}] ${ref.description}`, parameters: ref.inputSchema } });
      } catch (error) {
        const message = safeMcpFailure(error);
        failures.push({ serverId: server.id, message });
        logger.warn({ userId, serverId: server.id, errorClass: error instanceof Error ? error.name : "UnknownError", message }, "Third-party MCP discovery failed");
      }
    }
    return { tools: result, failures };
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
    const currentRef = connection.tools.get(name);
    if (!currentRef) throw new Error("MCP tool is no longer available after reconnect; refresh discovery and retry");
    validateMcpArguments(args, currentRef.inputSchema);
    const result = await connection.client.callTool({ name: currentRef.toolName, arguments: args }, undefined, { signal, timeout: config.mcpToolTimeoutMs });
    connection.lastUsedAt = Date.now();
    return normalizeMcpResult(result);
  }

  async closeIdle(maxIdleMs = 10 * 60_000): Promise<void> {
    const cutoff = Date.now() - maxIdleMs;
    for (const [key, connection] of this.connections) if (connection.lastUsedAt < cutoff) { await connection.transport.close().catch(() => undefined); await connection.dispatcher.close().catch(() => undefined); this.connections.delete(key); }
  }

  async invalidate(userId: number, serverId: string): Promise<void> {
    const key = `${userId}:${serverId}`;
    const connection = this.connections.get(key);
    if (!connection) return;
    await connection.transport.close().catch(() => undefined);
    await connection.dispatcher.close().catch(() => undefined);
    this.connections.delete(key);
  }

  async close(): Promise<void> { for (const [key, connection] of this.connections) { await connection.transport.close().catch(() => undefined); await connection.dispatcher.close().catch(() => undefined); this.connections.delete(key); } }
}

export const mcpClient = new McpClientManager();

function safeMcpFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown MCP connection failure";
  if (/401|403|unauthorized|forbidden|auth/i.test(raw)) return "Authentication failed. Check the server token and its required permissions.";
  if (/404|not found/i.test(raw)) return "The MCP endpoint was not found. Check that the server URL is its MCP endpoint.";
  if (/timeout|timed out|abort/i.test(raw)) return "The MCP server timed out before tool discovery completed.";
  if (/tool/i.test(raw) && /list|discover/i.test(raw)) return "The MCP server initialized, but tool discovery failed.";
  return "Could not connect to this MCP server or discover its tools. Check the endpoint and server availability.";
}

export async function discoverToolsForUser(userId: number, signal?: AbortSignal): Promise<{ tools: McpOpenAITool[]; failures: Array<{ serverId: string; message: string }> }> {
  return mcpClient.discoverToolsForUser(userId, signal);
}
