import type { ChannelInboundEventRecord } from "./store.js";
import type { InboundMessage } from "./channels/contracts.js";

type SendblueWorkflowContext = {
  workflowRunId?: string;
  run<T>(stepName: string, fn: () => Promise<T>): Promise<T>;
};

type SendblueWorkflowDependencies = {
  getEvent(eventId: string): Promise<ChannelInboundEventRecord | undefined>;
  updateEvent(eventId: string, patch: Partial<ChannelInboundEventRecord>): Promise<ChannelInboundEventRecord | undefined>;
  hydrate(message: InboundMessage): Promise<InboundMessage>;
  process(message: InboundMessage): Promise<unknown>;
  recordFailure(error: unknown, context: Record<string, unknown>): void;
};

/**
 * Keep every stateful lookup and branch inside one durable Workflow step.
 * Workflow replays can arrive after delivery has completed; returning before
 * `workflow.run` then causes Upstash to reject the request as unauthenticated.
 */
export async function processSendblueWorkflow(
  workflow: SendblueWorkflowContext,
  eventId: string,
  dependencies: SendblueWorkflowDependencies,
): Promise<{ skipped: boolean }> {
  return workflow.run("process-sendblue-message", async () => {
    const event = await dependencies.getEvent(eventId);
    if (!event || event.provider !== "sendblue") throw new Error("Sendblue event is missing or invalid");
    if (event.status === "completed") return { skipped: true };
    try {
      await dependencies.updateEvent(event.eventId, { status: "running", workflowRunId: workflow.workflowRunId });
      const hydrated = await dependencies.hydrate(event.message);
      await dependencies.process(hydrated);
      await dependencies.updateEvent(event.eventId, { status: "completed" });
      return { skipped: false };
    } catch (error) {
      await dependencies.updateEvent(event.eventId, { status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
      dependencies.recordFailure(error, { workflow: "sendblue-event", eventId: event.eventId });
      throw error;
    }
  });
}
