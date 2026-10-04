import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { claimTask, checkpointMission, createTask, initStore, createMission, getMission, listMissions, listTasks, retryTask, settleTaskRun, startMission, completeMission, completeMissionStep, recordMissionEvidence, recordTrustedMissionEvidence, replanMission, updateTask, verifyMission, missionBudgetPreflight, resumeMission, waitMission } from "../src/store.js";
import { contextPrompt, selectContext, upsertContextNode } from "../src/contextGraph.js";
import { createDepartmentHandoff, provisionDepartment } from "../src/departments.js";
import { getOutcomePackage, planOutcome } from "../src/outcomes/catalog.js";
import { resumeMissionAndSchedule, scheduleMissionSteps } from "../src/missionScheduler.js";
import { nativeTool } from "../src/nativeTools.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("context graph selects purpose-scoped, non-expired, non-sensitive context", async () => {
  const userId = 972001;
  await upsertContextNode(userId, { scope: "department", scopeId: "sales", kind: "decision", key: "ICP", value: "Fintech companies with 50+ employees", sensitivity: "normal", confidence: 0.9 });
  await upsertContextNode(userId, { scope: "department", scopeId: "sales", kind: "fact", key: "secret", value: "do not expose", sensitivity: "sensitive" });
  await upsertContextNode(userId, { scope: "department", scopeId: "sales", kind: "fact", key: "expired", value: "old", sensitivity: "normal", expiresAt: Date.now() - 1 });
  const nodes = await selectContext(userId, { scope: "department", scopeId: "sales", purpose: "sales" });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].key, "ICP");
  assert.match(await contextPrompt(userId, { purpose: "sales" }), /50\+ employees/);
});

test("department spaces and typed handoffs persist by owner", async () => {
  const userId = 972002;
  const department = await provisionDepartment(userId, "marketing", { approvedTools: ["COMPOSIO_SEARCH_WEB"] });
  const packet = await createDepartmentHandoff(userId, { department: "marketing", objective: "Prepare campaign brief", inputs: { campaign: "launch" }, constraints: ["Use approved claims"], evidenceRequired: ["source URLs"], toAgent: "maya" });
  assert.equal(department.department, "marketing");
  assert.equal(packet.status, "queued");
  assert.equal((await provisionDepartment(userId + 1, "marketing")).id === department.id, false);
});

test("outcome packages plan typed work and expose missing inputs", () => {
  const outcome = getOutcomePackage("qualified-fintech-leads");
  assert.ok(outcome);
  const plan = planOutcome("qualified-fintech-leads", { "ideal customer profile": "B2B fintech" });
  assert.ok(plan.missingInputs.includes("target geography"));
  assert.equal(plan.steps.at(-1)?.id, "verify");
  assert.match(plan.definitionOfDone, /Every lead/);
});

test("mission supports parallel ready steps, preflight budgets, and evidence verification", async () => {
  const userId = 972003;
  const mission = await createMission(userId, { title: "Launch", objective: "Prepare launch", definitionOfDone: "Two tracks are verified", requiredEvidence: ["source"], steps: [
    { id: "research", title: "Research", objective: "Research", parallelGroup: "prep" },
    { id: "design", title: "Design", objective: "Design", parallelGroup: "prep" },
    { id: "review", title: "Review", objective: "Review", dependsOn: ["research", "design"] },
  ] });
  const started = await startMission(userId, mission.id);
  assert.deepEqual(started?.activeStepIds?.sort(), ["design", "research"]);
  assert.equal(missionBudgetPreflight(started!, { toolCalls: 1 }).allowed, true);
  const first = await completeMissionStep(userId, mission.id, "research", "Research done");
  assert.equal(first?.steps.find((step) => step.id === "review")?.status, "pending");
  const second = await completeMissionStep(userId, mission.id, "design", "Design done");
  assert.equal(second?.steps.find((step) => step.id === "review")?.status, "running");
  await recordTrustedMissionEvidence(userId, mission.id, [{ id: "source-1", kind: "source", summary: "source verified", ref: "https://example.test/source", verified: true, verifiedBy: "system" }]);
  const verified = await verifyMission(userId, mission.id);
  assert.equal(verified?.verification?.verified, false); // review still has not completed
  await completeMissionStep(userId, mission.id, "review", "Review done");
  const done = await verifyMission(userId, mission.id);
  assert.equal(done?.verification?.verified, true);
  assert.equal((await getMission(userId, mission.id))?.events.some((event) => event.type === "step_completed"), true);
});

