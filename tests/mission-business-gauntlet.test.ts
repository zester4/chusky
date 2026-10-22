import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { ApprovalRequiredError } from "../src/agent.js";
import { executeTaskSlice, type TaskSliceContext } from "../src/taskSlice.js";
import { executeDurableTask } from "../src/taskRunner.js";
import { nativeTool } from "../src/nativeTools.js";
import { enqueueTaskWithClaim } from "../src/taskEnqueue.js";
import {
  blockMission,
  cancelMission,
  claimApproval,
  createApproval,
  createMission,
  getMission,
  getTask,
  initStore,
  listTasksForMission,
  recordTrustedMissionEvidence,
  resumeMissionFromApproval,
  resumeMissionFromProviderEvent,
  startMission,
  type MissionRecord,
} from "../src/store.js";
import { reconcileMissionExecution, replanMissionAndSchedule, resumeMissionAndSchedule } from "../src/missionScheduler.js";
import { recoverMissionsForOwner } from "../src/missionRecovery.js";
import { resumeMissionTaskAfterApproval } from "../src/missionApproval.js";
import { beginExternalAction, reconcileExternalActionByRead } from "../src/autonomy/actions.js";
import type { MissionWaitRequest, TaskWaitRequest } from "../src/types.js";
import { MissionFakeClock, MissionFakeQStash } from "./helpers/missionKernelHarness.js";

/**
 * The business profiles below are deliberately different mission shapes, not
 * different expected answers. The worker is still the production task runner;
 * only the model/provider boundary is deterministic. Each profile represents
 * a request a real company could give Chusky and forces the engine to preserve
 * identity, dependencies, evidence, waits, approvals, and recovery.
 */
interface BusinessProfile {
  slug: string;
  title: string;
  objective: string;
  definitionOfDone: string;
  steps: Array<{ id: string; title: string; objective: string; dependsOn?: string[]; evidenceRequired?: string[]; compensationObjective?: string }>;
  wait?: "timer" | "provider_event" | "approval";
  uncertainWrite?: boolean;
  replan?: boolean;
  pauseAndResume?: boolean;
}

const receipt = ["kind:tool_receipt"];

