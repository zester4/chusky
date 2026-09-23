import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { delegationStartedStatus, executeDelegation } from "../src/subagents/executor.js";
import { nativeTool, setPhoneCallLauncherForTests } from "../src/nativeTools.js";
import { WORKER_CAPABILITIES, classifyDelegationObjective, isComposioToolAllowedForWorker, normalizeDelegationToolScopes, planDelegationObjective, validateDelegationTarget } from "../src/subagents/capabilities.js";
import { initStore, getSession, listHandoffRecords, listTasks, createMission } from "../src/store.js";

beforeEach(async () => {
  await initStore({ memoryOnly: true });
  setPhoneCallLauncherForTests(async (userId, input) => ({ id: `twc_test_${userId}`, userId, provider: "twilio", direction: "outbound", callProfile: input.callProfile, phoneNumber: input.phoneNumber, purpose: input.purpose, status: "bridging", createdAt: Date.now(), updatedAt: Date.now() }));
});

afterEach(() => setPhoneCallLauncherForTests());

test("validates capability registry manifests for all worker capabilities", () => {
  const workers = ["lucas", "maya", "leo", "sofia", "dexter", "elena", "nora", "ivy", "quinn", "aria", "kai"] as const;
  for (const w of workers) {
    const cap = WORKER_CAPABILITIES[w];
    assert.ok(cap);
    assert.equal(cap.name, w);
    assert.ok(cap.allowedTools.length > 0);
    assert.ok(cap.allowedMemoryCategories.length > 0);
    assert.ok(Array.isArray(cap.allowedComposioPrefixes));
    assert.ok(cap.skills.primary.length > 0);
    assert.ok(Array.isArray(cap.skills.supporting));
    assert.ok(cap.systemPrompt.length > 20);
    assert.ok(cap.reflectionChecklist.length > 0);
  }
});

test("declares the intended worker-to-skill map", () => {
  assert.deepEqual(WORKER_CAPABILITIES.nora.skills.primary, ["research-pro"]);
  assert.ok(WORKER_CAPABILITIES.lucas.skills.primary.includes("fullstack-dev"));
  assert.ok(WORKER_CAPABILITIES.maya.skills.primary.includes("writing-pro"));
  assert.deepEqual(WORKER_CAPABILITIES.sofia.skills.primary, ["voice-call-pro"]);
  assert.deepEqual(WORKER_CAPABILITIES.dexter.skills.primary, ["computer-pro"]);
  assert.ok(WORKER_CAPABILITIES.elena.skills.primary.includes("project-pro"));
  assert.ok(WORKER_CAPABILITIES.chusky.skills.primary.includes("meeting-pro"));
  assert.deepEqual(WORKER_CAPABILITIES.ivy.skills.primary, ["workspace-pro", "writing-pro"]);
  assert.ok(WORKER_CAPABILITIES.quinn.skills.primary.includes("customer-research"));
  assert.ok(WORKER_CAPABILITIES.aria.skills.primary.includes("meeting-pro"));
  assert.ok(WORKER_CAPABILITIES.kai.skills.primary.includes("research-pro"));
});

test("routes business workflow objectives to their owning specialists", () => {
  assert.deepEqual(classifyDelegationObjective("triage the Gmail inbox and draft priority replies"), ["ivy"]);
  assert.deepEqual(classifyDelegationObjective("clean the sales pipeline and prepare qualified deal next steps"), ["quinn"]);
  assert.deepEqual(classifyDelegationObjective("run customer onboarding and identify churn risk"), ["aria"]);
  assert.deepEqual(classifyDelegationObjective("prepare the weekly KPI report and flag anomalies"), ["kai"]);
});

test("keeps business workers inside their intended connected-app families", () => {
  assert.equal(isComposioToolAllowedForWorker("ivy", "GMAIL_SEARCH_EMAILS"), true);
  assert.equal(isComposioToolAllowedForWorker("ivy", "SALESFORCE_UPDATE_OPPORTUNITY"), false);
  assert.equal(isComposioToolAllowedForWorker("quinn", "HUBSPOT_UPDATE_DEAL"), true);
  assert.equal(isComposioToolAllowedForWorker("quinn", "GOOGLESHEETS_UPDATE_SPREADSHEET"), false);
  assert.equal(isComposioToolAllowedForWorker("aria", "GOOGLECALENDAR_CREATE_EVENT"), true);
  assert.equal(isComposioToolAllowedForWorker("aria", "STRIPE_CREATE_PAYMENT_LINK"), true);
  assert.equal(isComposioToolAllowedForWorker("kai", "GOOGLESHEETS_GET_SPREADSHEET"), true);
  assert.equal(isComposioToolAllowedForWorker("kai", "GMAIL_SEND_EMAIL"), false);
});

