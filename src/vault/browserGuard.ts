import { config } from "../config.js";
import { vaultStatus } from "./vault.js";
import { classifyBrowserTarget, vaultActionPolicy, type VaultAction } from "./policy.js";

const knownNodes = new Map<string, string>();
const key = (userId: number, workspaceId: string, nodeId: string) => `${userId}:${workspaceId}:${nodeId}`;

function matches(value: unknown): Array<{ nodeId?: unknown; id?: unknown; name?: unknown }> {
  if (Array.isArray(value)) return value as Array<{ nodeId?: unknown; id?: unknown; name?: unknown }>;
  if (value && typeof value === "object" && Array.isArray((value as { matches?: unknown }).matches)) return (value as { matches: Array<{ nodeId?: unknown; id?: unknown; name?: unknown }> }).matches;
  return [];
}

export async function rememberVaultBrowserNodes(userId: number, workspaceId: string, result: unknown): Promise<void> {
  if (!config.vaultEnabled) return;
  for (const item of matches(result)) {
    const nodeId = typeof item.nodeId === "string" ? item.nodeId : typeof item.id === "string" ? item.id : undefined;
    if (nodeId && typeof item.name === "string") knownNodes.set(key(userId, workspaceId, nodeId), item.name.slice(0, 300));
  }
}

/** Enforces a narrow UI policy only while a matching retained identity is authenticated. */
export async function guardVaultBrowserAction(userId: number, workspaceId: string, args: Record<string, unknown>): Promise<void> {
  if (!config.vaultEnabled) return;
  const active = (await vaultStatus(userId)).some((session) => session.workspaceId === workspaceId && session.status === "authenticated");
  if (!active) return;
  const action = String(args.action ?? "");
  if (action === "click") throw new Error("Coordinate clicks are disabled in an authenticated vault session. Find the accessible control first, then invoke it with a declared vaultAction.");
  if (!(["invoke", "fill", "press", "open"].includes(action))) return;
  if (action === "press") throw new Error("Keyboard submit is disabled in an authenticated vault session. Invoke a discovered accessible control instead.");
  let target: VaultAction | undefined;
  if (action === "open") target = classifyBrowserTarget(String(args.url ?? ""));
  else {
    const nodeId = String(args.nodeId ?? ""); const label = knownNodes.get(key(userId, workspaceId, nodeId));
    if (!label) throw new Error("Authenticated vault interactions require a preceding CHUCK_DAYTONA_BROWSER find call so Chusky can verify the control safely.");
    target = classifyBrowserTarget(label);
  }
  if (!target) return;
  const decision = vaultActionPolicy(target);
  if (decision === "blocked") throw new Error(`Vault policy blocks ${target.replaceAll("_", " ")} for authenticated websites.`);
  if (decision === "approval_required" && args.vaultAction !== target) throw new Error(`Vault action ${target.replaceAll("_", " ")} requires an explicit matching vaultAction and approval.`);
}
