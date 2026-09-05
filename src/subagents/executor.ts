import { randomUUID } from "node:crypto";
import { WORKER_CAPABILITIES, isComposioToolAllowedForWorker } from "./capabilities.js";
import { memoryRouter } from "../memory/router.js";
import { nativeTool } from "../nativeTools.js";
import { chuckTools, validateNativeToolArguments } from "../agentTools.js";
import { isRiskyToolSlug, isReadOnlyToolSlug, humanToolStatus } from "../policy.js";
import { createApproval, getSession, getTask, getHandoffRecord, saveHandoffRecord, createTask, checkpointTask, completeTask, blockTask, updateTask } from "../store.js";
import { config } from "../config.js";
import { getScopedComposioTools, orChat, parseToolArguments, cleanModelText } from "../agent.js";
import type { ApiMessage } from "../types.js";
import type { CapabilityWorkerName } from "../memory/types.js";
import type { DelegationContract, DelegationResult, DelegationStatus, HandoffRecord } from "./contracts.js";

export async function executeDelegation(
  userId: number,
  contractInput: Partial<DelegationContract> & { worker: CapabilityWorkerName; objective: string },
  options?: {
    model?: string;
    onStatus?: (statusText: string) => Promise<void> | void;
    approvedApprovalId?: string;
    signal?: AbortSignal;
    historySummary?: string;
    resume?: { handoffId: string; taskId: string; workflowRunId?: string; resumeCount?: number };
  }
): Promise<DelegationResult> {
  const startTime = Date.now();
  const workerName = contractInput.worker;
  const manifest = WORKER_CAPABILITIES[workerName];

  if (!manifest) {
    throw new Error(`Unknown capability worker: ${workerName}`);
  }

  // Reject invalid requested tools that are not in the manifest allowlist
  if (contractInput.allowedTools && contractInput.allowedTools.length > 0) {
    const invalidTools = contractInput.allowedTools.filter((tool) => !manifest.allowedTools.includes(tool));
    if (invalidTools.length > 0) {
      throw new Error(`Invalid delegation contract: Tool(s) [${invalidTools.join(", ")}] are not permitted for worker capability '${workerName}' manifest allowlist.`);
    }
  }
  if (contractInput.allowedComposioTools && contractInput.allowedComposioTools.length > 0) {
    const invalidTools = contractInput.allowedComposioTools.filter((tool) => !isComposioToolAllowedForWorker(workerName, tool));
    if (invalidTools.length > 0) {
      throw new Error(`Invalid delegation contract: Composio tool(s) [${invalidTools.join(", ")}] are not permitted for worker capability '${workerName}'. Select only an exact action from its approved toolkit family.`);
    }
  }

  // Inherit model from options/contract or fallback to default
  const model = options?.model || contractInput.model || config.defaultModel;

  // Sanitize contract with strict defaults
  const contract: DelegationContract = {
    id: contractInput.id ?? randomUUID(),
    supervisor: "chusky",
    worker: workerName,
    objective: contractInput.objective,
    model,
    allowedComposioTools: [...new Set((contractInput.allowedComposioTools ?? []).map((tool) => tool.trim()).filter(Boolean))],
    allowedTools: (contractInput.allowedTools ?? manifest.allowedTools).filter((tool) =>
      manifest.allowedTools.includes(tool)
    ),
    context: contractInput.context ?? {},
    expectedOutput: contractInput.expectedOutput ?? "Summary of executed task and outcomes.",
    approvalPolicy: contractInput.approvalPolicy ?? "auto",
    timeoutSeconds: Math.max(5, Math.min(300, contractInput.timeoutSeconds ?? 60)),
    maxToolCalls: Math.max(0, Math.min(20, contractInput.maxToolCalls ?? 10)),
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
  const existingHandoff = options?.resume ? await getHandoffRecord(userId, options.resume.handoffId) : undefined;
  if (options?.resume && !existingHandoff) throw new Error("The durable handoff record for this worker continuation no longer exists or is not owned by the user.");
  const handoffRecord: HandoffRecord = existingHandoff ?? {
    id: `handoff_${randomUUID()}`,
    from: "chusky",
    to: workerName,
    objective: contract.objective,
    context: contract.context ?? {},
    expectedOutput: contract.expectedOutput,
    timestamp: Date.now(),
    status: "success",
    taskId: durableTask.id,
  };
  handoffRecord.delegation = {
    model,
    allowedTools: contract.allowedTools,
    allowedComposioTools: contract.allowedComposioTools,
    approvalPolicy: contract.approvalPolicy,
    timeoutSeconds: contract.timeoutSeconds,
    maxToolCalls: contract.maxToolCalls,
  };
  if (options?.resume?.workflowRunId) handoffRecord.workflowRunId = options.resume.workflowRunId;
  if (options?.resume?.resumeCount !== undefined) handoffRecord.resumeCount = options.resume.resumeCount;
  await saveHandoffRecord(userId, handoffRecord);

  // Active timeout cancellation signal combined with parent signal
  const timeoutSignal = AbortSignal.timeout(contract.timeoutSeconds * 1000);
  const activeSignal = options?.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;

  const logs: DelegationResult["toolCallsLog"] = [];
  let toolCallsCount = 0;
  let status: DelegationStatus = "success";
  let outputSummary = "";
  let proposal: DelegationResult["proposal"] | undefined;
  let approvalId: string | undefined;
  let toolRequest: DelegationResult["toolRequest"] | undefined;

  // Telegram status update notification
  if (options?.onStatus) {
    await options.onStatus(`🤖 ${manifest.displayName} is initializing task: "${contract.objective.slice(0, 100)}"...`);
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
    const scopedComposio = await getScopedComposioTools(userId, contract.allowedComposioTools);
    const workerTools = [...nativeWorkerTools, ...scopedComposio.tools];
    if (actionPayload) {
      // ── Explicit Tool Call Execution (Direct Action Payload) ────────────────
      if (!allowedToolNames.has(actionPayload.name)) {
        status = "failed";
        outputSummary = `Security boundary error: Tool ${actionPayload.name} is not permitted for worker capability ${workerName}.`;
        logs.push({
          tool: actionPayload.name,
          args: actionPayload.args,
          error: `Tool access denied for worker capability ${workerName}`,
        });
      } else if (actionPayload.name === "CHUCK_REQUEST_ADDITIONAL_TOOLS") {
        toolCallsCount++;
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
          logs.push({ tool: actionPayload.name, args: actionPayload.args, result: { requested: true, ...toolRequest } });
        }
      } else {
        toolCallsCount++;
        if (toolCallsCount > contract.maxToolCalls) {
          status = "max_tool_calls_exceeded";
          outputSummary = `Worker capability ${workerName} exceeded max tool call limit (${contract.maxToolCalls}).`;
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
          const isRisky = isRiskyToolSlug(actionPayload.name, executionArgs);
          const requiresApproval = !approvedForTool && !isReadOnly && (
            isRisky || contract.approvalPolicy === "require_chusky_approval"
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
            });

            approvalId = approvalRecord.id;
            proposal = {
              actionName: actionPayload.name,
              payload: executionArgs,
              requiresApproval: true,
            };
            status = "requires_approval";
            outputSummary = `Worker capability [${manifest.displayName}] requested approval for ${actionPayload.name}.`;

            if (options?.onStatus) {
              await options.onStatus(`🛡️ ${manifest.displayName} requested approval for ${actionPayload.name}. Approval ID: ${approvalRecord.id}`);
            }
            await blockTask(userId, durableTask.id, outputSummary, "Awaiting Chusky/User approval");
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
                      approvedApprovalId: options?.approvedApprovalId,
                      onStatus: options?.onStatus,
                      signal: activeSignal,
                    });
                  })()
                : await scopedComposio.execute(actionPayload.name, executionArgs);
              logs.push({ tool: actionPayload.name, args: executionArgs, result: toolResult });
              outputSummary = `Successfully executed ${actionPayload.name}. Result: ${JSON.stringify(toolResult).slice(0, 1000)}`;
              await checkpointTask(userId, durableTask.id, outputSummary, "Tool execution completed");
            } catch (err) {
              const errMsg = String((err as Error)?.message ?? err);
              logs.push({ tool: actionPayload.name, args: executionArgs, error: errMsg });
              outputSummary = `Execution error in ${actionPayload.name}: ${errMsg}. Reflection checklist: ${manifest.reflectionChecklist.join("; ")}`;
              status = "failed";
            }
          }
        }
      }
    } else if (canRunModel) {
      // ── Autonomous OpenRouter Worker Model Loop ─────────────────────────────
      const systemPrompt = `${manifest.systemPrompt}

${memorySnippet}

${options?.historySummary ? `Parent Conversation History Summary:\n${options.historySummary}\n` : ""}Delegated Native Tools: ${contract.allowedTools.join(", ") || "none"}
Delegated Composio Actions: ${contract.allowedComposioTools.join(", ") || "none"}
Do not attempt a tool outside those lists. External actions remain approval-gated.
If an integration action is unavailable or its slug appears wrong, do not guess,
search broadly, or retry variants. Stop and ask Chusky to use the supervisor-only
COMPOSIO_SEARCH_TOOL, verify the connected action, and delegate one exact slug.
${options?.resume ? `This is durable continuation #${(options.resume.resumeCount ?? 0) + 1} of the same task. Preserve the earlier objective and report only new work performed after the capability was granted.` : ""}

Delegation Context:
${JSON.stringify(contract.context)}

Expected Output Format:
${contract.expectedOutput}

Reflection Checklist (Verify before concluding):
${manifest.reflectionChecklist.map((c) => `- ${c}`).join("\n")}`;

      const messages: ApiMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: contract.objective },
      ];

      for (let round = 0; round < contract.maxToolCalls + 1; round++) {
        if (activeSignal.aborted) {
          status = "timed_out";
          outputSummary = `Worker capability ${workerName} execution aborted or timed out.`;
          break;
        }

        const duration = Date.now() - startTime;
        if (duration > contract.timeoutSeconds * 1000) {
          status = "timed_out";
          outputSummary = `Worker capability ${workerName} exceeded timeout (${contract.timeoutSeconds}s).`;
          break;
        }

        const response = await orChat(
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
            logs.push({ tool: slug, args: rawArgs, error: `Tool access denied for worker capability ${workerName}` });
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
              logs.push({ tool: slug, args: rawArgs, error: outputSummary });
            } else {
              status = "requires_tool_request";
              outputSummary = `${manifest.displayName} requested an additional capability: ${toolRequest.intent}. Reason: ${toolRequest.reason}`;
              logs.push({ tool: slug, args: rawArgs, result: { requested: true, ...toolRequest } });
              messages.push({ role: "tool", tool_call_id: call.id, content: "Capability request recorded. Stop here; Chusky will decide whether to discover and delegate a narrowly scoped tool." });
              await blockTask(userId, durableTask.id, outputSummary, "Awaiting Chusky tool discovery and scoped re-delegation");
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
          const isRisky = isRiskyToolSlug(slug, executionArgs);
          const requiresApproval = !approvedForTool && !isReadOnly && (
            isRisky || contract.approvalPolicy === "require_chusky_approval"
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
            });

            approvalId = approvalRecord.id;
            proposal = {
              actionName: slug,
              payload: executionArgs,
              requiresApproval: true,
            };
            status = "requires_approval";
            outputSummary = `Worker capability [${manifest.displayName}] requested approval for risky tool ${slug}. Halting until user approves.`;

            if (options?.onStatus) {
              await options.onStatus(`🛡️ ${manifest.displayName} requested approval for ${slug}. Approval ID: ${approvalRecord.id}`);
            }

            approvalNeeded = true;
            await blockTask(userId, durableTask.id, outputSummary, "Awaiting Chusky/User approval");
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
                    approvedApprovalId: options?.approvedApprovalId,
                    onStatus: options?.onStatus,
                    signal: activeSignal,
                  });
                })()
              : await scopedComposio.execute(slug, executionArgs);

            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            logs.push({ tool: slug, args: executionArgs, result });
            messages.push({ role: "tool", tool_call_id: call.id, content: resultStr.slice(0, 20000) });
            await checkpointTask(userId, durableTask.id, `Executed ${slug}`, "Proceed to next step");
          } catch (err) {
            const errMsg = String((err as Error)?.message ?? err);
            logs.push({ tool: slug, args: executionArgs, error: errMsg });

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
    } else {
      // Direct summary execution
      outputSummary = `Worker capability [${manifest.displayName}] received objective: "${contract.objective}". Output expected: "${contract.expectedOutput}". Scope verified clean. ${memorySnippet}`;
    }
  } catch (err) {
    status = "failed";
    outputSummary = `Unhandled exception in worker capability ${workerName}: ${String((err as Error)?.message ?? err)}`;
  }

  const durationMs = Date.now() - startTime;
  // A /agent-cancel can arrive while a provider turn is completing. Preserve
  // the user's cancellation rather than allowing a late worker response to
  // overwrite it with success.
  if ((await getTask(userId, durableTask.id))?.status === "cancelled") {
    status = "cancelled";
    outputSummary = "Worker delegation was cancelled by the user before completion.";
  }
  if (durationMs > contract.timeoutSeconds * 1000 && status === "success") {
    status = "timed_out";
  }

  if (status === "success") {
    await completeTask(userId, durableTask.id, outputSummary);
  } else if (status === "failed" || status === "max_tool_calls_exceeded" || status === "timed_out") {
    // `failTask` does not exist in store.ts. Use `blockTask` to record the
    // failure durably, then patch the status to "failed" via `updateTask`.
    await blockTask(userId, durableTask.id, outputSummary, "Worker terminated — no retry");
    await updateTask(userId, durableTask.id, { status: "failed" });
  }

  handoffRecord.status = status;
  if (toolRequest) handoffRecord.toolRequest = toolRequest;
  await saveHandoffRecord(userId, handoffRecord);

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
