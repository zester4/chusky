import { Client as WorkflowClient } from "@upstash/workflow";
import { config } from "./config.js";
import { getTriggerEvent } from "./store.js";
import { resolveWorkflowEndpoint } from "./workflowUrls.js";
import { workflowEventId } from "./workflowIds.js";
import { createHash } from "node:crypto";

export { resolveWorkflowEndpoint } from "./workflowUrls.js";

// v3 moves the long-running agent execution behind WorkflowContext.call. Keep
// v2 and legacy graphs readable so an already queued workflow can replay its
// original durable steps without a step-name or ordering mismatch.
export const TRIGGER_WORKFLOW_VERSION = 3 as const;

export type TriggerWorkflowVersion = "legacy" | "v2" | "v3";

export function triggerWorkflowVersionForPayload(version: unknown): TriggerWorkflowVersion {
  if (version === undefined) return "legacy";
  if (version === 2) return "v2";
  if (version === TRIGGER_WORKFLOW_VERSION) return "v3";
  throw new Error("Unsupported trigger workflow version.");
}

export function parseWorkflowFailureRequestPayload(body: Record<string, unknown>): Record<string, unknown> {
  const parse = (value: unknown): Record<string, unknown> | undefined => {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value !== "string" || value.length > 128_000) return undefined;
    const candidates = [value];
    try { candidates.push(Buffer.from(value, "base64").toString("utf8")); } catch { /* not base64 */ }
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch { /* try the other supported QStash payload encoding */ }
    }
    return undefined;
  };
  return parse(body.sourceBody) ?? parse(body.requestPayload) ?? parse(body.body) ?? body;
}

export function triggerWorkflowUrl(): string {
  return resolveWorkflowEndpoint(config.triggerWorkflowUrl, config.webhookUrl, "/workflows/trigger-event", "Trigger workflows");
}

/** Public callback used by QStash for the long-running trigger agent step. */
export function triggerAgentWorkflowUrl(): string {
  return resolveWorkflowEndpoint(config.triggerAgentWorkflowUrl, config.webhookUrl, "/internal/workflows/trigger-agent", "Trigger agent workflows");
}

/** Stable across QStash retries so a timed-out call can resume the same run. */
export function triggerAgentWorkflowRunId(eventId: string): string {
  return `trigger-agent-${eventId}`;
}

export function workflowClient(): WorkflowClient {
  if (!config.qstashToken) throw new Error("QStash is not configured. Set QSTASH_TOKEN.");
  return new WorkflowClient({ token: config.qstashToken, baseUrl: config.qstashUrl || undefined });
}

export function workflowFailureUrl(): string | undefined {
  if (!config.webhookUrl || !config.qstashCurrentSigningKey || !config.qstashNextSigningKey) return undefined;
  return `${config.webhookUrl.replace(/\/+$/, "")}/workflows/failure`;
}

/**
 * Stable provider idempotency key for a task publication. If the database
 * write after a QStash accept fails, recovery republishes the same task and
 * runAt with this exact key instead of creating a second workflow.
 */
export function taskWorkflowRunId(taskId: string, runAt: number): string {
  return `task-${taskId}-${runAt}`;
}

export async function enqueueTaskWorkflow(userId: number, taskId: string, runAt = Date.now()): Promise<string> {
  if (!config.webhookUrl) throw new Error("Task scheduling requires WEBHOOK_URL and QStash configuration");
  const workflow = await workflowClient().trigger({
    url: `${config.webhookUrl.replace(/\/+$/, "")}/workflows/task`,
    body: { taskId, userId },
    delay: Math.max(1, Math.ceil((runAt - Date.now()) / 1000)),
    workflowRunId: taskWorkflowRunId(taskId, runAt),
    retries: 3,
    retryDelay: "1000 * (1 + retried)",
    ...(workflowFailureUrl() ? { failureUrl: workflowFailureUrl() } : {}),
    flowControl: { key: `chusky-task-user-${userId}`, parallelism: 1, rate: 1, period: "1s" },
  });
  return workflow.workflowRunId;
}

export async function enqueueTinyFishResearchWorkflow(userId: number, runRecordId: string): Promise<string> {
  if (!config.webhookUrl) throw new Error("Background TinyFish Research requires WEBHOOK_URL and QStash configuration.");
  const stable = createHash("sha256").update(`${userId}:${runRecordId}`).digest("hex").slice(0, 40);
  const workflow = await workflowClient().trigger({
    url: `${config.webhookUrl.replace(/\/+$/, "")}/workflows/tinyfish-research`,
    body: { userId, runRecordId },
    workflowRunId: `tinyfish-research-${stable}`,
    retries: 3,
    retryDelay: "1000 * (1 + retried)",
    ...(workflowFailureUrl() ? { failureUrl: workflowFailureUrl() } : {}),
    flowControl: { key: `chusky-tinyfish-research-user-${userId}`, parallelism: 2, rate: 2, period: "1s" },
  });
  return workflow.workflowRunId;
}

/** Resume one waiting autonomous occurrence immediately after its approval. */
export async function enqueueAutonomyApprovalResume(input: { userId: number; kind: "reminder" | "job"; sourceId: string; occurrenceId?: string; approvalId: string }): Promise<string> {
  if (!config.webhookUrl) throw new Error("Autonomous approval resume requires WEBHOOK_URL and QStash configuration");
  const path = input.kind === "reminder" ? "/workflows/reminder" : "/workflows/job";
  const body = input.kind === "reminder"
    ? { reminderId: input.sourceId, userId: input.userId, approvalId: input.approvalId }
    : { jobId: input.sourceId, userId: input.userId, occurrenceId: input.occurrenceId, approvalId: input.approvalId };
  const workflow = await workflowClient().trigger({
    url: `${config.webhookUrl.replace(/\/+$/, "")}${path}`,
    body,
    delay: 1,
    workflowRunId: `autonomy-approval-${input.approvalId}`,
    retries: 3,
    retryDelay: "1000 * (1 + retried)",
    ...(workflowFailureUrl() ? { failureUrl: workflowFailureUrl() } : {}),
    flowControl: { key: `chusky-autonomy-user-${input.userId}`, parallelism: 1, rate: 1, period: "1s" },
  });
  return workflow.workflowRunId;
}

export async function notifyTriggerApproval(approvalId: string, approved: boolean, triggerEventId?: string): Promise<void> {
  const event = triggerEventId ? await getTriggerEvent(triggerEventId) : undefined;
  // Trigger publications use this deterministic workflowRunId. Keeping the
  // fallback here closes the small race where the approval callback reads the
  // event before the workflow's first checkpoint has persisted its ID.
  const workflowRunId = event?.workflowRunId ?? (triggerEventId ? `trigger-${triggerEventId}` : undefined);
  await workflowClient().notify({
    eventId: workflowEventId("trigger-approval", approvalId),
    eventData: { approved },
    ...(workflowRunId ? { workflowRunId } : {}),
  });
}
