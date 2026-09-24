import { Client as WorkflowClient } from "@upstash/workflow";
import { config } from "../config.js";
import { resolveWorkflowEndpoint } from "../workflowUrls.js";
import { isValidWorkflowEventId, workflowEventId } from "../workflowIds.js";
import { getHandoffRecord, saveHandoffRecord } from "../store.js";
import { isComposioToolAllowedForWorker, normalizeDelegationToolScopes, WORKER_CAPABILITIES } from "./capabilities.js";

export const SUBAGENT_TOOL_WAIT_TIMEOUT = "24h";

export interface SubagentToolDecision {
  allowedComposioTools: string[];
}

/** Queue the next bounded execution slice for a durable worker goal. */
export async function enqueueSubagentContinuation(userId: number, handoffId: string): Promise<{ workflowRunId: string }> {
  const record = await getHandoffRecord(userId, handoffId);
  if (!record || record.status !== "queued" || !record.taskId || !record.delegation?.budgetSeconds) {
    throw new Error("Only a queued durable worker run can be continued.");
  }
  const count = (record.delegation.continuationCount ?? 0) + 1;
  const workflowRunId = `subagent-run-${handoffId}-${count}`;
  await saveHandoffRecord(userId, {
    ...record,
    workflowRunId,
    delegation: { ...record.delegation, continuationCount: count },
  });
  const queued = await client().trigger({ url: subagentWorkflowUrl(), body: { userId, handoffId, mode: "continue" }, workflowRunId, retries: 3 });
  return { workflowRunId: String(queued.workflowRunId ?? workflowRunId) };
}

export function subagentWorkflowUrl(): string {
  return resolveWorkflowEndpoint("", config.webhookUrl, "/workflows/subagent", "Subagent workflows");
}

function client(): WorkflowClient {
  if (!config.qstashToken) throw new Error("Durable subagent continuation requires QSTASH_TOKEN.");
  return new WorkflowClient({ token: config.qstashToken, baseUrl: config.qstashUrl || undefined });
}

/** Cancel the durable Upstash run as well as the local worker signal. */
export async function cancelSubagentWorkflow(workflowRunId: string): Promise<boolean> {
  if (!workflowRunId.trim() || !config.qstashToken) return false;
  await client().cancel({ ids: workflowRunId });
  return true;
}

/** Start a durable waiter only after a worker has already stopped at a safe tool-request boundary. */
export async function enqueueSubagentToolContinuation(userId: number, handoffId: string): Promise<{ workflowRunId: string }> {
  const record = await getHandoffRecord(userId, handoffId);
  if (!record || record.status !== "requires_tool_request" || !record.taskId) {
    throw new Error("Only an owned worker run awaiting an additional-tool decision can be continued.");
  }
  // Persist these identifiers before triggering. A supervisor can legitimately
  // resolve the request immediately; workflowRunId makes Upstash retain that
  // notification until waitForEvent reaches the matching checkpoint.
  const decisionNumber = (record.resumeCount ?? 0) + 1;
  const workflowRunId = `subagent-tools-${handoffId}-${decisionNumber}`;
  const toolRequestEventId = workflowEventId("subagent-tools", handoffId, decisionNumber);
  await saveHandoffRecord(userId, { ...record, workflowRunId, toolRequestEventId });

  let queued: { workflowRunId: string };
  try {
    queued = await client().trigger({
      url: subagentWorkflowUrl(),
      body: { userId, handoffId },
      workflowRunId,
      retries: 3,
    });
  } catch (error) {
    // Do not leave a persisted waiter identity that looks runnable after the
    // trigger failed. A supervisor retry can safely publish the same run ID.
    const current = await getHandoffRecord(userId, handoffId);
    if (current?.workflowRunId === workflowRunId && current.toolRequestEventId === toolRequestEventId) {
      const withoutWaiter = { ...current };
      delete withoutWaiter.workflowRunId;
      delete withoutWaiter.toolRequestEventId;
      await saveHandoffRecord(userId, withoutWaiter);
    }
    throw error;
  }
  const persistedWorkflowRunId = String(queued.workflowRunId ?? workflowRunId);
  if (persistedWorkflowRunId !== workflowRunId) {
    await saveHandoffRecord(userId, { ...record, workflowRunId: persistedWorkflowRunId, toolRequestEventId });
  }
  return { workflowRunId: persistedWorkflowRunId };
}

/** Notify exactly the waiting run. workflowRunId enables Upstash lookback and closes the notify-before-wait race. */
export async function resolveSubagentToolRequest(userId: number, handoffId: string, requestedTools: string[]): Promise<{ eventId: string; workflowRunId: string; allowedComposioTools: string[] }> {
  let record = await getHandoffRecord(userId, handoffId);
  if (!record || record.status !== "requires_tool_request" || !record.taskId) {
    throw new Error("This worker run is not waiting for a durable tool decision.");
  }
  if (!record.workflowRunId || !record.toolRequestEventId) {
    await enqueueSubagentToolContinuation(userId, handoffId);
    record = await getHandoffRecord(userId, handoffId);
    if (!record?.workflowRunId || !record.toolRequestEventId) throw new Error("The worker decision waiter could not be queued. Retry after the workflow service recovers.");
  }
  // Repair records created by older builds that used ':' in the event ID.
  // Upstash rejects those IDs before the waiter can resume, so queue a fresh
  // safe waiter and notify that new event instead of leaving the handoff stuck.
  if (!isValidWorkflowEventId(record.toolRequestEventId)) {
    await enqueueSubagentToolContinuation(userId, handoffId);
    record = await getHandoffRecord(userId, handoffId);
    if (!record || !record.workflowRunId || !record.toolRequestEventId || !isValidWorkflowEventId(record.toolRequestEventId)) {
      throw new Error("This worker run has a stale workflow decision and could not be repaired. Retry the worker task.");
    }
  }
  const starter = WORKER_CAPABILITIES[record.to].starterComposioTools ?? [];
  const existing = record.delegation?.allowedComposioTools ?? [];
  const normalized = normalizeDelegationToolScopes({ allowedComposioTools: [...existing, ...requestedTools] });
  const allowedComposioTools = [...new Set([...starter, ...(normalized.allowedComposioTools ?? [])].map((tool) => tool.trim()).filter(Boolean))];
  if (!allowedComposioTools.length) throw new Error("Select at least one exact Composio tool slug discovered by Chusky.");
  const invalid = allowedComposioTools.filter((tool) => !isComposioToolAllowedForWorker(record.to, tool));
  if (invalid.length) throw new Error(`Requested Composio tool(s) are outside ${record.to}'s permitted integration family: ${invalid.join(", ")}`);
  await client().notify({
    eventId: record.toolRequestEventId,
    eventData: { allowedComposioTools } satisfies SubagentToolDecision,
    workflowRunId: record.workflowRunId,
  });
  return { eventId: record.toolRequestEventId, workflowRunId: record.workflowRunId, allowedComposioTools };
}