test("gives Nora only scoped Composio research-provider families", () => {
  const nora = WORKER_CAPABILITIES.nora;
  for (const tool of ["CHUCK_ARTIFACT", "CHUCK_CREATE_PDF", "CHUCK_CREATE_DOCUMENT", "CHUCK_REQUEST_ADDITIONAL_TOOLS"]) {
    assert.ok(nora.allowedTools.includes(tool), `${tool} should be available to Nora`);
  }
  for (const tool of ["TAVILY_SEARCH", "EXA_SEARCH", "FIRECRAWL_SCRAPE"]) {
    assert.equal(isComposioToolAllowedForWorker("nora", tool), true, `${tool} should be allowed for Nora when Chusky verifies it`);
  }
  for (const tool of ["COMPOSIO_SEARCH_WEB", "COMPOSIO_SEARCH_FETCH_URL_CONTENT", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_EXECUTE_TOOL", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL"]) {
    assert.equal(isComposioToolAllowedForWorker("nora", tool), true, `${tool} should be scoped to Nora`);
  }
  assert.equal(isComposioToolAllowedForWorker("nora", "COMPOSIO_SEARCH_TOOLS"), false, "Nora must request tool discovery from Chusky");
  assert.equal(isComposioToolAllowedForWorker("nora", "COMPOSIO_SEARCH_TOOL"), false, "Nora must not use the legacy search alias");
  for (const tool of ["GITHUB_CREATE_PULL_REQUEST"]) {
    assert.equal(isComposioToolAllowedForWorker("nora", tool), false, `${tool} must not be available to Nora`);
  }
  assert.match(nora.systemPrompt, /Tavily or Exa/);
  assert.match(nora.systemPrompt, /Firecrawl/);
});

test("normalizes generic web search aliases into the canonical Composio scope", () => {
  assert.deepEqual(
    normalizeDelegationToolScopes({
      allowedTools: ["web_search", "CHUCK_SCRATCHPAD_READ"],
      allowedComposioTools: ["web_search", "COMPOSIO_SEARCH_WEB"],
    }),
    {
      allowedTools: ["CHUCK_SCRATCHPAD_READ"],
      allowedComposioTools: ["COMPOSIO_SEARCH_WEB"],
    },
  );
});

test("does not let the web search alias bypass another worker's Composio boundary", async () => {
  await assert.rejects(
    () => executeDelegation(991016, {
      worker: "ivy",
      objective: "Triage the inbox and identify urgent communications",
      allowedTools: ["web_search"],
    }),
    /Composio tool\(s\).*not permitted/,
  );
});

test("routes a focused research objective to Nora", () => {
  validateDelegationTarget("nora", "Research current competitors, compare their pricing, and return cited evidence");
  assert.throws(
    () => validateDelegationTarget("lucas", "Research current competitors, compare their pricing, and return cited evidence"),
    /matches Nora.*worker=nora/
  );
});

test("builds routable role-specific stages for a mixed objective", () => {
  const plan = planDelegationObjective("Build a product website and create its brand images");
  assert.deepEqual(plan.map((step) => step.worker), ["leo", "lucas"]);
  for (const step of plan) validateDelegationTarget(step.worker, step.objective);
});

test("automatically sequences a mixed supervisor delegation instead of surfacing a routing error", async () => {
  const result = await nativeTool(991015, "CHUCK_DELEGATE_SUBAGENT", {
    worker: "lucas",
    objective: "Build a product website and create its brand images",
    context: { toolCall: { name: "CHUCK_SCRATCHPAD_READ", args: { query: "brand" } } },
  }) as { orchestration: string; status: string; completedStages: Array<{ worker: string }> };
  assert.equal(result.orchestration, "multi_specialist");
  assert.equal(result.status, "success");
  assert.deepEqual(result.completedStages.map((stage) => stage.worker), ["leo", "lucas"]);
  assert.equal((await listHandoffRecords(991015)).length, 2);
});

