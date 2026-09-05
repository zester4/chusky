import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { executeDelegation } from "../src/subagents/executor.js";
import { WORKER_CAPABILITIES, isComposioToolAllowedForWorker } from "../src/subagents/capabilities.js";
import { initStore, getSession, listHandoffRecords, listTasks } from "../src/store.js";

beforeEach(async () => { await initStore({ memoryOnly: true }); });

test("validates capability registry manifests for all 6 worker capabilities", () => {
  const workers = ["lucas", "maya", "leo", "sofia", "dexter", "elena"] as const;
  for (const w of workers) {
    const cap = WORKER_CAPABILITIES[w];
    assert.ok(cap);
    assert.equal(cap.name, w);
    assert.ok(cap.allowedTools.length > 0);
    assert.ok(cap.allowedMemoryCategories.length > 0);
    assert.ok(Array.isArray(cap.allowedComposioPrefixes));
    assert.ok(cap.systemPrompt.length > 20);
    assert.ok(cap.reflectionChecklist.length > 0);
  }
});

test("gives Lucas a complete private engineering loop while keeping provider tools role-scoped", () => {
  const lucas = WORKER_CAPABILITIES.lucas;
  for (const tool of ["CHUCK_DAYTONA_GIT", "CHUCK_DAYTONA_BROWSER", "CHUCK_DAYTONA_COMPUTER", "CHUCK_DAYTONA_PTY", "CHUCK_DAYTONA_PREVIEW"]) {
    assert.ok(lucas.allowedTools.includes(tool), `${tool} should be available to Lucas`);
  }
  assert.equal(isComposioToolAllowedForWorker("lucas", "GITHUB_CREATE_PULL_REQUEST"), true);
  assert.equal(isComposioToolAllowedForWorker("lucas", "COMPOSIO_SEARCH_TOOL"), false);
  assert.equal(isComposioToolAllowedForWorker("lucas", "COMPOSIO_REMOTE_BASH_TOOL"), false);
  assert.equal(isComposioToolAllowedForWorker("leo", "GITHUB_CREATE_PULL_REQUEST"), false);
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

test("creates pre-execution approval record and pauses delegation when worker attempts a risky tool call", async () => {
  const userId = 991004;
  // Sofia attempts risky tool CHUCK_START_PHONE_CALL
  const result = await executeDelegation(userId, {
    worker: "sofia",
    objective: "Place outbound phone call to vendor",
    context: {
      toolCall: {
        name: "CHUCK_START_PHONE_CALL",
        args: { phoneNumber: "+14155550123", purpose: "Vendor price negotiation" },
      },
    },
  });

  assert.equal(result.status, "requires_approval");
  assert.ok(result.approvalId);
  assert.ok(result.proposal);
  assert.equal(result.proposal.actionName, "CHUCK_START_PHONE_CALL");

  // Verify approval record exists in user session store
  const session = await getSession(userId);
  const record = session.approvals.find((a) => a.id === result.approvalId);
  assert.ok(record);
  assert.equal(record.toolSlug, "CHUCK_START_PHONE_CALL");
  assert.equal(record.status, "pending");
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
  assert.equal(handoffs[0].to, "leo");
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
  assert.match(statusLogs[0], /🤖 Lucas/);
});
