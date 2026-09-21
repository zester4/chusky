import { randomUUID } from "node:crypto";
import { enqueueTaskWorkflow } from "../triggerWorkflow.js";
import {
  createApproval,
  createTask,
  getApproval,
  getSession,
  getTask,
  saveSession,
  setApprovalStatus,
  type ComposerStage,
  type TaskRecord,
  type WorkflowComposerRecord,
} from "../store.js";
import { enqueueTaskWithClaim } from "../taskEnqueue.js";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
type TaskEnqueuer = (userId: number, taskId: string, runAt: number) => Promise<string>;

export type ComposerStageInput = {
  id: string;
  title: string;
  objective: string;
  dependsOn?: string[];
  requiresApproval?: boolean;
  retryLimit?: number;
  budgetSeconds?: number;
};

function normalizeStages(input: ComposerStageInput[]): ComposerStage[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw new Error("A workflow needs between 1 and 20 stages");
  const ids = new Set<string>();
  const stages = input.map((stage) => {
    const id = String(stage.id ?? "").trim();
    const title = String(stage.title ?? "").trim().slice(0, 160);
    const objective = String(stage.objective ?? "").trim().slice(0, 4000);
    if (!ID.test(id) || ids.has(id)) throw new Error("Workflow stage IDs must be unique and use letters, numbers, underscores, or hyphens");
    if (!title || !objective) throw new Error(`Workflow stage ${id || "(unknown)"} needs a title and objective`);
    ids.add(id);
    return {
      id,
      title,
      objective,
      dependsOn: [...new Set((stage.dependsOn ?? []).map(String))],
      status: "pending" as const,
      requiresApproval: stage.requiresApproval === true,
      retryLimit: Math.max(0, Math.min(5, Math.floor(stage.retryLimit ?? 2))),
      ...(stage.budgetSeconds ? { budgetSeconds: Math.max(30, Math.min(86_400, Math.floor(stage.budgetSeconds))) } : {}),
    };
  });
  for (const stage of stages) for (const dependency of stage.dependsOn) {
    if (!ids.has(dependency) || dependency === stage.id) throw new Error(`Workflow stage ${stage.id} has an invalid dependency`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Workflow stages cannot contain dependency cycles");
    if (visited.has(id)) return;
    visiting.add(id);
    const stage = stages.find((item) => item.id === id)!;
    stage.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  stages.forEach((stage) => visit(stage.id));
  return stages;
}

function view(record: WorkflowComposerRecord): WorkflowComposerRecord { return structuredClone(record); }

function taskStatus(status: TaskRecord["status"]): ComposerStage["status"] {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "cancel_requested") return "cancelled";
  return "pending";
}

function stageObjective(record: WorkflowComposerRecord, stage: ComposerStage): string {
  const dependencyResults = stage.dependsOn.map((dependencyId) => {
    const dependency = record.stages.find((item) => item.id === dependencyId);
    return dependency?.result ? `\nDependency ${dependencyId} result:\n${dependency.result.slice(0, 6000)}` : "";
  }).filter(Boolean).join("\n");
  return `You are executing stage "${stage.title}" in the Chusky workflow "${record.name}". Complete only this stage, preserve the stated objective, and return a concise result that downstream stages can use. Do not claim completion for work you did not perform.\n\nStage objective:\n${stage.objective}${dependencyResults}`;
}

async function createStageTask(userId: number, record: WorkflowComposerRecord, stage: ComposerStage): Promise<TaskRecord> {
  return createTask(userId, {
    title: `${record.name} · ${stage.title}`,
    objective: stageObjective(record, stage),
    maxAttempts: Math.max(1, stage.retryLimit + 1),
    steps: [{ id: stage.id, title: stage.title, status: "pending", updatedAt: Date.now() }],
    composerWorkflowId: record.id,
    composerStageId: stage.id,
    ...(stage.budgetSeconds ? { composerBudgetSeconds: stage.budgetSeconds } : {}),
  });
}

async function createStageApproval(userId: number, session: Awaited<ReturnType<typeof getSession>>, record: WorkflowComposerRecord, stage: ComposerStage) {
  return createApproval({
    userId,
    toolSlug: "CHUCK_WORKFLOW_STAGE",
    args: { workflowId: record.id, stageId: stage.id },
    request: `Approve workflow stage "${stage.title}" in "${record.name}" before it starts.`,
    history: [],
    model: session.model,
  });
}

/** Reconcile the graph with independent stage tasks and advance ready stages. */
export async function reconcileComposerWorkflow(userId: number, id: string, enqueuer?: TaskEnqueuer): Promise<WorkflowComposerRecord | undefined> {
  const session = await getSession(userId);
  const record = (session.workflowComposers ?? []).find((item) => item.id === id);
  if (!record || record.status === "draft") return record ? view(record) : undefined;

  for (const stage of record.stages) {
    if (!stage.taskId) continue;
    const task = await getTask(userId, stage.taskId);
    if (!task) continue;
    stage.status = taskStatus(task.status);
    if (task.result) stage.result = task.result.slice(0, 12_000);
  }

  if (record.stages.some((stage) => stage.status === "failed")) record.status = "failed";
  else if (record.stages.some((stage) => stage.status === "cancelled")) record.status = "cancelled";
  else if (record.stages.every((stage) => stage.status === "completed")) record.status = "completed";
  else record.status = record.stages.some((stage) => stage.status === "running") ? "running" : "queued";

  if (!["failed", "cancelled", "completed"].includes(record.status)) {
    for (const stage of record.stages) {
      if (stage.taskId || stage.status === "completed" || stage.status === "running") continue;
      const dependencies = stage.dependsOn.map((dependencyId) => record.stages.find((item) => item.id === dependencyId));
      if (dependencies.some((dependency) => !dependency || dependency.status === "failed" || dependency.status === "cancelled")) {
        stage.status = "failed";
        stage.result = "A required dependency did not complete.";
        record.status = "failed";
        continue;
      }
      if (dependencies.some((dependency) => dependency?.status !== "completed")) continue;

      if (stage.requiresApproval) {
        const approval = stage.approvalId ? await getApproval(userId, stage.approvalId) : undefined;
        if (!approval) {
          const created = await createStageApproval(userId, session, record, stage);
          stage.approvalId = created.id;
          stage.status = "blocked";
          continue;
        }
        if (approval.status === "pending") { stage.status = "blocked"; continue; }
        if (approval.status !== "approved") {
          stage.status = "failed";
          stage.result = "The required approval was denied or expired.";
          record.status = "failed";
          continue;
        }
        await setApprovalStatus(userId, approval.id, "consumed");
      }

      const task = await createStageTask(userId, record, stage);
      stage.taskId = task.id;
      stage.status = "pending";
      if (!record.taskId) record.taskId = task.id;
    }
  }

  record.updatedAt = Date.now();
  await saveSession(userId, session);

  if (enqueuer && !["failed", "cancelled", "completed"].includes(record.status)) {
    for (const stage of record.stages) {
      if (!stage.taskId) continue;
      const task = await getTask(userId, stage.taskId);
      if (!task || task.status !== "queued") continue;
      const pendingClaimExpired = task.workflowRunId?.startsWith("pending:") === true
        && (!task.enqueueClaim || task.enqueueClaim.expiresAt <= Date.now());
      if (task.workflowRunId && !pendingClaimExpired) continue;
      await enqueueTaskWithClaim(userId, task.id, task.runAt ?? Date.now(), enqueuer);
    }
  }
  return view(record);
}

export async function onComposerTaskSettled(userId: number, taskId: string): Promise<void> {
  const task = await getTask(userId, taskId);
  if (!task?.composerWorkflowId) return;
  await reconcileComposerWorkflow(userId, task.composerWorkflowId, enqueueTaskWorkflow);
}

export async function rejectComposerApproval(userId: number, approvalId: string): Promise<void> {
  const session = await getSession(userId);
  const record = (session.workflowComposers ?? []).find((item) => item.stages.some((stage) => stage.approvalId === approvalId));
  if (!record) return;
  const stage = record.stages.find((item) => item.approvalId === approvalId);
  if (stage) { stage.status = "failed"; stage.result = "The required approval was denied."; }
  record.status = "failed";
  record.updatedAt = Date.now();
  await saveSession(userId, session);
}

export async function listComposerWorkflows(userId: number): Promise<WorkflowComposerRecord[]> {
  const session = await getSession(userId);
  for (const record of session.workflowComposers ?? []) await reconcileComposerWorkflow(userId, record.id);
  const refreshed = await getSession(userId);
  return (refreshed.workflowComposers ?? []).sort((a, b) => b.updatedAt - a.updatedAt).map(view);
}

export async function createComposerWorkflow(userId: number, input: { name: string; description?: string; stages: ComposerStageInput[] }): Promise<WorkflowComposerRecord> {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 160);
  if (!name) throw new Error("Workflow name is required");
  const now = Date.now();
  const record: WorkflowComposerRecord = {
    id: `wf_${randomUUID()}`,
    name,
    ...(input.description?.trim() ? { description: input.description.trim().slice(0, 1000) } : {}),
    stages: normalizeStages(input.stages),
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  const session = await getSession(userId);
  session.workflowComposers = [...(session.workflowComposers ?? []), record].slice(-50);
  await saveSession(userId, session);
  return view(record);
}

export async function updateComposerWorkflow(userId: number, id: string, input: Partial<{ name: string; description: string; stages: ComposerStageInput[] }>): Promise<WorkflowComposerRecord | undefined> {
  const session = await getSession(userId);
  const record = (session.workflowComposers ?? []).find((item) => item.id === id);
  if (!record) return undefined;
  if (record.status !== "draft") throw new Error("Only draft workflows can be edited");
  if (input.name !== undefined) {
    const name = input.name.trim().replace(/\s+/g, " ").slice(0, 160);
    if (!name) throw new Error("Workflow name is required");
    record.name = name;
  }
  if (input.description !== undefined) record.description = input.description.trim().slice(0, 1000) || undefined;
  if (input.stages !== undefined) record.stages = normalizeStages(input.stages);
  record.updatedAt = Date.now();
  await saveSession(userId, session);
  return view(record);
}

export async function startComposerWorkflow(userId: number, id: string): Promise<{ workflow: WorkflowComposerRecord; tasks: TaskRecord[] }> {
  const session = await getSession(userId);
  const record = (session.workflowComposers ?? []).find((item) => item.id === id);
  if (!record) throw new Error("Workflow not found");
  if (record.status !== "draft") throw new Error("Workflow has already been started");
  record.status = "queued";
  record.updatedAt = Date.now();
  await saveSession(userId, session);
  const workflow = await reconcileComposerWorkflow(userId, id);
  if (!workflow) throw new Error("Workflow could not be started");
  const refreshed = await getSession(userId);
  const current = refreshed.workflowComposers!.find((item) => item.id === id)!;
  const tasks = (await Promise.all(current.stages.filter((stage) => stage.taskId).map((stage) => getTask(userId, stage.taskId!)))).filter((task): task is TaskRecord => Boolean(task));
  return { workflow: view(current), tasks };
}