test("gives Lucas a complete private engineering loop while keeping provider tools role-scoped", () => {
  const lucas = WORKER_CAPABILITIES.lucas;
  for (const tool of ["CHUCK_DAYTONA_GIT", "CHUCK_DAYTONA_BROWSER", "CHUCK_DAYTONA_COMPUTER", "CHUCK_DAYTONA_PTY", "CHUCK_DAYTONA_PREVIEW"]) {
    assert.ok(lucas.allowedTools.includes(tool), `${tool} should be available to Lucas`);
  }
  assert.equal(isComposioToolAllowedForWorker("lucas", "GITHUB_CREATE_PULL_REQUEST"), true);
  assert.equal(isComposioToolAllowedForWorker("lucas", "COMPOSIO_SEARCH_TOOLS"), false);
  assert.equal(isComposioToolAllowedForWorker("lucas", "COMPOSIO_REMOTE_BASH_TOOL"), false);
  assert.equal(isComposioToolAllowedForWorker("leo", "GITHUB_CREATE_PULL_REQUEST"), false);
  assert.deepEqual(WORKER_CAPABILITIES.maya.starterComposioTools, [
    "GMAIL_SEND_EMAIL",
    "INSTAGRAM_POST_IG_USER_MEDIA",
    "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
    "LINKEDIN_CREATE_LINKED_IN_POST",
  ]);
  for (const slug of WORKER_CAPABILITIES.maya.starterComposioTools) assert.equal(isComposioToolAllowedForWorker("maya", slug), true);
});

test("rejects high-confidence engineering work routed to Leo", () => {
  assert.throws(
    () => validateDelegationTarget("leo", "Fix the backend TypeScript bug and run the test suite"),
    /matches Lucas.*worker=lucas.*not worker=leo/
  );
});

test("rejects high-confidence visual work routed to Lucas", () => {
  assert.throws(
    () => validateDelegationTarget("lucas", "Create a new logo and marketing image"),
    /matches Leo.*worker=leo.*not worker=lucas/
  );
});

test("does not persist a task when semantic routing is invalid", async () => {
  const userId = 991012;
  await assert.rejects(
    () => executeDelegation(userId, { worker: "leo", objective: "Debug the backend API failure" }),
    /Delegation routing rejected.*worker=lucas/
  );
  assert.equal((await listTasks(userId)).length, 0);
  assert.equal((await listHandoffRecords(userId)).length, 0);
});

test("rejects a Composio action outside the worker's scoped integration family", async () => {
  await assert.rejects(
    () => executeDelegation(991009, {
      worker: "leo",
      objective: "Attempt repository write through an unrelated provider action",
      allowedComposioTools: ["GITHUB_CREATE_PULL_REQUEST"],
    }),
    /Composio tool\(s\).*not permitted/
  );
});

test("lets a worker request, but never self-grant, a missing capability", async () => {
  const result = await executeDelegation(991010, {
    worker: "lucas",
    objective: "Need repository pull-request access",
    context: {
      toolCall: {
        name: "CHUCK_REQUEST_ADDITIONAL_TOOLS",
        args: {
          intent: "Create a pull request for the verified branch",
          reason: "The current contract has no GitHub pull-request action.",
          preferredToolkit: "github",
        },
      },
    },
  });
  assert.equal(result.status, "requires_tool_request");
  assert.deepEqual(result.toolRequest, {
    intent: "Create a pull request for the verified branch",
    reason: "The current contract has no GitHub pull-request action.",
    preferredToolkit: "github",
  });
  assert.equal(result.toolCallsLog[0]?.result && (result.toolCallsLog[0].result as { requested?: boolean }).requested, true);
});

test("resumes the same durable worker task and handoff after a scoped tool decision", async () => {
  const userId = 991011;
  const paused = await executeDelegation(userId, {
    worker: "lucas",
    objective: "Prepare a verified pull-request plan",
    context: {
      toolCall: {
        name: "CHUCK_REQUEST_ADDITIONAL_TOOLS",
        args: { intent: "Create a pull request", reason: "GitHub action was not included in this worker scope." },
      },
    },
  });
  assert.equal(paused.status, "requires_tool_request");
  assert.ok(paused.taskId);
  assert.ok(paused.handoffRecord);

  const resumed = await executeDelegation(userId, {
    worker: "lucas",
    objective: paused.handoffRecord!.objective,
    context: { previousToolRequest: paused.toolRequest },
    allowedComposioTools: ["GITHUB_CREATE_PULL_REQUEST"],
  }, {
    resume: { handoffId: paused.handoffRecord!.id, taskId: paused.taskId!, workflowRunId: "subagent-tools-test-1", resumeCount: 1 },
  });
  assert.equal(resumed.status, "success");
  assert.equal(resumed.taskId, paused.taskId);
  assert.equal(resumed.handoffRecord?.id, paused.handoffRecord?.id);
  assert.equal(resumed.handoffRecord?.resumeCount, 1);
});

