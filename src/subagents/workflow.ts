import { Client as WorkflowClient } from "@upstash/workflow";
import { config } from "../config.js";
import { resolveWorkflowEndpoint } from "../workflowUrls.js";
import { getHandoffRecord, saveHandoffRecord } from "../store.js";
import { isComposioToolAllowedForWorker } from "./capabilities.js";

export const SUBAGENT_TOOL_WAIT_TIMEOUT = "24h";

export interface SubagentToolDecision {
  allowedComposioTools: string[];
}

export function subagentWorkflowUrl(): string {
  return resolveWorkflowEndpoint("", config.webhookUrl, "/workflows/subagent", "Subagent workflows");
}

function client(): WorkflowClient {
  if (!config.qstashToken) throw new Error("Durable subagent continuation requires QSTASH_TOKEN.");
  return new WorkflowClient({ token: config.qstashToken, baseUrl: config.qstashUrl || undefined });
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
  const toolRequestEventId = `subagent-tools:${handoffId}:${decisionNumber}`;
  await saveHandoffRecord(userId, { ...record, workflowRunId, toolRequestEventId });

  const queued = await client().trigger({
    url: subagentWorkflowUrl(),
    body: { userId, handoffId },
    workflowRunId,
    retries: 3,
  });
  const persistedWorkflowRunId = String(queued.workflowRunId ?? workflowRunId);
  if (persistedWorkflowRunId !== workflowRunId) {
    await saveHandoffRecord(userId, { ...record, workflowRunId: persistedWorkflowRunId, toolRequestEventId });
  }
  return { workflowRunId: persistedWorkflowRunId };
}

/** Notify exactly the waiting run. workflowRunId enables Upstash lookback and closes the notify-before-wait race. */
export async function resolveSubagentToolRequest(userId: number, handoffId: string, requestedTools: string[]): Promise<{ eventId: string; workflowRunId: string; allowedComposioTools: string[] }> {
  const record = await getHandoffRecord(userId, handoffId);
  if (!record || record.status !== "requires_tool_request" || !record.workflowRunId || !record.toolRequestEventId) {
    throw new Error("This worker run is not waiting for a durable tool decision.");
  }
  const allowedComposioTools = [...new Set(requestedTools.map((tool) => tool.trim()).filter(Boolean))];
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
