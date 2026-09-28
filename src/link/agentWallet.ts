import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CreateSpendRequestParams, Link, PaymentMethod, SpendRequest, Transaction, UcpCheckout, UcpProduct } from "@stripe/link-sdk";
import { config } from "../config.js";
import { decryptCredential, encryptCredential, type EncryptedCredential } from "../vault/crypto.js";
import { e2bBrowserEngine } from "../lib/e2b/index.js";
import { assertSafeBrowserUrl } from "../lib/e2b/urlSafety.js";
import { verifyBrowserResult, type BrowserDetector } from "../vault/browserOps.js";
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
import type { LinkOAuthStateRecord, LinkSpendRequestRecord, LinkSpendStatus, LinkSpendStatusDetails, LinkWalletRecord, LinkWalletTokens } from "./types.js";

const OAUTH_SCOPES = ["payment_methods.agentic", "userinfo:read"] as const;
const OAUTH_SCOPE = OAUTH_SCOPES.join(" ");
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const ACCESS_TOKEN_SKEW_MS = 60_000;
const MAX_CONTEXT = 2_000;
const MAX_LINE_ITEMS = 50;
const MAX_TOTALS = 20;
const MAX_APPROVAL_WAIT_SECONDS = 30;
const APPROVAL_POLL_INTERVAL_MS = 1_000;
const MAX_MPP_BODY_BYTES = 64 * 1024;
const MAX_MPP_RESPONSE_BYTES = 24 * 1024;
const MAX_UCP_FULFILLMENT_BYTES = 8 * 1024;
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
  return { id: record.id, providerId: record.providerId, status: record.status, merchantName: record.merchantName, merchantUrl: record.merchantUrl, amount: record.amount, currency: record.currency, approvalUrl: record.approvalUrl, credentialType: record.credentialType, executionMethod: record.executionMethod, merchantAccountId: record.merchantAccountId, networkId: record.networkId, ucpCheckoutId: record.ucpCheckoutId, ucpProfileId: record.ucpProfileId, cardBrand: record.cardBrand, cardLast4: record.cardLast4, linkTransactionId: record.linkTransactionId, statusDetails: record.statusDetails, merchantConfirmation: record.merchantConfirmation, createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt, ...(record.errorCode ? { errorCode: record.errorCode } : {}) };
}

function safeStatusDetails(value: unknown): LinkSpendStatusDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const raw = root.requires_action;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const requiresAction = raw as Record<string, unknown>;
  const next = requiresAction.next_action;
  if (!next || typeof next !== "object" || Array.isArray(next)) return undefined;
  const action = next as Record<string, unknown>;
  const type = typeof action.type === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(action.type) ? action.type : undefined;
  const resolution = action.resolution === "auto_resume" || action.resolution === "create_new_spend_request" || action.resolution === "create_new_spend_request_after_completion" ? action.resolution : undefined;
  if (!type || !resolution) return undefined;
  const actionUrl = action.action_url === null || action.action_url === undefined ? undefined : boundedHttps(action.action_url, "Link action URL");
  const expiresAt = typeof action.expires_at === "number" && Number.isFinite(action.expires_at) ? action.expires_at : undefined;
  return { requiresAction: { ...(typeof requiresAction.failure_code === "string" ? { failureCode: requiresAction.failure_code.slice(0, 120) } : {}), nextAction: { type, resolution, ...(actionUrl ? { actionUrl } : {}), ...(expiresAt ? { expiresAt } : {}) } } };
}

export function safeProviderSpend(value: SpendRequest): Pick<LinkSpendRequestRecord, "status" | "providerId" | "approvalUrl" | "credentialType" | "cardBrand" | "cardLast4" | "linkTransactionId" | "expiresAt" | "networkId" | "statusDetails"> {
  const statusDetails = safeStatusDetails(value.status_details);
  return { status: safeSpendStatus(value.status), providerId: value.id, ...(value.approval_url ? { approvalUrl: value.approval_url } : {}), ...(value.credential_type ? { credentialType: value.credential_type } : {}), ...(value.network_id ? { networkId: value.network_id } : {}), ...(value.card_brand ? { cardBrand: value.card_brand } : {}), ...(value.card_last4 ? { cardLast4: value.card_last4 } : {}), ...(value.link_transaction_id ? { linkTransactionId: value.link_transaction_id } : {}), ...(value.expires_at ? { expiresAt: value.expires_at } : {}), ...(statusDetails ? { statusDetails } : {}) };
}

function safeStatusMessage(status: LinkSpendStatus, statusDetails?: LinkSpendStatusDetails): string {
  if (status === "pending_approval") return "Approve this exact amount in the Link app, then ask Chusky to check it again.";
  if (status === "requires_action") {
    const action = statusDetails?.requiresAction?.nextAction;
    if (action?.resolution === "auto_resume") return "Link is processing an additional verification step; check again after the provider's wait window.";
    return `Link requires an additional owner action${action?.type ? ` (${action.type})` : ""} before this purchase can continue.`;
  }
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

function boundedPublicHttps(value: unknown, field: string): string {
  const url = boundedHttps(value, field);
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (["localhost", "metadata", "metadata.google.internal"].includes(host) || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) throw new Error(`${field} must use a public HTTPS host`);
  return url;
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) throw new Error(`${field} must be ${min}-${max} characters`);
  return value.trim();
}