test("executes typed delegation contract for Lucas with tool execution in boundary", async () => {
  const userId = 991001;
  const result = await executeDelegation(userId, {
    worker: "lucas",
    objective: "Compile project documentation",
    expectedOutput: "Clean documentation pdf",
    context: {
      toolCall: {
        name: "CHUCK_SCRATCHPAD_READ",
        args: { query: "doc" },
      },
    },
  });

  assert.equal(result.worker, "lucas");
  assert.equal(result.status, "success");
  assert.equal(result.toolCallsCount, 1);
  assert.ok(result.durationMs >= 0);
  assert.ok(result.taskId);
  assert.ok(result.handoffRecord);
  assert.equal(result.handoffRecord.from, "chusky");
  assert.equal(result.handoffRecord.to, "lucas");
  assert.equal(result.handoffRecord.taskId, result.taskId);

  // Verify handoff record persistence
  const handoffs = await listHandoffRecords(userId);
  assert.ok(handoffs.length > 0);
  assert.equal(handoffs[0].to, "lucas");
  assert.equal(handoffs[0].status, "success");

  // Verify durable task linkage
  const tasks = await listTasks(userId);
  assert.ok(tasks.length > 0);
  assert.equal(tasks[0].id, result.taskId);
  assert.match(tasks[0].title, /Lucas/);
});

test("rejects delegation contract with invalid tools not in manifest allowlist", async () => {
  const userId = 991006;
  await assert.rejects(
    async () => {
      await executeDelegation(userId, {
        worker: "leo",
        objective: "Invalid tool delegation test",
        allowedTools: ["CHUCK_DAYTONA_DELETE_FILE"], // Not allowed in Leo manifest
      });
    },
    /Invalid delegation contract/
  );
});

test("blocks worker capability from executing tools outside its whitelist boundary", async () => {
  const userId = 991002;
  // Leo (Marketing) is NOT allowed to execute CHUCK_DAYTONA_DELETE_FILE
  const result = await executeDelegation(userId, {
    worker: "leo",
    objective: "Attempt unauthorized system file deletion",
    context: {
      toolCall: {
        name: "CHUCK_DAYTONA_DELETE_FILE",
        args: { path: "workspace/config.json" },
      },
    },
  });

  assert.equal(result.status, "failed");
  assert.match(result.output, /Security boundary error: Tool CHUCK_DAYTONA_DELETE_FILE is not permitted for worker capability leo/);
});

test("enforces maxToolCalls budget limit on worker delegation contract", async () => {
  const userId = 991003;
  const result = await executeDelegation(userId, {
    worker: "lucas",
    objective: "Excessive tool execution test",
    maxToolCalls: 0, // 0 budget
    context: {
      toolCall: {
        name: "CHUCK_DAYTONA_FILE_DETAILS",
        args: { path: "workspace" },
      },
    },
  });

  assert.equal(result.status, "max_tool_calls_exceeded");
  assert.match(result.output, /exceeded max tool call limit/);
});

test("accepts the expanded 100-call per-slice worker ceiling", async () => {
  const result = await executeDelegation(991013, {
    worker: "lucas",
    objective: "Inspect the repository and prepare an engineering report",
    maxToolCalls: 100,
    context: { toolCall: { name: "CHUCK_SCRATCHPAD_READ", args: { query: "report" } } },
  });
  assert.equal(result.handoffRecord?.delegation?.maxToolCalls, 100);
});

test("supports five-minute worker budgets for simple tasks", async () => {
  const result = await executeDelegation(991014, {
    worker: "lucas",
    objective: "Read a short scratchpad note",
    duration: "5m",
    budgetSeconds: 1,
    context: { toolCall: { name: "CHUCK_SCRATCHPAD_READ", args: { query: "short" } } },
  });
  assert.equal(result.handoffRecord?.delegation?.duration, "5m");
  assert.equal(result.handoffRecord?.delegation?.budgetSeconds, 5 * 60);
});