const BUSINESS_PROFILES: BusinessProfile[] = [
  {
    slug: "lost-deal-revival",
    title: "Revive stalled enterprise opportunities",
    objective: "Find former prospects with new buying signals, prepare a tailored revival, and keep each opportunity moving until a verified next step exists.",
    definitionOfDone: "The shortlist is researched, saved, approved outreach is verified, replies are processed, and every opportunity has a durable next action.",
    wait: "provider_event",
    replan: true,
    steps: [
      { id: "signals", title: "Find buying signals", objective: "Identify former opportunities with fresh funding, hiring, leadership, or product signals.", evidenceRequired: receipt },
      { id: "research", title: "Research accounts", objective: "Understand why each opportunity stalled and what changed.", dependsOn: ["signals"], evidenceRequired: receipt },
      { id: "shortlist", title: "Shortlist accounts", objective: "Rank the strongest accounts and preserve the decision criteria.", dependsOn: ["research"], evidenceRequired: receipt },
      { id: "save-crm", title: "Save revival list", objective: "Persist the verified shortlist to the business system.", dependsOn: ["shortlist"], evidenceRequired: receipt },
      { id: "approve-outreach", title: "Approve outreach", objective: "Wait for owner approval before sending the tailored revival message.", dependsOn: ["save-crm"], evidenceRequired: receipt },
      { id: "send-outreach", title: "Send outreach", objective: "Send one relevant message per shortlisted opportunity and retain receipts.", dependsOn: ["approve-outreach"], evidenceRequired: receipt, compensationObjective: "Reconcile or compensate an uncertain outbound message." },
      { id: "wait-replies", title: "Wait for replies", objective: "Resume when the exact provider event for the outreach batch arrives.", dependsOn: ["send-outreach"], evidenceRequired: receipt },
      { id: "book-meeting", title: "Advance the conversation", objective: "Prepare the next meeting or verified follow-up from the reply.", dependsOn: ["wait-replies"], evidenceRequired: receipt },
    ],
  },
  {
    slug: "support-incident",
    title: "Resolve a customer-impacting incident",
    objective: "Investigate an alert, coordinate the response, communicate safely, and close the incident with a verified postmortem.",
    definitionOfDone: "The incident is triaged, the owner-approved communication is sent, recovery is verified, and the postmortem is stored.",
    wait: "human_input",
    pauseAndResume: true,
    steps: [
      { id: "triage", title: "Triage alert", objective: "Classify the incident and preserve the first evidence.", evidenceRequired: receipt },
      { id: "impact", title: "Measure impact", objective: "Measure affected customers and services using bounded observations.", dependsOn: ["triage"], evidenceRequired: receipt },
      { id: "parallel-status", title: "Gather status", objective: "Gather service and customer-success status in one bounded branch.", dependsOn: ["impact"], evidenceRequired: receipt },
      { id: "parallel-comms", title: "Draft communication", objective: "Prepare a truthful customer update without sending it yet.", dependsOn: ["impact"], evidenceRequired: receipt },
      { id: "join-response", title: "Join response", objective: "Join the independent status and communication branches.", dependsOn: ["parallel-status", "parallel-comms"], evidenceRequired: receipt },
      { id: "owner-input", title: "Confirm recovery", objective: "Wait for the incident owner to confirm the recovery decision.", dependsOn: ["join-response"], evidenceRequired: receipt },
      { id: "postmortem", title: "Publish postmortem", objective: "Store the verified timeline, impact, and corrective actions.", dependsOn: ["owner-input"], evidenceRequired: receipt },
    ],
  },
  {
    slug: "candidate-hiring",
    title: "Run a hiring campaign",
    objective: "Find, qualify, and move suitable candidates through an approved hiring process without losing state between interviews.",
    definitionOfDone: "Candidates are sourced, evaluated, scheduled, approved decisions are recorded, and the chosen candidate has a verified next step.",
    wait: "timer",
    steps: [
      { id: "source", title: "Source candidates", objective: "Build a candidate list that matches the role requirements.", evidenceRequired: receipt },
      { id: "score", title: "Score candidates", objective: "Evaluate candidates against the role rubric and preserve the rationale.", dependsOn: ["source"], evidenceRequired: receipt },
      { id: "screen", title: "Screen candidates", objective: "Prepare the strongest candidates for interviews.", dependsOn: ["score"], evidenceRequired: receipt },
      { id: "schedule", title: "Schedule interviews", objective: "Wait through the scheduling window before checking interview responses.", dependsOn: ["screen"], evidenceRequired: receipt },
      { id: "interview", title: "Process interviews", objective: "Record interview outcomes and identify the strongest fit.", dependsOn: ["schedule"], evidenceRequired: receipt },
      { id: "offer", title: "Prepare offer", objective: "Prepare the offer for review without sending it automatically.", dependsOn: ["interview"], evidenceRequired: receipt },
      { id: "onboard", title: "Start onboarding", objective: "Complete the verified first onboarding handoff.", dependsOn: ["offer"], evidenceRequired: receipt },
    ],
  },
  {
    slug: "invoice-reconciliation",
    title: "Reconcile vendor invoices",
    objective: "Match invoices to purchase records, resolve exceptions, and prepare only verified payments for approval.",
    definitionOfDone: "Every invoice is matched or explicitly excepted, uncertain writes are reconciled, and the payment batch is ready for approval.",
    uncertainWrite: true,
    steps: [
      { id: "ingest", title: "Ingest invoices", objective: "Collect the bounded invoice batch and preserve source references.", evidenceRequired: receipt },
      { id: "match", title: "Match purchase records", objective: "Match invoices to purchase orders and receipts.", dependsOn: ["ingest"], evidenceRequired: receipt },
      { id: "exceptions", title: "Resolve exceptions", objective: "Separate mismatches from invoices safe to include.", dependsOn: ["match"], evidenceRequired: receipt },
      { id: "prepare-batch", title: "Prepare payment batch", objective: "Create one idempotent payment batch intent.", dependsOn: ["exceptions"], evidenceRequired: receipt, compensationObjective: "Reconcile or compensate an uncertain payment batch." },
      { id: "approve-batch", title: "Approve batch", objective: "Wait for exact owner approval before external payment execution.", dependsOn: ["prepare-batch"], evidenceRequired: receipt },
      { id: "verify", title: "Verify ledger", objective: "Read back the final ledger state and close only verified invoices.", dependsOn: ["approve-batch"], evidenceRequired: receipt },
    ],
  },
  {
    slug: "customer-onboarding",
    title: "Onboard a new business customer",
    objective: "Coordinate setup, training, integration checks, and a first-value review over multiple days.",
    definitionOfDone: "The customer setup is verified, training is recorded, the integration is healthy, and the next success milestone is scheduled.",
    wait: "provider_event",
    steps: [
      { id: "intake", title: "Collect requirements", objective: "Capture the customer's goals, users, and integration requirements.", evidenceRequired: receipt },
      { id: "workspace", title: "Prepare workspace", objective: "Prepare the customer workspace and preserve its configuration receipt.", dependsOn: ["intake"], evidenceRequired: receipt },
      { id: "integrate", title: "Connect systems", objective: "Start the external integration and wait for its exact completion event.", dependsOn: ["workspace"], evidenceRequired: receipt },
      { id: "train", title: "Train users", objective: "Record training completion and unresolved questions.", dependsOn: ["integrate"], evidenceRequired: receipt },
      { id: "first-value", title: "Verify first value", objective: "Verify the first customer outcome and preserve the next success action.", dependsOn: ["train"], evidenceRequired: receipt },
    ],
  },
  {
    slug: "security-review",
    title: "Prepare a security review",
    objective: "Collect evidence, identify gaps, request owner decisions, and produce a reviewable security packet.",
    definitionOfDone: "The packet contains sourced evidence, unresolved gaps, explicit approvals, and a durable remediation plan.",
    wait: "approval",
    steps: [
      { id: "scope", title: "Scope review", objective: "Define the systems, data, and controls in scope.", evidenceRequired: receipt },
      { id: "evidence-a", title: "Collect access evidence", objective: "Collect access-control evidence in an independent branch.", dependsOn: ["scope"], evidenceRequired: receipt },
      { id: "evidence-b", title: "Collect retention evidence", objective: "Collect retention and deletion evidence in an independent branch.", dependsOn: ["scope"], evidenceRequired: receipt },
      { id: "join", title: "Join evidence", objective: "Combine the independent evidence branches without losing provenance.", dependsOn: ["evidence-a", "evidence-b"], evidenceRequired: receipt },
      { id: "remediate", title: "Plan remediation", objective: "Prepare a bounded remediation plan for each gap.", dependsOn: ["join"], evidenceRequired: receipt },
      { id: "approve", title: "Approve remediation", objective: "Wait for owner approval of the exact remediation plan.", dependsOn: ["remediate"], evidenceRequired: receipt },
      { id: "packet", title: "Finalize packet", objective: "Produce the reviewable security packet and preserve the remaining open risks.", dependsOn: ["approve"], evidenceRequired: receipt },
    ],
  },
  {
    slug: "content-launch",
    title: "Coordinate a product launch",
    objective: "Prepare launch assets, coordinate review, wait for the scheduled window, and verify the public release.",
    definitionOfDone: "All launch assets are reviewed, the release is approved, the window is respected, and the public result is verified.",
    wait: "timer",
    replan: true,
    steps: [
      { id: "brief", title: "Create launch brief", objective: "Define audience, message, assets, and release criteria.", evidenceRequired: receipt },
      { id: "copy", title: "Prepare copy", objective: "Prepare the launch copy and preserve its review status.", dependsOn: ["brief"], evidenceRequired: receipt },
      { id: "creative", title: "Prepare creative", objective: "Prepare the launch creative in an independent branch.", dependsOn: ["brief"], evidenceRequired: receipt },
      { id: "qa", title: "Run launch QA", objective: "Join copy and creative and verify launch readiness.", dependsOn: ["copy", "creative"], evidenceRequired: receipt },
      { id: "approve", title: "Approve release", objective: "Wait for the exact release approval.", dependsOn: ["qa"], evidenceRequired: receipt },
      { id: "window", title: "Wait for release window", objective: "Sleep until the approved release window, then verify it has arrived.", dependsOn: ["approve"], evidenceRequired: receipt },
      { id: "verify", title: "Verify release", objective: "Read back the public release and close only when it is visible.", dependsOn: ["window"], evidenceRequired: receipt },
    ],
  },
  {
    slug: "renewal-risk",
    title: "Protect an at-risk customer renewal",
    objective: "Detect renewal risk, understand the account, prepare a save plan, and continue through the customer's response.",
    definitionOfDone: "Risk is evidenced, the save plan is reviewed, the customer response is processed, and a verified next action is recorded.",
    wait: "provider_event",
    steps: [
      { id: "detect", title: "Detect risk", objective: "Identify usage, support, leadership, and renewal signals.", evidenceRequired: receipt },
      { id: "diagnose", title: "Diagnose account", objective: "Understand the customer's blockers and desired outcomes.", dependsOn: ["detect"], evidenceRequired: receipt },
      { id: "plan", title: "Prepare save plan", objective: "Prepare a specific plan tied to the customer's blockers.", dependsOn: ["diagnose"], evidenceRequired: receipt },
      { id: "approve", title: "Approve save plan", objective: "Wait for owner approval before making a material concession or commitment.", dependsOn: ["plan"], evidenceRequired: receipt },
      { id: "outreach", title: "Reach out", objective: "Start the customer conversation and preserve the provider receipt.", dependsOn: ["approve"], evidenceRequired: receipt },
      { id: "response", title: "Process response", objective: "Resume on the exact customer response and record the next action.", dependsOn: ["outreach"], evidenceRequired: receipt },
    ],
  },
  {
    slug: "data-migration",
    title: "Migrate a customer data set",
    objective: "Move a large data set in resumable batches, survive partial failures, and finish with a read-back verification.",
    definitionOfDone: "Every batch has a durable checkpoint and verified receipt, failed batches are retried safely, and the destination count is reconciled.",
    steps: Array.from({ length: 10 }, (_, index) => ({
      id: `batch-${index + 1}`,
      title: `Migrate batch ${index + 1}`,
      objective: `Move and verify data batch ${index + 1} without repeating a committed external write.`,
      ...(index ? { dependsOn: [`batch-${index}`] } : {}),
      evidenceRequired: receipt,
      ...(index === 4 ? { compensationObjective: "Reconcile the ambiguous migration batch before retrying." } : {}),
    })),
    uncertainWrite: true,
  },
  {
    slug: "partner-program",
    title: "Build a referral partner pipeline",
    objective: "Find, qualify, save, and engage referral partners while preserving approval and follow-up state.",
    definitionOfDone: "The partner list is qualified, saved, approved outreach is verified, and each response has a concrete next step.",
    wait: "provider_event",
    steps: [
      { id: "discover", title: "Discover partners", objective: "Find companies serving the target customer base.", evidenceRequired: receipt },
      { id: "rank-a", title: "Rank partner fit", objective: "Rank partners by overlap and strategic fit in one branch.", dependsOn: ["discover"], evidenceRequired: receipt },
      { id: "rank-b", title: "Rank partner reach", objective: "Rank partners by reach and activation potential in another branch.", dependsOn: ["discover"], evidenceRequired: receipt },
      { id: "join", title: "Join partner shortlist", objective: "Combine both ranking signals and preserve the shortlist.", dependsOn: ["rank-a", "rank-b"], evidenceRequired: receipt },
      { id: "save", title: "Save partner pipeline", objective: "Save the verified partner pipeline to the connected workspace.", dependsOn: ["join"], evidenceRequired: receipt },
      { id: "approve", title: "Approve partner outreach", objective: "Wait for owner approval of the partnership angle.", dependsOn: ["save"], evidenceRequired: receipt },
      { id: "outreach", title: "Start partner conversation", objective: "Send the approved partnership introduction once.", dependsOn: ["approve"], evidenceRequired: receipt },
      { id: "response", title: "Process partner response", objective: "Resume from the exact response and preserve the next meeting action.", dependsOn: ["outreach"], evidenceRequired: receipt },
    ],
  },
];