test("mission scheduler materializes each parallel branch as an idempotent durable task", async () => {
  const userId = 972004;
  const mission = await createMission(userId, { title: "Parallel work", objective: "Run independent tracks", definitionOfDone: "Both tracks complete", steps: [
    { id: "a", title: "Track A", objective: "A", allowedTools: ["GMAIL_SEND_EMAIL"] },
    { id: "b", title: "Track B", objective: "B" },
  ] });
  const started = await startMission(userId, mission.id);
  const enqueued: string[] = [];
  const linked = await scheduleMissionSteps(userId, started!, async (_owner, taskId) => { enqueued.push(taskId); return `qstash_${taskId}`; });
  assert.equal(enqueued.length, 2);
  assert.equal((await listTasks(userId)).filter((task) => task.missionId === mission.id).length, 2);
  assert.deepEqual((await listTasks(userId)).find((task) => task.missionStepId === "a")?.missionAllowedTools, ["GMAIL_SEND_EMAIL"]);
  assert.equal(linked?.steps.every((step) => Boolean(step.taskId)), true);
  const again = await scheduleMissionSteps(userId, linked!, async (_owner, taskId) => { enqueued.push(taskId); return `duplicate_${taskId}`; });
  assert.equal(enqueued.length, 2);
  assert.equal(again?.rootTaskId, linked?.rootTaskId);
  assert.equal(again?.events.length, linked?.events.length, "an idempotent schedule replay does not append duplicate progress events");
});

test("mission step completion rejects missing required trusted evidence", async () => {
  const userId = 972006;
  const mission = await createMission(userId, {
    title: "Receipt-gated step",
    objective: "Perform one provider action and retain its receipt.",
    definitionOfDone: "The provider action is complete and its receipt is attached to the step.",
    steps: [{ id: "send", title: "Send", objective: "Send the approved message", evidenceRequired: ["kind:tool_receipt"] }],
  });
  const started = await startMission(userId, mission.id);
  const rejected = await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: started!.currentStepId, result: "The message was sent." }) as { stepCompletion?: string; closeout?: { blockers?: string[] } };
  assert.equal(rejected.stepCompletion, "not_ready");
  assert.match(rejected.closeout?.blockers?.join(" ") ?? "", /trusted evidence/i);
  assert.equal((await getMission(userId, mission.id))?.steps[0]?.status, "running");

  await recordTrustedMissionEvidence(userId, mission.id, [{ id: "receipt-step", kind: "tool_receipt", summary: "Provider confirmed the message", ref: "receipt://send-1", verified: true, verifiedBy: "system" }], "send");
  const completed = await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: "send", result: "The provider receipt confirms delivery." }) as { status: string };
  assert.equal(completed.status, "completed");
});

test("provider tool names in prose step requirements match trusted receipts", async () => {
  const userId = 972010;
  const mission = await createMission(userId, {
    title: "Prose provider receipt",
    objective: "Execute one bounded provider read.",
    definitionOfDone: "The provider read is complete and its trusted receipt is attached.",
    steps: [{
      id: "read",
      title: "Read Gmail",
      objective: "Read a bounded inbox view.",
      evidenceRequired: ["A trusted server receipt for the successful GMAIL_FETCH_EMAILS provider action."],
    }],
  });
  const started = await startMission(userId, mission.id);
  await recordTrustedMissionEvidence(userId, mission.id, [{
    id: "gmail-receipt",
    kind: "tool_receipt",
    summary: "GMAIL_FETCH_EMAILS completed successfully with provider receipt log_test_gmail.",
    source: "composio:GMAIL_FETCH_EMAILS",
    ref: "log_test_gmail",
    verified: true,
    verifiedBy: "system",
    verifiedAt: Date.now(),
  }], "read");
  const completed = await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: started!.currentStepId, result: "The trusted Gmail receipt confirms the read." }) as { status?: string };
  assert.equal(completed.status, "completed");
});

