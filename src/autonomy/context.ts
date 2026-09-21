import {
  getMission,
  getChannelConversation,
  getSession,
  getTask,
  listAttentionRecords,
  searchMemories,
  type OpenLoopRecord,
  type MemoryFact,
  type MissionRecord,
  type TaskRecord,
} from "../store.js";
import type { AutonomyContextSnapshot, AutonomyLinks } from "./types.js";

export interface AutonomyContextBundle {
  capturedAt: number;
  objective: string;
  links: AutonomyLinks;
  freshnessMs: number;
  conversation: Array<{ role: "user" | "assistant"; content: string; createdAt?: number }>;
  memories: Array<Pick<MemoryFact, "key" | "value" | "category" | "confidence" | "sensitivity" | "projectId">>;
  task?: Pick<TaskRecord, "id" | "title" | "objective" | "status" | "checkpoint" | "nextAction" | "result" | "updatedAt">;
  mission?: Pick<MissionRecord, "id" | "title" | "objective" | "definitionOfDone" | "status" | "checkpoint" | "nextAction" | "currentStepId" | "updatedAt">;
  openLoops: OpenLoopRecord[];
  summary: string;
}

function safeText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max) : "";
}

function linked(value: string | undefined, pattern: RegExp): string | undefined {
  return value && pattern.test(value) ? value : undefined;
}

/**
 * Build a bounded, owner-scoped context bundle immediately before an
 * autonomous slice. This avoids stale full-history prompts while still
 * letting a reminder, job, mission, or pulse understand what it is tending.
 */
export async function buildAutonomyContextBundle(userId: number, input: {
  objective: string;
  links?: AutonomyLinks;
  snapshot?: AutonomyContextSnapshot;
  includeHistory?: boolean;
}): Promise<AutonomyContextBundle> {
  const objective = safeText(input.objective, 2_000);
  const links: AutonomyLinks = {
    ...(linked(input.links?.taskId, /^task_[A-Za-z0-9_-]{1,160}$/) ? { taskId: input.links?.taskId } : {}),
    ...(linked(input.links?.missionId, /^mis_[A-Za-z0-9_-]{1,160}$/) ? { missionId: input.links?.missionId } : {}),
    ...(linked(input.links?.missionStepId, /^[A-Za-z0-9_-]{1,160}$/) ? { missionStepId: input.links?.missionStepId } : {}),
    ...(linked(input.links?.openLoopId, /^loop_[A-Za-z0-9_-]{1,160}$/) ? { openLoopId: input.links?.openLoopId } : {}),
    ...(linked(input.links?.attentionCandidateId, /^cand_[A-Za-z0-9_-]{1,160}$/) ? { attentionCandidateId: input.links?.attentionCandidateId } : {}),
    ...(linked(input.links?.projectId, /^[A-Za-z0-9_-]{1,160}$/) ? { projectId: input.links?.projectId } : {}),
    ...(linked(input.links?.meetingId, /^[A-Za-z0-9_-]{1,160}$/) ? { meetingId: input.links?.meetingId } : {}),
    ...(linked(input.links?.conversationId, /^[A-Za-z0-9_.:-]{1,200}$/) ? { conversationId: input.links?.conversationId } : {}),
  };

  const session = await getSession(userId);
  const [task, mission, memories, openLoops, channelConversation] = await Promise.all([
    links.taskId ? getTask(userId, links.taskId) : Promise.resolve(undefined),
    links.missionId ? getMission(userId, links.missionId) : Promise.resolve(undefined),
    objective ? searchMemories(userId, objective, { projectId: links.projectId, sensitivity: "normal", limit: 6 }) : Promise.resolve([]),
    listAttentionRecords(userId, "open_loop", { limit: 200 }),
    links.conversationId ? getChannelConversation(links.conversationId) : Promise.resolve(undefined),
  ]);

  // A conversation id is an untrusted link supplied by a caller. Never let a
  // valid id expose another owner's history; an invalid/mismatched link must
  // produce an empty context rather than falling back to the caller's chat.
  const conversationSource = links.conversationId
    ? channelConversation?.userId === userId ? channelConversation.history : []
    : (input.includeHistory === true ? session.history : []);
  const conversation = input.includeHistory === false ? [] : conversationSource.slice(-8).map((message) => ({ role: message.role, content: safeText(message.content, 2_000), ...(message.createdAt ? { createdAt: message.createdAt } : {}) }));
  const safeMemories = memories.map((memory) => ({ key: memory.key, value: safeText(memory.value, 1_000), category: memory.category, confidence: memory.confidence, sensitivity: memory.sensitivity, ...(memory.projectId ? { projectId: memory.projectId } : {}) }));
  const linkIds = Object.values(links).filter(Boolean) as string[];
  const objectiveTerms = new Set(objective.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4));
  const relevantLoops = (openLoops as OpenLoopRecord[]).filter((loop) => {
    if (links.openLoopId) return loop.id === links.openLoopId;
    if (loop.relatedEntityIds?.some((id) => linkIds.includes(id))) return true;
    const loopTerms = `${loop.title} ${loop.objective ?? ""} ${loop.nextAction ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4);
    return [...new Set(loopTerms)].filter((term) => objectiveTerms.has(term)).length >= 2;
  });
  const summary = [
    input.snapshot?.summary,
    task ? `Task ${task.title}: ${task.status}${task.nextAction ? `; next: ${task.nextAction}` : ""}` : undefined,
    mission ? `Mission ${mission.title}: ${mission.status}${mission.nextAction ? `; next: ${mission.nextAction}` : ""}` : undefined,
    relevantLoops.length ? `${relevantLoops.length} open loop(s) require attention.` : undefined,
  ].filter(Boolean).join(" ").slice(0, 4_000);

  return {
    capturedAt: Date.now(), objective, links, freshnessMs: Math.max(0, Date.now() - (input.snapshot?.capturedAt ?? Date.now())),
    conversation, memories: safeMemories, task: task ? { id: task.id, title: task.title, objective: task.objective, status: task.status, checkpoint: task.checkpoint, nextAction: task.nextAction, result: task.result, updatedAt: task.updatedAt } : undefined,
    mission: mission ? { id: mission.id, title: mission.title, objective: mission.objective, definitionOfDone: mission.definitionOfDone, status: mission.status, checkpoint: mission.checkpoint, nextAction: mission.nextAction, currentStepId: mission.currentStepId, updatedAt: mission.updatedAt } : undefined,
    openLoops: relevantLoops, summary,
  };
}

export function contextBundleToPrompt(bundle: AutonomyContextBundle): string {
  return JSON.stringify({
    capturedAt: bundle.capturedAt,
    freshnessMs: bundle.freshnessMs,
    objective: bundle.objective,
    summary: bundle.summary,
    links: bundle.links,
    conversation: bundle.conversation,
    memories: bundle.memories,
    task: bundle.task,
    mission: bundle.mission,
    openLoops: bundle.openLoops.map((loop) => ({ id: loop.id, title: loop.title, status: loop.status, nextAction: loop.nextAction, dueAt: loop.dueAt, waitingFor: loop.waitingFor })),
  });
}