function context(queue: MissionFakeQStash, runAgent: NonNullable<TaskSliceContext["runAgent"]>): TaskSliceContext {
  return {
    attempt: 0,
    workflowRunId: "business-gauntlet-worker",
    enqueueMissionTask: queue.enqueue,
    runAgent,
    sdkTaskMessage: async (task) => task?.objective ?? "",
    sdkTaskSkillInstructions: async () => undefined,
    sdkDurationSeconds: () => undefined,
    sendMessage: async () => undefined,
    withUserLock: async (_userId, _signal, work) => work(),
  };
}

function activeStep(mission: MissionRecord): string {
  const id = mission.activeStepIds?.[0] ?? mission.currentStepId;
  assert.ok(id, `Mission ${mission.id} has no active step.`);
  return id;
}

function deterministicRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

async function completeWithTrustedReceipt(userId: number, missionId: string, stepId: string, runtime: { taskId?: string; missionId?: string; missionStepId?: string; enqueueMissionTask: MissionFakeQStash["enqueue"] }): Promise<void> {
  await recordTrustedMissionEvidence(userId, missionId, [{
    id: `gauntlet-receipt-${missionId}-${stepId}`,
    kind: "tool_receipt",
    summary: `Trusted provider receipt for ${stepId}.`,
    source: "gauntlet://provider",
    ref: `gauntlet:${missionId}:${stepId}`,
    verified: true,
  }], stepId);
  await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: missionId, stepId, result: `Verified business outcome for ${stepId}.` }, runtime);
}

