/**
 * Complex model-free mission matrix.
 *
 * This is deliberately a provider-boundary test: QStash, signatures, task
 * leases, mission state transitions, app-account selection, provider receipt
 * handling, waits, approvals, and recovery are real. The model and external
 * business providers are scripted and cannot make network calls.
 *
 * Run:
 *   node --use-env-proxy --import=tsx scripts/live-mission-complex-qstash.ts --apply
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Client, Receiver } from "@upstash/qstash";
import { config as loadDotenv } from "dotenv";
import type { AgentResult } from "../src/agent.js";
import type { TaskSliceContext } from "../src/taskSlice.js";
import type { MissionWaitRequest } from "../src/nativeTools.js";
import type { TaskWaitRequest } from "../src/types.js";

type Outcome = AgentResult["toolOutcomes"][number];
type ScenarioKind = "campaign" | "retry" | "uncertain" | "disconnected" | "human_input" | "duplicate" | "cancelled" | "parallel";
type CampaignProfile = "lost_deals" | "partners" | "churned_customers" | "recruiting" | "key_accounts" | "baseline";

interface AppConnection {
  toolkit: string;
  accountId: string;
  alias: string;
  status: "connected" | "revoked" | "missing";
}

interface ProviderReceipt {
  key: string;
  toolkit: string;
  accountId: string;
  toolSlug: string;
  receiptId: string;
  dispatched: number;
  state: "succeeded" | "unknown" | "failed";
}

interface Scenario {
  name: string;
  kind: ScenarioKind;
  profile?: CampaignProfile;
  userId: number;
  missionId: string;
  initialTaskId?: string;
  expectedStatus: "completed" | "blocked" | "cancelled";
  approvalPrepared?: boolean;
  approvalId?: string;
  approvalReleased?: boolean;
  eventResumed?: boolean;
  humanInputSupplied?: boolean;
  uncertainReconciled?: boolean;
  retryAttempt?: number;
  scriptedRuns: number;
  timerDeadline?: number;
  taskIds: Set<string>;
}

async function main(): Promise<void> {
  // The live script is run directly with Node/tsx, so no framework has loaded
  // .env for it. Load the selected local/staging file before checking QStash
  // credentials, while preserving explicitly exported shell variables.
  loadDotenv({ path: process.env.CHUSKY_ENV_FILE ?? resolve(process.cwd(), ".env") });
  if (!process.argv.includes("--apply")) throw new Error("Pass --apply to publish synthetic real QStash messages.");
  for (const name of ["QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY"]) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }

  process.env.DOTENV_CONFIG_PATH = resolve(__dirname, "../tests/empty.env");
  process.env.JEV_MODE = "off";
  process.env.TURN_OPENING_ENABLED = "false";
  process.env.LOG_LEVEL = "error";

  const nativeFetch = globalThis.fetch.bind(globalThis);
  const qstashUrl = process.env.QSTASH_URL || "https://qstash.upstash.io";
  const allowedHosts = new Set([new URL(qstashUrl).hostname, "smee.io"]);
  const deniedHosts = new Set<string>();
  let deniedNetworkCalls = 0;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!allowedHosts.has(url.hostname)) {
      deniedNetworkCalls++;
      deniedHosts.add(url.hostname);
      throw new Error("Complex mission proof blocked a non-queue network request.");
    }
    return nativeFetch(input, init);
  };

  const store = await import("../src/store.js");
  const { reconcileMissionExecution } = await import("../src/missionScheduler.js");
  const { executeDurableTask } = await import("../src/taskRunner.js");
  const { executeTaskSlice } = await import("../src/taskSlice.js");
  const { nativeTool } = await import("../src/nativeTools.js");
  const { createApproval, getMission, getTask, listTasks, recordTrustedMissionEvidence, resumeMission, resumeMissionFromProviderEvent, setApprovalStatus, startMission, updateTask, waitMission, cancelMission, cancelMissionTasks } = store;
  const { enqueueTaskWithClaim, } = await import("../src/taskEnqueue.js");
  const { resumeMissionTaskAfterApproval } = await import("../src/missionApproval.js");

  await store.initStore({ memoryOnly: true });
  const client = new Client({ token: process.env.QSTASH_TOKEN!, baseUrl: qstashUrl });
  const receiver = new Receiver({ currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!, nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY! });
  const relay = await fetch("https://smee.io/new", { redirect: "manual", signal: AbortSignal.timeout(15000) });
  const relayLocation = relay.headers.get("location");
  if (!relayLocation || new URL(relayLocation).hostname !== "smee.io") throw new Error("Could not allocate a temporary webhook relay.");
  const destination = relayLocation;

  const suiteId = randomUUID();
  const ownerIds = new Set<number>();
  const scenarios = new Map<string, Scenario>();
  const taskToScenario = new Map<string, Scenario>();
  const messageIds: string[] = [];
  const signedDeliveryIds = new Set<string>();
  const errors: string[] = [];
  const processing = new Set<Promise<void>>();
  const providerReceipts = new Map<string, ProviderReceipt>();
  const appConnections = new Map<string, AppConnection>([
    ["gmail", { toolkit: "gmail", accountId: "acct_gmail_synthetic", alias: "owner-gmail", status: "connected" }],
    ["calendar", { toolkit: "googlecalendar", accountId: "acct_calendar_synthetic", alias: "owner-calendar", status: "connected" }],
    ["sheets", { toolkit: "googlesheets", accountId: "acct_sheets_synthetic", alias: "owner-sheets", status: "connected" }],
    ["crm", { toolkit: "hubspot", accountId: "acct_crm_synthetic", alias: "owner-crm", status: "connected" }],
    ["ats", { toolkit: "greenhouse", accountId: "acct_ats_synthetic", alias: "owner-ats", status: "connected" }],
    ["notion", { toolkit: "notion", accountId: "acct_notion_synthetic", alias: "owner-notion", status: "revoked" }],
  ]);
  type CampaignAction = { connection: string; toolkit: string; tool: string };
  const campaignMappings: Record<CampaignProfile, Record<string, CampaignAction>> = {
    baseline: {
      signals: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
      list: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_SEARCH_CONTACTS" },
      shortlist: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_UPDATE_CONTACT" },
      enrichment: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      "saved-work": { connection: "sheets", toolkit: "googlesheets", tool: "GOOGLE_SHEETS_APPEND_ROWS" },
      research: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      outreach: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      followup: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      client: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_CREATE_TICKET" },
      feedback: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
    },
    lost_deals: {
      signals: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
      list: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_SEARCH_DEALS" },
      shortlist: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_UPDATE_DEAL" },
      enrichment: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      "saved-work": { connection: "sheets", toolkit: "googlesheets", tool: "GOOGLE_SHEETS_APPEND_ROWS" },
      research: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      outreach: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      followup: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      client: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_UPDATE_DEAL" },
      feedback: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
    },
    partners: {
      signals: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
      list: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_SEARCH_COMPANIES" },
      shortlist: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_UPDATE_COMPANY" },
      enrichment: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      "saved-work": { connection: "sheets", toolkit: "googlesheets", tool: "GOOGLE_SHEETS_APPEND_ROWS" },
      research: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      outreach: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      followup: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      client: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_CREATE_TICKET" },
      feedback: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
    },
    churned_customers: {
      signals: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
      list: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_SEARCH_CONTACTS" },
      shortlist: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_UPDATE_CONTACT" },
      enrichment: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      "saved-work": { connection: "sheets", toolkit: "googlesheets", tool: "GOOGLE_SHEETS_APPEND_ROWS" },
      research: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      outreach: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      followup: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      client: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_CREATE_TICKET" },
      feedback: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
    },
    recruiting: {
      signals: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
      list: { connection: "ats", toolkit: "greenhouse", tool: "GREENHOUSE_SEARCH_CANDIDATES" },
      shortlist: { connection: "ats", toolkit: "greenhouse", tool: "GREENHOUSE_UPDATE_CANDIDATE" },
      enrichment: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      "saved-work": { connection: "sheets", toolkit: "googlesheets", tool: "GOOGLE_SHEETS_APPEND_ROWS" },
      research: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      outreach: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      followup: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      client: { connection: "ats", toolkit: "greenhouse", tool: "GREENHOUSE_UPDATE_CANDIDATE" },
      feedback: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
    },
    key_accounts: {
      signals: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
      list: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_SEARCH_CONTACTS" },
      shortlist: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_UPDATE_CONTACT" },
      enrichment: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      "saved-work": { connection: "sheets", toolkit: "googlesheets", tool: "GOOGLE_SHEETS_APPEND_ROWS" },
      research: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" },
      outreach: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      followup: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_SEND_EMAIL" },
      client: { connection: "crm", toolkit: "hubspot", tool: "HUBSPOT_CREATE_TICKET" },
      feedback: { connection: "gmail", toolkit: "gmail", tool: "GMAIL_LIST_MESSAGES" },
    },
  };
  const providerActionLog: Array<{ scenario: string; stepId: string; toolkit: string; accountId: string; toolSlug: string; kind: "discovery" | "dispatch" | "readback"; receiptId?: string }> = [];
  const deniedForeignDeliveries: string[] = [];
  let scriptedAgentRuns = 0;
  let duplicateSuppressed = 0;
  let duplicateTaskDeliveriesSuppressed = 0;
  let connectionBlocks = 0;
  let approvalWaits = 0;
  let providerWaits = 0;
  let humanInputWaits = 0;
  let timerWaits = 0;
  let streamReady!: () => void;
  const ready = new Promise<void>((resolveReady) => { streamReady = resolveReady; });
  const streamAbort = new AbortController();

  const registerTask = async (scenario: Scenario, taskId: string): Promise<void> => {
    scenario.taskIds.add(taskId);
    taskToScenario.set(taskId, scenario);
  };

  const publish = async (userId: number, taskId: string, runAt = Date.now()): Promise<string> => {
    assert.ok(ownerIds.has(userId), "Only synthetic owners may publish.");
    assert.ok(messageIds.length < 180, "Complex proof publication limit exceeded.");
    const accepted = await client.publishJSON({
      url: destination,
      body: { suiteId, userId, taskId },
      delay: Math.max(1, Math.ceil((runAt - Date.now()) / 1000)),
      retries: 0,
    });
    messageIds.push(accepted.messageId);
    return accepted.messageId;
  };

  const runtimeFor = (scenario: Scenario, taskId: string, stepId: string) => ({
    taskId,
    missionId: scenario.missionId,
    missionStepId: stepId,
    enqueueMissionTask: publish,
  });

  const connection = (name: string): AppConnection => {
    const account = appConnections.get(name);
    if (!account || account.status !== "connected") throw new Error(`Synthetic app connection ${name} is unavailable.`);
    return account;
  };

  const connectionNameForToolkit = (toolkit: string): string => toolkit === "gmail"
    ? "gmail"
    : toolkit === "googlecalendar"
      ? "calendar"
      : toolkit === "googlesheets"
        ? "sheets"
        : toolkit === "hubspot"
          ? "crm"
          : toolkit === "greenhouse"
            ? "ats"
            : "gmail";

  const dispatchProvider = (scenario: Scenario, stepId: string, connectionName: string, toolSlug: string, mode: "success" | "uncertain" | "readback" = "success"): Outcome => {
    const account = connection(connectionName);
    const key = `${scenario.missionId}:${stepId}:${toolSlug}`;
    const existing = providerReceipts.get(key);
    if (mode === "readback") {
      const receipt = existing?.receiptId ?? `readback_${randomUUID()}`;
      providerActionLog.push({ scenario: scenario.name, stepId, toolkit: account.toolkit, accountId: account.accountId, toolSlug, kind: "readback", receiptId: receipt });
      return { callId: randomUUID(), toolSlug, status: "succeeded", dispatched: false, receiptId: receipt };
    }
    if (existing) {
      duplicateSuppressed++;
      providerActionLog.push({ scenario: scenario.name, stepId, toolkit: account.toolkit, accountId: account.accountId, toolSlug, kind: "readback", receiptId: existing.receiptId });
      return { callId: randomUUID(), toolSlug, status: "succeeded", dispatched: false, receiptId: existing.receiptId };
    }
    const receiptId = `receipt_${randomUUID()}`;
    const state = mode === "uncertain" ? "unknown" : "succeeded";
    providerReceipts.set(key, { key, toolkit: account.toolkit, accountId: account.accountId, toolSlug, receiptId, dispatched: 1, state });
    providerActionLog.push({ scenario: scenario.name, stepId, toolkit: account.toolkit, accountId: account.accountId, toolSlug, kind: "dispatch", receiptId });
    return { callId: randomUUID(), toolSlug, status: mode === "uncertain" ? "uncertain" : "succeeded", dispatched: true, receiptId };
  };

  const discoverAndSchema = (scenario: Scenario, stepId: string, toolkit: string, toolSlug: string): Outcome[] => {
    const connectionName = connectionNameForToolkit(toolkit);
    const account = connection(connectionName);
    const discoveryCall = randomUUID();
    const schemaCall = randomUUID();
    providerActionLog.push({ scenario: scenario.name, stepId, toolkit, accountId: account.accountId, toolSlug: "COMPOSIO_SEARCH_TOOLS", kind: "discovery" });
    providerActionLog.push({ scenario: scenario.name, stepId, toolkit, accountId: account.accountId, toolSlug: "COMPOSIO_GET_TOOL_SCHEMAS", kind: "discovery" });
    const receipt = dispatchProvider(scenario, stepId, connectionName, toolSlug, "success");
    return [
      { callId: discoveryCall, toolSlug: "COMPOSIO_SEARCH_TOOLS", status: "succeeded", dispatched: false },
      { callId: schemaCall, toolSlug: "COMPOSIO_GET_TOOL_SCHEMAS", status: "succeeded", dispatched: false },
      receipt,
    ];
  };

  const evidenceAndComplete = async (scenario: Scenario, taskId: string, stepId: string, runtime: ReturnType<typeof runtimeFor>, receipt?: Outcome): Promise<AgentResult> => {
    if (receipt?.receiptId) {
      await recordTrustedMissionEvidence(scenario.userId, scenario.missionId, [{ id: `ev_${scenario.name}_${stepId}`, kind: "tool_receipt", summary: `Verified synthetic provider receipt for ${receipt.toolSlug}.`, source: "synthetic://provider", ref: receipt.receiptId, verified: true, verifiedBy: "system", verifiedAt: Date.now() }], stepId);
    }
    await nativeTool(scenario.userId, "CHUCK_MISSION_STEP_COMPLETE", { id: scenario.missionId, stepId, result: `Verified step ${stepId}; no unverified provider action remains.` }, runtime);
    return { text: `Verified ${stepId}`, toolsUsed: [receipt?.toolSlug ?? "CHUCK_MISSION_STEP_COMPLETE", "CHUCK_MISSION_STEP_COMPLETE"], toolsSucceeded: [receipt?.toolSlug ?? "CHUCK_MISSION_STEP_COMPLETE", "CHUCK_MISSION_STEP_COMPLETE"], toolOutcomes: receipt ? [receipt, { callId: randomUUID(), toolSlug: "CHUCK_MISSION_STEP_COMPLETE", status: "succeeded", dispatched: true }] : [{ callId: randomUUID(), toolSlug: "CHUCK_MISSION_STEP_COMPLETE", status: "succeeded", dispatched: true }], cost: 0 };
  };

  const scriptedAgent: NonNullable<TaskSliceContext["runAgent"]> = async (...args) => {
    const userId = args[0];
    const options = args[9] as { taskId?: string; missionId?: string; missionStepId?: string; missionTimerResumed?: boolean } | undefined;
    assert.ok(options?.taskId && options.missionId && options.missionStepId, "Every complex proof run must be mission-scoped.");
    const scenario = scenarios.get(options.missionId!);
    assert.ok(scenario && scenario.userId === userId, "The scripted agent must stay owner-scoped.");
    const mission = await getMission(userId, scenario.missionId);
    assert.ok(mission);
    const step = mission.steps.find((candidate) => candidate.id === options.missionStepId);
    assert.ok(step && step.status === "running");
    for (const dependency of step.dependsOn) assert.equal(mission.steps.find((candidate) => candidate.id === dependency)?.status, "completed", `Dependency ${dependency} must complete before ${step.id}.`);
    scenario.scriptedRuns++;
    scriptedAgentRuns++;
    const runtime = runtimeFor(scenario, options.taskId!, step.id);

    if (scenario.kind === "retry") {
      if (!scenario.retryAttempt) {
        scenario.retryAttempt = 1;
        await nativeTool(userId, "CHUCK_MISSION_CHECKPOINT", { id: scenario.missionId, checkpoint: "The provider was temporarily unavailable before dispatch.", nextAction: "Retry the same read-only provider action once." }, runtime);
        return { text: "Checkpointed a non-dispatched transient provider failure.", toolsUsed: ["GOOGLE_SHEETS_GET", "CHUCK_MISSION_CHECKPOINT"], toolsSucceeded: ["CHUCK_MISSION_CHECKPOINT"], toolOutcomes: [{ callId: randomUUID(), toolSlug: "GOOGLE_SHEETS_GET", status: "failed", dispatched: false }, { callId: randomUUID(), toolSlug: "CHUCK_MISSION_CHECKPOINT", status: "succeeded", dispatched: true }], cost: 0 };
      }
      const receipt = dispatchProvider(scenario, step.id, "sheets", "GOOGLE_SHEETS_GET", "success");
      return evidenceAndComplete(scenario, options.taskId!, step.id, runtime, receipt);
    }

    if (scenario.kind === "uncertain") {
      if (!scenario.uncertainReconciled) {
        const receipt = dispatchProvider(scenario, step.id, "gmail", "GMAIL_SEND_EMAIL", "uncertain");
        return { text: "The provider accepted the request but did not return a definitive outcome.", toolsUsed: ["GMAIL_SEND_EMAIL"], toolsSucceeded: [], toolOutcomes: [receipt], cost: 0 };
      }
      const receipt = dispatchProvider(scenario, step.id, "gmail", "GMAIL_SEND_EMAIL", "readback");
      return evidenceAndComplete(scenario, options.taskId!, step.id, runtime, receipt);
    }

    if (scenario.kind === "disconnected") {
      connectionBlocks++;
      await nativeTool(userId, "CHUCK_MISSION_BLOCK", { id: scenario.missionId, reason: "The requested Notion connection is revoked in this test.", nextAction: "Reconnect Notion, then resume the same mission step; no write was attempted." }, runtime);
      return { text: "Blocked safely on the missing connection.", toolsUsed: ["CHUCK_MISSION_BLOCK"], toolsSucceeded: ["CHUCK_MISSION_BLOCK"], toolOutcomes: [{ callId: randomUUID(), toolSlug: "CHUCK_MISSION_BLOCK", status: "succeeded", dispatched: true }], cost: 0 };
    }

    if (scenario.kind === "campaign") {
      if (step.id === "next-action") {
        if (!options.missionTimerResumed) {
          const wait: TaskWaitRequest = { runAt: Date.now() + 60_000, checkpoint: "Saved the next-action deadline after the shortlist was prepared.", nextAction: "Wake and verify the follow-up action; do not repeat the timer." };
          scenario.timerDeadline = wait.runAt;
          timerWaits++;
          return { text: "Parked until the durable follow-up deadline.", toolsUsed: ["CHUCK_TASK_WAIT"], toolsSucceeded: ["CHUCK_TASK_WAIT"], toolOutcomes: [{ callId: randomUUID(), toolSlug: "CHUCK_TASK_WAIT", status: "succeeded", dispatched: true }], taskWait: wait, cost: 0 };
        }
        assert.ok(Date.now() >= (scenario.timerDeadline ?? 0), "A timer continuation must not run before its saved deadline.");
        return evidenceAndComplete(scenario, options.taskId!, step.id, runtime);
      }
      if (step.id === "meeting") {
        if (!scenario.eventResumed) {
          const outcomes = [dispatchProvider(scenario, step.id, "calendar", "GOOGLE_CALENDAR_CREATE_EVENT", "success")];
          let missionWait: MissionWaitRequest | undefined;
          await nativeTool(userId, "CHUCK_MISSION_WAIT_EVENT", { id: scenario.missionId, stepId: step.id, provider: "google-calendar", providerEventId: `calendar-event-${scenario.missionId}`, timeoutSeconds: 60, checkpoint: "Meeting request submitted; wait for the provider event before follow-up.", nextAction: "Read the created meeting and verify the attendee details before proceeding." }, { ...runtime, requestMissionWait: (request) => { missionWait = request; } });
          assert.ok(missionWait);
          providerWaits++;
          return { text: "Waiting for the exact calendar provider event.", toolsUsed: ["GOOGLE_CALENDAR_CREATE_EVENT", "CHUCK_MISSION_WAIT_EVENT"], toolsSucceeded: ["GOOGLE_CALENDAR_CREATE_EVENT", "CHUCK_MISSION_WAIT_EVENT"], toolOutcomes: [...outcomes, { callId: randomUUID(), toolSlug: "CHUCK_MISSION_WAIT_EVENT", status: "succeeded", dispatched: true }], missionWait, cost: 0 };
        }
        const receipt = dispatchProvider(scenario, step.id, "calendar", "GOOGLE_CALENDAR_GET", "readback");
        return evidenceAndComplete(scenario, options.taskId!, step.id, runtime, receipt);
      }
      const selected = campaignMappings[scenario.profile ?? "baseline"][step.id];
      if (selected) {
        const outcomes = discoverAndSchema(scenario, step.id, selected.toolkit, selected.tool);
        const receipt = outcomes.find((outcome) => outcome.toolSlug === selected.tool);
        return evidenceAndComplete(scenario, options.taskId!, step.id, runtime, receipt);
      }
      return evidenceAndComplete(scenario, options.taskId!, step.id, runtime);
    }

    const generic = scenario.kind === "parallel" || scenario.kind === "duplicate"
      ? dispatchProvider(scenario, step.id, "sheets", "GOOGLE_SHEETS_APPEND_ROWS", "success")
      : scenario.kind === "human_input" && scenario.humanInputSupplied
        ? dispatchProvider(scenario, step.id, "gmail", "GMAIL_SEND_EMAIL", "success")
        : undefined;
    return evidenceAndComplete(scenario, options.taskId!, step.id, runtime, generic);
  };

  const prepareApprovalIfNeeded = async (scenario: Scenario, taskId: string): Promise<void> => {
    if (scenario.kind !== "campaign" || scenario.approvalPrepared) return;
    const task = await getTask(scenario.userId, taskId);
    if (!task?.missionStepId || task.missionStepId !== "outreach") return;
    const mission = await getMission(scenario.userId, scenario.missionId);
    if (!mission || mission.status !== "running") return;
    const approval = await createApproval({ userId: scenario.userId, missionId: scenario.missionId, toolSlug: "GMAIL_SEND_EMAIL", args: { audience: "synthetic campaign contact" }, request: "Approve the exact synthetic outreach action for this mission test.", history: [], model: "chusky/mission-proof" });
    const waiting = await waitMission(scenario.userId, scenario.missionId, { kind: "approval", key: approval.id, stepId: "outreach", expiresAt: approval.expiresAt }, "Research is complete and the draft is ready.", "Approve the exact outreach action before sending.");
    assert.equal(waiting?.status, "waiting");
    scenario.approvalPrepared = true;
    scenario.approvalId = approval.id;
    approvalWaits++;
  };

  const prepareHumanInputIfNeeded = async (scenario: Scenario, taskId: string): Promise<void> => {
    if (scenario.kind !== "human_input" || scenario.humanInputSupplied) return;
    const task = await getTask(scenario.userId, taskId);
    if (!task?.missionStepId || task.missionStepId !== "input") return;
    const mission = await getMission(scenario.userId, scenario.missionId);
    if (!mission || mission.status !== "running") return;
    const waiting = await waitMission(scenario.userId, scenario.missionId, { kind: "human_input", stepId: "input" }, "The outreach audience is missing.", "Ask the owner for the audience, then resume this same mission.");
    assert.equal(waiting?.status, "waiting");
  };

  const findScenario = async (userId: number, taskId: string): Promise<Scenario | undefined> => {
    const known = taskToScenario.get(taskId);
    if (known) return known;
    for (const scenario of scenarios.values()) {
      const task = await getTask(scenario.userId, taskId);
      if (task?.missionId === scenario.missionId) {
        await registerTask(scenario, taskId);
        if (scenario.userId !== userId) deniedForeignDeliveries.push(taskId);
        return scenario;
      }
    }
    return undefined;
  };

  const afterDelivery = async (scenario: Scenario, payload: { userId: number; taskId: string }, result: { task?: { status?: string; runAt?: number } }): Promise<void> => {
    const mission = await getMission(scenario.userId, scenario.missionId);
    if (!mission) return;
    if (scenario.kind === "campaign" && mission.status === "waiting" && mission.waiting?.kind === "approval" && !scenario.approvalReleased) {
      assert.ok(scenario.approvalId);
      assert.ok(await setApprovalStatus(scenario.userId, scenario.approvalId!, "approved"));
      const resumed = await resumeMissionTaskAfterApproval(scenario.userId, scenario.approvalId!, async (owner, taskId, runAt) => publish(owner, taskId, runAt));
      assert.ok(resumed.status === "resumed" || resumed.status === "already_queued");
      scenario.approvalReleased = true;
      return;
    }
    if (scenario.kind === "campaign" && mission.status === "waiting" && mission.waiting?.kind === "provider_event" && !scenario.eventResumed) {
      const provider = mission.waiting.provider!;
      const providerEventId = mission.waiting.providerEventId!;
      assert.ok(await resumeMissionFromProviderEvent(scenario.userId, scenario.missionId, provider, providerEventId));
      assert.ok(await resumeMissionFromProviderEvent(scenario.userId, scenario.missionId, provider, providerEventId), "Duplicate provider callbacks must be idempotent while the mission is running.");
      scenario.eventResumed = true;
      const task = await getTask(scenario.userId, payload.taskId);
      assert.ok(task);
      await updateTask(scenario.userId, payload.taskId, { status: "queued", runAt: Date.now(), workflowRunId: undefined, workflowPublishedAt: undefined, enqueueClaim: undefined });
      await enqueueTaskWithClaim(scenario.userId, payload.taskId, Date.now(), async (owner, taskId, runAt) => publish(owner, taskId, runAt));
      return;
    }
    if (scenario.kind === "uncertain" && mission.status === "blocked" && !scenario.uncertainReconciled) {
      const receipt = [...providerReceipts.values()].find((item) => item.key.startsWith(`${scenario.missionId}:`));
      assert.ok(receipt?.state === "unknown");
      receipt.state = "succeeded";
      await recordTrustedMissionEvidence(scenario.userId, scenario.missionId, [{ id: `ev_${scenario.name}_readback`, kind: "before_after", summary: "Provider read-back confirmed the previously uncertain send receipt.", source: "synthetic://provider", ref: receipt.receiptId, verified: true, verifiedBy: "system", verifiedAt: Date.now() }], mission.currentStepId);
      assert.ok(await resumeMission(scenario.userId, scenario.missionId));
      scenario.uncertainReconciled = true;
      await reconcileMissionExecution(scenario.userId, scenario.missionId, async (owner, taskId, runAt) => publish(owner, taskId, runAt));
      return;
    }
    if (scenario.kind === "human_input" && mission.status === "waiting" && mission.waiting?.kind === "human_input" && !scenario.humanInputSupplied) {
      humanInputWaits++;
      scenario.humanInputSupplied = true;
      assert.ok(await resumeMission(scenario.userId, scenario.missionId));
      await reconcileMissionExecution(scenario.userId, scenario.missionId, async (owner, taskId, runAt) => publish(owner, taskId, runAt));
      return;
    }
    if (mission.status === "waiting" && mission.waiting?.kind === "timer") {
      const task = await getTask(scenario.userId, payload.taskId);
      if (task?.runAt) await publish(scenario.userId, payload.taskId, task.runAt);
      return;
    }
    if (result.task?.status === "queued" && mission.status === "running") {
      await publish(scenario.userId, payload.taskId, Date.now());
    }
  };

  const receive = async (data: string): Promise<void> => {
    const envelope = JSON.parse(data) as { body?: { suiteId?: string; userId?: number; taskId?: string }; "upstash-signature"?: string; "upstash-message-id"?: string };
    const payload = envelope.body;
    if (!payload || payload.suiteId !== suiteId || typeof payload.userId !== "number" || typeof payload.taskId !== "string") return;
    const validPayload = { suiteId: payload.suiteId, userId: payload.userId, taskId: payload.taskId };
    assert.equal(typeof envelope["upstash-signature"], "string");
    assert.ok(await receiver.verify({ signature: envelope["upstash-signature"]!, body: JSON.stringify(validPayload), url: destination }));
    signedDeliveryIds.add(envelope["upstash-message-id"] || envelope["upstash-signature"]!);
    const scenario = await findScenario(validPayload.userId, validPayload.taskId);
    if (!scenario || scenario.userId !== validPayload.userId) {
      if (scenario) deniedForeignDeliveries.push(validPayload.taskId);
      return;
    }
    await prepareApprovalIfNeeded(scenario, validPayload.taskId);
    await prepareHumanInputIfNeeded(scenario, validPayload.taskId);
    const result = await executeDurableTask({ userId: validPayload.userId, taskId: validPayload.taskId }, {
      workerId: `complex-proof-${randomUUID()}`,
      execute: (task, signal) => executeTaskSlice(task, signal, {
        attempt: task.attempt,
        workflowRunId: `complex-proof-${suiteId}`,
        runAgent: scriptedAgent,
        enqueueMissionTask: publish,
        sdkTaskMessage: async (current) => current?.objective ?? "",
        sdkTaskSkillInstructions: async () => undefined,
        sdkDurationSeconds: () => undefined,
        sendMessage: async () => undefined,
        withUserLock: async (owner, _signal, work) => {
          const token = randomUUID();
          assert.ok(await store.acquireUserLock(owner, token));
          try { return await work(); } finally { await store.releaseUserLock(owner, token); }
        },
      }),
    });
    if (scenario.kind === "duplicate" && !result.claimed) duplicateTaskDeliveriesSuppressed++;
    await afterDelivery(scenario, validPayload, result);
  };

  const stream = (async () => {
    const response = await fetch(destination, { headers: { accept: "text/event-stream" }, signal: streamAbort.signal });
    if (!response.ok || !response.body) throw new Error("Relay subscription failed");
    streamReady();
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || frame.includes("event: ready")) continue;
        const work = receive(data).catch((error) => { errors.push(error instanceof Error ? error.message : "Receiver failed"); });
        processing.add(work);
        void work.finally(() => processing.delete(work));
      }
    }
  })().catch((error) => { if (!streamAbort.signal.aborted) errors.push(error instanceof Error ? error.message : "Relay stream failed"); });

  const createScenario = async (name: string, kind: ScenarioKind, steps: Array<{ id: string; title: string; objective: string; dependsOn?: string[]; allowedTools?: string[] }>, options: { expectedStatus?: Scenario["expectedStatus"]; campaignProfile?: CampaignProfile; workSchedule?: { timezone: string; windowStart: string; windowEnd: string; dailyBudgetSeconds: number; cadenceSeconds: number } } = {}): Promise<Scenario> => {
    const userId = 7_908_000_000 + Math.floor(Math.random() * 800_000) + scenarios.size;
    ownerIds.add(userId);
    const mission = await store.createMission(userId, {
      title: name,
      objective: `Exercise a durable ${name} mission across real queue deliveries.`,
      definitionOfDone: "Every permitted step is settled once with verified state or an honest durable blocker.",
      idempotencyKey: `complex-live-${suiteId}-${name}`,
      requiredEvidence: kind === "disconnected" ? [] : ["tool_receipt"],
      ...(options.workSchedule ? { workSchedule: options.workSchedule } : {}),
      budget: { maxDurationSeconds: 24 * 60 * 60, maxSteps: 100, maxSlices: 200, maxToolCalls: 500, maxCost: 25 },
      steps,
    });
    await startMission(userId, mission.id);
    const scenario: Scenario = { name, kind, ...(options.campaignProfile ? { profile: options.campaignProfile } : {}), userId, missionId: mission.id, expectedStatus: options.expectedStatus ?? (kind === "disconnected" ? "blocked" : kind === "cancelled" ? "cancelled" : "completed"), scriptedRuns: 0, taskIds: new Set() };
    scenarios.set(mission.id, scenario);
    await reconcileMissionExecution(userId, mission.id, async (owner, taskId, runAt) => publish(owner, taskId, runAt));
    const tasks = await listTasks(userId);
    for (const task of tasks.filter((candidate) => candidate.missionId === mission.id)) await registerTask(scenario, task.id);
    scenario.initialTaskId = [...scenario.taskIds][0];
    return scenario;
  };

  try {
    await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Relay did not become ready")), 15000).unref())]);
    const currentHour = new Date().getUTCHours();
    const windowStart = `${String(currentHour).padStart(2, "0")}:00`;
    const windowEndHour = Math.min(23, currentHour + 2);
    const windowEnd = `${String(windowEndHour).padStart(2, "0")}:59`;
    // The mission validator measures HH:MM windows in whole minutes. Keep
    // the test budget inside the actual window even at the end of the day;
    // a fixed 7,200-second budget is invalid for a 22:00–23:59 window.
    const campaignDailyBudgetSeconds = Math.min(7_200, (windowEndHour * 60 + 59 - currentHour * 60) * 60);
    const campaignWorkSchedule = { timezone: "UTC", windowStart, windowEnd, dailyBudgetSeconds: campaignDailyBudgetSeconds, cadenceSeconds: 60 };
    const relationshipCampaignSteps = (profile: CampaignProfile, outcome: string): Array<{ id: string; title: string; objective: string; dependsOn?: string[]; allowedTools?: string[] }> => {
      const mapping = campaignMappings[profile];
      const allowed = (stepId: string): string[] | undefined => mapping[stepId] ? [mapping[stepId].tool] : undefined;
      return [
        { id: "goal", title: "Goal", objective: `Persist the business outcome: ${outcome}.` },
        { id: "signals", title: "Signals", objective: `Detect fresh signals relevant to ${outcome}.`, dependsOn: ["goal"], allowedTools: allowed("signals") },
        { id: "list", title: "List", objective: `Build the working list needed to ${outcome}.`, dependsOn: ["signals"], allowedTools: allowed("list") },
        { id: "shortlist", title: "Shortlist", objective: `Prioritize the strongest candidates for ${outcome}.`, dependsOn: ["list"], allowedTools: allowed("shortlist") },
        { id: "enrichment", title: "Enrichment", objective: "Add current contacts, company context, and relevant history.", dependsOn: ["shortlist"], allowedTools: allowed("enrichment") },
        { id: "saved-work", title: "Saved work", objective: "Save the verified working list for the owner.", dependsOn: ["enrichment"], allowedTools: allowed("saved-work") },
        { id: "next-action", title: "Next action", objective: "Wait for a meaningful trigger or scheduled follow-up, then resume once.", dependsOn: ["saved-work"] },
        { id: "research", title: "Research", objective: "Understand the situation and prepare a relevant next step.", dependsOn: ["next-action"], allowedTools: allowed("research") },
        { id: "outreach", title: "Outreach", objective: "Send a tailored, approved message through the connected channel.", dependsOn: ["research"], allowedTools: allowed("outreach") },
        { id: "meeting", title: "Meeting", objective: "Create the meeting and wait for the exact provider callback.", dependsOn: ["outreach"], allowedTools: ["GOOGLE_CALENDAR_CREATE_EVENT", "GOOGLE_CALENDAR_GET"] },
        { id: "followup", title: "Follow-up", objective: "Continue the verified next step after the meeting.", dependsOn: ["meeting"], allowedTools: allowed("followup") },
        { id: "client", title: "Client", objective: "Persist the post-conversation relationship or care record.", dependsOn: ["followup"], allowedTools: allowed("client") },
        { id: "feedback", title: "Feedback", objective: "Read feedback signals and close the mission with a verified outcome.", dependsOn: ["client"], allowedTools: allowed("feedback") },
      ];
    };
    const campaign = await createScenario("full-lifecycle-campaign", "campaign", [
      { id: "goal", title: "Goal", objective: "Persist the business outcome and completion contract." },
      { id: "signals", title: "Signals", objective: "Read connected Gmail signals and identify relevant opportunities.", dependsOn: ["goal"], allowedTools: ["GMAIL_LIST_MESSAGES"] },
      { id: "list", title: "List", objective: "Find relevant people in the connected CRM.", dependsOn: ["signals"], allowedTools: ["HUBSPOT_SEARCH_CONTACTS"] },
      { id: "shortlist", title: "Shortlist", objective: "Rank the strongest fits and persist the shortlist.", dependsOn: ["list"], allowedTools: ["HUBSPOT_UPDATE_CONTACT"] },
      { id: "enrichment", title: "Enrichment", objective: "Enrich each shortlisted person from connected sources.", dependsOn: ["shortlist"], allowedTools: ["GMAIL_FETCH_EMAILS"] },
      { id: "saved-work", title: "Saved work", objective: "Save the verified working list to Google Sheets.", dependsOn: ["enrichment"], allowedTools: ["GOOGLE_SHEETS_APPEND_ROWS"] },
      { id: "next-action", title: "Next action", objective: "Wait for the durable follow-up deadline and resume once.", dependsOn: ["saved-work"] },
      { id: "research", title: "Research", objective: "Research the shortlisted people before outreach.", dependsOn: ["next-action"], allowedTools: ["GMAIL_FETCH_EMAILS"] },
      { id: "outreach", title: "Outreach", objective: "Send the approved outreach through Gmail.", dependsOn: ["research"], allowedTools: ["GMAIL_SEND_EMAIL"] },
      { id: "meeting", title: "Meeting", objective: "Create the meeting and wait for the exact calendar callback.", dependsOn: ["outreach"], allowedTools: ["GOOGLE_CALENDAR_CREATE_EVENT", "GOOGLE_CALENDAR_GET"] },
      { id: "followup", title: "Follow-up", objective: "Send a concise verified follow-up after the meeting.", dependsOn: ["meeting"], allowedTools: ["GMAIL_SEND_EMAIL"] },
      { id: "client", title: "Client", objective: "Create a verified client-care record in the CRM.", dependsOn: ["followup"], allowedTools: ["HUBSPOT_CREATE_TICKET"] },
      { id: "feedback", title: "Feedback", objective: "Read feedback signals and close the mission with a verified receipt.", dependsOn: ["client"], allowedTools: ["GMAIL_LIST_MESSAGES"] },
    ], { campaignProfile: "baseline", workSchedule: campaignWorkSchedule });

    const lostDeals = await createScenario("re-engage-lost-deals", "campaign", relationshipCampaignSteps("lost_deals", "revive stalled opportunities from the last six to twelve months"), { campaignProfile: "lost_deals", workSchedule: campaignWorkSchedule });
    const partners = await createScenario("find-referral-partners", "campaign", relationshipCampaignSteps("partners", "build a qualified referral and integration partner pipeline"), { campaignProfile: "partners", workSchedule: campaignWorkSchedule });
    const churned = await createScenario("win-back-churned-customers", "campaign", relationshipCampaignSteps("churned_customers", "bring realistic former customers back before they settle with a competitor"), { campaignProfile: "churned_customers", workSchedule: campaignWorkSchedule });
    const recruiting = await createScenario("recruit-right-candidates", "campaign", relationshipCampaignSteps("recruiting", "fill an open role with strong, relevant candidates"), { campaignProfile: "recruiting", workSchedule: campaignWorkSchedule });
    const keyAccounts = await createScenario("protect-and-expand-key-accounts", "campaign", relationshipCampaignSteps("key_accounts", "reduce churn risk and find expansion opportunities in active accounts"), { campaignProfile: "key_accounts", workSchedule: campaignWorkSchedule });

    const retry = await createScenario("transient-provider-retry", "retry", [{ id: "retry", title: "Retry", objective: "Retry a non-dispatched provider read once and complete with a receipt.", allowedTools: ["GOOGLE_SHEETS_GET"] }]);
    const uncertain = await createScenario("uncertain-write-reconciliation", "uncertain", [{ id: "uncertain", title: "Uncertain write", objective: "Reconcile an accepted-but-uncertain email send without sending twice.", allowedTools: ["GMAIL_SEND_EMAIL", "GMAIL_GET_MESSAGE"] }]);
    const disconnected = await createScenario("revoked-connection", "disconnected", [{ id: "connection", title: "Connection gate", objective: "Attempt to save work to a revoked Notion connection and block honestly.", allowedTools: ["NOTION_CREATE_PAGE"] }]);
    const human = await createScenario("human-input-resume", "human_input", [{ id: "input", title: "Missing owner detail", objective: "Wait for the owner to supply the missing outreach audience, then continue.", allowedTools: ["GMAIL_SEND_EMAIL"] }]);
    const duplicate = await createScenario("duplicate-and-cross-owner-delivery", "duplicate", [{ id: "duplicate", title: "Duplicate", objective: "Complete once when the queue delivers the task repeatedly.", allowedTools: ["GOOGLE_SHEETS_APPEND_ROWS"] }]);
    const cancelled = await createScenario("cancel-before-delivery", "cancelled", [{ id: "cancelled", title: "Cancelled", objective: "Never execute after the owner cancels before delivery.", allowedTools: ["GMAIL_SEND_EMAIL"] }]);
    const parallel = await createScenario("parallel-branches-and-join", "parallel", [
      { id: "root", title: "Root", objective: "Prepare the branch inputs." },
      { id: "people", title: "People", objective: "Process the people branch.", dependsOn: ["root"], allowedTools: ["GOOGLE_SHEETS_APPEND_ROWS"] },
      { id: "companies", title: "Companies", objective: "Process the company branch.", dependsOn: ["root"], allowedTools: ["GOOGLE_SHEETS_APPEND_ROWS"] },
      { id: "join", title: "Join", objective: "Join both verified branches.", dependsOn: ["people", "companies"], allowedTools: ["GOOGLE_SHEETS_APPEND_ROWS"] },
    ]);

    assert.ok([campaign, lostDeals, partners, churned, recruiting, keyAccounts, retry, uncertain, duplicate, cancelled].every((scenario) => scenario.initialTaskId));
    await cancelMission(cancelled.userId, cancelled.missionId, "Synthetic owner cancellation before the queue delivery.");
    await cancelMissionTasks(cancelled.userId, cancelled.missionId);

    // Publish the duplicate and cross-owner deliveries after the normal
    // publication. The task lease, owner scope, and completion CAS must make
    // both harmless.
    await publish(duplicate.userId, duplicate.initialTaskId!);
    const foreignOwner = duplicate.userId + 50_000;
    ownerIds.add(foreignOwner);
    await publish(foreignOwner, duplicate.initialTaskId!);

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !errors.length) {
      const states = await Promise.all([...scenarios.values()].map(async (scenario) => (await getMission(scenario.userId, scenario.missionId))?.status));
      const terminal = [...scenarios.values()].every((scenario, index) => states[index] === scenario.expectedStatus);
      const campaignStates = await Promise.all([...scenarios.values()].filter((scenario) => scenario.kind === "campaign").map(async (scenario) => getMission(scenario.userId, scenario.missionId)));
      const requiredFullPaths = campaignStates.every((mission) => mission?.status === "completed" && mission.steps.length === 13);
      if (terminal && requiredFullPaths && signedDeliveryIds.size >= 25) break;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
    }
    await Promise.all([...processing]);
    assert.deepEqual(errors, []);
    assert.equal(signedDeliveryIds.size, messageIds.length, "Every accepted QStash publication must be observed as a signed delivery in this no-retry run.");
    const terminalStatuses = await Promise.all([...scenarios.values()].map(async (scenario) => ({
      name: scenario.name,
      expected: scenario.expectedStatus,
      actual: (await getMission(scenario.userId, scenario.missionId))?.status,
    })));
    assert.deepEqual(
      terminalStatuses.filter(({ expected, actual }) => expected !== actual),
      [],
      `Every complex mission scenario must reach its expected terminal state: ${JSON.stringify(terminalStatuses)}`,
    );
    assert.equal(deniedForeignDeliveries.length >= 1, true, "A cross-owner delivery must be rejected.");
    assert.equal(connectionBlocks, 1);
    assert.equal(approvalWaits, 6);
    assert.equal(providerWaits, 6);
    assert.equal(humanInputWaits, 1);
    assert.equal(timerWaits, 6);
    assert.ok(duplicateTaskDeliveriesSuppressed >= 1, "Duplicate task delivery must be suppressed by the durable task lease/CAS.");
    assert.ok([...deniedHosts].every((host) => ["registry.npmjs.org", "telemetry.composio.dev"].includes(host)), "Unexpected non-queue network activity was attempted.");
    assert.equal(providerReceipts.get([...providerReceipts.keys()].find((key) => key.startsWith(`${uncertain.missionId}:`))!)?.dispatched, 1, "Uncertain provider action must not be dispatched twice.");
    const output = [];
    for (const scenario of scenarios.values()) {
      const mission = await getMission(scenario.userId, scenario.missionId);
      const tasks = (await listTasks(scenario.userId)).filter((task) => task.missionId === scenario.missionId);
      output.push({ name: scenario.name, kind: scenario.kind, profile: scenario.profile, status: mission?.status, expectedStatus: scenario.expectedStatus, stepStatuses: mission?.steps.map(({ id, status, attempts }) => ({ id, status, attempts })), taskStatuses: tasks.map(({ id, status, attempt }) => ({ id, status, attempt })), scriptedRuns: scenario.scriptedRuns, events: mission?.events.filter((event) => ["waiting", "approval_waiting", "approval_resumed", "provider_event", "blocked", "completed", "cancelled"].includes(event.type)).map(({ type, message }) => ({ type, message })) });
    }
    console.log(JSON.stringify({
      ok: true,
      storage: "isolated-memory",
      queue: "real-qstash",
      modelProviderCalls: 0,
      appProviderCalls: 0,
      signedDeliveries: signedDeliveryIds.size,
      publications: messageIds.length,
      scriptedAgentRuns,
      providerDispatches: [...providerReceipts.values()].reduce((total, receipt) => total + receipt.dispatched, 0),
      connectedAccounts: [...appConnections.values()].map(({ toolkit, accountId, alias, status }) => ({ toolkit, accountId, alias, status })),
      providerActionLogEntries: providerActionLog.length,
      duplicateSuppressed,
      duplicateTaskDeliveriesSuppressed,
      deniedForeignDeliveries: deniedForeignDeliveries.length,
      controlTransitions: { timerWaits, approvalWaits, providerWaits, humanInputWaits, connectionBlocks },
      blockedBackgroundHosts: [...deniedHosts],
      scenarios: output,
      tested: [
        "goal-to-feedback campaign with 13 dependency-ordered stages",
        "lost-deal re-engagement campaign with CRM deal signals and revival follow-through",
        "referral and integration partner campaign with company-fit ranking",
        "churned-customer win-back campaign with account-history recovery",
        "candidate recruiting campaign with ATS-backed list and shortlist steps",
        "key-account protection and expansion campaign with customer-care follow-through",
        "real QStash signatures and delayed timer wake",
        "connected account selection plus discovery/schema/execute sequencing",
        "approval pause and exact-task resume",
        "provider callback wait, duplicate callback, and read-back",
        "human-input wait and resume",
        "non-dispatched transient failure retry",
        "accepted-but-uncertain provider write without duplicate dispatch",
        "revoked app connection blocks without a write",
        "parallel branches and dependency join",
        "duplicate task delivery and cross-owner rejection",
        "cancellation before delivery",
      ],
      limitations: [
        "Smee acknowledges HTTP before local processing; QStash retry-after-receiver-failure is not proven here.",
        "Storage is isolated in memory; Redis/Neon persistence and process restart require a separate deployed canary.",
        "App connections and provider receipts are scripted boundaries; no Gmail, Calendar, CRM, Notion, Twilio, voice, or model API was called.",
        "The multi-day contract is represented by durable mission budgets, work schedule, checkpoints, and waits; this run compresses elapsed wall time.",
      ],
    }, null, 2));
  } finally {
    streamAbort.abort();
    await stream;
    await Promise.allSettled(messageIds.map((id) => client.messages.delete(id)));
    await store.closeStore();
    globalThis.fetch = nativeFetch;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : "Complex mission matrix failed");
  process.exitCode = 1;
});