export function validateSpendArgs(args: Record<string, unknown>): { merchantName: string; merchantUrl: string; amount: number; currency: string; context: string; credentialType?: "card" | "shared_payment_token"; executionMethod?: "link_pay_token"; merchantAccountId?: string; networkId?: string; ucpCheckoutId?: string; ucpProfileId?: string; idempotencyKey?: string; lineItems?: CreateSpendRequestParams["line_items"]; totals?: CreateSpendRequestParams["totals"]; metadata?: Record<string, string> } {
  const amount = Number(args.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > config.linkMaxSpendCents) throw new Error(`amount must be an integer number of cents between 1 and ${config.linkMaxSpendCents}`);
  const currency = boundedText(args.currency ?? "USD", "currency", 3, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a three-letter code");
  const executionMethod = args.executionMethod === undefined ? undefined : boundedText(args.executionMethod, "executionMethod", 1, 40) as "link_pay_token";
  if (executionMethod && executionMethod !== "link_pay_token") throw new Error("executionMethod must be link_pay_token");
  const credentialType = args.credentialType === undefined ? undefined : boundedText(args.credentialType, "credentialType", 1, 40) as "card" | "shared_payment_token";
  if (credentialType && !["card", "shared_payment_token"].includes(credentialType)) throw new Error("credentialType must be card or shared_payment_token");
  if (executionMethod && credentialType === "shared_payment_token") throw new Error("Link Pay Token requests cannot use shared_payment_token");
  if (credentialType === "shared_payment_token" && !args.networkId) throw new Error("networkId is required for Shared Payment Token requests");
  if (executionMethod && !args.merchantAccountId) throw new Error("merchantAccountId is required for Link Pay Token requests");
  const merchantName = boundedText(args.merchantName ?? (executionMethod ? "Stripe hosted checkout" : ""), "merchantName", 1, 160);
  const merchantUrl = boundedHttps(args.merchantUrl ?? (executionMethod ? "https://checkout.stripe.com/" : ""), "merchantUrl");
  const context = boundedText(args.context, "context", 100, MAX_CONTEXT);
  const idempotencyKey = args.idempotencyKey === undefined ? undefined : boundedText(args.idempotencyKey, "idempotencyKey", 8, 160);
  const lineItems = args.lineItems === undefined ? undefined : Array.isArray(args.lineItems) && args.lineItems.length <= MAX_LINE_ITEMS ? args.lineItems as CreateSpendRequestParams["line_items"] : (() => { throw new Error("lineItems must contain at most 50 items"); })();
  const totals = args.totals === undefined ? undefined : Array.isArray(args.totals) && args.totals.length <= MAX_TOTALS ? args.totals as CreateSpendRequestParams["totals"] : (() => { throw new Error("totals must contain at most 20 items"); })();
  const metadata = args.metadata === undefined ? undefined : (() => {
    if (!args.metadata || typeof args.metadata !== "object" || Array.isArray(args.metadata)) throw new Error("metadata must be an object");
    const entries = Object.entries(args.metadata).slice(0, 50).map(([key, value]) => {
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key) || typeof value !== "string" || value.length > 500) throw new Error("metadata keys and values are bounded");
      return [key, value] as const;
    });
    return Object.fromEntries(entries);
  })();
  return { merchantName, merchantUrl, amount, currency, context, ...(credentialType ? { credentialType } : {}), ...(executionMethod ? { executionMethod } : {}), ...(args.merchantAccountId ? { merchantAccountId: boundedText(args.merchantAccountId, "merchantAccountId", 5, 120) } : {}), ...(args.networkId ? { networkId: boundedText(args.networkId, "networkId", 3, 160) } : {}), ...(args.ucpCheckoutId ? { ucpCheckoutId: boundedText(args.ucpCheckoutId, "ucpCheckoutId", 3, 160) } : {}), ...(args.ucpProfileId ? { ucpProfileId: boundedText(args.ucpProfileId, "ucpProfileId", 3, 160) } : {}), ...(idempotencyKey ? { idempotencyKey } : {}), ...(lineItems ? { lineItems } : {}), ...(totals ? { totals } : {}), ...(metadata ? { metadata } : {}) };
}

function boundedJson(value: unknown, field: string, maxBytes: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) throw new Error(`${field} is too large`);
  return value as Record<string, unknown>;
}

function safeHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("headers must be an object");
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 30)) {
    const name = key.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,80}$/.test(name) || typeof raw !== "string" || raw.length > 2_000) throw new Error("headers contain an invalid value");
    if (["authorization", "cookie", "set-cookie", "proxy-authorization", "x-api-key", "api-key", "stripe-authorization", "payment", "host", "content-length", "transfer-encoding", "connection", "upgrade"].includes(name)) throw new Error(`The ${name} header cannot be supplied to an MPP request`);
    result[name] = raw;
  }
  return result;
}