test("strict provider closeout records a system verification after step completion", async () => {
  const userId = 972011;
  const mission = await createMission(userId, {
    title: "System-trusted provider closeout",
    objective: "Execute one bounded provider read and close it with a trusted receipt.",
    definitionOfDone: "The read completed and its server receipt is verified.",
    verificationMode: "strict",
    requiredEvidence: ["Trusted server receipt for GMAIL_FETCH_EMAILS."],
    steps: [{
      id: "read",
      title: "Read Gmail",
      objective: "Read a bounded inbox view.",
      evidenceRequired: ["Trusted server receipt for GMAIL_FETCH_EMAILS."],
    }],
  });
  const started = await startMission(userId, mission.id);
  await recordTrustedMissionEvidence(userId, mission.id, [{
    id: "gmail-receipt-system-closeout",
    kind: "tool_receipt",
    summary: "GMAIL_FETCH_EMAILS completed successfully with provider receipt log_system_closeout.",
    source: "composio:GMAIL_FETCH_EMAILS",
    ref: "log_system_closeout",
    verified: true,
    verifiedBy: "system",
    verifiedAt: Date.now(),
  }], "read");
  const completed = await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: started!.currentStepId, result: "The trusted Gmail receipt confirms the read." }) as { status?: string };
  assert.equal(completed.status, "completed");
  const verified = await verifyMission(userId, mission.id, { verifiedBy: "agent" });
  assert.equal(verified?.verification?.verified, true);
  assert.equal(verified?.verification?.verifiedBy, "system");
});

test("native lifecycle checkpoints satisfy step-local internal evidence without satisfying provider receipts", async () => {
  const userId = 972008;
  const mission = await createMission(userId, {
    title: "Internal checkpoint evidence",
    objective: "Persist a native-only checkpoint before a durable wait.",
    definitionOfDone: "The checkpoint step completes from server-observed lifecycle state.",
    steps: [{ id: "checkpoint", title: "Persist pre-wait checkpoint", objective: "Save the checkpoint before waiting.", evidenceRequired: ["kind:before_after"] }],
  });
  await startMission(userId, mission.id);
  await checkpointMission(userId, mission.id, "pre-wait checkpoint", "Start the durable timer wait.");

  const completed = await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: "checkpoint", result: "Checkpoint persisted." }) as { status?: string; steps?: Array<{ status?: string; evidence?: Array<{ kind?: string; verifiedBy?: string }> }> };
  assert.equal(completed.status, "completed");
  assert.equal(completed.steps?.[0]?.status, "completed");
  assert.ok(completed.steps?.[0]?.evidence?.some((item) => item.kind === "before_after" && item.verifiedBy === "system"));
});

test("prose step requirements accept the server-derived internal checkpoint proof", async () => {
  const userId = 972009;
  const mission = await createMission(userId, {
    title: "Prose checkpoint evidence",
    objective: "Persist and complete an internal pre-wait checkpoint.",
    definitionOfDone: "The checkpoint step completes from server-observed lifecycle state.",
    steps: [{
      id: "checkpoint",
      title: "Persist pre-wait checkpoint",
      objective: "Save the checkpoint before waiting.",
      evidenceRequired: ["Server-derived internal before_after checkpoint proof for the persisted pre-wait checkpoint (mission ID, step count, trusted runtime ISO timestamp). No provider receipt."],
    }],
  });
  const started = await startMission(userId, mission.id);
  await checkpointMission(userId, mission.id, "mission ID=mis_internal, step count=1, trusted runtime ISO timestamp=2026-10-03T00:00:00.000Z", "Complete the persisted pre-wait checkpoint.");
  const completed = await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: mission.id, stepId: started!.currentStepId, result: "The server-observed checkpoint is complete." }) as { status?: string };
  assert.equal(completed.status, "completed");
  assert.equal((await getMission(userId, mission.id))?.steps[0]?.status, "completed");
});

