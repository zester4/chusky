import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CreateSpendRequestParams, Link, PaymentMethod, SpendRequest, Transaction } from "@stripe/link-sdk";
import { config } from "../config.js";
import { decryptCredential, encryptCredential, type EncryptedCredential } from "../vault/crypto.js";
import { e2bBrowserEngine } from "../lib/e2b/index.js";
import {
  clearLinkWallet,
  getLinkOAuthState,
  getLinkSpendRequest,
  getLinkWallet,
  listLinkSpendRequests,
  removeLinkOAuthState,
  saveLinkOAuthState,
  saveLinkSpendRequest,
  saveLinkWallet,
} from "../store.js";
import type { LinkOAuthStateRecord, LinkSpendRequestRecord, LinkSpendStatus, LinkWalletRecord, LinkWalletTokens } from "./types.js";

const OAUTH_SCOPES = ["payment_methods.agentic", "userinfo:read"] as const;
const OAUTH_SCOPE = OAUTH_SCOPES.join(" ");
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const ACCESS_TOKEN_SKEW_MS = 60_000;
const MAX_CONTEXT = 2_000;
const MAX_LINE_ITEMS = 50;
const MAX_TOTALS = 20;
const MAX_APPROVAL_WAIT_SECONDS = 30;
const APPROVAL_POLL_INTERVAL_MS = 1_000;
let linkSdkPromise: Promise<typeof import("@stripe/link-sdk")> | undefined;
// The application emits CommonJS while Link's official SDK is ESM-only.
// Keep this import native after TypeScript emits the file; a normal dynamic
// import would be rewritten to require() and fail in the production process.
const importLinkSdk = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<typeof import("@stripe/link-sdk")>;

function walletKey(): string {
  if (!config.linkEncryptionKey) throw new Error("LINK_AGENT_WALLET_ENCRYPTION_KEY is required for Link Agent Wallet");
  return config.linkEncryptionKey;
}

function assertEnabled(): void {
  if (!config.linkAgentWalletEnabled) throw new Error("Link Agent Wallet is disabled");
  if (!config.linkClientId || !config.linkClientSecret || !config.linkPublishableKey) throw new Error("Link Agent Wallet is not configured");
}

