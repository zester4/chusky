import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { decryptCredential, encryptCredential, type EncryptedCredential } from "../vault/crypto.js";
import { connectMcpServer, listMcpCatalog } from "./client.js";
import { getSession, saveSession, type McpOAuthStateRecord } from "../store.js";

const STATE_TTL_MS = 10 * 60_000;
type OAuthSecret = { codeVerifier?: string; clientInformation?: OAuthClientInformationMixed; discoveryState?: OAuthDiscoveryState };
type StateEnvelope = { userId: number; nonce: string };

function key(): string {
  if (!config.mcpConnectionEncryptionKey) throw new Error("MCP_CONNECTION_ENCRYPTION_KEY is required for MCP OAuth");
  return config.mcpConnectionEncryptionKey;
}

function callbackUrl(): string {
  const value = config.mcpOAuthCallbackUrl || (config.webhookUrl ? new URL("/mcp/oauth/callback", config.webhookUrl).toString() : "");
  if (!value) throw new Error("MCP_OAUTH_CALLBACK_URL or WEBHOOK_URL is required for MCP OAuth");
  return value;
}

function encodeState(userId: number): string {
  const encrypted = encryptCredential({ userId, nonce: randomUUID() }, key(), "MCP_CONNECTION_ENCRYPTION_KEY");
  return Buffer.from(JSON.stringify(encrypted), "utf8").toString("base64url");
}

function decodeState(state: string): StateEnvelope {
  if (!/^[A-Za-z0-9_-]{40,4096}$/.test(state)) throw new Error("Invalid MCP OAuth state");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(state, "base64url").toString("utf8")); } catch { throw new Error("Invalid MCP OAuth state"); }
  const envelope = decryptCredential<StateEnvelope>(value as EncryptedCredential, key(), "MCP_CONNECTION_ENCRYPTION_KEY");
  if (!Number.isSafeInteger(envelope.userId) || envelope.userId <= 0 || typeof envelope.nonce !== "string") throw new Error("Invalid MCP OAuth state");
  return envelope;
}

function publicClientMetadata(redirectUri: string): OAuthClientMetadata {
  return {
    client_name: "Chusky",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  } as OAuthClientMetadata;
}

async function updatePending(userId: number, state: string, update: (secret: OAuthSecret) => OAuthSecret): Promise<McpOAuthStateRecord> {
  const session = await getSession(userId);
  const pending = session.mcpOAuthStates!.find((item) => item.state === state);
  if (!pending || pending.expiresAt <= Date.now()) throw new Error("MCP OAuth authorization has expired; start again");
  const secret = decryptCredential<OAuthSecret>(pending.secret, key(), "MCP_CONNECTION_ENCRYPTION_KEY");
  pending.secret = encryptCredential(update(secret), key(), "MCP_CONNECTION_ENCRYPTION_KEY");
  await saveSession(userId, session);
  return pending;
}

function providerFor(userId: number, serverId: string, pending: McpOAuthStateRecord, initialSecret: OAuthSecret, authorizationCode?: string) {
  let authorizationUrl = "";
  let tokens: OAuthTokens | undefined;
  const redirectUri = pending.redirectUri;
  const server = listMcpCatalog().servers.find((item) => item.id === serverId);
  if (!server || server.auth !== "oauth") throw new Error("MCP OAuth server is not in the Chusky catalog");
  const provider: OAuthClientProvider = {
    redirectUrl: redirectUri,
    clientMetadata: publicClientMetadata(redirectUri),
    state: () => pending.state,
    clientInformation: () => initialSecret.clientInformation,
    saveClientInformation: async (clientInformation) => { await updatePending(userId, pending.state, (secret) => ({ ...secret, clientInformation })); },
    tokens: () => undefined,
    saveTokens: (next) => { tokens = next; },
    redirectToAuthorization: (url) => { authorizationUrl = url.toString(); },
    saveCodeVerifier: async (codeVerifier) => { await updatePending(userId, pending.state, (secret) => ({ ...secret, codeVerifier })); },
    codeVerifier: async () => {
      const session = await getSession(userId);
      const current = session.mcpOAuthStates!.find((item) => item.state === pending.state);
      if (!current) throw new Error("MCP OAuth authorization has expired; start again");
      const secret = decryptCredential<OAuthSecret>(current.secret, key(), "MCP_CONNECTION_ENCRYPTION_KEY");
      if (!secret.codeVerifier) throw new Error("MCP OAuth code verifier is missing; start again");
      return secret.codeVerifier;
    },
    saveDiscoveryState: async (discoveryState) => { await updatePending(userId, pending.state, (secret) => ({ ...secret, discoveryState })); },
    discoveryState: () => initialSecret.discoveryState,
  };
  return { provider, getAuthorizationUrl: () => authorizationUrl, getTokens: () => tokens, server, authorizationCode };
}

export async function beginMcpOAuth(userId: number, serverId: string): Promise<{ authorizationUrl: string; state: string; expiresAt: number }> {
  if (!config.mcpEnabled) throw new Error("Third-party MCP is disabled");
  const server = listMcpCatalog().servers.find((item) => item.id === serverId && item.enabled !== false);
  if (!server || server.auth !== "oauth") throw new Error("This MCP server does not support OAuth");
  const redirectUri = callbackUrl();
  const state = encodeState(userId);
  const now = Date.now();
  const session = await getSession(userId);
  const pending: McpOAuthStateRecord = { state, serverId, redirectUri, secret: encryptCredential({}, key(), "MCP_CONNECTION_ENCRYPTION_KEY"), createdAt: now, expiresAt: now + STATE_TTL_MS };
  session.mcpOAuthStates = [...(session.mcpOAuthStates ?? []).filter((item) => item.expiresAt > now && item.state !== state), pending].slice(-10);
  await saveSession(userId, session);
  const flow = providerFor(userId, serverId, pending, {});
  await auth(flow.provider, { serverUrl: server.url, scope: server.scopes?.join(" ") });
  if (!flow.getAuthorizationUrl()) throw new Error("MCP server did not return an OAuth authorization URL");
  return { authorizationUrl: flow.getAuthorizationUrl(), state, expiresAt: pending.expiresAt };
}

export async function finishMcpOAuth(state: string, code: string): Promise<{ serverId: string; connection: Awaited<ReturnType<typeof connectMcpServer>> }> {
  const { userId } = decodeState(state);
  const session = await getSession(userId);
  const pending = session.mcpOAuthStates!.find((item) => item.state === state);
  if (!pending || pending.expiresAt <= Date.now()) throw new Error("MCP OAuth authorization has expired; start again");
  const secret = decryptCredential<OAuthSecret>(pending.secret, key(), "MCP_CONNECTION_ENCRYPTION_KEY");
  const flow = providerFor(userId, pending.serverId, pending, secret, code);
  await auth(flow.provider, { serverUrl: flow.server.url, authorizationCode: code, scope: flow.server.scopes?.join(" ") });
  const tokens = flow.getTokens();
  if (!tokens?.access_token) throw new Error("MCP OAuth server did not return an access token");
  session.mcpOAuthStates = (session.mcpOAuthStates ?? []).filter((item) => item.state !== state);
  await saveSession(userId, session);
  const connection = await connectMcpServer(userId, pending.serverId, { accessToken: tokens.access_token, ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}), ...(tokens.token_type ? { tokenType: tokens.token_type } : {}), ...(tokens.expires_in ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}) });
  return { serverId: pending.serverId, connection };
}
