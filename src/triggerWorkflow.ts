import { Client as WorkflowClient } from "@upstash/workflow";
import { config } from "./config.js";
import { getTriggerEvent } from "./store.js";
import { resolveWorkflowEndpoint } from "./workflowUrls.js";

export { resolveWorkflowEndpoint } from "./workflowUrls.js";

export function triggerWorkflowUrl(): string {
  return resolveWorkflowEndpoint(config.triggerWorkflowUrl, config.webhookUrl, "/workflows/trigger-event", "Trigger workflows");
}

export function workflowClient(): WorkflowClient {
  if (!config.qstashToken) throw new Error("QStash is not configured. Set QSTASH_TOKEN.");
  return new WorkflowClient({ token: config.qstashToken, baseUrl: config.qstashUrl || undefined });
}

export function workflowFailureUrl(): string | undefined {
  if (!config.webhookUrl || !config.qstashCurrentSigningKey || !config.qstashNextSigningKey) return undefined;
  return `${config.webhookUrl.replace(/\/+$/, "")}/workflows/failure`;
}

export async function enqueueTaskWorkflow(userId: number, taskId: string, runAt = Date.now()): Promise<string> {
  if (!config.webhookUrl) throw new Error("Task scheduling requires WEBHOOK_URL and QStash configuration");
  const workflow = await workflowClient().trigger({
    url: `${config.webhookUrl.replace(/\/+$/, "")}/workflows/task`,
    body: { taskId, userId },
    delay: Math.max(1, Math.ceil((runAt - Date.now()) / 1000)),
    workflowRunId: `task-${taskId}-${runAt}`,
    retries: 3,
    retryDelay: "1000 * (1 + retried)",
    ...(workflowFailureUrl() ? { failureUrl: workflowFailureUrl() } : {}),
    flowControl: { key: `chusky-task-user-${userId}`, parallelism: 1, rate: 1, period: "1s" },
  });
  return workflow.workflowRunId;
}

export async function notifyTriggerApproval(approvalId: string, approved: boolean, triggerEventId?: string): Promise<void> {
  const event = triggerEventId ? await getTriggerEvent(triggerEventId) : undefined;
  await workflowClient().notify({
    eventId: `trigger-approval:${approvalId}`,
    eventData: { approved },
    ...(event?.workflowRunId ? { workflowRunId: event.workflowRunId } : {}),
  });
}