function callbackUrl(): string {
  const value = config.linkOAuthCallbackUrl || (config.webhookUrl ? new URL("/link/oauth/callback", config.webhookUrl).toString() : "");
  if (!value || !/^https:\/\//i.test(value)) throw new Error("LINK_OAUTH_CALLBACK_URL or WEBHOOK_URL must be a public HTTPS URL");
  return value;
}

function encodeState(userId: number): string {
  const envelope = encryptCredential({ userId, nonce: randomUUID() }, walletKey(), "LINK_AGENT_WALLET_ENCRYPTION_KEY");
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function decodeState(state: string): { userId: number } {
  if (!/^[A-Za-z0-9_-]{40,4096}$/.test(state)) throw new Error("Invalid Link OAuth state");
  try {
    const envelope = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as EncryptedCredential;
    const decoded = decryptCredential<{ userId: number; nonce: string }>(envelope, walletKey(), "LINK_AGENT_WALLET_ENCRYPTION_KEY");
    if (!Number.isSafeInteger(decoded.userId) || decoded.userId <= 0 || typeof decoded.nonce !== "string") throw new Error("Invalid Link OAuth state");
    return { userId: decoded.userId };
  } catch {
    throw new Error("Invalid Link OAuth state");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function randomVerifier(): string {
  return base64Url(randomBytes(32));
}

async function codeChallenge(verifier: string): Promise<string> {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeError(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : "";
  if (/timeout|abort/i.test(message)) return new Error(`${fallback} timed out; no payment credential was exposed.`);
  if (/401|403|unauthorized|invalid.*token/i.test(message)) return new Error(`${fallback} authorization needs to be refreshed.`);
  return new Error(`${fallback} is temporarily unavailable.`);
}

async function linkFetch(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.linkRequestTimeoutMs);
  try {
    const response = await fetch(`${config.linkAuthBaseUrl.replace(/\/$/, "")}${path}`, { ...init, signal: controller.signal, headers: { Accept: "application/json", Authorization: `Bearer ${config.linkPublishableKey}`, ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(init.headers ?? {}) } });
    const body = await response.json().catch(() => ({})) as unknown;
    if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) throw new Error(`Link OAuth returned ${response.status}`);
    return body as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function tokenRecord(value: Record<string, unknown>, prior?: LinkWalletTokens): LinkWalletTokens {
  const accessToken = typeof value.access_token === "string" ? value.access_token : prior?.accessToken;
  if (!accessToken) throw new Error("Link did not return an access token");
  const refreshToken = typeof value.refresh_token === "string" ? value.refresh_token : prior?.refreshToken;
  const expiresIn = Number(value.expires_in);
  return { accessToken, ...(refreshToken ? { refreshToken } : {}), tokenType: typeof value.token_type === "string" ? value.token_type : prior?.tokenType, expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : prior?.expiresAt ?? Date.now() + 3_600_000, scope: typeof value.scope === "string" ? value.scope : prior?.scope };
}

async function saveTokens(userId: number, tokens: LinkWalletTokens, existing: LinkWalletRecord | undefined, userInfo?: string, scopes?: string[]): Promise<LinkWalletRecord> {
  const now = Date.now();
  const record: LinkWalletRecord = { userId, status: "connected", scopes: scopes ?? existing?.scopes ?? [OAUTH_SCOPE], encryptedTokens: encryptCredential(tokens as unknown as Record<string, unknown>, walletKey(), "LINK_AGENT_WALLET_ENCRYPTION_KEY"), expiresAt: tokens.expiresAt, ...(userInfo ? { linkUserId: userInfo } : existing?.linkUserId ? { linkUserId: existing.linkUserId } : {}), createdAt: existing?.createdAt ?? now, updatedAt: now };
  await saveLinkWallet(userId, record);
  return record;
}

async function accessToken(userId: number, forceRefresh = false): Promise<string> {
  assertEnabled();
  const wallet = await getLinkWallet(userId);
  if (!wallet || wallet.status !== "connected") throw new Error("Link Agent Wallet is not connected. Ask Chusky to connect Link first.");
  let tokens = decryptCredential<LinkWalletTokens>(wallet.encryptedTokens, walletKey(), "LINK_AGENT_WALLET_ENCRYPTION_KEY");
  if (!forceRefresh && tokens.expiresAt > Date.now() + ACCESS_TOKEN_SKEW_MS) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error("Link authorization needs to be refreshed");
  try {
    const refreshed = await linkFetch("/auth/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: config.linkClientId }) });
    tokens = tokenRecord(refreshed, tokens);
    await saveTokens(userId, tokens, wallet);
    return tokens.accessToken;
  } catch (error) {
    await saveLinkWallet(userId, { ...wallet, status: "reauth_required", updatedAt: Date.now() });
    throw safeError(error, "Link authorization");
  }
}

async function client(userId: number): Promise<Link> {
  linkSdkPromise ??= importLinkSdk("@stripe/link-sdk");
  const { Link } = await linkSdkPromise;
  return new Link({ apiBaseUrl: config.linkApiBaseUrl, getAccessToken: (options?: { forceRefresh?: boolean }) => accessToken(userId, options?.forceRefresh === true) });
}

function safeSpendStatus(value: unknown): LinkSpendStatus {
  const status = String(value ?? "uncertain");
  return ["created", "pending_approval", "approved", "expired", "denied", "submitted", "succeeded", "failed", "canceled", "requires_action", "uncertain"].includes(status) ? status as LinkSpendStatus : "uncertain";
}

function safeSpendView(record: LinkSpendRequestRecord): Record<string, unknown> {
  return { id: record.id, providerId: record.providerId, status: record.status, merchantName: record.merchantName, merchantUrl: record.merchantUrl, amount: record.amount, currency: record.currency, approvalUrl: record.approvalUrl, credentialType: record.credentialType, cardBrand: record.cardBrand, cardLast4: record.cardLast4, linkTransactionId: record.linkTransactionId, createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt, ...(record.errorCode ? { errorCode: record.errorCode } : {}) };
}

export function safeProviderSpend(value: SpendRequest): Pick<LinkSpendRequestRecord, "status" | "providerId" | "approvalUrl" | "credentialType" | "cardBrand" | "cardLast4" | "linkTransactionId" | "expiresAt"> {
  return { status: safeSpendStatus(value.status), providerId: value.id, ...(value.approval_url ? { approvalUrl: value.approval_url } : {}), ...(value.credential_type ? { credentialType: value.credential_type } : {}), ...(value.card_brand ? { cardBrand: value.card_brand } : {}), ...(value.card_last4 ? { cardLast4: value.card_last4 } : {}), ...(value.link_transaction_id ? { linkTransactionId: value.link_transaction_id } : {}), ...(value.expires_at ? { expiresAt: value.expires_at } : {}) };
}

function safeStatusMessage(status: LinkSpendStatus): string {
  if (status === "pending_approval") return "Approve this exact amount in the Link app, then ask Chusky to check it again.";
  if (status === "requires_action") return "Link requires an additional owner action before this purchase can continue.";
  if (["approved", "submitted", "succeeded"].includes(status)) return "The Link request is approved or in progress; verify the merchant receipt before claiming success.";
  if (["denied", "expired", "canceled", "failed"].includes(status)) return `The Link request is ${status}; no payment retry was performed.`;
  return "The Link request is still being prepared; check its status before continuing.";
}

async function requestProviderApproval(userId: number, local: LinkSpendRequestRecord): Promise<LinkSpendRequestRecord> {
  if (!local.providerId) throw new Error("Link spend request is not available for approval");
  const status = safeSpendStatus(local.status);
  if (!["created", "pending_approval"].includes(status)) return local;
  if (status === "pending_approval" && local.approvalUrl) return local;
  try {
    const approval = await (await client(userId)).spendRequests.requestApproval(local.providerId);
    const next: LinkSpendRequestRecord = { ...local, status: "pending_approval", ...(approval.approval_url ? { approvalUrl: approval.approval_url } : {}), updatedAt: Date.now() };
    await saveLinkSpendRequest(userId, next);
    return next;
  } catch (error) {
    const next: LinkSpendRequestRecord = { ...local, errorCode: "approval_request_failed", updatedAt: Date.now() };
    await saveLinkSpendRequest(userId, next);
    throw safeError(error, "Link approval request");
  }
}

function boundedHttps(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 2_000) throw new Error(`${field} must be an HTTPS URL`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${field} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${field} must be an HTTPS URL without credentials`);
  return url.toString();
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) throw new Error(`${field} must be ${min}-${max} characters`);
  return value.trim();
}

export function validateSpendArgs(args: Record<string, unknown>): { merchantName: string; merchantUrl: string; amount: number; currency: string; context: string; idempotencyKey?: string; lineItems?: CreateSpendRequestParams["line_items"]; totals?: CreateSpendRequestParams["totals"] } {
  const amount = Number(args.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > config.linkMaxSpendCents) throw new Error(`amount must be an integer number of cents between 1 and ${config.linkMaxSpendCents}`);
  const currency = boundedText(args.currency ?? "USD", "currency", 3, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter code");
  const merchantName = boundedText(args.merchantName, "merchantName", 1, 160);
  const merchantUrl = boundedHttps(args.merchantUrl, "merchantUrl");
  const context = boundedText(args.context, "context", 100, MAX_CONTEXT);
  const idempotencyKey = args.idempotencyKey === undefined ? undefined : boundedText(args.idempotencyKey, "idempotencyKey", 8, 160);
  const lineItems = args.lineItems === undefined ? undefined : Array.isArray(args.lineItems) && args.lineItems.length <= MAX_LINE_ITEMS ? args.lineItems as CreateSpendRequestParams["line_items"] : (() => { throw new Error("lineItems must contain at most 50 items"); })();
  const totals = args.totals === undefined ? undefined : Array.isArray(args.totals) && args.totals.length <= MAX_TOTALS ? args.totals as CreateSpendRequestParams["totals"] : (() => { throw new Error("totals must contain at most 20 items"); })();
  return { merchantName, merchantUrl, amount, currency, context, ...(idempotencyKey ? { idempotencyKey } : {}), ...(lineItems ? { lineItems } : {}), ...(totals ? { totals } : {}) };
}

export async function beginLinkOAuth(userId: number): Promise<{ authorizationUrl: string; expiresAt: number }> {
  assertEnabled();
  const redirectUri = callbackUrl();
  const state = encodeState(userId);
  const verifier = randomVerifier();
  const record: LinkOAuthStateRecord = { state, redirectUri, encryptedSecret: encryptCredential({ verifier }, walletKey(), "LINK_AGENT_WALLET_ENCRYPTION_KEY"), createdAt: Date.now(), expiresAt: Date.now() + OAUTH_STATE_TTL_MS };
  await saveLinkOAuthState(userId, record);
  const challenge = await codeChallenge(verifier);
  const url = new URL("/auth", config.linkAuthBaseUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.linkClientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("key", config.linkPublishableKey);
  return { authorizationUrl: url.toString(), expiresAt: record.expiresAt };
}

export async function finishLinkOAuth(state: string, code: string): Promise<{ userId: number }> {
  assertEnabled();
  const { userId } = decodeState(state);
  const pending = await getLinkOAuthState(userId, state);
  if (!pending || pending.expiresAt <= Date.now()) throw new Error("Link authorization has expired; start again");
  const secret = decryptCredential<{ verifier: string }>(pending.encryptedSecret, walletKey(), "LINK_AGENT_WALLET_ENCRYPTION_KEY");
  if (typeof code !== "string" || code.length < 8 || code.length > 4_000) throw new Error("Invalid Link authorization code");
  try {
    const tokenResponse = await linkFetch("/auth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: config.linkClientId, client_secret: config.linkClientSecret, redirect_uri: pending.redirectUri, code_verifier: secret.verifier }) });
    const tokens = tokenRecord(tokenResponse);
    const grantedScopes = typeof tokenResponse.scope === "string" ? tokenResponse.scope.split(/[ ,]+/).filter(Boolean).slice(0, 20) : [];
    if (!grantedScopes.includes("payment_methods.agentic")) throw new Error("Link did not grant the required payment_methods.agentic scope");
    await saveTokens(userId, tokens, await getLinkWallet(userId), typeof tokenResponse.user_id === "string" ? tokenResponse.user_id : undefined, grantedScopes.length ? grantedScopes : [OAUTH_SCOPE]);
    await removeLinkOAuthState(userId, state);
    return { userId };
  } catch (error) {
    throw safeError(error, "Link authorization");
  }
}

export async function linkWalletStatus(userId: number): Promise<Record<string, unknown>> {
  assertEnabled();
  const wallet = await getLinkWallet(userId);
  if (!wallet) return { connected: false, status: "disconnected" };
  if (wallet.status === "reauth_required") return { connected: false, status: wallet.status, scopes: wallet.scopes };
  try {
    const info = await (await client(userId)).userInfo.retrieve();
    return { connected: true, status: wallet.status, scopes: wallet.scopes, ...(info.id ? { linkUserId: info.id } : {}), spendLimits: info.agent_wallet_spend_limits };
  } catch (error) { throw safeError(error, "Link wallet status"); }
}

export async function linkPaymentMethods(userId: number): Promise<unknown[]> {
  try {
    const methods = await (await client(userId)).paymentMethods.list();
    return methods.slice(0, 50).map((method: PaymentMethod) => ({ id: method.id, type: method.type, name: method.name, nickname: method.nickname, isDefault: method.is_default, card: method.card_details ? { brand: method.card_details.brand, last4: method.card_details.last4, expMonth: method.card_details.exp_month, expYear: method.card_details.exp_year } : undefined, bank: method.bank_account_details ? { last4: method.bank_account_details.last4, bankName: method.bank_account_details.bank_name } : undefined }));
  } catch (error) { throw safeError(error, "Link payment methods"); }
}

export async function createLinkSpendRequest(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = validateSpendArgs(args);
  const localId = `lsp_${randomUUID()}`;
  const now = Date.now();
  const local: LinkSpendRequestRecord = { id: localId, userId, status: "uncertain", merchantName: input.merchantName, merchantUrl: input.merchantUrl, amount: input.amount, currency: input.currency, context: input.context, createdAt: now, updatedAt: now };
  await saveLinkSpendRequest(userId, local);
  const params: CreateSpendRequestParams = { idempotency_key: input.idempotencyKey ?? `chusky_${sha256(localId).slice(0, 40)}`, amount: input.amount, currency: input.currency, merchant_name: input.merchantName, merchant_url: input.merchantUrl, context: input.context, test: config.linkTestMode, ...(input.lineItems ? { line_items: input.lineItems } : {}), ...(input.totals ? { totals: input.totals } : {}) };
  try {
    const response = await (await client(userId)).spendRequests.create(params);
    let next: LinkSpendRequestRecord = { ...local, ...safeProviderSpend(response), updatedAt: Date.now() };
    await saveLinkSpendRequest(userId, next);
    if (next.status === "created" || (next.status === "pending_approval" && !next.approvalUrl)) next = await requestProviderApproval(userId, next);
    return { ...safeSpendView(next), next: safeStatusMessage(next.status) };
  } catch (error) {
    if (error instanceof Error && /approval request|authorization needs|temporarily unavailable|timed out/i.test(error.message)) throw error;
    await saveLinkSpendRequest(userId, { ...local, status: "uncertain", errorCode: "provider_unavailable", updatedAt: Date.now() });
    throw safeError(error, "Link spend request");
  }
}

export async function requestLinkSpendApproval(userId: number, id: string): Promise<Record<string, unknown>> {
  const local = await getLinkSpendRequest(userId, id);
  if (!local) throw new Error("Link spend request not found");
  const next = await requestProviderApproval(userId, local);
  return { ...safeSpendView(next), next: safeStatusMessage(next.status) };
}

export async function waitForLinkSpendApproval(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = boundedText(args.spendRequestId, "spendRequestId", 20, 140);
  const waitSeconds = args.waitSeconds === undefined ? 0 : Number(args.waitSeconds);
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_APPROVAL_WAIT_SECONDS) throw new Error(`waitSeconds must be an integer between 0 and ${MAX_APPROVAL_WAIT_SECONDS}`);
  let local = await getLinkSpendRequest(userId, id);
  if (!local) throw new Error("Link spend request not found");
  if (local.status === "created") local = await requestProviderApproval(userId, local);
  const deadline = Date.now() + waitSeconds * 1_000;
  while (true) {
    const current = await linkSpendStatus(userId, id);
    const status = safeSpendStatus(current.status);
    if (status !== "pending_approval" || Date.now() >= deadline) return { ...current, waiting: status === "pending_approval", next: safeStatusMessage(status) };
    await new Promise((resolve) => setTimeout(resolve, Math.min(APPROVAL_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))));
  }
}

export async function linkSpendStatus(userId: number, id: string): Promise<Record<string, unknown>> {
  const local = await getLinkSpendRequest(userId, id);
  if (!local) throw new Error("Link spend request not found");
  if (!local.providerId) return safeSpendView(local);
  try {
    const response = await (await client(userId)).spendRequests.retrieve(local.providerId);
    if (!response) return safeSpendView(local);
    const next = { ...local, ...safeProviderSpend(response), updatedAt: Date.now() };
    await saveLinkSpendRequest(userId, next);
    return safeSpendView(next);
  } catch (error) { throw safeError(error, "Link spend request status"); }
}

export async function cancelLinkSpendRequest(userId: number, id: string): Promise<Record<string, unknown>> {
  const local = await getLinkSpendRequest(userId, id);
  if (!local?.providerId) throw new Error("Link spend request is not available to cancel");
  try {
    const response = await (await client(userId)).spendRequests.cancel(local.providerId);
    const next = { ...local, ...safeProviderSpend(response), status: "canceled" as const, updatedAt: Date.now() };
    await saveLinkSpendRequest(userId, next);
    return safeSpendView(next);
  } catch (error) { throw safeError(error, "Link spend request cancellation"); }
}

export async function listLinkSpendRequestViews(userId: number, limit?: number): Promise<unknown[]> {
  return (await listLinkSpendRequests(userId, limit)).map(safeSpendView);
}

function safeTransaction(value: Transaction): Record<string, unknown> {
  return {
    id: value.id,
    sourceId: value.source_id,
    amount: value.amount,
    currency: value.currency,
    createdDate: value.created_date,
    description: typeof value.description === "string" ? value.description.slice(0, 500) : undefined,
    origin: value.origin,
    category: value.category,
    status: typeof value.status === "string" ? value.status.slice(0, 80) : undefined,
  };
}

export async function linkSpendReceipt(userId: number, id: string): Promise<Record<string, unknown>> {
  const local = await getLinkSpendRequest(userId, id);
  if (!local) throw new Error("Link spend request not found");
  if (!local.providerId) return { ...safeSpendView(local), receipt: null, receiptPending: true, next: "The spend request has no provider receipt yet." };
  try {
    const link = await client(userId);
    const response = await link.spendRequests.retrieve(local.providerId);
    if (!response) return { ...safeSpendView(local), receipt: null, receiptPending: true, next: "Link has not returned a receipt for this request yet." };
    const next = { ...local, ...safeProviderSpend(response), updatedAt: Date.now() };
    await saveLinkSpendRequest(userId, next);
    const paymentStatus = response.payment_status_details && typeof response.payment_status_details === "object" ? {
      outcome: response.payment_status_details.outcome,
      ...(response.payment_status_details.code ? { code: String(response.payment_status_details.code).slice(0, 80) } : {}),
      ...(response.payment_status_details.decline_code ? { declineCode: String(response.payment_status_details.decline_code).slice(0, 80) } : {}),
    } : undefined;
    let transaction: Record<string, unknown> | undefined;
    let transactionLookupFailed = false;
    if (next.linkTransactionId) {
      try {
        const page = await link.transactions.list({ limit: 50 });
        const match = page.data.find((item: Transaction) => item.id === next.linkTransactionId);
        if (match) transaction = safeTransaction(match);
      } catch {
        transactionLookupFailed = true;
      }
    }
    const receipt = transaction ?? (paymentStatus || next.linkTransactionId ? { ...(next.linkTransactionId ? { transactionId: next.linkTransactionId } : {}), ...(paymentStatus ? { paymentStatus } : {}) } : undefined);
    return { ...safeSpendView(next), ...(receipt ? { receipt } : { receipt: null }), ...(transactionLookupFailed || !receipt ? { receiptPending: true } : {}), next: receipt && !transactionLookupFailed ? "This is the safe Link receipt metadata; confirm the merchant's own order confirmation separately." : "Link has not returned a complete receipt yet; check again before claiming merchant fulfillment." };
  } catch (error) { throw safeError(error, "Link receipt lookup"); }
}

export async function disconnectLinkWallet(userId: number): Promise<{ disconnected: true }> {
  assertEnabled();
  const wallet = await getLinkWallet(userId);
  if (wallet) {
    try {
      const tokens = decryptCredential<LinkWalletTokens>(wallet.encryptedTokens, walletKey(), "LINK_AGENT_WALLET_ENCRYPTION_KEY");
      if (tokens.refreshToken) await linkFetch("/auth/revoke", { method: "POST", body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: "refresh_token", client_id: config.linkClientId, client_secret: config.linkClientSecret }) });
    } catch (error) { throw safeError(error, "Link wallet disconnection"); }
  }
  await clearLinkWallet(userId);
  return { disconnected: true };
}

export async function completeApprovedLinkCheckout(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!config.e2bEnabled || !config.e2bApiKey) throw new Error("Link checkout requires the E2B secure browser backend");
  const spendId = boundedText(args.spendRequestId, "spendRequestId", 20, 140);
  const local = await getLinkSpendRequest(userId, spendId);
  if (!local?.providerId) throw new Error("Link spend request is not ready for checkout");
  const provider = await (await client(userId)).spendRequests.retrieve(local.providerId, { include: ["card"] });
  if (!provider || safeSpendStatus(provider.status) !== "approved" || !provider.card) throw new Error("Approve this exact spend request in Link before checkout");
  const browser = await e2bBrowserEngine.browser(userId, { action: "status" });
  const currentUrl = browser && typeof browser === "object" && typeof (browser as { lastUrl?: unknown }).lastUrl === "string" ? (browser as { lastUrl: string }).lastUrl : "";
  if (!currentUrl || new URL(currentUrl).origin !== new URL(local.merchantUrl).origin) throw new Error("The secure browser is not on the approved merchant origin");
  const nodeMap = [
    ["cardNumberNodeId", provider.card.number],
    ["expiryNodeId", `${String(provider.card.exp_month).padStart(2, "0")}/${String(provider.card.exp_year).slice(-2)}`],
    ["cvcNodeId", provider.card.cvc ?? ""],
  ] as const;
  for (const [key, value] of nodeMap) {
    const nodeId = boundedText(args[key], key, 8, 160);
    if (!value) throw new Error(`Link did not provide ${key.replace("NodeId", "")}`);
    await e2bBrowserEngine.secureFill(userId, { nodeId, value, sessionId: args.sessionId });
  }
  if (args.cardholderNodeId) await e2bBrowserEngine.secureFill(userId, { nodeId: boundedText(args.cardholderNodeId, "cardholderNodeId", 8, 160), value: provider.card.billing_address?.name ?? "", sessionId: args.sessionId });
  if (args.submitNodeId) {
    try {
      await e2bBrowserEngine.browser(userId, { action: "click", nodeId: boundedText(args.submitNodeId, "submitNodeId", 8, 160), sessionId: args.sessionId }, { ownerPrivateRun: true, ownerApprovedAction: true });
    } catch {
      // A browser transport failure can happen after the merchant accepted the
      // click. Do not let the model replay a potentially non-idempotent payment.
      await saveLinkSpendRequest(userId, { ...local, status: "uncertain", errorCode: "checkout_submission_uncertain", updatedAt: Date.now() });
      throw new Error("Checkout submission outcome is uncertain; inspect the merchant and Link status before retrying.");
    }
  }
  const next = { ...local, status: args.submitNodeId ? "submitted" as const : "approved" as const, updatedAt: Date.now() };
  await saveLinkSpendRequest(userId, next);
  return { ...safeSpendView(next), submitted: Boolean(args.submitNodeId), next: args.submitNodeId ? "The checkout was submitted. Check the Link spend request and merchant confirmation before claiming success." : "The approved card was filled securely. Inspect the checkout and submit it with the approved purchase control." };
}

export async function executeLinkPayment(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const executionMethod = args.executionMethod === undefined ? "browser" : boundedText(args.executionMethod, "executionMethod", 1, 40);
  if (executionMethod !== "browser") throw new Error("This execution path supports the approved virtual-card browser checkout only; no Link token was exposed or sent to an undocumented merchant endpoint.");
  return completeApprovedLinkCheckout(userId, args);
}
