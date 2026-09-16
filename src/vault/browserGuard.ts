import { config } from "../config.js";
import { vaultBroker } from "./client.js";
import { vaultStatus } from "./vault.js";
import { vaultActionPolicy, type VaultAction } from "./policy.js";
import { browserSessionIsRevoked, classifyBrowserIntent } from "./browserOps.js";

type KnownNode = { label: string; origin: string; capturedAt: number };
const knownNodes = new Map<string, KnownNode>();
const key = (userId: number, workspaceId: string, nodeId: string) => `${userId}:${workspaceId}:${nodeId}`;
const NODE_TTL_MS = 2 * 60_000;
const SENSITIVE_WORKSPACE_DATA = /(cookies?|login data|web data|local storage|session storage|key4\.db|logins\.json|google[-_ ]?chrome|chromium|firefox|\.ssh|\.aws|credentials|browser profile|password store|secret store)/i;

function matches(value: unknown): Array<{ nodeId?: unknown; id?: unknown; name?: unknown }> {
  if (Array.isArray(value)) return value as Array<{ nodeId?: unknown; id?: unknown; name?: unknown }>;
  if (value && typeof value === "object" && Array.isArray((value as { matches?: unknown }).matches)) return (value as { matches: Array<{ nodeId?: unknown; id?: unknown; name?: unknown }> }).matches;
  return [];
}

export async function rememberVaultBrowserNodes(userId: number, workspaceId: string, result: unknown, currentUrl?: string): Promise<void> {
  // An optional or temporarily misconfigured broker must not break ordinary
  // Daytona browsing. Once the broker is actually configured, all retained
  // authenticated sessions continue through the strict guard below.
  if (!config.vaultEnabled || !vaultBroker.enabled()) return;
  let origin = "";
  try { origin = currentUrl ? new URL(currentUrl).origin : ""; } catch { origin = ""; }
  for (const item of matches(result)) {
    const nodeId = typeof item.nodeId === "string" ? item.nodeId : typeof item.id === "string" ? item.id : undefined;
    if (nodeId && typeof item.name === "string" && origin) knownNodes.set(key(userId, workspaceId, nodeId), { label: item.name.slice(0, 300), origin, capturedAt: Date.now() });
  }
}