test("lets a delegated worker start a validated outbound call without an approval pause", async () => {
  const userId = 991004;
  // Sofia attempts risky tool CHUCK_START_PHONE_CALL
  const result = await executeDelegation(userId, {
    worker: "sofia",
    objective: "Place outbound phone call to vendor",
    context: {
      toolCall: {
        name: "CHUCK_START_PHONE_CALL",
        args: { phoneNumber: "+14155550123", purpose: "Vendor price negotiation", callProfile: "personal" },
      },
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.approvalId, undefined);
  assert.equal(result.proposal, undefined);
  const session = await getSession(userId);
  assert.equal(session.approvals.some((a) => a.toolSlug === "CHUCK_START_PHONE_CALL"), false);
});

test("allows safe read-only tools to execute automatically even under strict approvalPolicy", async () => {
  const userId = 991007;
  const result = await executeDelegation(userId, {
    worker: "lucas",
    objective: "Read safe scratchpad note",
    approvalPolicy: "require_chusky_approval", // Strict policy
    context: {
      toolCall: {
        name: "CHUCK_SCRATCHPAD_READ",
        args: { query: "note" },
      },
    },
  });

  // Read-only tools must execute automatically without requiring approval
  assert.equal(result.status, "success");
  assert.equal(result.toolCallsCount, 1);
});

test("lets Elena use mission proof, evidence, and repair controls under strict worker approval policy", async () => {
  const userId = 991017;
  const cases = [
    { name: "CHUCK_MISSION_PROOF", args: (id: string) => ({ id }) },
    { name: "CHUCK_MISSION_EVIDENCE", args: (id: string) => ({ id, evidence: [{ kind: "assertion", summary: "Checkpoint recorded", verified: false }] }) },
    { name: "CHUCK_MISSION_REPAIR", args: (id: string) => ({ id, reason: "Recover the failed mission", nextAction: "Resume from its checkpoint" }) },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    const mission = await createMission(userId, {
      id: `mis_worker_approval_${index}`,
      title: "Worker approval regression",
      objective: "Exercise safe mission controls",
      definitionOfDone: "Mission control tool executes without an approval pause",
    });
    const result = await executeDelegation(userId, {
      worker: "elena",
      objective: `Use ${scenario.name} to continue mission governance`,
      allowedTools: [scenario.name],
      approvalPolicy: "require_chusky_approval",
      context: { toolCall: { name: scenario.name, args: scenario.args(mission.id) } },
    });

    assert.equal(result.status, "success", scenario.name);
    assert.equal(result.approvalId, undefined, scenario.name);
    assert.equal((await getSession(userId)).approvals.some((approval) => approval.toolSlug === scenario.name), false, scenario.name);
  }
});

test("executes peer handoff between domain workers via CHUCK_HANDOFF_SUBAGENT", async () => {
  const userId = 991008;
  const result = await executeDelegation(userId, {
    worker: "lucas",
    objective: "Hand off visual branding task to Leo",
    context: {
      toolCall: {
        name: "CHUCK_HANDOFF_SUBAGENT",
        args: {
          targetWorker: "leo",
          objective: "Generate product marketing graphic",
          expectedOutput: "Marketing banner image asset",
        },
      },
    },
  });

  assert.equal(result.status, "success");
  const handoffs = await listHandoffRecords(userId);
  assert.ok(handoffs.length >= 2);
  assert.ok(handoffs.some((handoff) => handoff.to === "leo"));
});

test("emits real-time status update callbacks to Telegram during execution", async () => {
  const userId = 991005;
  const statusLogs: string[] = [];

  await executeDelegation(
    userId,
    {
      worker: "lucas",
      objective: "Inspect project status",
      context: {
        toolCall: {
          name: "CHUCK_SCRATCHPAD_READ",
          args: { query: "status" },
        },
      },
    },
    {
      onStatus: async (text) => {
        statusLogs.push(text);
      },
    }
  );

  assert.ok(statusLogs.length >= 2);
  assert.match(statusLogs[0], /Delegated to Lucas/);
  assert.match(statusLogs[0], /Task: Inspect project status/);
});

test("formats a bounded specialist handoff preview without hidden worker context", () => {
  const objective = `Create a dashboard\nwith customer-facing metrics and a release checklist. ${"x".repeat(200)}`;
  const status = delegationStartedStatus("Lucas — Lead Engineer", objective);
  assert.match(status, /^🤝 Delegated to Lucas — Lead Engineer\nTask: Create a dashboard with customer-facing metrics/);
  assert.match(status, /…$/);
  assert.ok(status.length <= 220);
});
