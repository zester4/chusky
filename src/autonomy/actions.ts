import { createHash } from "node:crypto";
import { claimDelivery, completeDelivery, getExternalAction, getMission, listExternalActions, recordTrustedMissionEvidence, saveExternalAction, updateExternalAction, type ExternalActionReceipt } from "../store.js";
import { logger } from "../logger.js";
import { queueCompensation, appendTraceEvent, appendReliabilitySample } from "../reliability/persistence.js";

export interface TrustedProviderAction {
  toolSlug: string;
  argumentsHash: string;
  index?: number;
}

function missionReceiptEvidence(receipt: ExternalActionReceipt): Array<{
  id: string;
  kind: "tool_receipt";
  summary: string;
  source?: string;
  ref: string;
  hash: string;
  verified: true;
  verifiedBy: "system";
}> {
  const actionEvidence = (receipt.providerActions ?? []).slice(0, 50).map((action) => ({
    id: `evidence_${receipt.id}_${action.index ?? 0}_${createHash("sha256").update(`${action.toolSlug}:${action.argumentsHash}`).digest("hex").slice(0, 16)}`,
    kind: "tool_receipt" as const,
    summary: `${action.toolSlug} completed successfully inside a confirmed provider batch.`,
    source: action.toolSlug,
    ref: `tool-receipt:${receipt.id}:${action.index ?? 0}`,
    hash: action.argumentsHash,
    verified: true as const,
    verifiedBy: "system" as const,
  }));
  return [{
    id: `evidence_${receipt.id}`,
    kind: "tool_receipt",
    summary: `${receipt.tool} completed successfully${receipt.providerId ? ` (${receipt.providerId})` : ""}.`,
    ref: `tool-receipt:${receipt.id}`,
    hash: receipt.argumentsHash,
    verified: true,
    verifiedBy: "system",
  }, ...actionEvidence];
}

/**
 * Repair mission proof after a provider write succeeded but the process died
 * before the evidence mutation completed. This never replays the provider.
 */
export async function repairMissionEvidenceForMission(userId: number, missionId: string, receipts?: ExternalActionReceipt[]): Promise<number> {
  const candidates = (receipts ?? await listExternalActions(userId, 400)).filter((receipt) =>
    receipt.status === "succeeded"
    && receipt.sourceKind === "mission"
    && receipt.sourceId === missionId
    && receipt.missionEvidenceStatus !== "persisted",
  );
  let repaired = 0;
  for (const receipt of candidates) {
    try {
      const recorded = await recordTrustedMissionEvidence(userId, missionId, missionReceiptEvidence(receipt), receipt.missionStepId);
      if (!recorded) continue;
      const updated = await updateExternalAction(userId, receipt.logicalActionId, {
        missionEvidenceStatus: "persisted",
        missionEvidenceError: undefined,
      });
      if (updated?.missionEvidenceStatus === "persisted") repaired++;
    } catch (error) {
      logger.warn({ userId, missionId, receiptId: receipt.id, errorName: error instanceof Error ? error.name : "UnknownError" }, "Trusted mission evidence repair failed");
    }
  }
  return repaired;
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function externalArgumentsHash(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableValue(args)).digest("hex");
}

/**
 * Classify provider writes that need a replay receipt. Internal task/mission
 * controls mutate Chusky state, not an external provider, so they must never
 * become trusted external-action evidence.
 */
export function isExternalWriteTool(tool: string): boolean {
  const normalized = tool.toUpperCase();
  if (["CHUCK_TOOL_PREFLIGHT", "CHUCK_INTEGRATION_HEALTH", "CHUCK_ARTIFACT_QA", "CHUCK_TOOL_RECOVERY"].includes(normalized)) return false;
  if (/^CHUCK_(MISSION|TASK)_/.test(normalized)) return false;
  if (normalized.startsWith("CHUCK_") && /(^|_)(LIST|GET|SEARCH|FIND|LOOKUP|READ|STATUS|STATE|CHECK|PREVIEW|HEALTH|DETAILS|FILES)(_|$)/.test(normalized)) return false;
  if (normalized.startsWith("CHUCK_") && ["CHUCK_TASK_CHECKPOINT", "CHUCK_MISSION_CHECKPOINT", "CHUCK_ATTENTION_STATE"].includes(normalized)) return false;
  if (!normalized.startsWith("CHUCK_") && /(^|_)(SEARCH|GET|GET_TOOL_SCHEMAS|LIST|FIND|LOOKUP|READ|FETCH|STATUS|STATE|HEALTH|DESCRIBE)(_|$)/.test(normalized)) return false;
  return true;
}

