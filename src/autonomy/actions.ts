import { createHash } from "node:crypto";
import { claimDelivery, completeDelivery, getExternalAction, saveExternalAction, updateExternalAction, type ExternalActionReceipt } from "../store.js";

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function externalArgumentsHash(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableValue(args)).digest("hex");
}

/** Heuristic only for deciding which autonomous calls need a replay receipt. */
export function isExternalWriteTool(tool: string): boolean {
  const normalized = tool.toUpperCase();
  if (normalized.startsWith("CHUCK_") && /(^|_)(LIST|GET|SEARCH|FIND|LOOKUP|READ|STATUS|STATE|CHECK|PREVIEW|HEALTH|DETAILS|FILES)(_|$)/.test(normalized)) return false;
  if (normalized.startsWith("CHUCK_") && ["CHUCK_TASK_CHECKPOINT", "CHUCK_MISSION_CHECKPOINT", "CHUCK_ATTENTION_STATE"].includes(normalized)) return false;
  if (!normalized.startsWith("CHUCK_") && /(^|_)(SEARCH|GET|GET_TOOL_SCHEMAS|LIST|FIND|LOOKUP|READ|FETCH|STATUS|STATE|HEALTH|DESCRIBE)(_|$)/.test(normalized)) return false;
  return true;
}

export interface ExternalActionClaim {
  state: "new" | "succeeded" | "in_flight";
  receipt?: ExternalActionReceipt;
  logicalActionId: string;
}

export async function beginExternalAction(input: {
  userId: number;
  provider: ExternalActionReceipt["provider"];
  tool: string;
  args: Record<string, unknown>;
  runId: string;
  source?: { kind: string; id: string; occurrenceId?: string };
}): Promise<ExternalActionClaim> {
  const argumentsHash = externalArgumentsHash(input.args);
  const logicalActionId = [input.source?.kind ?? "run", input.source?.id ?? input.runId, input.source?.occurrenceId ?? "single", input.tool, argumentsHash].join(":").slice(0, 240);
  const existing = await getExternalAction(input.userId, logicalActionId);
  if (existing?.status === "succeeded") return { state: "succeeded", receipt: existing, logicalActionId };
  const claimed = await claimDelivery(`autonomy:external-action:${input.userId}:${createHash("sha256").update(logicalActionId).digest("hex")}`, 30 * 60 * 1000);
  if (!claimed) return { state: "in_flight", receipt: existing, logicalActionId };
  const receipt = await saveExternalAction({
    id: existing?.id ?? `act_${createHash("sha256").update(`${input.userId}:${logicalActionId}`).digest("hex").slice(0, 48)}`,
    userId: input.userId, provider: input.provider, tool: input.tool, argumentsHash, logicalActionId,
    ...(typeof input.args.account_alias === "string" ? { account: input.args.account_alias.slice(0, 160) } : {}),
    ...(input.source?.occurrenceId ? { occurrenceId: input.source.occurrenceId } : {}), status: "started", createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
  });
  return { state: "new", receipt, logicalActionId };
}

export async function finishExternalAction(userId: number, logicalActionId: string, resultSummary: string, providerId?: string): Promise<void> {
  await updateExternalAction(userId, logicalActionId, { status: "succeeded", resultSummary: resultSummary.slice(0, 8_000), ...(providerId ? { providerId: providerId.slice(0, 240) } : {}), error: undefined });
  await completeDelivery(`autonomy:external-action:${userId}:${createHash("sha256").update(logicalActionId).digest("hex")}`, 365 * 24 * 60 * 60);
}

export async function failExternalAction(userId: number, logicalActionId: string, error: string): Promise<void> {
  await updateExternalAction(userId, logicalActionId, { status: "failed", error: error.slice(0, 1_000) });
}
