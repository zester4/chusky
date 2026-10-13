import { BROWSER_ACTION_POLICY, browserActionPolicy, classifyBrowserTarget } from "../lib/browser-runtime/actionPolicy.js";
export type { BrowserPolicyAction as VaultAction, BrowserPolicyDecision as VaultActionDecision } from "../lib/browser-runtime/actionPolicy.js";
import type { BrowserPolicyAction as VaultAction, BrowserPolicyDecision as VaultActionDecision } from "../lib/browser-runtime/actionPolicy.js";

export function vaultActionPolicy(action: VaultAction): VaultActionDecision { return browserActionPolicy(action); }
export function safeVaultPolicy(): Record<VaultAction, VaultActionDecision> { return { ...BROWSER_ACTION_POLICY }; }
export { classifyBrowserTarget };
