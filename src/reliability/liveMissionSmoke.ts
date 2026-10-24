import { timingSafeEqual } from "node:crypto";
import type { TaskSliceContext } from "../taskSlice.js";
import { nativeTool, type NativeToolRuntime } from "../nativeTools.js";
import { TASK_WAIT_MIN_SECONDS } from "../taskWait.js";

export const LIVE_MISSION_SMOKE_EXECUTION_MODE = "durable_engine_smoke" as const;

type SmokeRunOptions = {
  taskId?: string;
  missionId?: string;
  missionStepId?: string;
  missionStepObjective?: string;
  missionTimerResumed?: boolean;
  enqueueMissionTask?: NativeToolRuntime["enqueueMissionTask"];
};

function stageFromObjective(objective: string | undefined): { delaySeconds: number; title: string } {
  const text = typeof objective === "string" ? objective.trim() : "";
  const match = /^(.*?)\s*Wait\s+(\d+)\s+seconds?/i.exec(text);
  if (!match) throw new Error("Staging mission smoke step is missing its bounded wait contract.");
  const delaySeconds = Number(match[2]);
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds < TASK_WAIT_MIN_SECONDS || delaySeconds > 3600) {
    throw new Error("Staging mission smoke wait is outside the supported range.");
  }
  return { delaySeconds, title: (match[1]?.trim() || "Staging durable engine smoke stage").replace(/[:.]$/, "") };
}

/**
 * Deterministic model boundary for the deployed staging engine smoke.
 * QStash, Redis, Neon, mission state, task leases, timer wakes, and mission
 * settlement remain real; only the model/provider decision is scripted.
 */
export const runLiveMissionSmokeAgent: NonNullable<TaskSliceContext["runAgent"]> = async (...args) => {
  const options = args[9] as SmokeRunOptions | undefined;
  if (!options?.taskId || !options.missionId || !options.missionStepId) throw new Error("Staging mission smoke received incomplete durable context.");
  const stage = stageFromObjective(options.missionStepObjective);
  const userId = Number(args[0]);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Staging mission smoke received an invalid owner.");

  const runtime: NativeToolRuntime = {
    taskId: options.taskId,
    missionId: options.missionId,
    missionStepId: options.missionStepId,
    missionTimerResumed: options.missionTimerResumed,
    ...(options.enqueueMissionTask ? { enqueueMissionTask: options.enqueueMissionTask } : {}),
  };

  if (!options.missionTimerResumed) {
    let request: Parameters<NonNullable<NativeToolRuntime["requestTaskWait"]>>[0] | undefined;
    await nativeTool(userId, "CHUCK_TASK_WAIT", {
      delaySeconds: stage.delaySeconds,
      checkpoint: `${stage.title} checkpoint saved before sleep`,
      nextAction: `Verify ${stage.title} after the QStash wake`,
    }, { ...runtime, requestTaskWait: (value) => { request = value; } });
    if (!request) throw new Error("Staging mission smoke could not capture its durable wait request.");
    return {
      text: `${stage.title} is sleeping on a real QStash timer.`,
      toolsUsed: ["CHUCK_TASK_WAIT"],
      toolsSucceeded: ["CHUCK_TASK_WAIT"],
      toolOutcomes: [],
      taskWait: request,
      cost: 0,
    };
  }

  await nativeTool(userId, "CHUCK_MISSION_CHECKPOINT", {
    id: options.missionId,
    checkpoint: `${stage.title} checkpoint verified after wake`,
    nextAction: `Complete ${stage.title}`,
  }, runtime);
  await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", {
    id: options.missionId,
    stepId: options.missionStepId,
    result: `${stage.title} completed after a real QStash wake`,
  }, runtime);
  return {
    text: `${stage.title} completed after the real QStash wake.`,
    toolsUsed: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"],
    toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_STEP_COMPLETE"],
    toolOutcomes: [],
    cost: 0,
  };
};

export function verifyLiveMissionSmokeSecret(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function normalizeLiveMissionSmokeDelays(value: unknown): [number, number, number] {
  const raw = Array.isArray(value) ? value : [60, 60, 60];
  if (raw.length !== 3) throw new Error("Exactly three staging mission smoke delays are required.");
  const delays = raw.map((item) => Number(item));
  if (delays.some((delay) => !Number.isSafeInteger(delay) || delay < TASK_WAIT_MIN_SECONDS || delay > 3600)) {
    throw new Error(`Each staging mission smoke delay must be a whole number from ${TASK_WAIT_MIN_SECONDS} to 3600 seconds.`);
  }
  return delays as [number, number, number];
}