async function runBusinessProfile(profile: BusinessProfile, index: number): Promise<{ slices: number; effects: number; waits: number; approvals: number }> {
  const userId = 1_100_000 + index;
  const clock = new MissionFakeClock(Date.UTC(2026, 0, 1, 8));
  clock.installTimers();
  try {
    const queue = new MissionFakeQStash();
    const next = deterministicRandom(index * 7919 + profile.slug.length);
    const mission = await createMission(userId, {
      id: `mis_gauntlet_${profile.slug}_${index}`,
      title: profile.title,
      objective: profile.objective,
      definitionOfDone: profile.definitionOfDone,
      verificationMode: "strict",
      requiredEvidence: receipt,
      budget: {
        durationMode: "active",
        maxDurationSeconds: 30 * 60 * 60,
        maxLifetimeSeconds: 30 * 86400,
        maxSteps: 100,
        maxSlices: 500,
        maxToolCalls: 500,
        maxCost: 50,
      },
      steps: profile.steps,
    });
    assert.equal((await startMission(userId, mission.id))?.status, "running");
    await reconcileMissionExecution(userId, mission.id, queue.enqueue);

    const flags = new Set<string>();
    const effects = new Set<string>();
    let waits = 0;
    let approvals = 0;
    let slices = 0;
    let replanned = false;
    let lostPublication = false;

    const runAgent = async (...args: any[]) => {
      const options = args[9] as { taskId?: string; missionId?: string; missionStepId?: string; missionTimerResumed?: boolean };
      assert.equal(options.missionId, mission.id);
      assert.ok(options.taskId && options.missionStepId);
      const stepId = options.missionStepId!;
      const step = profile.steps.find((candidate) => candidate.id === stepId);
      assert.ok(step, `Unknown step ${stepId} in ${profile.slug}`);
      const runtime = { taskId: options.taskId, missionId: mission.id, missionStepId: stepId, enqueueMissionTask: queue.enqueue };
      const flag = (name: string): boolean => {
        const key = `${stepId}:${name}`;
        if (flags.has(key)) return false;
        flags.add(key);
        return true;
      };

      if (profile.wait === "timer" && (stepId === "schedule" || stepId === "window") && flag("timer")) {
        let request: TaskWaitRequest | undefined;
        await nativeTool(userId, "CHUCK_MISSION_CHECKPOINT", { id: mission.id, checkpoint: `${stepId}:window-prepared`, nextAction: `Verify ${stepId} after the durable window.` }, runtime);
        await nativeTool(userId, "CHUCK_TASK_WAIT", { delaySeconds: 60 + (index % 61), checkpoint: `${stepId}:window-prepared`, nextAction: `Verify ${stepId} after the durable window.` }, { ...runtime, requestTaskWait: (value) => { request = value; } });
        assert.ok(request);
        waits++;
        return { text: `The ${step.title} window is durably parked.`, toolsUsed: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_TASK_WAIT"], toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT", "CHUCK_TASK_WAIT"], taskWait: request };
      }

      if (profile.wait === "provider_event" && (stepId === "wait-replies" || stepId === "integrate" || stepId === "response" || stepId === "wait-replies") && flag("event")) {
        let request: MissionWaitRequest | undefined;
        const eventId = `gauntlet-event-${profile.slug}-${index}-${stepId}`;
        await nativeTool(userId, "CHUCK_MISSION_WAIT_EVENT", { id: mission.id, stepId, provider: "gauntlet-provider", providerEventId: eventId, timeoutSeconds: 900, checkpoint: `${stepId}:waiting`, nextAction: `Continue ${stepId} after ${eventId}.` }, { ...runtime, requestMissionWait: (value) => { request = value; } });
        assert.ok(request);
        waits++;
        return { text: `Waiting for the exact ${step.title} callback.`, toolsUsed: ["CHUCK_MISSION_WAIT_EVENT"], toolsSucceeded: ["CHUCK_MISSION_WAIT_EVENT"], missionWait: request };
      }

      if (profile.wait === "approval" && (stepId === "approve" || stepId === "approve-outreach" || stepId === "approve-batch" || stepId === "offer") && flag("approval")) {
        const approval = await createApproval({ userId, missionId: mission.id, toolSlug: "GAUNTLET_APPROVED_ACTION", args: { missionId: mission.id, stepId, decision: "continue" }, request: `Approve the exact ${step.title} action.`, history: [], model: "test/gauntlet" });
        approvals++;
        throw new ApprovalRequiredError(approval.id, approval.toolSlug, approval.args);
      }

      if (profile.slug === "support-incident" && stepId === "owner-input" && flag("human")) {
        const waiting = await blockMission(userId, mission.id, "Incident owner input is required before recovery can be confirmed.", "Confirm the recovery decision, then resume this mission.");
        assert.equal(waiting?.status, "blocked");
        return { text: "The incident is blocked for owner confirmation.", toolsUsed: [], toolsSucceeded: [] };
      }

      if (profile.uncertainWrite && (stepId === "send-outreach" || stepId === "prepare-batch" || stepId === "batch-5") && flag("external")) {
        const claim = await beginExternalAction({ userId, provider: "gauntlet", tool: "GAUNTLET_EXTERNAL_WRITE", args: { missionId: mission.id, stepId }, runId: `gauntlet-${profile.slug}-${index}`, source: { kind: "mission", id: mission.id, missionStepId: stepId } });
        assert.equal(claim.state, "new");
        effects.add(claim.logicalActionId);
        // Advance through the installed timer queue so task, mission, and
        // account-lock heartbeats execute while the provider call is in
        // flight. A synchronous clock jump would model a frozen process,
        // which is a different crash test covered separately.
        await clock.advanceAsync(31 * 60_000);
        const ambiguous = await beginExternalAction({ userId, provider: "gauntlet", tool: "GAUNTLET_EXTERNAL_WRITE", args: { missionId: mission.id, stepId }, runId: `gauntlet-retry-${profile.slug}-${index}`, source: { kind: "mission", id: mission.id, missionStepId: stepId } });
        assert.equal(ambiguous.state, "ambiguous");
        const reconciled = await reconcileExternalActionByRead({ userId, logicalActionId: claim.logicalActionId, evidenceRef: `gauntlet-read:${mission.id}:${stepId}`, summary: "The provider read-back confirms the external write.", verifiedAt: clock.now });
        assert.equal(reconciled?.status, "succeeded");
      }

      // Every successful step gets a server-trusted receipt before completion;
      // the model cannot close a strict mission with prose alone.
      if (!effects.has(`${stepId}:completed`)) {
        await completeWithTrustedReceipt(userId, mission.id, stepId, runtime);
        effects.add(`${stepId}:completed`);
      }
      return { text: `${step.title} verified.`, toolsUsed: ["CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: ["CHUCK_MISSION_STEP_COMPLETE"] };
    };

    const dependencies = context(queue, runAgent);
    let guard = 0;
    while ((await getMission(userId, mission.id))?.status !== "completed") {
      assert.ok(++guard < 600, `${profile.slug} must not spin or strand a continuation`);
      let current = await getMission(userId, mission.id);
      assert.ok(current);

      if (current.status === "blocked" && profile.slug === "support-incident" && current.nextAction?.includes("Confirm the recovery")) {
        await resumeMissionAndSchedule(userId, mission.id, queue.enqueue);
        current = await getMission(userId, mission.id);
        assert.equal(current?.status, "running");
      }
      if (current.status === "waiting" && current.waiting?.kind === "timer") {
        assert.equal(await resumeMissionAndSchedule(userId, mission.id, queue.enqueue).then((value) => value?.status), "waiting");
        clock.advance(Math.max(1, current.waiting.runAt! - clock.now));
        await resumeMissionAndSchedule(userId, mission.id, queue.enqueue);
      } else if (current.status === "waiting" && current.waiting?.kind === "provider_event") {
        const waiting = current.waiting;
        assert.equal(await resumeMissionFromProviderEvent(userId, mission.id, "wrong-provider", waiting.providerEventId!), undefined);
        assert.equal(await resumeMissionFromProviderEvent(userId, mission.id, waiting.provider!, `wrong-${waiting.providerEventId}`), undefined);
        assert.ok(await resumeMissionFromProviderEvent(userId, mission.id, waiting.provider!, waiting.providerEventId!));
        assert.ok(await resumeMissionFromProviderEvent(userId, mission.id, waiting.provider!, waiting.providerEventId!));
        await reconcileMissionExecution(userId, mission.id, queue.enqueue);
      } else if (current.status === "waiting" && current.waiting?.kind === "approval") {
        const approvalId = current.waiting.key!;
        assert.equal(await resumeMissionFromApproval(userId, mission.id, approvalId), undefined);
        assert.ok(await claimApproval(userId, approvalId));
        const [first, replay] = await Promise.all([
          resumeMissionTaskAfterApproval(userId, approvalId, queue.enqueue),
          resumeMissionTaskAfterApproval(userId, approvalId, queue.enqueue),
        ]);
        assert.ok(first.status === "resumed" || first.status === "already_queued" || replay.status === "resumed" || replay.status === "already_queued");
      }

      current = await getMission(userId, mission.id);
      assert.ok(current);
      if (current.status === "completed") break;
      assert.equal(current.status, "running", `${profile.slug} entered unexpected ${current.status}: ${current.error ?? ""}`);

      if (profile.pauseAndResume && !flags.has("mission:paused") && current.consumedSteps >= 2) {
        flags.add("mission:paused");
        const paused = await import("../src/store.js").then(({ pauseMission }) => pauseMission(userId, mission.id, "Owner paused the incident to inspect the impact."));
        assert.equal(paused?.status, "paused");
        assert.equal((await reconcileMissionExecution(userId, mission.id, queue.enqueue))?.status, "paused");
        assert.equal((await resumeMissionAndSchedule(userId, mission.id, queue.enqueue))?.status, "running");
      }

      if (profile.replan && !replanned && current.consumedSteps >= 2) {
        replanned = true;
        const replannedSteps = profile.steps.map((step) => step.id === "book-meeting"
          ? { ...step, objective: "Prepare the next meeting, including the new qualification requirement, from the reply." }
          : step);
        await replanMissionAndSchedule(userId, mission.id, replannedSteps, "A new verified business requirement changed the unfinished work.", queue.enqueue);
      }

      const tasks = await listTasksForMission(userId, mission.id);
      const activeIds = new Set(current.activeStepIds?.length ? current.activeStepIds : current.currentStepId ? [current.currentStepId] : []);
      const activeTasks = tasks.filter((task) => activeIds.has(task.missionStepId ?? "") && !["completed", "cancelled"].includes(task.status));
      assert.ok(activeTasks.length > 0, `${profile.slug} lost its active task frontier`);

      if (!lostPublication && activeTasks[0]) {
        const task = await getTask(userId, activeTasks[0].id);
        if (task?.status === "queued" && task.workflowPublishedAt !== undefined) {
          lostPublication = true;
          const lostIndex = queue.deliveries.findIndex((delivery) => delivery.taskId === task.id);
          assert.ok(lostIndex >= 0, `${profile.slug} must have a queued publication to lose`);
          queue.drop(lostIndex);
          clock.advance(61_000);
          const report = await recoverMissionsForOwner(userId, queue.enqueue, { now: clock.now });
          assert.ok(report.republished >= 1 || report.repaired >= 1, `${profile.slug} did not recover the lost publication`);
        }
      }

      let dueIndex = queue.deliveries.findIndex((delivery) => delivery.runAt <= clock.now);
      if (dueIndex < 0) {
        const nextWake = Math.min(...queue.deliveries.map((delivery) => delivery.runAt));
        assert.ok(Number.isFinite(nextWake), `${profile.slug} lost all future wakes`);
        clock.advance(Math.max(1, nextWake - clock.now));
        dueIndex = queue.deliveries.findIndex((delivery) => delivery.runAt <= clock.now);
      }
      assert.ok(dueIndex >= 0);
      const delivery = queue.deliveries.splice(dueIndex, 1)[0]!;
      const run = await executeDurableTask({ userId, taskId: delivery.taskId }, {
        workerId: `gauntlet-${profile.slug}-${index}-${slices++}`,
        execute: (task, signal) => executeTaskSlice(task, signal, dependencies),
      });
      // At-least-once delivery means a duplicate may arrive after another
      // worker already claimed or completed the same task. The runner's
      // claimed=false result is the safe, expected no-op for that replay.
      if (!run.claimed) continue;
      if (!run.task) {
        const persisted = await getTask(userId, delivery.taskId);
        assert.ok(persisted, "A claimed task must remain inspectable after a stale settlement.");
        assert.ok(["queued", "completed", "blocked", "failed", "cancelled"].includes(persisted.status), `A stale settlement cannot leave a task running: ${JSON.stringify({ profile: profile.slug, taskId: delivery.taskId, status: persisted.status, lease: persisted.lease, workflowRunId: persisted.workflowRunId, nextAction: persisted.nextAction })}`);
        continue;
      }
      assert.ok(!["failed"].includes(run.task.status), `${profile.slug} worker failed: ${run.task.error ?? "unknown"}`);
      if (run.task.status === "queued" && run.task.runAt !== undefined) await enqueueTaskWithClaim(userId, run.task.id, run.task.runAt, queue.enqueue);

      if (next() > 0.35 && queue.deliveries.length) queue.duplicate(Math.floor(next() * queue.deliveries.length));
      if (next() > 0.55) queue.reverse();
    }

    const completed = await getMission(userId, mission.id);
    assert.equal(completed?.status, "completed", `${profile.slug} did not complete: ${completed?.error ?? completed?.nextAction ?? "unknown"}`);
    assert.equal(completed?.steps.every((step) => step.status === "completed"), true);
    assert.equal(completed?.verification?.verified, true);
    assert.equal(completed?.waiting, undefined);
    assert.ok(completed?.events.some((event) => event.type === "completed"));
    assert.ok(lostPublication, `${profile.slug} must exercise publication recovery`);
    return { slices, effects: effects.size, waits, approvals };
  } finally {
    clock.restore();
  }
}

before(async () => {
  config.jevMode = "off";
  await initStore({ memoryOnly: true });
});

after(() => { config.jevMode = "off"; });

test("real business mission profiles survive composed waits, approvals, re-plans, provider ambiguity, queue loss, and replay", { timeout: 240_000 }, async () => {
  const report: Array<{ slug: string; slices: number; effects: number; waits: number; approvals: number }> = [];
  // Five deterministic schedules per business profile vary duplicate delivery,
  // reverse delivery order, timer lateness, and the point at which a lost
  // publication is recovered. Together with the existing one-hundred-case
  // chaos suite this gives the engine a broad matrix without random flakes.
  for (let variant = 0; variant < 5; variant++) {
    for (const [profileIndex, profile] of BUSINESS_PROFILES.entries()) {
      const index = variant * BUSINESS_PROFILES.length + profileIndex;
      report.push({ slug: `${profile.slug}#${variant + 1}`, ...(await runBusinessProfile(profile, index)) });
    }
  }
  assert.equal(report.length, BUSINESS_PROFILES.length * 5);
  assert.ok(report.reduce((total, item) => total + item.slices, 0) >= BUSINESS_PROFILES.length * 5 * 5);
  assert.ok(report.some((item) => item.waits > 0));
  assert.ok(report.some((item) => item.approvals > 0));
  assert.ok(report.some((item) => item.effects > 0));
});

test("mission control remains owner-scoped during concurrent business work", async () => {
  const ownerA = 1_200_001;
  const ownerB = 1_200_002;
  const queue = new MissionFakeQStash();
  const mission = await createMission(ownerA, {
    title: "Private customer migration",
    objective: "Move only owner A's customer data.",
    definitionOfDone: "Owner A's migration is verified.",
    steps: [{ id: "move", title: "Move", objective: "Move the private data.", evidenceRequired: receipt }],
  });
  await startMission(ownerA, mission.id);
  await reconcileMissionExecution(ownerA, mission.id, queue.enqueue);
  assert.equal(await getMission(ownerB, mission.id), undefined);
  assert.equal(await resumeMissionFromProviderEvent(ownerB, mission.id, "gauntlet-provider", "event"), undefined);
  assert.equal(await cancelMission(ownerB, mission.id, "cross-owner cancellation"), undefined);
  const ownerAState = await getMission(ownerA, mission.id);
  assert.equal(ownerAState?.status, "running");
});

test("expired provider callbacks block instead of reviving a stale business mission", async () => {
  const userId = 1_200_003;
  const clock = new MissionFakeClock(Date.UTC(2026, 0, 1, 8));
  clock.install();
  try {
    const queue = new MissionFakeQStash();
    const mission = await createMission(userId, { title: "Expired vendor callback", objective: "Wait for the vendor result.", definitionOfDone: "Vendor result reconciled.", steps: [{ id: "vendor", title: "Vendor", objective: "Wait for vendor callback.", evidenceRequired: receipt }] });
    await startMission(userId, mission.id);
    await reconcileMissionExecution(userId, mission.id, queue.enqueue);
    const expiresAt = clock.now + 60_000;
    const waiting = await import("../src/store.js").then(({ waitMission }) => waitMission(userId, mission.id, { kind: "provider_event", provider: "vendor", providerEventId: "vendor-event-1", stepId: "vendor", expiresAt }, "Vendor intent saved", "Wait for vendor-event-1."));
    assert.equal(waiting?.status, "waiting");
    clock.advance(61_000);
    assert.equal(await resumeMissionFromProviderEvent(userId, mission.id, "vendor", "vendor-event-1"), undefined);
    const report = await recoverMissionsForOwner(userId, mission.id, queue.enqueue, { now: clock.now });
    assert.equal(report.blocked, 1);
    const blocked = await getMission(userId, mission.id);
    assert.equal(blocked?.status, "blocked");
    assert.match(blocked?.nextAction ?? "", /reconcile|resume|replan/i);
  } finally {
    clock.restore();
  }
});