function decodeJsonBase64Url(value: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,20000}$/.test(value)) throw new Error("MPP payment challenge request is invalid");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new Error("MPP payment challenge request is not valid JSON"); }
  return boundedJson(decoded, "MPP payment challenge", 24 * 1024);
}

function challengeValue(value: string): string {
  return value.length <= 4_000 ? value : value.slice(0, 4_000);
}

/** Parse the standards-based Payment challenge without retaining credentials. */
export function parsePaymentChallenge(value: unknown): { id: string; realm: string; method: string; intent: string; request: string; requestJson: Record<string, unknown> } {
  const header = Array.isArray(value) ? value.find((item): item is string => typeof item === "string" && /^\s*Payment\s+/i.test(item)) : value;
  if (typeof header !== "string" || !/^\s*Payment\s+/i.test(header)) throw new Error("The merchant did not return a Payment challenge");
  const params: Record<string, string> = {};
  const body = header.replace(/^\s*Payment\s+/i, "");
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) params[match[1].toLowerCase()] = (match[2] ?? match[3] ?? "").replace(/\\([\\"])/g, "$1");
  for (const key of ["id", "realm", "method", "intent", "request"]) if (!params[key]) throw new Error(`MPP payment challenge is missing ${key}`);
  return { id: challengeValue(params.id), realm: challengeValue(params.realm), method: challengeValue(params.method), intent: challengeValue(params.intent), request: challengeValue(params.request), requestJson: decodeJsonBase64Url(params.request) };
}

function challengeNetworkId(request: Record<string, unknown>): string | undefined {
  const methodDetails = request.methodDetails ?? request.method_details;
  const candidates = [request.networkId, request.network_id, typeof methodDetails === "object" && methodDetails ? (methodDetails as Record<string, unknown>).networkId : undefined, typeof methodDetails === "object" && methodDetails ? (methodDetails as Record<string, unknown>).network_id : undefined];
  return candidates.find((value): value is string => typeof value === "string" && value.length >= 2 && value.length <= 160);
}

function challengeCurrency(request: Record<string, unknown>): string | undefined {
  const raw = request.currency ?? (typeof request.amount === "object" && request.amount ? (request.amount as Record<string, unknown>).currency : undefined) ?? (typeof request.methodDetails === "object" && request.methodDetails ? (request.methodDetails as Record<string, unknown>).currency : undefined);
  return typeof raw === "string" && /^[A-Za-z]{3}$/.test(raw) ? raw.toUpperCase() : undefined;
}

function minorAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) <= Number.MAX_SAFE_INTEGER) return Number(value);
  if (typeof value === "string" && /^\d+\.\d{1,2}$/.test(value)) {
    const [whole, fraction] = value.split(".");
    const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    return Number.isSafeInteger(result) && result > 0 ? result : undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return minorAmount((value as Record<string, unknown>).value ?? (value as Record<string, unknown>).amount);
  return undefined;
}

function challengeAmount(request: Record<string, unknown>): number | undefined {
  return minorAmount(request.amount ?? request.total ?? request.amount_total ?? (typeof request.paymentDetails === "object" && request.paymentDetails ? (request.paymentDetails as Record<string, unknown>).amount : undefined));
}

function safeUcpProduct(value: UcpProduct): Record<string, unknown> {
  const variantCount = Array.isArray(value.variants) ? value.variants.length : 0;
  return {
    ...(typeof value.sku === "string" ? { sku: value.sku.slice(0, 240) } : {}),
    ...(typeof value.sku_id === "string" ? { skuId: value.sku_id.slice(0, 240) } : {}),
    ...(typeof value.title === "string" ? { title: value.title.slice(0, 300) } : {}),
    ...(typeof value.name === "string" ? { name: value.name.slice(0, 300) } : {}),
    ...(typeof value.profile_id === "string" ? { profileId: value.profile_id.slice(0, 240) } : {}),
    ...(typeof value.merchant_name === "string" ? { merchantName: value.merchant_name.slice(0, 200) } : {}),
    ...(typeof value.brand === "string" ? { brand: value.brand.slice(0, 160) } : {}),
    ...(typeof value.price === "number" ? { price: value.price } : {}),
    ...(typeof value.sale_price === "number" ? { salePrice: value.sale_price } : {}),
    ...(typeof value.currency === "string" ? { currency: value.currency.slice(0, 3).toUpperCase() } : {}),
    ...(typeof value.availability === "string" ? { availability: value.availability.slice(0, 100) } : {}),
    ...(typeof value.link === "string" ? { link: value.link.slice(0, 2_000) } : {}),
    ...(variantCount ? { variantCount } : {}),
  };
}