test("mission creation and replanning reject supervisor-owned step tools at the store boundary", async () => {
  const userId = 972007;
  await assert.rejects(() => createMission(userId, {
    title: "Invalid fence",
    objective: "Reject supervisor controls",
    definitionOfDone: "The invalid plan is never stored",
    steps: [{ title: "Bad step", objective: "Attempt to widen authority", allowedTools: ["CHUCK_MISSION_COMPLETE"] }],
  }), /supervisor-owned allowed tool/i);

  const mission = await createMission(userId, { title: "Replan fence", objective: "Reject invalid replans", definitionOfDone: "The original step remains", steps: [{ id: "only", title: "Only", objective: "Run" }] });
  await startMission(userId, mission.id);
  await assert.rejects(() => replanMission(userId, mission.id, [{ id: "only", title: "Only", objective: "Run", allowedTools: ["CHUCK_TASK_WAIT"] }], "Invalid supervisor fence"), /supervisor-owned allowed tool/i);
  assert.deepEqual((await getMission(userId, mission.id))?.steps[0]?.allowedTools, ["CHUCK_FIND_TOOLS"]);
});

test("resuming an already-running mission repairs missing task scheduling without duplicating it", async () => {
  const userId = 972014;
  const mission = await createMission(userId, { title: "Resume recovery", objective: "Continue a running step", definitionOfDone: "The step is completed", steps: [
    { id: "only", title: "Only step", objective: "Continue from the saved checkpoint" },
  ] });
  await startMission(userId, mission.id);
  const enqueued: string[] = [];
  const enqueueMissionTask = async (_ownerId: number, taskId: string) => {
    enqueued.push(taskId);
    return `workflow_${taskId}`;
  };

  const resumed = await nativeTool(userId, "CHUCK_MISSION_RESUME", { id: mission.id }, { enqueueMissionTask });
  assert.equal((resumed as { status: string }).status, "running");
  assert.equal(enqueued.length, 1, "the missing ready-step workflow is recovered");
  assert.equal((await listTasks(userId)).filter((task) => task.missionId === mission.id).length, 1);

  const replay = await nativeTool(userId, "CHUCK_MISSION_RESUME", { id: mission.id }, { enqueueMissionTask });
  assert.equal((replay as { status: string }).status, "running");
  assert.equal(enqueued.length, 1, "repeating resume does not publish a second workflow");
  assert.equal((await listTasks(userId)).filter((task) => task.missionId === mission.id).length, 1);
});

test("resuming an overdue timer wake requeues the same mission task exactly once", async () => {
  const userId = 972015;
  const mission = await createMission(userId, { title: "Timer wake recovery", objective: "Continue after a durable wait", definitionOfDone: "The waiting step continues", steps: [
    { id: "only", title: "Only step", objective: "Continue from the post-wake action" },
  ] });
  const started = await startMission(userId, mission.id);
  const published: string[] = [];
  const enqueue = async (_ownerId: number, taskId: string) => {
    published.push(taskId);
    return `workflow_${published.length}`;
  };
  await scheduleMissionSteps(userId, started!, enqueue);
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id);
  assert.ok(task);
  const claimed = await claimTask(userId, task!.id, "timer-worker", 60_000);
  assert.ok(claimed?.lease);
  const runAt = Date.now() - 1;
  await waitMission(userId, mission.id, { kind: "timer", runAt }, "Pre-wait checkpoint", "Execute the post-wake readback.");
  const parked = await settleTaskRun(userId, task!.id, claimed!.lease!.token, {
    status: "queued",
    waiting: true,
    message: "Waiting for the durable timer",
    runAt,
    checkpoint: "Pre-wait checkpoint",
    nextAction: "Execute the post-wake readback.",
  });
  assert.equal(parked?.status, "queued");
  assert.equal((await getMission(userId, mission.id))?.status, "waiting");

  const resumed = await resumeMissionAndSchedule(userId, mission.id, enqueue);
  assert.equal(resumed?.status, "running");
  assert.equal(resumed?.waiting, undefined);
  assert.equal(resumed?.nextAction, "Execute the post-wake readback.");
  assert.equal(published.length, 2, "the original task is republished once for its overdue wake");
  assert.equal(published[1], task!.id);
  assert.equal((await listTasks(userId)).filter((item) => item.missionId === mission.id).length, 1);

  const replay = await resumeMissionAndSchedule(userId, mission.id, enqueue);
  assert.equal(replay?.status, "running");
  assert.equal(published.length, 2, "replaying resume does not publish a duplicate wake");
});

