import { randomUUID } from "node:crypto";
import { WORKER_CAPABILITIES, isComposioToolAllowedForWorker, normalizeDelegationToolScopes, validateDelegationTarget } from "./capabilities.js";
import { cancelSubagentWorkflow, enqueueSubagentContinuation } from "./workflow.js";
import { memoryRouter } from "../memory/router.js";
import { nativeTool } from "../nativeTools.js";
import { chuckTools, validateNativeToolArguments } from "../agentTools.js";
import { requiresToolApproval, isRiskyToolSlug, isReadOnlyToolSlug, humanToolStatus } from "../policy.js";
import { createApproval, getSession, getTask, getHandoffRecord, saveHandoffRecord, claimHandoffBudget, createTask, checkpointTask, completeTask, blockTask, updateTask, setApprovalStatus, getAgentRun, saveAgentRun, requestTaskCancellation, finalizeTaskCancellation, type AgentRunRecord } from "../store.js";
import { config } from "../config.js";
import { getScopedComposioTools, orChat, parseToolArguments, cleanModelText, UnavailableComposioToolsError } from "../agent.js";
import type { ApiMessage } from "../types.js";
import type { CapabilityWorkerName } from "../memory/types.js";
import type { ReplyTarget } from "../channels/contracts.js";
import { skillContextForBinding } from "../skills/catalog.js";
import { WORKER_DURATION_SECONDS, type DelegationContract, type DelegationResult, type DelegationStatus, type HandoffRecord, type WorkerDuration } from "./contracts.js";
import { CancellationError, isCancellationError, safeToolAudit, throwIfAborted } from "../cancellation.js";

const DELEGATION_STATUS_PREVIEW_LENGTH = 160;
const activeWorkerControllers = new Map<string, AbortController>();
let workerChat = orChat;
let scopedToolsForWorker = getScopedComposioTools;

/** Replace external inference/provider boundaries in deterministic unit tests. */
export function setSubagentExecutorDependenciesForTests(overrides?: {
  chat?: typeof orChat;
  getScopedComposioTools?: typeof getScopedComposioTools;
}): void {
  workerChat = overrides?.chat ?? orChat;
  scopedToolsForWorker = overrides?.getScopedComposioTools ?? getScopedComposioTools;
}

/** Request both local interruption and durable Upstash cancellation. */
export async function requestDelegationCancellation(userId: number, handoffId: string, reason = "Worker cancellation requested by the user."): Promise<HandoffRecord | undefined> {
  const record = await getHandoffRecord(userId, handoffId);
  if (!record) return undefined;
  if (["success", "failed", "timed_out", "max_tool_calls_exceeded", "fallback_executed", "cancelled", "interrupted"].includes(record.status)) return undefined;
  if (record.taskId) await requestTaskCancellation(userId, record.taskId, reason);
  activeWorkerControllers.get(handoffId)?.abort(new CancellationError(reason));
  if (record.workflowRunId) {
    try { await cancelSubagentWorkflow(record.workflowRunId); } catch { /* local cancellation remains authoritative */ }
  }
  const updated = { ...record, status: "cancel_requested" as const };
  await saveHandoffRecord(userId, updated);
  return updated;
}

/**
 * User-facing handoff text. Keep this limited to the task objective—not the
 * worker system prompt, tools, memories, or hidden execution context.
 */
export function delegationStartedStatus(displayName: string, objective: string): string {
  const compactObjective = objective.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  const preview = compactObjective.length > DELEGATION_STATUS_PREVIEW_LENGTH
    ? `${compactObjective.slice(0, DELEGATION_STATUS_PREVIEW_LENGTH - 1).trimEnd()}…`
    : compactObjective;
  return `🤝 Delegated to ${displayName}\nTask: ${preview || "Specialist task"}`;
}