export interface ExternalActionClaim {
  state: "new" | "succeeded" | "in_flight" | "ambiguous";
  receipt?: ExternalActionReceipt;
  logicalActionId: string;
}

function externalActionLogicalId(input: {
  source?: { kind: string; id: string; occurrenceId?: string; missionStepId?: string };
  tool: string;
  argumentsHash: string;
  includeMissionStep: boolean;
}): string {
  const parts = [
    input.source?.kind ?? "run",
    input.source?.id ?? "run",
    input.source?.occurrenceId ?? "single",
  ];
  // A mission step is a distinct execution occurrence. Keep it in the
  // idempotency frontier so two separate steps that intentionally perform the
  // same provider action with the same arguments do not collapse into one
  // external write. The legacy form is still read below for records created
  // before this field was part of the key.
  if (input.includeMissionStep && input.source?.missionStepId) {
    parts.push("step", input.source.missionStepId);
  }
  parts.push(input.tool, input.argumentsHash);
  return parts.join(":").slice(0, 240);
}

export async function beginExternalAction(input: {
  userId: number;
  provider: ExternalActionReceipt["provider"];
  tool: string;
  args: Record<string, unknown>;
  runId: string;
  source?: { kind: string; id: string; occurrenceId?: string; missionStepId?: string };
}): Promise<ExternalActionClaim> {
  const argumentsHash = externalArgumentsHash(input.args);
  const missionScoped = Boolean(input.source?.missionStepId);
  const logicalActionId = externalActionLogicalId({ source: input.source, tool: input.tool, argumentsHash, includeMissionStep: missionScoped });
  const legacyLogicalActionId = missionScoped
    ? externalActionLogicalId({ source: input.source, tool: input.tool, argumentsHash, includeMissionStep: false })
    : logicalActionId;
  let existing = await getExternalAction(input.userId, logicalActionId);
  // Preserve idempotency for a mission action that was started by an older
  // deployment, but never borrow a legacy receipt from a different mission
  // step. Without this ownership check, a same-arguments action in step B
  // could incorrectly replay step A success after a rolling deployment.
  if (!existing && legacyLogicalActionId !== logicalActionId) {
    const legacy = await getExternalAction(input.userId, legacyLogicalActionId);
    if (legacy
      && legacy.sourceKind === input.source?.kind
      && legacy.sourceId === input.source?.id
      && legacy.missionStepId === input.source?.missionStepId) {
      existing = legacy;
    }
  }
  const effectiveLogicalActionId = existing?.logicalActionId ?? logicalActionId;
  if (existing?.status === "succeeded") return { state: "succeeded", receipt: existing, logicalActionId: effectiveLogicalActionId };
  const deliveryKey = `autonomy:external-action:${input.userId}:${createHash("sha256").update(effectiveLogicalActionId).digest("hex")}`;
  if (existing?.status === "ambiguous" || existing?.status === "failed") return { state: "ambiguous", receipt: existing, logicalActionId: effectiveLogicalActionId };
  // A process may die after the provider accepts a write but before the
  // success receipt is persisted. Once the execution lease expires, never
  // replay that started action automatically; quarantine it for reconciliation.
  if (existing?.status === "started" && Date.now() - existing.updatedAt >= 30 * 60 * 1000) {
    const ambiguous = await updateExternalAction(input.userId, effectiveLogicalActionId, {
      status: "ambiguous",
      error: "The provider outcome is uncertain. Verify the provider state before manually retrying this action.",
    });
    await completeDelivery(deliveryKey, 365 * 24 * 60 * 60);
    return { state: "ambiguous", receipt: ambiguous ?? existing, logicalActionId: effectiveLogicalActionId };
  }
  const claimed = await claimDelivery(deliveryKey, 30 * 60 * 1000);
  if (!claimed) return { state: "in_flight", receipt: existing, logicalActionId: effectiveLogicalActionId };
  const receipt = await saveExternalAction({
    id: existing?.id ?? `act_${createHash("sha256").update(`${input.userId}:${effectiveLogicalActionId}`).digest("hex").slice(0, 48)}`,
    userId: input.userId, provider: input.provider, tool: input.tool, argumentsHash, logicalActionId: effectiveLogicalActionId,
    ...(input.source?.kind ? { sourceKind: input.source.kind.slice(0, 80) } : {}),
    ...(input.source?.id ? { sourceId: input.source.id.slice(0, 240) } : {}),
    ...(input.source?.missionStepId ? { missionStepId: input.source.missionStepId.slice(0, 160) } : {}),
    ...(typeof input.args.account_alias === "string" ? { account: input.args.account_alias.slice(0, 160) } : {}),
    ...(input.source?.occurrenceId ? { occurrenceId: input.source.occurrenceId } : {}), status: "started", createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
  });
  await appendTraceEvent({ ownerId: input.userId, kind: "receipt", type: "external_action.started", at: Date.now(), correlationId: effectiveLogicalActionId, summary: `${input.tool} started through ${input.provider}.`, metadata: { provider: input.provider } }).catch(() => undefined);
  return { state: "new", receipt, logicalActionId: effectiveLogicalActionId };
}