test("replayed mission start calls in one agent run create and schedule only one mission", async () => {
  const userId = 972016;
  const args = {
    title: "Idempotent mission start",
    objective: "Create one durable mission despite a retried tool call",
    definitionOfDone: "Exactly one mission and one initial task exist",
    steps: [{ id: "only", title: "First step", objective: "Run once" }],
  };
  const enqueued: string[] = [];
  const runtime = {
    currentRunId: "run_replayed_mission_start",
    enqueueMissionTask: async (_ownerId: number, taskId: string) => { enqueued.push(taskId); return `workflow_${taskId}`; },
  };

  const first = await nativeTool(userId, "CHUCK_MISSION_START", { ...args }, runtime) as { id: string };
  const replay = await nativeTool(userId, "CHUCK_MISSION_START", { ...args }, runtime) as { id: string };

  assert.equal(replay.id, first.id);
  assert.equal((await listMissions(userId)).filter((mission) => mission.title === args.title).length, 1);
  assert.equal((await listTasks(userId)).filter((task) => task.missionId === first.id).length, 1);
  assert.equal(enqueued.length, 1, "the repeated start must not enqueue a duplicate workflow");
});

test("a mission ID sent to start fails with recovery guidance before creating or resuming anything", async () => {
  const userId = 972018;
  await assert.rejects(
    nativeTool(userId, "CHUCK_MISSION_START", { id: "mis_existing" }),
    /creates a new mission.*CHUCK_MISSION_RESUME.*no mission was created/i,
  );
  assert.deepEqual(await listMissions(userId), []);
});

test("replayed native task creation in one agent run returns the same durable task", async () => {
  const userId = 972017;
  const args = { title: "Idempotent task creation", objective: "Create one resumable task" };
  const runtime = { currentRunId: "run_replayed_task_create" };
  const first = await nativeTool(userId, "CHUCK_TASK_CREATE", { ...args }, runtime) as { id: string };
  const replay = await nativeTool(userId, "CHUCK_TASK_CREATE", { ...args }, runtime) as { id: string };
  assert.equal(replay.id, first.id);
  assert.equal((await listTasks(userId)).filter((task) => task.title === args.title).length, 1);
  const separate = await nativeTool(userId, "CHUCK_TASK_CREATE", { title: "A separate task", objective: args.objective }, runtime) as { id: string };
  assert.notEqual(separate.id, first.id, "different task intents within one run remain distinct");
});

test("an existing task ID sent to task creation fails before creating a task", async () => {
  const userId = 972019;
  await assert.rejects(
    nativeTool(userId, "CHUCK_TASK_CREATE", { id: "task_existing" }),
    /creates a new task.*CHUCK_TASK_GET.*no task was created/i,
  );
  assert.deepEqual(await listTasks(userId), []);
});

test("native replan reports a completed-step conflict without mutating the mission", async () => {
  const userId = 972015;
  const mission = await createMission(userId, { title: "Preserve completed work", objective: "Replan only unfinished work", definitionOfDone: "The remaining step is complete", steps: [
    { id: "done", title: "Completed research", objective: "Gather verified sources" },
    { id: "next", title: "Draft", objective: "Write the brief", dependsOn: ["done"] },
  ] });
  await startMission(userId, mission.id);
  await completeMissionStep(userId, mission.id, "done", "Three sources verified");

  const before = await getMission(userId, mission.id);
  const result = await nativeTool(userId, "CHUCK_MISSION_REPLAN", {
    id: mission.id,
    reason: "Updated positioning",
    steps: [{ id: "replacement", title: "Draft with new positioning", objective: "Write the updated brief" }],
  }) as { status: string; reason?: string; completedStepIds?: string[]; nextAction?: string; mission?: { status: string } };

  assert.equal(result.status, "rejected");
  assert.match(result.reason ?? "", /completed.*preserv/i);
  assert.deepEqual(result.completedStepIds, ["done"]);
  assert.match(result.nextAction ?? "", /include.*completed step/i);
  assert.equal(result.mission?.status, "running");
  const after = await getMission(userId, mission.id);
  assert.deepEqual(after, before, "a rejected replan leaves the mission exactly unchanged");
});

