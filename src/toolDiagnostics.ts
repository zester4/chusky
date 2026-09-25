import { validateToolArgumentsAgainstSchema } from "./agentTools.js";
import { toolApprovalPolicy } from "./policy.js";

type ToolDefinition = { function?: { name?: unknown; parameters?: unknown }; name?: unknown; inputSchema?: unknown };
type AccountMetadata = { id: string; toolkit: string; status: string; alias?: string; updatedAt?: string };
type RunEvent = { id?: string; type: string; at?: number; data?: Record<string, unknown> };

function slugOf(tool: ToolDefinition): string {
  return String(tool.function?.name ?? tool.name ?? "");
}

/** Inspect the exact catalog shown to this model turn; never discover or grant tools. */
export function preflightToolCall(catalog: readonly unknown[] | undefined, requestedTool: string, args: Record<string, unknown>) {
  const toolName = requestedTool.trim();
  if (!catalog) return { tool: toolName, available: false, schemaAvailable: false, argumentsValid: null, approvalRequired: true, status: "unavailable" as const, message: "The current run's tool catalog is unavailable; no execution was attempted." };
  const tool = catalog.find((entry): entry is ToolDefinition => Boolean(entry && typeof entry === "object" && slugOf(entry as ToolDefinition) === toolName)) as ToolDefinition | undefined;
  if (!tool) return { tool: toolName, available: false, schemaAvailable: false, argumentsValid: null, approvalRequired: true, status: "unavailable" as const, message: "This exact tool is not in the current run's exposed/granted tool list. No execution was attempted." };
  const schema = tool.function?.parameters ?? tool.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { tool: toolName, available: true, schemaAvailable: false, argumentsValid: null, approvalRequired: toolApprovalPolicy(toolName, args) === "approval_required", status: "schema_unavailable" as const, message: "The tool is exposed, but no concrete input schema was advertised, so arguments cannot be safely prevalidated." };
  }
  try {
    validateToolArgumentsAgainstSchema(toolName, structuredClone(args), schema);
    const approvalRequired = toolApprovalPolicy(toolName, args) === "approval_required";
    return { tool: toolName, available: true, schemaAvailable: true, argumentsValid: true, approvalRequired, status: approvalRequired ? "approval_required" as const : "ready" as const, message: approvalRequired ? "Arguments match the advertised schema. The normal approval gate is still required; this check does not approve or execute the action." : "Arguments match the advertised schema. No tool was executed." };
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Arguments do not match the advertised schema.").slice(0, 500);
    return { tool: toolName, available: true, schemaAvailable: true, argumentsValid: false, approvalRequired: toolApprovalPolicy(toolName, args) === "approval_required", status: "invalid_arguments" as const, message };
  }
}

/** Provider-reported account status only; never implies that every app scope works. */
export function summarizeIntegrationHealth(accounts: readonly AccountMetadata[] | undefined, toolkit?: string) {
  if (!accounts) return { status: "unknown" as const, checkedAt: new Date().toISOString(), accounts: [], message: "Connected-account status could not be read; no live app action was attempted." };
  const normalizedToolkit = toolkit?.trim().toLowerCase();
  const matching = accounts.filter((account) => !normalizedToolkit || account.toolkit.toLowerCase() === normalizedToolkit).slice(0, 50);
  if (!matching.length) return { status: "not_connected" as const, checkedAt: new Date().toISOString(), toolkit: normalizedToolkit, accounts: [], message: "No matching connected account is available for this owner." };
  const mapped = matching.map((account) => {
    const raw = account.status.trim().toUpperCase();
    const status = ["ACTIVE", "CONNECTED", "READY", "AUTHORIZED"].includes(raw)
      ? "connected" as const
      : ["EXPIRED", "DISABLED", "REVOKED", "INACTIVE", "NEEDS_REAUTH", "ERROR", "FAILED"].includes(raw)
        ? "attention_required" as const
        : "unknown" as const;
    return { id: account.id, toolkit: account.toolkit, status, providerStatus: raw.slice(0, 48), ...(account.alias ? { alias: account.alias.slice(0, 120) } : {}), ...(account.updatedAt ? { updatedAt: account.updatedAt.slice(0, 40) } : {}) };
  });
  const overall = mapped.some((account) => account.status === "attention_required")
    ? "attention_required" as const
    : mapped.every((account) => account.status === "connected")
      ? "connected" as const
      : "unknown" as const;
  return { status: overall, checkedAt: new Date().toISOString(), toolkit: normalizedToolkit, accounts: mapped, message: overall === "connected" ? "Composio reports these account connections as active. This does not verify a particular action's scopes or provider-side health." : overall === "attention_required" ? "At least one connection needs attention. Reconnect it before retrying affected app actions." : "The provider returned an unrecognized status; treat this connection as unverified." };
}

/** Return a bounded recommendation from persisted run evidence; never replay the call. */
export function inspectToolRecovery(events: readonly RunEvent[], toolCallId?: string) {
  const results = events.filter((event) => event.type === "run.tool_result" && event.data && typeof event.data.callId === "string");
  const event = toolCallId
    ? [...results].reverse().find((candidate) => candidate.data?.callId === toolCallId)
    : [...results].reverse().find((candidate) => candidate.data?.ok === false);
  if (!event || !event.data) return { status: "not_found" as const, retryAdvice: "verify_first" as const, message: "No matching persisted tool result was found. Do not replay an action based only on this lookup." };
  const data = event.data;
  const ok = data.ok === true;
  const advice = ok ? "already_succeeded" as const : data.retrySafety === "safe_retry" ? "safe_retry" as const : "verify_first" as const;
  return {
    status: ok ? "succeeded" as const : "failed" as const,
    tool: typeof data.tool === "string" ? data.tool.slice(0, 160) : "unknown",
    toolCallId: String(data.callId).slice(0, 200),
    ...(typeof data.failureClass === "string" ? { failureClass: data.failureClass.slice(0, 64) } : {}),
    retryAdvice: advice,
    ...(typeof event.at === "number" ? { recordedAt: new Date(event.at).toISOString() } : {}),
    message: ok ? "The persisted run records this tool call as successful. Do not repeat it." : advice === "safe_retry" ? "The run failed before dispatch, so the call may be corrected and retried. This tool does not retry it." : "The action may have reached its executor. Verify external state before any retry; this tool does not replay it.",
  };
}