export async function finishExternalAction(userId: number, logicalActionId: string, resultSummary: string, providerId?: string, providerActions: TrustedProviderAction[] = []): Promise<ExternalActionReceipt | undefined> {
  const normalizedProviderActions = providerActions.slice(0, 50).flatMap((action) => action && typeof action.toolSlug === "string" && typeof action.argumentsHash === "string"
    ? [{ toolSlug: action.toolSlug.slice(0, 180), argumentsHash: action.argumentsHash.slice(0, 128), ...(typeof action.index === "number" && Number.isSafeInteger(action.index) && action.index >= 0 ? { index: action.index } : {}) }]
    : []);
  const receipt = await updateExternalAction(userId, logicalActionId, { status: "succeeded", resultSummary: resultSummary.slice(0, 8_000), ...(providerId ? { providerId: providerId.slice(0, 240) } : {}), ...(normalizedProviderActions.length ? { providerActions: normalizedProviderActions } : {}), receiptVerification: "provider_response", verifiedAt: Date.now(), error: undefined });
  if (!receipt) {
    // Do not acknowledge the delivery claim when the success receipt itself
    // was not durably updated. Callers must surface an uncertain outcome.
    logger.error({ userId, logicalActionId }, "External action succeeded but its durable receipt was missing");
    return undefined;
  }
  await appendReliabilitySample({ ownerId: userId, operation: receipt?.tool ?? "external_action", status: "success", at: Date.now(), provider: receipt?.provider }).catch(() => undefined);
  await appendTraceEvent({ ownerId: userId, kind: "receipt", type: "external_action.succeeded", at: Date.now(), correlationId: logicalActionId, summary: `${receipt?.tool ?? "External action"} was confirmed by the provider.`, metadata: { providerId: providerId ?? null } }).catch(() => undefined);
  // This is the production trusted-evidence boundary: the provider/tool
  // execution returned successfully and Chusky has a durable receipt. The
  // model can request evidence, but it cannot manufacture this system proof.
  if (receipt?.sourceKind === "mission" && receipt.sourceId) {
    try {
      const recorded = await recordTrustedMissionEvidence(userId, receipt.sourceId, missionReceiptEvidence(receipt), receipt.missionStepId);
      if (!recorded) throw new Error("mission evidence target was unavailable or changed concurrently");
      await updateExternalAction(userId, logicalActionId, { missionEvidenceStatus: "persisted", missionEvidenceError: undefined });
    } catch (error) {
      // The external side effect already succeeded, so do not lie that it
      // failed. Make the missing proof immediately visible in the durable
      // receipt and structured logs so strict mission verification can be
      // repaired instead of silently appearing incomplete.
      await updateExternalAction(userId, logicalActionId, { missionEvidenceStatus: "failed", missionEvidenceError: "Trusted mission evidence could not be persisted." }).catch(() => undefined);
      logger.error({ userId, missionId: receipt.sourceId, receiptId: receipt.id, errorName: error instanceof Error ? error.name : "UnknownError" }, "Trusted mission evidence persistence failed after external action success");
    }
  }
  await completeDelivery(`autonomy:external-action:${userId}:${createHash("sha256").update(logicalActionId).digest("hex")}`, 365 * 24 * 60 * 60);
  return receipt;
}