export async function executeDelegation(
  userId: number,
  contractInput: Partial<DelegationContract> & { worker: CapabilityWorkerName; objective: string },
  options?: {
    model?: string;
    onStatus?: (statusText: string) => Promise<void> | void;
    approvedApprovalId?: string;
    signal?: AbortSignal;
    historySummary?: string;
    deliveryTarget?: ReplyTarget;
    parentHandoffId?: string;
    parentWorker?: CapabilityWorkerName;
    delegationDepth?: number;
    rootHandoffId?: string;
    resume?: { handoffId: string; taskId: string; workflowRunId?: string; resumeCount?: number };
  }
): Promise<DelegationResult> {
  const startTime = Date.now();
  const workerName = contractInput.worker;
  const manifest = WORKER_CAPABILITIES[workerName];

  if (!manifest) {
    throw new Error(`Unknown capability worker: ${workerName}`);
  }
  if (workerName === "chusky") {
    throw new Error("Subagent delegation must target a specialist worker, not the Chusky supervisor.");
  }

  // Normalize known external vocabulary before enforcing Chusky's strict
  // native-vs-Composio contract boundary. Unknown names remain untouched and
  // are rejected by the existing manifest checks below.
  const normalizedScopes = normalizeDelegationToolScopes(contractInput);
  contractInput = { ...contractInput, ...normalizedScopes };

  // Reject invalid requested tools that are not in the manifest allowlist
  if (contractInput.allowedTools && contractInput.allowedTools.length > 0) {
    const invalidTools = contractInput.allowedTools.filter((tool) => !manifest.allowedTools.includes(tool));
    if (invalidTools.length > 0) {
      throw new Error(`Invalid delegation contract: Tool(s) [${invalidTools.join(", ")}] are not permitted for worker capability '${workerName}' manifest allowlist.`);
    }
  }
  const starterComposioTools = manifest.starterComposioTools ?? [];
  if (contractInput.allowedComposioTools && contractInput.allowedComposioTools.length > 0) {
    const invalidTools = contractInput.allowedComposioTools.filter((tool) =>
      !starterComposioTools.includes(tool) && !isComposioToolAllowedForWorker(workerName, tool)
    );
    if (invalidTools.length > 0) {
      throw new Error(`Invalid delegation contract: Composio tool(s) [${invalidTools.join(", ")}] are not permitted for worker capability '${workerName}'. Select only an exact action from its approved toolkit family.`);
    }
  }

  // A durable continuation reuses the already-validated handoff contract.
  // Its persisted manifest-wide tool list is not a new routing hint; treating
  // it as one can falsely classify a resumed worker as a mixed objective.
  validateDelegationTarget(workerName, contractInput.objective, options?.resume ? [] : contractInput.allowedTools ?? []);

  const duration = (contractInput.duration && contractInput.duration in WORKER_DURATION_SECONDS ? contractInput.duration : "30m") as WorkerDuration;
  const budgetSeconds = Math.max(WORKER_DURATION_SECONDS["5m"], Math.min(WORKER_DURATION_SECONDS["1w"], contractInput.budgetSeconds ?? WORKER_DURATION_SECONDS[duration]));
  const requestedTotalToolCalls = contractInput.maxTotalToolCalls;
  const maxTotalToolCalls = Number.isFinite(requestedTotalToolCalls)
    ? Math.max(1, Math.min(1000, Math.floor(requestedTotalToolCalls!)))
    : 200;
  const existingHandoff = options?.resume ? await getHandoffRecord(userId, options.resume.handoffId) : undefined;
  if (options?.resume && !existingHandoff) throw new Error("The durable handoff record for this worker continuation no longer exists or is not owned by the user.");
  const startedAt = existingHandoff?.delegation?.startedAt ?? Date.now();
  const existingRun = existingHandoff?.delegation?.runId ? await getAgentRun(userId, existingHandoff.delegation.runId) : undefined;

  // Inherit model from options/contract or fallback to default
  const model = options?.model || contractInput.model || config.defaultModel;

  // Sanitize contract with strict defaults
  const contract: DelegationContract = {
    id: contractInput.id ?? randomUUID(),
    supervisor: "chusky",
    worker: workerName,
    objective: contractInput.objective,
    model,
    // Starter actions are exact, role-scoped slugs from Context7/Composio
    // documentation. They are optional at runtime when the corresponding app
    // is not connected; explicitly delegated actions remain required.
    allowedComposioTools: [...new Set([...starterComposioTools, ...(contractInput.allowedComposioTools ?? [])].map((tool) => tool.trim()).filter(Boolean))],
    allowedTools: (contractInput.allowedTools ?? manifest.allowedTools).filter((tool) =>
      manifest.allowedTools.includes(tool) && !((options?.delegationDepth ?? 0) >= 1 && tool === "CHUCK_HANDOFF_SUBAGENT")
    ),
    context: contractInput.context ?? {},
    expectedOutput: contractInput.expectedOutput ?? "Summary of executed task and outcomes.",
    approvalPolicy: contractInput.approvalPolicy ?? "auto",
    timeoutSeconds: Math.max(5, Math.min(300, contractInput.timeoutSeconds ?? 60)),
    maxToolCalls: Math.max(0, Math.min(100, contractInput.maxToolCalls ?? 40)),
    duration,
    budgetSeconds,
    maxTotalToolCalls,
  };

  // 1. Durable Task Linkage. A workflow continuation reuses the original task
  // and handoff record instead of creating a second, unrelated worker run.
  const durableTask = options?.resume
    ? await getTask(userId, options.resume.taskId)
    : await createTask(userId, {
        title: `[${manifest.displayName}] ${contract.objective.slice(0, 80)}`,
        objective: contract.objective,
      });
  if (!durableTask) throw new Error("The durable task for this worker continuation no longer exists or is not owned by the user.");

  // 2. Persistent Handoff Record
  const handoffRecord: HandoffRecord = existingHandoff ?? {
    id: `handoff_${randomUUID()}`,
    from: options?.parentWorker ?? "chusky",
    to: workerName,
    objective: contract.objective,
    context: contract.context ?? {},
    expectedOutput: contract.expectedOutput,
    timestamp: Date.now(),
    status: "queued",
    ...(options?.parentHandoffId ? { parentHandoffId: options.parentHandoffId } : {}),
    ...(options?.rootHandoffId ? { rootHandoffId: options.rootHandoffId } : {}),
    delegationDepth: options?.delegationDepth ?? 0,
    taskId: durableTask.id,
  };
  handoffRecord.rootHandoffId ??= options?.rootHandoffId ?? handoffRecord.id;
  handoffRecord.delegation = {
    runId: existingRun?.id ?? existingHandoff?.delegation?.runId ?? `run_${randomUUID()}`,
    model,
    allowedTools: contract.allowedTools,
    allowedComposioTools: contract.allowedComposioTools,
    approvalPolicy: contract.approvalPolicy,
    timeoutSeconds: contract.timeoutSeconds,
    maxToolCalls: contract.maxToolCalls,
    duration: contract.duration,
    budgetSeconds: contract.budgetSeconds,
    maxTotalToolCalls: existingHandoff?.delegation?.maxTotalToolCalls ?? maxTotalToolCalls,
    maxPeerHandoffs: existingHandoff?.delegation?.maxPeerHandoffs ?? 1,
    sharedToolCallsUsed: existingHandoff?.delegation?.sharedToolCallsUsed ?? 0,
    peerHandoffsUsed: existingHandoff?.delegation?.peerHandoffsUsed ?? 0,
    startedAt,
    continuationCount: existingHandoff?.delegation?.continuationCount ?? 0,
  };
  if (options?.resume?.workflowRunId) handoffRecord.workflowRunId = options.resume.workflowRunId;
  if (options?.resume?.resumeCount !== undefined) handoffRecord.resumeCount = options.resume.resumeCount;
  await saveHandoffRecord(userId, handoffRecord);

  // Active timeout cancellation signal combined with parent signal
  const timeoutSignal = AbortSignal.timeout(contract.timeoutSeconds * 1000);
  const workerController = new AbortController();
  activeWorkerControllers.set(handoffRecord.id, workerController);
  const activeSignal = AbortSignal.any([timeoutSignal, workerController.signal, ...(options?.signal ? [options.signal] : [])]);

  const logs: DelegationResult["toolCallsLog"] = [];
  const cancellationCleanups: Array<() => Promise<void>> = [];
  const runCancellationCleanups = async (): Promise<void> => {
    await Promise.allSettled(cancellationCleanups.splice(0).map((cleanup) => cleanup()));
  };
  const registerCancellationCleanup = (cleanup: () => Promise<void>): void => {
    if (activeSignal.aborted) void cleanup().catch(() => undefined);
    else cancellationCleanups.push(cleanup);
  };
  let toolCallsCount = 0;
  let status: DelegationStatus = "success";
  let outputSummary = "";
  let proposal: DelegationResult["proposal"] | undefined;
  let approvalId: string | undefined;
  let toolRequest: DelegationResult["toolRequest"] | undefined;
  let sharedBudgetExhausted = false;

  // The shared status callback is used by every channel. Make the selected
  // specialist and a bounded preview visible before any worker work begins.
  if (options?.onStatus) {
    await options.onStatus(delegationStartedStatus(manifest.displayName, contract.objective));
  }

  // Retrieve capability-scoped memories from shared Memory Router
  const scopedMemories = await memoryRouter.queryScopedMemories(userId, workerName, {
    query: contract.objective,
    limit: 5,
  });

  const memorySnippet = scopedMemories.length
    ? `Domain Scoped Memory:\n${scopedMemories.map((m) => `- [${m.category}] ${m.key}: ${m.value}`).join("\n")}`
    : "No relevant domain memories retrieved.";

  // Filter available tools to strictly match the native + provider boundaries.
  // Composio actions are resolved only when a supervisor explicitly selected
  // exact slugs for this run; workers never inherit the full provider catalogue.
  const nativeWorkerTools = chuckTools.filter((t) => contract.allowedTools.includes(t.function.name));
  const allowedToolNames = new Set([...contract.allowedTools, ...contract.allowedComposioTools]);

  // Determine if context contains an explicit tool call payload
  const actionPayload = contract.context?.toolCall as { name: string; args: Record<string, unknown> } | undefined;

  // Determine if we are running in an environment with API keys for LLM completions
  const canRunModel = Boolean(config.openRouterApiKey && config.openRouterApiKey !== "mock-key");

  try {
    // Native-only contract tests and fallback summaries do not need a live
    // Composio session. Avoid contacting the provider unless the worker model
    // or an explicit Composio action actually requires it.
    const needsComposio = (canRunModel && contract.allowedComposioTools.length > 0) || Boolean(actionPayload && !actionPayload.name.startsWith("CHUCK_"));
    const scopedComposio = needsComposio
      ? await scopedToolsForWorker(userId, contract.allowedComposioTools, { optionalSlugs: starterComposioTools, objective: contract.objective })
      : { tools: [], missing: starterComposioTools, execute: async () => { throw new Error("No Composio action was delegated to this worker."); } };
    const workerTools = [...nativeWorkerTools, ...scopedComposio.tools];
    if (actionPayload) {
      // ── Explicit Tool Call Execution (Direct Action Payload) ────────────────
      if (!allowedToolNames.has(actionPayload.name)) {
        status = "failed";
        outputSummary = `Security boundary error: Tool ${actionPayload.name} is not permitted for worker capability ${workerName}.`;
        logs.push(safeToolAudit({ tool: actionPayload.name, args: actionPayload.args, userId, runId: handoffRecord.delegation.runId, status: "failed", error: `Tool access denied for worker capability ${workerName}` }));
      } else if (actionPayload.name === "CHUCK_REQUEST_ADDITIONAL_TOOLS") {
        toolCallsCount++;
        if (toolCallsCount > contract.maxToolCalls) {
          status = "max_tool_calls_exceeded";
          outputSummary = `Worker capability ${workerName} exceeded max tool call limit (${contract.maxToolCalls}).`;
        } else if (!(await claimHandoffBudget(userId, handoffRecord.rootHandoffId!, "tool"))) {
          sharedBudgetExhausted = true;
          status = "max_tool_calls_exceeded";
          outputSummary = `The shared delegation tree exceeded its total tool-call limit (${handoffRecord.delegation.maxTotalToolCalls}).`;
        } else {
          toolRequest = {
            intent: String(actionPayload.args.intent ?? "").trim(),
            reason: String(actionPayload.args.reason ?? "").trim(),
            preferredToolkit: actionPayload.args.preferredToolkit ? String(actionPayload.args.preferredToolkit).trim() : undefined,
          };
          if (!toolRequest.intent || !toolRequest.reason) {
          status = "failed";
          outputSummary = "A worker tool request requires both intent and reason.";
          } else {
            status = "requires_tool_request";
            outputSummary = `${manifest.displayName} requested an additional capability: ${toolRequest.intent}. Reason: ${toolRequest.reason}`;
            await blockTask(userId, durableTask.id, outputSummary, "Awaiting Chusky tool discovery and scoped re-delegation");
            logs.push(safeToolAudit({ tool: actionPayload.name, args: actionPayload.args, userId, runId: handoffRecord.delegation.runId, status: "completed", requested: true }));
          }
        }
      } else {
        toolCallsCount++;
        if (toolCallsCount > contract.maxToolCalls) {
          status = "max_tool_calls_exceeded";
          outputSummary = `Worker capability ${workerName} exceeded max tool call limit (${contract.maxToolCalls}).`;
        } else if (!(await claimHandoffBudget(userId, handoffRecord.rootHandoffId!, "tool"))) {
          sharedBudgetExhausted = true;
          status = "max_tool_calls_exceeded";
          outputSummary = `The shared delegation tree exceeded its total tool-call limit (${handoffRecord.delegation.maxTotalToolCalls}).`;
        } else {
          const approved = options?.approvedApprovalId
            ? await getSession(userId).then((s) =>
                s.approvals.find(
                  (a) => a.id === options.approvedApprovalId && a.status === "approved" && a.expiresAt > Date.now()
                )
              )
            : undefined;

          const approvedForTool = approved?.toolSlug === actionPayload.name;
          const executionArgs = approvedForTool ? approved.args : actionPayload.args;
          const isReadOnly = isReadOnlyToolSlug(actionPayload.name);
          const requiresApproval = !approvedForTool && requiresToolApproval(
            actionPayload.name,
            executionArgs,
            !isReadOnly && contract.approvalPolicy === "require_chusky_approval",
          );

          if (requiresApproval) {
            // Create store approval record BEFORE execution!
            const approvalRecord = await createApproval({
              userId,
              toolSlug: actionPayload.name,
              args: executionArgs,
              request: `Worker capability ${manifest.displayName} requested execution of ${actionPayload.name}`,
              history: [],
              model,
              handoffId: handoffRecord.id,
            });

            approvalId = approvalRecord.id;
            proposal = {
              actionName: actionPayload.name,
              payload: executionArgs,
              requiresApproval: true,
            };
            status = "requires_approval";
            outputSummary = `Worker capability [${manifest.displayName}] proposed ${actionPayload.name}. Awaiting Chusky supervisor review.`;

            if (options?.onStatus) {
              await options.onStatus(`🛡️ ${manifest.displayName} requested approval for ${actionPayload.name}. Approval ID: ${approvalRecord.id}`);
            }
            await blockTask(userId, durableTask.id, outputSummary, "Awaiting Chusky supervisor review");
          } else {
            if (options?.onStatus) {
              await options.onStatus(humanToolStatus(actionPayload.name));
            }
            try {
              const toolResult = actionPayload.name.startsWith("CHUCK_")
                ? await (async () => {
                    validateNativeToolArguments(actionPayload.name, executionArgs);
                    return nativeTool(userId, actionPayload.name, executionArgs, {
                      model,
                      worker: workerName,
                      handoffId: handoffRecord.id,
                      delegationDepth: handoffRecord.delegationDepth ?? 0,
                      workerBinding: {
                        expectedOutput: contract.expectedOutput,
                        allowedTools: contract.allowedTools,
                        allowedComposioTools: contract.allowedComposioTools,
                        approvalPolicy: contract.approvalPolicy,
                        timeoutSeconds: contract.timeoutSeconds,
                        maxToolCalls: contract.maxToolCalls,
                        maxTotalToolCalls: handoffRecord.delegation!.maxTotalToolCalls,
                      },
                      rootHandoffId: handoffRecord.rootHandoffId,
                      approvedApprovalId: options?.approvedApprovalId,
                      deliveryTarget: options?.deliveryTarget,
                      onStatus: options?.onStatus,
                      signal: activeSignal,
                      registerCancellationCleanup,
                    });
                  })()
                : await scopedComposio.execute(actionPayload.name, executionArgs, activeSignal);
              logs.push(safeToolAudit({ tool: actionPayload.name, args: executionArgs, userId, runId: handoffRecord.delegation.runId, status: "completed" }));
              outputSummary = `Successfully executed ${actionPayload.name}. Result: ${JSON.stringify(toolResult).slice(0, 1000)}`;
              await checkpointTask(userId, durableTask.id, outputSummary, "Tool execution completed");
              if (approvedForTool && isRiskyToolSlug(actionPayload.name, executionArgs)) {
                await setApprovalStatus(userId, options!.approvedApprovalId!, "consumed");
              }
            } catch (err) {
              if (isCancellationError(err, activeSignal)) throw err;
              const errMsg = String((err as Error)?.message ?? err);
              logs.push(safeToolAudit({ tool: actionPayload.name, args: executionArgs, userId, runId: handoffRecord.delegation.runId, status: isCancellationError(err, activeSignal) ? "cancelled" : "failed", error: errMsg }));
              outputSummary = `Execution error in ${actionPayload.name}: ${errMsg}. Reflection checklist: ${manifest.reflectionChecklist.join("; ")}`;
              status = "failed";
            }
          }
        }
      }
    } else if (canRunModel) {
      // ── Autonomous OpenRouter Worker Model Loop ─────────────────────────────
      let skillContext = "";
      try { skillContext = await skillContextForBinding(manifest.skills, contract.objective); } catch { /* Skill tools remain available for explicit lookup. */ }
      const systemPrompt = `${manifest.systemPrompt}

${memorySnippet}

${options?.historySummary ? `Parent Conversation History Summary:\n${options.historySummary}\n` : ""}Delegated Native Tools: ${contract.allowedTools.join(", ") || "none"}
Delegated Composio Actions: ${scopedComposio.tools.map((tool: any) => String(tool?.function?.name ?? tool?.name ?? "")).filter(Boolean).join(", ") || "none"}
Unavailable starter actions (connection required): ${scopedComposio.missing.filter((slug) => starterComposioTools.includes(slug)).join(", ") || "none"}
Do not attempt a tool outside those lists. Destructive, financial, permission-changing,
deployment, remote Git push, and other high-impact external actions remain
approval-gated; validated outbound calls are autonomous under the current policy.
For research, use the scoped COMPOSIO_SEARCH_WEB and COMPOSIO_SEARCH_FETCH_URL_CONTENT
tools directly when available. If an integration action is unavailable or its slug
appears wrong, do not guess or retry variants. Use COMPOSIO_SEARCH_TOOLS (or the
legacy COMPOSIO_SEARCH_TOOL name), inspect the schema, and ask Chusky to delegate
one exact verified slug.
${options?.resume ? `This is durable continuation #${(options.resume.resumeCount ?? 0) + 1} of the same task. Preserve the earlier objective and report only new work performed after the capability was granted.` : ""}

Delegation Context:
${JSON.stringify(contract.context)}

Expected Output Format:
${contract.expectedOutput}

Reflection Checklist (Verify before concluding):
${manifest.reflectionChecklist.map((c) => `- ${c}`).join("\n")}
${skillContext ? `\nRelevant project skill guidance (trusted local instructions; user and supervisor instructions take precedence):\n${skillContext}` : ""}`;

      const restoredMessages = existingRun?.state?.messages;
      const messages: ApiMessage[] = Array.isArray(restoredMessages) && restoredMessages.length
        ? restoredMessages as ApiMessage[]
        : [
            { role: "system", content: systemPrompt },
            { role: "user", content: contract.objective },
          ];
      if (options?.resume && Array.isArray(restoredMessages) && restoredMessages.length) {
        const systemIndex = messages.findIndex((message) => message.role === "system");
        if (systemIndex >= 0) messages[systemIndex] = { ...messages[systemIndex]!, content: systemPrompt };
        else messages.unshift({ role: "system", content: systemPrompt });
      }
      let runVersion = existingRun?.version ?? 0;
      const runRecord: AgentRunRecord = existingRun ?? {
        id: handoffRecord.delegation.runId!,
        userId,
        kind: "worker",
        worker: workerName,
        objective: contract.objective,
        model,
        status: "running",
        budget: { duration: contract.duration, timeoutSeconds: contract.timeoutSeconds, maxToolCalls: contract.maxToolCalls, startedAt },
        state: { messages, toolCallsExecuted: 0, round: 0 },
        version: 0,
        events: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const checkpointRun = async (statusPatch: AgentRunRecord["status"], data: Record<string, unknown> = {}): Promise<void> => {
        runRecord.status = statusPatch;
        runRecord.state = {
          ...(runRecord.state ?? {}),
          messages,
          toolCallsExecuted: toolCallsCount,
          output: outputSummary || undefined,
          checkpoint: typeof data.checkpoint === "string" ? data.checkpoint : runRecord.state?.checkpoint,
          nextAction: typeof data.nextAction === "string" ? data.nextAction : runRecord.state?.nextAction,
          round: typeof data.round === "number" ? data.round : runRecord.state?.round,
        };
        runRecord.events = [...runRecord.events, { id: `evt_${randomUUID()}`, type: String(data.eventType ?? statusPatch), at: Date.now(), data }].slice(-200);
        const saved = await saveAgentRun(runRecord, existingRun ? runVersion : undefined);
        runVersion = saved.version;
        Object.assign(runRecord, saved);
      };
      await checkpointRun("running", { eventType: options?.resume ? "worker.resumed" : "worker.started", round: 0 });

      for (let round = 0; round < contract.maxToolCalls + 1; round++) {
        throwIfAborted(activeSignal);
        const taskBeforeRound = await getTask(userId, durableTask.id);
        if (taskBeforeRound?.status === "cancel_requested" || taskBeforeRound?.status === "cancelled") {
          workerController.abort(new CancellationError());
          throw new CancellationError();
        }

        const duration = Date.now() - startTime;
        if (duration > contract.timeoutSeconds * 1000) {
          status = "timed_out";
          outputSummary = `Worker capability ${workerName} exceeded timeout (${contract.timeoutSeconds}s).`;
          break;
        }

        await checkpointRun("running", { eventType: "worker.model_requested", round, model, messageCount: messages.length });
        const response = await workerChat(
          model,
          messages,
          workerTools,
          activeSignal
        );

        const choice = response.choices?.[0];
        if (!choice) {
          status = "failed";
          outputSummary = `No response choice received from worker model.`;
          break;
        }
        await checkpointRun("running", { eventType: "worker.model_completed", round, model, finishReason: choice.finish_reason ?? "unknown", hasToolCalls: Boolean(choice.message?.tool_calls?.length) });

        const { message: assistantMsg } = choice;
        const toolCalls = assistantMsg.tool_calls ?? [];
        const assistantText = cleanModelText(String(assistantMsg.content ?? ""));

        if (toolCalls.length === 0) {
          // Guard: if the model returned neither text nor tool calls, inject a
          // one-time nudge and continue rather than silently exiting with a
          // blank summary (which cascades into the "model output must contain
          // either output text or tool calls" OpenRouter error on the next turn).
          if (!assistantText) {
            if (round < contract.maxToolCalls) {
              messages.push({ role: "assistant", content: "(no response)" });
              messages.push({
                role: "user",
                content: "Your previous response was empty. Please provide a concise summary of what you have done or ask a clarifying question.",
              });
              continue;
            }
            // Exhausted retries — mark as failed
            status = "failed";
            outputSummary = `Worker capability ${workerName} returned an empty response after ${round} rounds.`;
            break;
          }
          outputSummary = assistantText || `Task completed by ${manifest.displayName}.`;
          status = "success";
          break;
        }

        messages.push({
          role: "assistant",
          content: typeof assistantMsg.content === "string" ? cleanModelText(assistantMsg.content) || null : assistantMsg.content ?? null,
          tool_calls: toolCalls,
        });

        let approvalNeeded = false;

        for (const call of toolCalls) {
          const slug = call.function.name;
          const rawArgs = parseToolArguments(call.function.arguments);

          // 1. Tool Whitelist Boundary Check
          if (!allowedToolNames.has(slug)) {
            status = "failed";
            outputSummary = `Security boundary error: Tool ${slug} is not permitted for worker capability ${workerName}.`;
            logs.push(safeToolAudit({ tool: slug, args: rawArgs, userId, runId: handoffRecord.delegation.runId, status: "failed", error: `Tool access denied for worker capability ${workerName}` }));
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `Security boundary error: Tool ${slug} is not permitted for ${workerName}.`,
            });
            break;
          }

          toolCallsCount++;
          if (toolCallsCount > contract.maxToolCalls) {
            status = "max_tool_calls_exceeded";
            outputSummary = `Worker capability ${workerName} exceeded max tool call limit (${contract.maxToolCalls}).`;
            break;
          }
          if (!(await claimHandoffBudget(userId, handoffRecord.rootHandoffId!, "tool"))) {
            sharedBudgetExhausted = true;
            status = "max_tool_calls_exceeded";
            outputSummary = `The shared delegation tree exceeded its total tool-call limit (${handoffRecord.delegation.maxTotalToolCalls}).`;
            break;
          }

          // A worker can ask its supervisor for a missing capability, but it
          // cannot discover, self-authorize, or self-grant a provider tool.
          if (slug === "CHUCK_REQUEST_ADDITIONAL_TOOLS") {
            toolRequest = {
              intent: String(rawArgs.intent ?? "").trim(),
              reason: String(rawArgs.reason ?? "").trim(),
              preferredToolkit: rawArgs.preferredToolkit ? String(rawArgs.preferredToolkit).trim() : undefined,
            };
            if (!toolRequest.intent || !toolRequest.reason) {
              status = "failed";
              outputSummary = "A worker tool request requires both intent and reason.";
              logs.push(safeToolAudit({ tool: slug, args: rawArgs, userId, runId: handoffRecord.delegation.runId, status: "failed", error: outputSummary }));
            } else {
              status = "requires_tool_request";
              outputSummary = `${manifest.displayName} requested an additional capability: ${toolRequest.intent}. Reason: ${toolRequest.reason}`;
              logs.push(safeToolAudit({ tool: slug, args: rawArgs, userId, runId: handoffRecord.delegation.runId, status: "completed", requested: true }));
              messages.push({ role: "tool", tool_call_id: call.id, content: "Capability request recorded. Stop here; Chusky will decide whether to discover and delegate a narrowly scoped tool." });
              await blockTask(userId, durableTask.id, outputSummary, "Awaiting Chusky tool discovery and scoped re-delegation");
              await checkpointRun("waiting_tools", { eventType: "worker.tool_request", checkpoint: outputSummary, nextAction: "Await Chusky tool discovery and scoped re-delegation" });
            }
            approvalNeeded = true;
            break;
          }

          // 2. Pre-Execution Approval Gate Check
          const approved = options?.approvedApprovalId
            ? await getSession(userId).then((s) =>
                s.approvals.find(
                  (a) => a.id === options.approvedApprovalId && a.status === "approved" && a.expiresAt > Date.now()
                )
              )
            : undefined;

          const approvedForTool = approved?.toolSlug === slug;
          const executionArgs = approvedForTool ? approved.args : rawArgs;
          const isReadOnly = isReadOnlyToolSlug(slug);
          const requiresApproval = !approvedForTool && requiresToolApproval(
            slug,
            executionArgs,
            !isReadOnly && contract.approvalPolicy === "require_chusky_approval",
          );

          if (requiresApproval) {
            // Create store approval record BEFORE execution!
            const approvalRecord = await createApproval({
              userId,
              toolSlug: slug,
              args: executionArgs,
              request: `Worker capability ${manifest.displayName} requested execution of ${slug}`,
              history: [],
              model,
              handoffId: handoffRecord.id,
            });

            approvalId = approvalRecord.id;
            proposal = {
              actionName: slug,
              payload: executionArgs,
              requiresApproval: true,
            };
            status = "requires_approval";
            outputSummary = `Worker capability [${manifest.displayName}] proposed risky tool ${slug}. Awaiting Chusky supervisor review.`;

            if (options?.onStatus) {
              await options.onStatus(`🛡️ ${manifest.displayName} requested approval for ${slug}. Approval ID: ${approvalRecord.id}`);
            }

            approvalNeeded = true;
            await blockTask(userId, durableTask.id, outputSummary, "Awaiting Chusky supervisor review");
            await checkpointRun("waiting_approval", { eventType: "worker.approval_requested", checkpoint: outputSummary, nextAction: "Await Chusky supervisor review", approvalId: approvalRecord.id });
            break;
          }

          // 3. Execute Tool in Boundary
          if (options?.onStatus) {
            await options.onStatus(humanToolStatus(slug));
          }

          try {
            const result = slug.startsWith("CHUCK_")
              ? await (async () => {
                  validateNativeToolArguments(slug, executionArgs);
                  return nativeTool(userId, slug, executionArgs, {
                    model,
                    worker: workerName,
                    handoffId: handoffRecord.id,
                    delegationDepth: handoffRecord.delegationDepth ?? 0,
                    workerBinding: {
                      expectedOutput: contract.expectedOutput,
                      allowedTools: contract.allowedTools,
                      allowedComposioTools: contract.allowedComposioTools,
                      approvalPolicy: contract.approvalPolicy,
                      timeoutSeconds: contract.timeoutSeconds,
                      maxToolCalls: contract.maxToolCalls,
                      duration: contract.duration,
                      budgetSeconds: contract.budgetSeconds,
                      maxTotalToolCalls: handoffRecord.delegation!.maxTotalToolCalls,
                    },
                    rootHandoffId: handoffRecord.rootHandoffId,
                    approvedApprovalId: options?.approvedApprovalId,
                    deliveryTarget: options?.deliveryTarget,
                    onStatus: options?.onStatus,
                    signal: activeSignal,
                    registerCancellationCleanup,
                  });
                })()
              : await scopedComposio.execute(slug, executionArgs, activeSignal);

            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            logs.push(safeToolAudit({ tool: slug, args: executionArgs, userId, runId: handoffRecord.delegation.runId, status: "completed" }));
            messages.push({ role: "tool", tool_call_id: call.id, content: resultStr.slice(0, 20000) });
            await checkpointTask(userId, durableTask.id, `Executed ${slug}`, "Proceed to next step");
            await checkpointRun("running", { eventType: "worker.tool_completed", tool: slug, round, checkpoint: `Executed ${slug}`, nextAction: "Proceed to next step" });
            if (approvedForTool && isRiskyToolSlug(slug, executionArgs)) await setApprovalStatus(userId, options!.approvedApprovalId!, "consumed");
          } catch (err) {
            if (isCancellationError(err, activeSignal)) throw err;
            const errMsg = String((err as Error)?.message ?? err);
            logs.push(safeToolAudit({ tool: slug, args: executionArgs, userId, runId: handoffRecord.delegation.runId, status: isCancellationError(err, activeSignal) ? "cancelled" : "failed", error: errMsg }));

            // 1-turn reflection prompt on error
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `Tool Execution Error: ${errMsg}. Please reflect on checklist: ${manifest.reflectionChecklist.join("; ")} and attempt a fix or clean summary.`,
            });
          }
        }

        if (approvalNeeded || status !== "success") {
          break;
        }
      }
      if (status === "success") await checkpointRun("completed", { eventType: "worker.completed", checkpoint: outputSummary, nextAction: "" });
      else if (status === "timed_out" || status === "max_tool_calls_exceeded") await checkpointRun(sharedBudgetExhausted ? "failed" : "queued", { eventType: sharedBudgetExhausted ? "worker.shared_budget_exhausted" : "worker.slice_exhausted", checkpoint: outputSummary, nextAction: sharedBudgetExhausted ? "Return the exhausted delegation tree to Chusky for replanning." : "Continue from the latest durable checkpoint.", round: contract.maxToolCalls });
      else if (status === "failed") await checkpointRun("failed", { eventType: "worker.failed", checkpoint: outputSummary, nextAction: "Inspect the failure and retry when safe." });
    } else {
      // Never turn missing inference infrastructure into a synthetic success.
      // Contract tests can still exercise native/action-only workers, but a
      // normal delegated objective needs a real model response.
      status = "failed";
      outputSummary = "Worker model is unavailable. Configure a live OPENROUTER_API_KEY before starting delegated work.";
    }
  } catch (err) {
    if (isCancellationError(err, activeSignal)) {
      await runCancellationCleanups();
      if (actionPayload?.name) logs.push(safeToolAudit({ tool: actionPayload.name, args: actionPayload.args, userId, runId: handoffRecord.delegation.runId, status: "cancelled", error: "Cancellation requested while the provider call was in flight." }));
      status = "interrupted";
      outputSummary = "Worker delegation was interrupted by a cancellation request.";
    } else if (err instanceof UnavailableComposioToolsError) {
      status = "requires_tool_request";
      toolRequest = {
        intent: `Find an available replacement for ${err.missingSlugs.join(", ")}`.slice(0, 500),
        reason: err.connectionRequiredToolkits.length
          ? `No connected app is available for this action. The owner may need to connect one of: ${err.connectionRequiredToolkits.join(", ")}.`
          : "The exact action granted to this worker is not available in the owner's connected Composio session. Chusky must verify an exact replacement or ask the owner to connect the required app.",
        preferredToolkit: err.connectionRequiredToolkits[0] ?? err.missingSlugs[0]?.split("_")[0]?.toLowerCase(),
      };
      outputSummary = `${manifest.displayName} is waiting because a granted connected-app action is unavailable. Chusky must verify a replacement or request the required connection.`;
      await blockTask(userId, durableTask.id, outputSummary, "Await Chusky to verify an available exact action or request the required connection");
    } else {
      status = "failed";
      outputSummary = `Unhandled exception in worker capability ${workerName}: ${String((err as Error)?.message ?? err)}`;
  }
}

  const durationMs = Date.now() - startTime;
  const totalElapsedMs = Date.now() - startedAt;
  // A /agent-cancel can arrive while a provider turn is completing. Preserve
  // the user's cancellation rather than allowing a late worker response to
  // overwrite it with success.
  const finalTask = await getTask(userId, durableTask.id);
  if (finalTask?.status === "cancel_requested" || finalTask?.status === "cancelled" || status === "interrupted") {
    if (status !== "interrupted") status = "cancelled";
    outputSummary = "Worker delegation was cancelled by the user before completion.";
  }
  if (durationMs > contract.timeoutSeconds * 1000 && status === "success") {
    status = "timed_out";
  }

  // A slice limit is a continuation point, not a terminal failure. The
  // durable supervisor will enqueue the same handoff again while its overall
  // goal budget remains available.
  if (!sharedBudgetExhausted && (status === "timed_out" || status === "max_tool_calls_exceeded") && contract.maxToolCalls > 0 && totalElapsedMs < contract.budgetSeconds! * 1000) {
    status = "queued";
    outputSummary = `${manifest.displayName} completed an execution slice. Continuing the same task automatically within the ${contract.duration} budget.`;
  }

  if (status === "success") {
    await completeTask(userId, durableTask.id, outputSummary);
  } else if (status === "cancelled" || status === "interrupted") {
    await finalizeTaskCancellation(userId, durableTask.id, outputSummary || "Worker delegation cancelled.");
  } else if (status === "queued") {
    await updateTask(userId, durableTask.id, { status: "queued", checkpoint: outputSummary, nextAction: "Continue from the latest checkpoint in the next execution slice." });
  } else if (status === "failed" || status === "max_tool_calls_exceeded" || status === "timed_out") {
    // `failTask` does not exist in store.ts. Use `blockTask` to record the
    // failure durably, then patch the status to "failed" via `updateTask`.
    await blockTask(userId, durableTask.id, outputSummary, "Worker terminated — no retry");
    await updateTask(userId, durableTask.id, { status: "failed" });
  }

  handoffRecord.status = status;
  if (toolRequest) handoffRecord.toolRequest = toolRequest;
  await saveHandoffRecord(userId, handoffRecord);

  if (status === "queued" && config.qstashToken && config.webhookUrl) {
    try {
      const continuation = await enqueueSubagentContinuation(userId, handoffRecord.id);
      outputSummary += ` Continuation queued (${continuation.workflowRunId}).`;
    } catch (error) {
      status = "failed";
      outputSummary = `The next worker slice could not be queued: ${String((error as Error)?.message ?? error)}`;
      await updateTask(userId, durableTask.id, { status: "failed", error: outputSummary, nextAction: "Check QStash configuration and retry the task." });
      handoffRecord.status = status;
      await saveHandoffRecord(userId, handoffRecord);
    }
  } else if (status === "queued") {
    // Never report a durable continuation that cannot actually be scheduled.
    // This makes missing QStash/public-webhook configuration an explicit,
    // retryable failure instead of a task stranded in `queued` forever.
    status = "failed";
    outputSummary = "Worker reached its slice limit, but durable continuation is unavailable. Configure QSTASH_TOKEN and WEBHOOK_URL, then retry the task.";
    await updateTask(userId, durableTask.id, { status: "failed", error: outputSummary, nextAction: "Configure QSTASH_TOKEN and WEBHOOK_URL, then retry." });
    handoffRecord.status = status;
    await saveHandoffRecord(userId, handoffRecord);
  }

  // Reconcile the durable run after the outer continuation decision. A slice
  // may first checkpoint as queued and then become failed if scheduling is not
  // available; the run record must expose that final truth as well.
  if (handoffRecord.delegation?.runId) {
    const finalRun = await getAgentRun(userId, handoffRecord.delegation.runId);
    if (finalRun) {
      await saveAgentRun({
        ...finalRun,
        status: status === "success" ? "completed" : status === "cancelled" ? "cancelled" : status === "interrupted" ? "interrupted" : status === "queued" ? "queued" : status === "requires_approval" ? "waiting_approval" : status === "requires_tool_request" ? "waiting_tools" : "failed",
        state: { ...(finalRun.state ?? {}), output: outputSummary.slice(0, 20_000), checkpoint: outputSummary.slice(0, 4_000), nextAction: status === "queued" ? "Continue from the latest durable checkpoint." : "" },
        events: [...finalRun.events, { id: `evt_${randomUUID()}`, type: `run.${status}`, at: Date.now(), data: { output: outputSummary.slice(0, 2_000) } }].slice(-200),
      }, finalRun.version);
    }
  }

  activeWorkerControllers.delete(handoffRecord.id);
  return {
    contractId: contract.id,
    worker: workerName,
    status,
    output: outputSummary,
    toolCallsCount,
    toolCallsLog: logs,
    proposal,
    approvalId,
    toolRequest,
    taskId: durableTask.id,
    handoffRecord,
    durationMs,
  };
}

/** Resume a worker only from the exact owner-approved action stored in its approval record. */
export async function resumeApprovedDelegation(userId: number, approvalId: string): Promise<DelegationResult> {
  const approval = (await getSession(userId)).approvals.find((item) => item.id === approvalId);
  if (!approval || approval.status !== "approved" || approval.expiresAt <= Date.now() || !approval.handoffId) {
    throw new Error("The owner-approved worker action is missing, expired, or no longer available.");
  }
  const handoff = await getHandoffRecord(userId, approval.handoffId);
  if (!handoff?.taskId || !handoff.delegation || handoff.status !== "requires_approval") {
    throw new Error("The approved worker action is no longer attached to a resumable handoff.");
  }
  await updateTask(userId, handoff.taskId, { status: "running", error: undefined, nextAction: "Executing the exact action approved by the owner." });
  return executeDelegation(userId, {
    worker: handoff.to as CapabilityWorkerName,
    objective: handoff.objective,
    context: { ...handoff.context, toolCall: { name: approval.toolSlug, args: approval.args } },
    expectedOutput: handoff.expectedOutput,
    model: handoff.delegation.model,
    allowedTools: handoff.delegation.allowedTools,
    allowedComposioTools: handoff.delegation.allowedComposioTools,
    approvalPolicy: handoff.delegation.approvalPolicy,
    timeoutSeconds: handoff.delegation.timeoutSeconds,
    maxToolCalls: handoff.delegation.maxToolCalls,
    duration: handoff.delegation.duration,
    budgetSeconds: handoff.delegation.budgetSeconds,
    maxTotalToolCalls: handoff.delegation.maxTotalToolCalls,
  }, {
    approvedApprovalId: approvalId,
    resume: { handoffId: handoff.id, taskId: handoff.taskId, resumeCount: (handoff.resumeCount ?? 0) + 1 },
    rootHandoffId: handoff.rootHandoffId ?? handoff.id,
    model: handoff.delegation.model,
  });
}
