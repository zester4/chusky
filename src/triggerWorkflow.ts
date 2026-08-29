import { Client as WorkflowClient } from "@upstash/workflow";
import { config } from "./config.js";

export function triggerWorkflowUrl(): string {
  const url = config.triggerWorkflowUrl || `${config.webhookUrl.replace(/\/+$/, "")}/workflows/trigger-event`;
  if (!url || !/^https:\/\//i.test(url)) throw new Error("Trigger workflows require TRIGGER_WORKFLOW_URL or an HTTPS WEBHOOK_URL");
  return url;
}

export function workflowClient(): WorkflowClient {
  if (!config.qstashToken) throw new Error("QStash is not configured. Set QSTASH_TOKEN.");
  return new WorkflowClient({ token: config.qstashToken, baseUrl: config.qstashUrl || undefined });
}

export async function notifyTriggerApproval(approvalId: string, approved: boolean): Promise<void> {
  await workflowClient().notify({
    eventId: `trigger-approval:${approvalId}`,
    eventData: { approved },
  });
}