export async function failExternalAction(userId: number, logicalActionId: string, error: string): Promise<void> {
  const receipt = await updateExternalAction(userId, logicalActionId, {
    status: "ambiguous",
    error: `The provider outcome is uncertain; verify the provider state before manually retrying. ${error}`.slice(0, 1_000),
  });
  if (receipt?.status === "succeeded") return;
  await appendReliabilitySample({ ownerId: userId, operation: receipt?.tool ?? "external_action", status: "uncertain", at: Date.now(), provider: receipt?.provider }).catch(() => undefined);
  await appendTraceEvent({ ownerId: userId, kind: "receipt", type: "external_action.ambiguous", at: Date.now(), correlationId: logicalActionId, status: "uncertain", summary: "External provider outcome is uncertain and has been quarantined.", metadata: { tool: receipt?.tool ?? "unknown" } }).catch(() => undefined);
  if (receipt?.sourceKind === "mission" && receipt.sourceId && receipt.missionStepId) {
    const mission = await getMission(userId, receipt.sourceId);
    const step = mission?.steps.find((candidate) => candidate.id === receipt.missionStepId);
    if (step?.compensationObjective) {
      await queueCompensation({ ownerId: userId, missionId: receipt.sourceId, missionStepId: receipt.missionStepId, originalActionId: receipt.id, provider: receipt.provider, objective: step.compensationObjective }).catch((compensationError) => logger.warn({ userId, missionId: receipt.sourceId, errorName: compensationError instanceof Error ? compensationError.name : "UnknownError" }, "Could not queue mission compensation"));
    }
  }
  await completeDelivery(`autonomy:external-action:${userId}:${createHash("sha256").update(logicalActionId).digest("hex")}`, 365 * 24 * 60 * 60);
}

/** Promote an ambiguous provider write only when a fresh read-back proves its expected state. */
export async function reconcileExternalActionByRead(input: { userId: number; logicalActionId: string; evidenceRef: string; summary: string; verifiedAt: number }): Promise<ExternalActionReceipt | undefined> {
  const current = await getExternalAction(input.userId, input.logicalActionId);
  if (!current || !["started", "ambiguous", "succeeded"].includes(current.status) || !input.evidenceRef.trim()) return undefined;
  const reconciled = await updateExternalAction(input.userId, input.logicalActionId, {
    status: "succeeded",
    resultSummary: input.summary.slice(0, 8_000),
    receiptVerification: "provider_read",
    receiptEvidenceRef: input.evidenceRef.slice(0, 500),
    verifiedAt: input.verifiedAt,
    error: undefined,
  });
  if (!reconciled) return undefined;
  await appendReliabilitySample({ ownerId: input.userId, operation: reconciled.tool, status: "success", at: input.verifiedAt, provider: reconciled.provider });
  await appendTraceEvent({ ownerId: input.userId, kind: "receipt", type: "external_action.reconciled", at: input.verifiedAt, correlationId: input.logicalActionId, status: "verified", summary: `${reconciled.tool} state was confirmed by a fresh provider read.`, metadata: { provider: reconciled.provider, evidenceRef: input.evidenceRef.slice(0, 500) } });
  if (reconciled.sourceKind === "mission" && reconciled.sourceId) {
    try {
      const recorded = await recordTrustedMissionEvidence(input.userId, reconciled.sourceId, [{
        id: `evidence_reconcile_${reconciled.id}_${createHash("sha256").update(input.evidenceRef).digest("hex").slice(0, 20)}`,
        kind: "before_after",
        summary: input.summary.slice(0, 2_000),
        source: reconciled.tool,
        ref: input.evidenceRef.slice(0, 500),
        hash: reconciled.argumentsHash,
        verified: true,
        verifiedBy: "system",
      }], reconciled.missionStepId);
      await updateExternalAction(input.userId, input.logicalActionId, { missionEvidenceStatus: recorded ? "persisted" : "failed", missionEvidenceError: recorded ? undefined : "Trusted mission evidence could not be persisted." });
    } catch (error) {
      await updateExternalAction(input.userId, input.logicalActionId, { missionEvidenceStatus: "failed", missionEvidenceError: "Trusted mission evidence could not be persisted." }).catch(() => undefined);
      logger.warn({ userId: input.userId, receiptId: reconciled.id, errorName: error instanceof Error ? error.name : "UnknownError" }, "Trusted mission evidence persistence failed after read-back reconciliation");
    }
  }
  await completeDelivery(`autonomy:external-action:${input.userId}:${createHash("sha256").update(input.logicalActionId).digest("hex")}`, 365 * 24 * 60 * 60);
  return reconciled;
}
