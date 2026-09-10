import { config } from "../config.js";
import { vaultBroker, type VaultSetupRequest, type VaultSession } from "./client.js";
import { safeVaultPolicy } from "./policy.js";

export type { VaultSetupRequest } from "./client.js";
function text(value: unknown, field: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${field} must be 1-${max} characters`); return value.trim(); }
export function normaliseVaultOrigin(value: string): string { const url = new URL(value); if (url.protocol !== "https:") throw new Error("Vault websites must use HTTPS"); if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("origin must be a clean HTTPS origin, such as https://www.amazon.com"); return url.origin; }
export function normaliseVaultService(value: string): string { const service = text(value, "service", 80).toLowerCase(); if (!/^[a-z0-9][a-z0-9 ._-]*$/.test(service)) throw new Error("service contains unsupported characters"); return service; }
function safeUrl(value: string, origin: string, field: string): string { const url = new URL(value, origin); if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error(`${field} must stay on the configured HTTPS origin`); return url.toString(); }
function account(userId: number): string { return `account_${userId}`; }
function assertEnabled(): void { if (!config.vaultEnabled || !vaultBroker.enabled()) throw new Error("Vault is not enabled. Configure VAULT_ENABLED=true, VAULT_BROKER_URL, and VAULT_BROKER_HMAC_SECRET."); }

// Vault availability is checked at tool execution time. An incomplete
// optional integration must not prevent Telegram, health checks, and the
// other channels from starting.
export async function initVault(): Promise<void> { return; }
export async function beginVaultSetup(userId: number, request: VaultSetupRequest) {
  assertEnabled(); const service = normaliseVaultService(request.service); const origin = normaliseVaultOrigin(request.origin);
  const result = await vaultBroker.beginSetup(account(userId), { service, origin, loginUrl: safeUrl(request.loginUrl || origin, origin, "loginUrl"), logoutUrl: request.logoutUrl ? safeUrl(request.logoutUrl, origin, "logoutUrl") : undefined, usernameFieldLabel: text(request.usernameFieldLabel || "Email or username", "usernameFieldLabel", 120), passwordFieldLabel: text(request.passwordFieldLabel || "Password", "passwordFieldLabel", 120), submitButtonLabel: text(request.submitButtonLabel || "Sign in", "submitButtonLabel", 120) });
  return { ...result, message: "Open this private one-time link to enter the login directly. Chusky and the model never see the username or password." };
}
export async function listVault(userId: number) { assertEnabled(); const result = await vaultBroker.list(account(userId)); return result.credentials.map((credential) => ({ ...credential, policy: safeVaultPolicy() })); }
export async function vaultStatus(userId: number, service?: string) { assertEnabled(); return (await vaultBroker.status(account(userId), service ? normaliseVaultService(service) : undefined)).sessions; }
export async function recordVaultSession(userId: number, input: Omit<VaultSession, "id"> & { credentialId: string }) { assertEnabled(); return (await vaultBroker.recordSession(account(userId), input)).session; }
export async function leaseVaultCredential(userId: number, service: string, workspaceId: string) { assertEnabled(); return (await vaultBroker.lease(account(userId), normaliseVaultService(service), workspaceId)).credential; }
export async function logoutVault(userId: number, service: string) { assertEnabled(); return vaultBroker.logout(account(userId), normaliseVaultService(service)); }