test("native mission replan schedules every newly dependency-ready branch", async () => {
  const userId = 972016;
  const mission = await createMission(userId, { title: "Replan and resume", objective: "Replace stale work", definitionOfDone: "Both branches complete", steps: [
    { id: "root", title: "Root", objective: "Prepare input" },
    { id: "old", title: "Old", objective: "Obsolete work", dependsOn: ["root"] },
  ] });
  await startMission(userId, mission.id);
  await completeMissionStep(userId, mission.id, "root", "Root complete");
  const queued: string[] = [];
  const result = await nativeTool(userId, "CHUCK_MISSION_REPLAN", {
    id: mission.id,
    reason: "Split remaining work into independent branches",
    steps: [
      { id: "root", title: "Root", objective: "Prepare input" },
      { id: "new-a", title: "New A", objective: "First branch", dependsOn: ["root"] },
      { id: "new-b", title: "New B", objective: "Second branch", dependsOn: ["root"] },
    ],
  }, { enqueueMissionTask: async (_ownerId, taskId) => { queued.push(taskId); return `workflow_${taskId}`; } }) as { activeStepIds?: string[]; steps: Array<{ id: string; taskId?: string }> };
  assert.deepEqual(result.activeStepIds, ["new-a", "new-b"]);
  assert.equal(queued.length, 2);
  assert.deepEqual(result.steps.filter((step) => step.id.startsWith("new-") && step.taskId).map((step) => step.id), ["new-a", "new-b"]);
});

test("mission provider-event waits require the owning durable mission task", async () => {
  const userId = 972017;
  const mission = await createMission(userId, { title: "Wait for event", objective: "Wait for provider callback", definitionOfDone: "Callback processed" });
  await startMission(userId, mission.id);
  await assert.rejects(() => nativeTool(userId, "CHUCK_MISSION_WAIT_EVENT", {
    id: mission.id, provider: "crm", providerEventId: "event-1",
  }), /active durable mission task/i);

  let captured: { provider: string; providerEventId: string } | undefined;
  const result = await nativeTool(userId, "CHUCK_MISSION_WAIT_EVENT", {
    id: mission.id, provider: "crm", providerEventId: "event-1",
  }, { taskId: "task_mission_wait", missionId: mission.id, requestMissionWait: (request) => { captured = request; } }) as { status: string };
  assert.equal(result.status, "waiting");
  assert.deepEqual(captured && { provider: captured.provider, providerEventId: captured.providerEventId }, { provider: "crm", providerEventId: "event-1" });
});

test("strict missions cannot be completed before independent verification", async () => {
  const userId = 972005;
  const mission = await createMission(userId, { title: "Verified outcome", objective: "Produce proof", definitionOfDone: "Evidence is verified", requiredEvidence: ["receipt"] });
  const started = await startMission(userId, mission.id);
  assert.equal(await completeMission(userId, mission.id, "premature"), undefined);
  await completeMissionStep(userId, mission.id, started!.currentStepId!, "Step result");
  await recordMissionEvidence(userId, mission.id, [{ id: "assertion-1", kind: "assertion", summary: "receipt confirmed", verified: true, verifiedBy: "agent" }]);
  const rejected = await verifyMission(userId, mission.id);
  assert.equal(rejected?.verification?.verified, false);
  await recordTrustedMissionEvidence(userId, mission.id, [{ id: "receipt-1", kind: "tool_receipt", summary: "receipt confirmed", ref: "tool://receipt-1", verified: true, verifiedBy: "system" }]);
  await verifyMission(userId, mission.id);
  const completed = await completeMission(userId, mission.id, "Outcome verified");
  assert.equal(completed?.status, "completed");
});

test("native mission verification cannot claim a human verifier", async () => {
  const userId = 972050;
  const mission = await createMission(userId, { title: "Attribution", objective: "Verify metadata", definitionOfDone: "Verification is recorded" });
  const result = await nativeTool(userId, "CHUCK_MISSION_VERIFY", { id: mission.id }) as { verification?: { verifiedBy?: string } };
  assert.equal(result.verification?.verifiedBy, "agent");
});

