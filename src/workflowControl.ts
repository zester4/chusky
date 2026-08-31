import { WorkflowAbort } from "@upstash/workflow";

/**
 * Upstash uses this exception as normal control flow after a durable step has
 * been recorded. It is not an application failure and must reach the workflow
 * runtime unchanged so it can resume the replay on the next invocation.
 */
export function isWorkflowControlFlow(error: unknown): error is WorkflowAbort {
  return error instanceof WorkflowAbort;
}