/** Enforces a narrow UI policy only while a matching retained identity is authenticated. */
export async function guardVaultBrowserAction(userId: number, workspaceId: string, args: Record<string, unknown>): Promise<void> {
  if (!config.vaultEnabled || !vaultBroker.enabled()) return;
  const action = String(args.action ?? "");
  const workspaceSessions = (await vaultStatus(userId)).filter((session) => session.workspaceId === workspaceId);
  const activeSessions = workspaceSessions.filter((session) => session.status === "authenticated" && (!session.expiresAt || session.expiresAt > Date.now()));
  const active = activeSessions.length > 0;
  if (!active) {
    const hasRevokedIdentity = workspaceSessions.some(browserSessionIsRevoked);
    if (hasRevokedIdentity && !["status", "start"].includes(action)) throw new Error("This Daytona workspace contains a revoked or expired website session. Log in again with CHUCK_VAULT_LOGIN or complete a private browser handoff before using the browser.");
    return;
  }
  const currentOrigin = typeof args.currentUrl === "string" ? (() => { try { return new URL(args.currentUrl).origin; } catch { return ""; } })() : "";
  const pageBoundActions = new Set(["snapshot", "find", "focus", "invoke", "fill", "back", "forward", "refresh", "scroll"]);
  if (pageBoundActions.has(action) && (!currentOrigin || !activeSessions.some((session) => session.origin === currentOrigin))) {
    throw new Error("Authenticated browser work must stay on the current saved website origin. Open or inspect the authorised origin again before continuing.");
  }
  if (currentOrigin && !["status", "start", "open", "windows"].includes(action) && !activeSessions.some((session) => session.origin === currentOrigin)) {
    throw new Error("The current browser page is outside every active saved website origin. Open the intended authorised origin before continuing.");
  }
  if (["screenshot", "screenshot_region", "recording_start", "recording_stop", "recording_list", "recording_get", "recording_delete", "recording_download", "process_logs", "process_errors"].includes(action)) throw new Error("Screenshots, recordings, and raw desktop logs are disabled while a saved website identity is authenticated. Use the private browser handoff when a human must inspect the page.");
  if (["click", "type", "mouse_click", "mouse_move", "mouse_drag", "keyboard_type", "keyboard_hotkey"].includes(action)) throw new Error("Coordinate and keyboard typing are disabled in an authenticated vault session. Find the accessible control first, then invoke or fill it with a declared vaultAction.");
  if (action === "accessibility_invoke") return guardVaultBrowserAction(userId, workspaceId, { ...args, action: "invoke" });
  if (action === "accessibility_set_value") return guardVaultBrowserAction(userId, workspaceId, { ...args, action: "fill" });
  if (!(["invoke", "fill", "press", "open"].includes(action))) return;
  if (action === "press") throw new Error("Keyboard submit is disabled in an authenticated vault session. Invoke a discovered accessible control instead.");
  let target: VaultAction | undefined;
  if (action === "open") {
    let nextOrigin = "";
    try { nextOrigin = new URL(String(args.url ?? "")).origin; } catch { /* browser validates the URL */ }
    if (nextOrigin && !activeSessions.some((session) => session.origin === nextOrigin)) throw new Error("Authenticated vault browsing is bound to its saved website origin. Start a separate site login before navigating to another origin.");
    // Navigation within the already-authenticated origin is ordinary browsing;
    // only a classified high-impact destination should require an action claim.
    target = classifyBrowserIntent({ url: String(args.url ?? "") });
    if (target === "unknown") target = "browse";
  }
  else {
    const nodeId = String(args.nodeId ?? ""); const known = knownNodes.get(key(userId, workspaceId, nodeId));
    if (!known || Date.now() - known.capturedAt > NODE_TTL_MS) { knownNodes.delete(key(userId, workspaceId, nodeId)); throw new Error("Authenticated vault interactions require a fresh CHUCK_DAYTONA_BROWSER find call so Chusky can verify the control safely."); }
    const discoveredOrigin = typeof args.currentUrl === "string" ? (() => { try { return new URL(args.currentUrl).origin; } catch { return ""; } })() : "";
    if (!discoveredOrigin || discoveredOrigin !== known.origin || !activeSessions.some((session) => session.origin === discoveredOrigin)) throw new Error("The discovered browser control is stale or belongs to a different website origin. Inspect the current page again before acting.");
    target = classifyBrowserIntent({ label: known.label, url: discoveredOrigin });
  }
  target ??= "unknown";
  const decision = vaultActionPolicy(target);
  if (decision === "blocked") throw new Error(`Vault policy blocks ${target.replaceAll("_", " ")} for authenticated websites.`);
  if (decision === "approval_required" && args.vaultAction !== target) throw new Error(`Vault action ${target.replaceAll("_", " ")} requires an explicit matching vaultAction and approval.`);
}

/** Prevent generic Daytona tools from reading or changing browser credential stores. */
export async function guardVaultWorkspaceAccess(userId: number, workspaceId: string, value: unknown, label = "workspace input"): Promise<void> {
  if (!config.vaultEnabled || !vaultBroker.enabled()) return;
  const active = (await vaultStatus(userId)).some((session) => session.workspaceId === workspaceId && session.status === "authenticated" && (!session.expiresAt || session.expiresAt > Date.now()));
  if (active && SENSITIVE_WORKSPACE_DATA.test(String(value ?? ""))) throw new Error(`Access to browser credential data is blocked while a saved website identity is authenticated (${label}). Use CHUCK_VAULT_LOGIN or the private browser handoff.`);
}