test("native mission closeout completes verified work and returns exact evidence blockers instead of a generic failure", async () => {
  const userId = 972052;
  const legacy = await createMission(userId, { title: "Legacy closeout", objective: "Finish one step", definitionOfDone: "The step is verified", steps: [{ id: "only", title: "Only step", objective: "Complete the task" }] });
  const startedLegacy = await startMission(userId, legacy.id);
  const legacyResult = await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: legacy.id, stepId: startedLegacy!.currentStepId, result: "The task was completed and verified" }) as { status: string; closeout?: { status?: string } };
  assert.equal(legacyResult.status, "completed");
  assert.equal(legacyResult.closeout?.status, "completed");

  const strict = await createMission(userId, { title: "Strict closeout", objective: "Finish with receipt proof", definitionOfDone: "The task and receipt are verified", requiredEvidence: ["receipt"], steps: [{ id: "only", title: "Only step", objective: "Complete the task" }] });
  const startedStrict = await startMission(userId, strict.id);
  const stepResult = await nativeTool(userId, "CHUCK_MISSION_STEP_COMPLETE", { id: strict.id, stepId: startedStrict!.currentStepId, result: "The task was completed" }) as { status: string; closeout?: { status?: string; blockers?: string[] }; verification?: { unresolved?: string[] } };
  assert.equal(stepResult.status, "blocked");
  assert.equal(stepResult.closeout?.status, "blocked");
  assert.match(stepResult.verification?.unresolved?.join(" ") ?? "", /receipt/i);

  const blockedComplete = await nativeTool(userId, "CHUCK_MISSION_COMPLETE", { id: strict.id, result: "Done" }) as { status: string; closeout?: { status?: string; blockers?: string[]; nextAction?: string } };
  assert.equal(blockedComplete.status, "blocked");
  assert.equal(blockedComplete.closeout?.status, "blocked");
  assert.match(blockedComplete.closeout?.blockers?.join(" ") ?? "", /receipt/i);
  assert.ok(blockedComplete.closeout?.nextAction);

  await recordTrustedMissionEvidence(userId, strict.id, [{ id: "receipt-proof", kind: "tool_receipt", summary: "Provider receipt independently read back", source: "gmail", ref: "receipt://verified", verified: true, verifiedBy: "system" }]);
  await resumeMission(userId, strict.id);
  const completed = await nativeTool(userId, "CHUCK_MISSION_VERIFY", { id: strict.id }) as { status: string; closeout?: { status?: string } };
  assert.equal(completed.status, "completed");
  assert.equal(completed.closeout?.status, "completed");
  const replay = await nativeTool(userId, "CHUCK_MISSION_COMPLETE", { id: strict.id, result: "Repeat" }) as { status: string; closeout?: { alreadyCompleted?: boolean } };
  assert.equal(replay.status, "completed");
  assert.equal(replay.closeout?.alreadyCompleted, true);
});

test("mission verification tool rejects caller supplied provider outcome results", async () => {
  await initStore({ memoryOnly: true });
  const mission = await createMission(972051, { title: "Provider evidence", objective: "Verify external state", definitionOfDone: "Current provider state is confirmed" });
  await assert.rejects(() => nativeTool(972051, "CHUCK_MISSION_VERIFY", {
    id: mission.id,
    checks: [{ id: "crm", kind: "provider_read", description: "Lead is qualified", toolSlug: "CRM_GET_LEAD", arguments: { id: "lead_1" }, expected: { status: "qualified" } }],
    results: [{ checkId: "crm", status: "passed", observed: { status: "qualified" }, provider: "crm", evidenceRef: "fabricated", observedAt: Date.now() }],
  }), /additional propert|not allowed/i);
});

test("terminal task failure reconciles the linked mission step and mission status", async () => {
  const userId = 972006;
  const mission = await createMission(userId, { title: "Failure recovery", objective: "Run one bounded step", definitionOfDone: "The step succeeds", steps: [{ id: "only", title: "Only step", objective: "Run once", retryLimit: 0 }] });
  const started = await startMission(userId, mission.id);
  await scheduleMissionSteps(userId, started!, async () => "workflow_failure");
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id);
  assert.ok(task);
  const claimed = await claimTask(userId, task!.id, "failure-worker", 60_000);
  assert.ok(claimed?.lease);
  await settleTaskRun(userId, task!.id, claimed!.lease!.token, { status: "failed", message: "Provider permanently rejected the request" });
  const failed = await getMission(userId, mission.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.steps.find((step) => step.id === "only")?.status, "failed");
  assert.match(failed?.nextAction ?? "", /repair|replan/i);
});