function safeUcpCheckout(value: UcpCheckout): Record<string, unknown> {
  const order = value.order_details && typeof value.order_details === "object" && !Array.isArray(value.order_details) ? value.order_details : undefined;
  return { id: value.id, status: value.status, currency: value.currency, amountTotal: value.amount_total, amountSubtotal: value.amount_subtotal, expiresAt: value.expires_at, ...(order ? { order: Object.fromEntries(Object.entries(order).filter(([key, item]) => /^(id|order_id|status|number|url|merchant|fulfillment)$/i.test(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean"))) } : {}) };
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error("Merchant response exceeded the bounded payment response size");
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function safeReceiptHeader(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = decodeJsonBase64Url(value);
    return Object.fromEntries(Object.entries(parsed).filter(([key, item]) => /^(id|status|state|reference|transaction|amount|currency|created|expires)/i.test(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")));
  } catch { return { present: true }; }
}

function mppCredential(challenge: { id: string; realm: string; method: string; intent: string; request: string }, token: string): string {
  return Buffer.from(JSON.stringify({ challenge: { id: challenge.id, realm: challenge.realm, method: challenge.method, intent: challenge.intent, request: challenge.request }, payload: { spt: token } }), "utf8").toString("base64url");
}

function safeMppMethod(value: unknown): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  const method = boundedText(value ?? "GET", "method", 3, 6).toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("MPP supports only standard HTTP payment methods");
  return method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
}

function extractOrderId(value: UcpCheckout): string | undefined {
  const order = value.order_details;
  if (!order || typeof order !== "object" || Array.isArray(order)) return undefined;
  const id = order.id ?? order.order_id ?? order.number;
  return typeof id === "string" && id.length <= 240 ? id : undefined;
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
  const executionMethod: LinkSpendRequestRecord["executionMethod"] = input.ucpCheckoutId ? "ucp" : input.credentialType === "shared_payment_token" ? "mpp" : input.executionMethod ? "link_pay_token" : "browser";
  const local: LinkSpendRequestRecord = { id: localId, userId, status: "uncertain", merchantName: input.merchantName, merchantUrl: input.merchantUrl, amount: input.amount, currency: input.currency, context: input.context, executionMethod, ...(input.credentialType ? { credentialType: input.credentialType } : {}), ...(input.merchantAccountId ? { merchantAccountId: input.merchantAccountId } : {}), ...(input.networkId ? { networkId: input.networkId } : {}), ...(input.ucpCheckoutId ? { ucpCheckoutId: input.ucpCheckoutId } : {}), ...(input.ucpProfileId ? { ucpProfileId: input.ucpProfileId } : {}), createdAt: now, updatedAt: now };
  await saveLinkSpendRequest(userId, local);
  const params: CreateSpendRequestParams = { idempotency_key: input.idempotencyKey ?? `chusky_${sha256(localId).slice(0, 40)}`, amount: input.amount, currency: input.currency, context: input.context, test: config.linkTestMode, ...(executionMethod === "link_pay_token" ? { execution_method: "link_pay_token" as const, merchant_account_id: input.merchantAccountId } : {}), ...(input.credentialType ? { credential_type: input.credentialType } : {}), ...(input.networkId ? { network_id: input.networkId } : {}), ...(executionMethod !== "link_pay_token" ? { merchant_name: input.merchantName, merchant_url: input.merchantUrl } : {}), ...(input.lineItems ? { line_items: input.lineItems } : {}), ...(input.totals ? { totals: input.totals } : {}), ...(input.metadata ? { metadata: input.metadata } : {}) };
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
    const details = current.statusDetails as LinkSpendStatusDetails | undefined;
    const autoResumable = status === "requires_action" && details?.requiresAction?.nextAction.resolution === "auto_resume";
    const waiting = status === "pending_approval" || autoResumable;
    if (!waiting || Date.now() >= deadline) return { ...current, waiting, next: safeStatusMessage(status, details) };
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

export async function reportLinkOutcome(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertEnabled();
  const spendId = boundedText(args.spendRequestId, "spendRequestId", 20, 140);
  const local = await getLinkSpendRequest(userId, spendId);
  if (!local?.providerId) throw new Error("Link spend request is not available for reporting");
  const outcome = boundedText(args.outcome, "outcome", 1, 20).toLowerCase();
  if (outcome !== "success" && outcome !== "blocked" && outcome !== "abandoned") throw new Error("outcome must be success, blocked, or abandoned");
  const allowedTags = new Set(["stripe_checkout", "captcha", "anti_bot_script", "cdn_block", "waf_block", "dns_block", "rate_limited", "login_required", "3ds_challenge", "page_inaccessible", "timeout", "site_error", "payment_declined", "other"]);
  const tags = args.tags === undefined ? undefined : (() => {
    if (!Array.isArray(args.tags) || args.tags.length > 8) throw new Error("tags must contain at most 8 values");
    return args.tags.map((tag) => boundedText(tag, "tag", 1, 60).toLowerCase()).filter((tag) => allowedTags.has(tag));
  })();
  const result = await (await client(userId)).reports.create({ domain: new URL(local.merchantUrl).hostname, outcome: outcome as "success" | "blocked" | "abandoned", spend_request_id: local.providerId, ...(tags?.length ? { tags: tags as never } : {}), ...(args.step ? { step: boundedText(args.step, "step", 1, 120) } : {}), ...(args.context ? { freeform_context: boundedText(args.context, "context", 1, 2_000) } : {}), ...(args.attemptTrace ? { attempt_trace: boundedText(args.attemptTrace, "attemptTrace", 1, 8_000) } : {}) });
  return { spendRequestId: local.id, outcome, status: typeof result.status === "string" ? result.status.slice(0, 80) : "reported", next: "The bounded outcome report was sent to Link; it does not change the payment or merchant order state." };
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

export async function inspectLinkPayTokenCheckout(userId: number, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!config.e2bEnabled || !config.e2bApiKey) throw new Error("Link Pay Token checkout requires the E2B secure browser backend");
  const result = await e2bBrowserEngine.inspectLinkPayToken(userId, { sessionId: args.sessionId });
  return { ...result, next: (result as { supported?: boolean }).supported ? "Create a Link Pay Token spend request for this exact merchant account, then wait for the owner's Link approval." : "This checkout does not expose the Stripe Link Pay Token markers; use the approved virtual-card checkout path or a merchant MPP/UCP flow." };
}

export async function discoverLinkMppPayment(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertEnabled();
  const url = boundedPublicHttps(args.url, "url");
  await assertSafeBrowserUrl(url, { resolveDns: true });
  const method = safeMppMethod(args.method);
  const headers = safeHeaders(args.headers);
  const body = args.body === undefined ? undefined : boundedText(args.body, "body", 1, MAX_MPP_BODY_BYTES);
  const parsedBody = body === undefined ? undefined : Buffer.byteLength(body, "utf8") <= MAX_MPP_BODY_BYTES ? body : undefined;
  if (body !== undefined && !parsedBody) throw new Error("body is too large");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.linkRequestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { method, headers: { Accept: "application/json, application/problem+json, */*", ...headers }, ...(parsedBody !== undefined ? { body: parsedBody } : {}), redirect: "manual", signal: controller.signal });
    await boundedResponseText(response, MAX_MPP_RESPONSE_BYTES);
  } catch (error) {
    throw safeError(error, "MPP merchant discovery");
  } finally { clearTimeout(timer); }
  if (response.status !== 402) return { paymentRequired: false, status: response.status, next: response.ok ? "The merchant did not request an MPP payment." : "The merchant did not return a usable MPP payment challenge." };
  const challenge = parsePaymentChallenge(response.headers.get("www-authenticate"));
  if (challenge.method.toLowerCase() !== "stripe") throw new Error("This MPP challenge is not the Stripe payment method supported by Link Shared Payment Tokens");
  const challengeNetwork = challengeNetworkId(challenge.requestJson);
  const networkId = boundedText(args.networkId ?? challengeNetwork ?? "", "networkId", 2, 160);
  const challengeAmountValue = challengeAmount(challenge.requestJson);
  const amount = challengeAmountValue ?? Number(args.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("MPP challenge did not contain a supported amount; provide the exact amount in cents");
  if (args.amount !== undefined && challengeAmountValue !== undefined && Number(args.amount) !== challengeAmountValue) throw new Error("The supplied amount does not match the merchant's MPP challenge");
  const currency = (challengeCurrency(challenge.requestJson) ?? boundedText(args.currency ?? "", "currency", 3, 3)).toUpperCase();
  const context = boundedText(args.context, "context", 100, MAX_CONTEXT);
  const origin = new URL(url).origin;
  const created = await createLinkSpendRequest(userId, { merchantName: boundedText(args.merchantName ?? new URL(url).hostname, "merchantName", 1, 160), merchantUrl: origin, amount, currency, context, credentialType: "shared_payment_token", networkId, idempotencyKey: args.idempotencyKey, lineItems: args.lineItems, totals: args.totals });
  const spendId = boundedText(created.id, "spendRequestId", 20, 140);
  const local = await getLinkSpendRequest(userId, spendId);
  if (!local) throw new Error("MPP spend request was not persisted");
  const encryptedMppRequest = encryptCredential({ url, method, headers, ...(parsedBody !== undefined ? { body: parsedBody } : {}), challenge: { id: challenge.id, realm: challenge.realm, method: challenge.method, intent: challenge.intent, request: challenge.request } }, walletKey(), "LINK_AGENT_WALLET_ENCRYPTION_KEY");
  const next: LinkSpendRequestRecord = { ...local, executionMethod: "mpp", credentialType: "shared_payment_token", networkId, encryptedMppRequest, mppChallenge: { id: challenge.id, realm: challenge.realm, method: challenge.method, intent: challenge.intent, request: challenge.request }, updatedAt: Date.now() };
  await saveLinkSpendRequest(userId, next);
  return { ...safeSpendView(next), mpp: { challengeDetected: true, method: challenge.method, intent: challenge.intent, networkId }, next: "Approve the exact Link spend request. After approval, use CHUCK_LINK_MPP_PAY once; an uncertain result must be inspected before any retry." };
}

export async function payLinkMppRequest(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertEnabled();
  const spendId = boundedText(args.spendRequestId, "spendRequestId", 20, 140);
  const local = await getLinkSpendRequest(userId, spendId);
  if (!local?.providerId || local.executionMethod !== "mpp" || !local.encryptedMppRequest || !local.mppChallenge) throw new Error("This is not a prepared MPP spend request");
  if (["succeeded", "submitted"].includes(local.status)) return { ...safeSpendView(local), paymentAttempted: false, next: "This MPP request was already submitted; retrieve its receipt instead of replaying it." };
  if (local.status === "uncertain") throw new Error("The previous MPP payment outcome is uncertain; inspect the merchant and Link receipt before retrying.");
  const provider = await (await client(userId)).spendRequests.retrieve(local.providerId, { include: ["shared_payment_token"] });
  if (!provider || safeSpendStatus(provider.status) !== "approved" || !provider.shared_payment_token?.id) throw new Error("Approve this exact Shared Payment Token spend request in Link before paying");
  const request = decryptCredential<{ url: string; method: string; headers: Record<string, string>; body?: string }>(local.encryptedMppRequest, walletKey(), "LINK_AGENT_WALLET_ENCRYPTION_KEY");
  const payment = mppCredential({ id: local.mppChallenge.id, realm: local.mppChallenge.realm, method: local.mppChallenge.method, intent: local.mppChallenge.intent, request: local.mppChallenge.request }, provider.shared_payment_token.id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.linkRequestTimeoutMs);
  let response: Response;
  let receipt: Record<string, unknown> | undefined;
  try {
    response = await fetch(request.url, { method: request.method, headers: { ...request.headers, Authorization: `Payment ${payment}`, Accept: "application/json, application/problem+json, */*" }, ...(request.body !== undefined ? { body: request.body } : {}), redirect: "manual", signal: controller.signal });
    await boundedResponseText(response, MAX_MPP_RESPONSE_BYTES);
    receipt = safeReceiptHeader(response.headers.get("payment-receipt"));
  } catch (error) {
    await saveLinkSpendRequest(userId, { ...local, status: "uncertain", errorCode: "mpp_payment_uncertain", updatedAt: Date.now() });
    throw new Error("MPP payment outcome is uncertain; inspect the merchant and Link receipt before retrying.");
  } finally { clearTimeout(timer); }
  if (response.status >= 300 && response.status < 400 || response.status >= 500) {
    await saveLinkSpendRequest(userId, { ...local, status: "uncertain", errorCode: "mpp_payment_uncertain", updatedAt: Date.now() });
    throw new Error("MPP payment outcome is uncertain; inspect the merchant and Link receipt before retrying.");
  }
  if (response.status < 200 || response.status >= 300) {
    const next = { ...local, status: "failed" as const, errorCode: response.status === 402 ? "mpp_payment_rejected" : "mpp_payment_failed", updatedAt: Date.now() };
    await saveLinkSpendRequest(userId, next);
    return { ...safeSpendView(next), paymentAttempted: true, ...(receipt ? { receipt } : {}), next: "The one-time MPP credential was rejected; no replay was attempted." };
  }
  const confirmed = Boolean(receipt && /^(success|succeeded|paid|completed|complete)$/i.test(String(receipt.status ?? receipt.state ?? "")));
  const next: LinkSpendRequestRecord = { ...local, status: confirmed ? "succeeded" : "submitted", ...(confirmed ? { merchantConfirmation: { status: "observed", source: "provider", ...(typeof receipt?.reference === "string" ? { orderId: receipt.reference } : {}), observedAt: Date.now() } } : {}), updatedAt: Date.now() };
  await saveLinkSpendRequest(userId, next);
  return { ...safeSpendView(next), paymentAttempted: true, ...(receipt ? { receipt } : {}), next: confirmed ? "The merchant returned a successful MPP receipt." : "The merchant accepted the HTTP request; inspect the merchant order confirmation and Link receipt before claiming fulfillment." };
}

function boundedStringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} must contain at most ${maxItems} values`);
  return value.map((item) => boundedText(item, field, 1, maxLength));
}

export async function searchLinkUcpCatalog(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertEnabled();
  const limit = args.limit === undefined ? 20 : Number(args.limit);
  const offset = args.offset === undefined ? 0 : Number(args.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) throw new Error("UCP catalog pagination is invalid");
  const raw = await (await client(userId)).ucp.searchCatalog({
    ...(args.query === undefined ? {} : { query: boundedText(args.query, "query", 1, 300) }),
    ...(args.profileId === undefined ? {} : { profile_id: boundedText(args.profileId, "profileId", 2, 240) }),
    ...(args.sku === undefined ? {} : { sku: boundedText(args.sku, "sku", 1, 240) }),
    ...(args.brand ? { brand: boundedStringArray(args.brand, "brand", 10, 120) } : {}),
    ...(args.category ? { category: boundedStringArray(args.category, "category", 10, 120) } : {}),
    ...(args.color ? { color: boundedStringArray(args.color, "color", 10, 80) } : {}),
    ...(args.size ? { size: boundedStringArray(args.size, "size", 10, 80) } : {}),
    ...(args.availability === undefined ? {} : { availability: boundedText(args.availability, "availability", 1, 80) }),
    ...(args.currency === undefined ? {} : { currency: boundedText(args.currency, "currency", 3, 3).toUpperCase() }),
    ...(args.sort === undefined ? {} : { sort: boundedText(args.sort, "sort", 1, 80) }),
    limit, offset, include_facets: args.includeFacets === true, test: config.linkTestMode,
  });
  return { data: Array.isArray(raw.data) ? raw.data.slice(0, 50).map((item: UcpProduct) => safeUcpProduct(item)) : [], ...(raw.total_count === undefined ? {} : { totalCount: raw.total_count }), ...(raw.has_more === undefined ? {} : { hasMore: raw.has_more }), ...(raw.took_ms === undefined ? {} : { tookMs: raw.took_ms }), next: "Use the returned SKU and profile ID to create a checkout, then create a Link spend request for the exact checkout total." };
}

function safeFulfillmentDetails(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const result = boundedJson(value, "fulfillmentDetails", MAX_UCP_FULFILLMENT_BYTES);
  const forbidden = /password|secret|token|authorization|cookie|card|cvv|cvc|payment/i;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (forbidden.test(key)) throw new Error("fulfillmentDetails cannot contain credentials or payment fields");
      visit(child);
    }
  };
  visit(result);
  return result;
}

export async function createLinkUcpCheckout(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertEnabled();
  const profileId = boundedText(args.profileId, "profileId", 2, 240);
  if (!Array.isArray(args.lineItems) || args.lineItems.length < 1 || args.lineItems.length > 50) throw new Error("lineItems must contain between 1 and 50 items");
  const lineItems = args.lineItems.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each UCP line item must be an object");
    const record = item as Record<string, unknown>;
    const skuId = boundedText(record.skuId ?? record.sku_id, "skuId", 1, 240);
    const quantity = Number(record.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw new Error("UCP line item quantity must be between 1 and 99");
    return { sku_id: skuId, quantity };
  });
  const fulfillmentDetails = safeFulfillmentDetails(args.fulfillmentDetails);
  const checkout = await (await client(userId)).ucp.createCheckout({ profile_id: profileId, line_items: lineItems, ...(args.currency === undefined ? {} : { currency: boundedText(args.currency, "currency", 3, 3).toUpperCase() }), ...(fulfillmentDetails ? { fulfillment_details: fulfillmentDetails } : {}), test: config.linkTestMode });
  return { checkout: safeUcpCheckout(checkout), paymentRequired: checkout.status === "requires_action" || checkout.status === "open", next: "If payment is required, create one exact Link spend request for this checkout total and retain its checkout ID and profile ID. Complete UCP only after Link marks that spend approved." };
}

export async function completeLinkUcpCheckout(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertEnabled();
  const spendId = boundedText(args.spendRequestId, "spendRequestId", 20, 140);
  const local = await getLinkSpendRequest(userId, spendId);
  if (!local?.providerId || local.executionMethod !== "ucp") throw new Error("The UCP checkout has no Link spend request bound to this checkout");
  if (["denied", "expired", "canceled", "failed", "uncertain"].includes(local.status)) throw new Error("The UCP payment is not eligible for completion");
  const checkoutId = boundedText(args.checkoutId ?? local.ucpCheckoutId, "checkoutId", 2, 240);
  const profileId = boundedText(args.profileId ?? local.ucpProfileId, "profileId", 2, 240);
  if (local.ucpCheckoutId && local.ucpCheckoutId !== checkoutId) throw new Error("The checkout ID does not match the locally bound UCP checkout");
  if (local.ucpProfileId && local.ucpProfileId !== profileId) throw new Error("The profile ID does not match the locally bound UCP checkout");
  const link = await client(userId);
  const linked = await link.ucp.retrieveCheckout(checkoutId, { spend_request_id: local.providerId, test: config.linkTestMode });
  if (!linked?.spend_request || linked.spend_request.id !== local.providerId) throw new Error("The UCP checkout is not bound to this exact Link spend request");
  if (safeSpendStatus(linked.spend_request.status) !== "approved" && safeSpendStatus(linked.spend_request.status) !== "submitted") throw new Error("Approve this exact Link spend request before completing the UCP checkout");
  const completed = await link.ucp.completeCheckout(checkoutId, { spend_request_id: local.providerId, profile_id: profileId, test: config.linkTestMode });
  const orderId = extractOrderId(completed);
  const next: LinkSpendRequestRecord = { ...local, executionMethod: "ucp", ucpCheckoutId: checkoutId, ucpProfileId: profileId, status: completed.status === "completed" ? "succeeded" : "submitted", ...(orderId ? { merchantConfirmation: { status: "observed", source: "ucp", orderId, observedAt: Date.now() } } : {}), updatedAt: Date.now() };
  await saveLinkSpendRequest(userId, next);
  return { ...safeSpendView(next), checkout: safeUcpCheckout(completed), orderConfirmed: Boolean(orderId || completed.status === "completed"), next: completed.status === "completed" ? "UCP reported a completed order; the bounded order details are the merchant confirmation." : "UCP has not reached a completed terminal state; do not claim fulfillment." };
}

export async function confirmLinkMerchantOrder(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const spendId = boundedText(args.spendRequestId, "spendRequestId", 20, 140);
  const local = await getLinkSpendRequest(userId, spendId);
  if (!local) throw new Error("Link spend request not found");
  if (!Array.isArray(args.detectors) || args.detectors.length < 1 || args.detectors.length > 12) throw new Error("detectors must contain between 1 and 12 required observations");
  const detectors: BrowserDetector[] = args.detectors.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each order detector must be an object");
    const record = item as Record<string, unknown>;
    return { ...(record.urlIncludes ? { urlIncludes: boundedText(record.urlIncludes, "urlIncludes", 1, 300) } : {}), ...(record.titleIncludes ? { titleIncludes: boundedText(record.titleIncludes, "titleIncludes", 1, 300) } : {}), ...(record.textIncludes ? { textIncludes: boundedText(record.textIncludes, "textIncludes", 1, 300) } : {}), required: record.required !== false };
  });
  const browser = await e2bBrowserEngine.browser(userId, { action: "status", sessionId: args.sessionId });
  const currentUrl = browser && typeof browser === "object" && typeof (browser as { lastUrl?: unknown }).lastUrl === "string" ? (browser as { lastUrl: string }).lastUrl : "";
  if (!currentUrl || new URL(currentUrl).origin !== new URL(local.merchantUrl).origin) throw new Error("The secure browser is not on the merchant origin for this spend request");
  const snapshot = await e2bBrowserEngine.browser(userId, { action: "snapshot", sessionId: args.sessionId });
  const observedText = JSON.stringify(snapshot).slice(0, 20_000);
  const verification = verifyBrowserResult({ currentUrl, title: typeof (browser as { title?: unknown })?.title === "string" ? (browser as { title: string }).title : undefined, text: observedText, detectors });
  const next: LinkSpendRequestRecord = { ...local, merchantConfirmation: { status: verification.passed ? "observed" : "not_observed", source: "browser", observedAt: Date.now() }, updatedAt: Date.now() };
  await saveLinkSpendRequest(userId, next);
  return { ...safeSpendView(next), merchantConfirmed: verification.passed, verification: { passed: verification.passed, matched: verification.matched, missing: verification.missing }, next: verification.passed ? "The merchant page matched every required confirmation detector." : "The merchant page did not match every required detector; do not claim the order completed." };
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

async function completeApprovedLinkPayToken(userId: number, args: Record<string, unknown>, local: LinkSpendRequestRecord): Promise<Record<string, unknown>> {
  if (!local.providerId || !local.merchantAccountId) throw new Error("The Link Pay Token request is missing its approved merchant account binding");
  const provider = await (await client(userId)).spendRequests.retrieve(local.providerId, { include: ["link_pay_token"] });
  if (!provider || safeSpendStatus(provider.status) !== "approved" || typeof provider.link_pay_token !== "string" || !provider.link_pay_token) throw new Error("Approve this exact Link Pay Token spend request in Link before checkout");
  const inspected = await e2bBrowserEngine.inspectLinkPayToken(userId, { sessionId: args.sessionId });
  if (inspected.supported !== true || inspected.merchantAccountId !== local.merchantAccountId) throw new Error("The live Stripe checkout is not the approved Link Pay Token merchant account");
  await e2bBrowserEngine.secureLinkPayToken(userId, { value: provider.link_pay_token, merchantAccountId: local.merchantAccountId, sessionId: args.sessionId });
  if (args.submitNodeId) {
    try { await e2bBrowserEngine.browser(userId, { action: "click", nodeId: boundedText(args.submitNodeId, "submitNodeId", 8, 160), sessionId: args.sessionId }, { ownerPrivateRun: true, ownerApprovedAction: true }); }
    catch { await saveLinkSpendRequest(userId, { ...local, status: "uncertain", errorCode: "checkout_submission_uncertain", updatedAt: Date.now() }); throw new Error("Checkout submission outcome is uncertain; inspect the merchant and Link status before retrying."); }
  }
  const next: LinkSpendRequestRecord = { ...local, status: args.submitNodeId ? "submitted" : "approved", updatedAt: Date.now() };
  await saveLinkSpendRequest(userId, next);
  return { ...safeSpendView(next), submitted: Boolean(args.submitNodeId), next: args.submitNodeId ? "The Link Pay Token checkout was submitted. Verify the merchant order and Link receipt before claiming fulfillment." : "The approved Link Pay Token was filled inside the verified Stripe frame. Inspect and submit the checkout with the approved control." };
}

export async function completeApprovedLinkCheckout(userId: number, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!config.e2bEnabled || !config.e2bApiKey) throw new Error("Link checkout requires the E2B secure browser backend");
  const spendId = boundedText(args.spendRequestId, "spendRequestId", 20, 140);
  const local = await getLinkSpendRequest(userId, spendId);
  if (!local?.providerId) throw new Error("Link spend request is not ready for checkout");
  if (local.executionMethod === "link_pay_token" || args.executionMethod === "link_pay_token") return completeApprovedLinkPayToken(userId, args, local);
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
  if (!["browser", "link_pay_token"].includes(executionMethod)) throw new Error("The approved Link checkout method must be browser or link_pay_token");
  return completeApprovedLinkCheckout(userId, args);
}