test("resuming a failed mission reactivates its unfinished step and reuses its deterministic task", async () => {
  const userId = 972009;
  const mission = await createMission(userId, { title: "Recover failed step", objective: "Continue one step", definitionOfDone: "The step succeeds", steps: [{ id: "only", title: "Only step", objective: "Continue safely", retryLimit: 0 }] });
  const started = await startMission(userId, mission.id);
  const published: string[] = [];
  await scheduleMissionSteps(userId, started!, async (_ownerId, taskId) => { published.push(taskId); return `workflow_${published.length}`; });
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id);
  assert.ok(task);
  const claimed = await claimTask(userId, task!.id, "failed-step-worker", 60_000);
  assert.ok(claimed?.lease);
  await settleTaskRun(userId, task!.id, claimed!.lease!.token, { status: "failed", message: "Worker made no durable progress" });
  assert.equal((await getMission(userId, mission.id))?.status, "failed");
  const resumed = await resumeMission(userId, mission.id);
  assert.equal(resumed?.status, "running");
  assert.equal(resumed?.steps.find((step) => step.id === "only")?.status, "running");
  await scheduleMissionSteps(userId, resumed!, async (_ownerId, taskId) => { published.push(taskId); return `workflow_${published.length}`; });
  const recoveredTask = (await listTasks(userId)).find((item) => item.missionId === mission.id);
  assert.equal(recoveredTask?.id, task!.id);
  assert.equal(recoveredTask?.status, "queued");
  assert.equal(published.length, 2);
});

test("concurrent mission schedulers publish one workflow for one deterministic step", async () => {
  const userId = 972007;
  const mission = await createMission(userId, { title: "Concurrent schedule", objective: "Run once", definitionOfDone: "One step", steps: [{ id: "only", title: "Only", objective: "Run" }] });
  const started = await startMission(userId, mission.id);
  let enqueues = 0;
  await Promise.all([
    scheduleMissionSteps(userId, started!, async () => { enqueues += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return `workflow_${enqueues}`; }),
    scheduleMissionSteps(userId, started!, async () => { enqueues += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return `workflow_${enqueues}`; }),
  ]);
  assert.equal(enqueues, 1);
});

test("mission scheduler recovers an expired pending enqueue claim", async () => {
  const userId = 972008;
  const mission = await createMission(userId, { title: "Recover publish", objective: "Recover", definitionOfDone: "One step", steps: [{ id: "only", title: "Only", objective: "Run" }] });
  const started = await startMission(userId, mission.id);
  const first = await scheduleMissionSteps(userId, started!, async () => "workflow_first");
  const task = (await listTasks(userId)).find((item) => item.missionId === mission.id);
  assert.ok(task);
  await updateTask(userId, task!.id, { workflowRunId: "pending:crashed-publisher", enqueueClaim: { token: "crashed-publisher", expiresAt: Date.now() - 1 } });
  let publishes = 0;
  await scheduleMissionSteps(userId, first!, async () => { publishes += 1; return "workflow_recovered"; });
  assert.equal(publishes, 1);
  assert.equal((await listTasks(userId)).find((item) => item.id === task!.id)?.workflowRunId, "workflow_recovered");
});

test("manual task retry clears stale provider publication state", async () => {
  const userId = 972009;
  const task = await createTask(userId, { title: "Retry me", objective: "Retry", runAt: Date.now() });
  await updateTask(userId, task.id, { status: "failed", workflowRunId: "workflow_old", enqueueClaim: { token: "old", expiresAt: Date.now() + 60_000 } });
  const retried = await retryTask(userId, task.id);
  assert.equal(retried?.status, "queued");
  assert.equal(retried?.workflowRunId, undefined);
  assert.equal(retried?.enqueueClaim, undefined);
});
