import test from "node:test";
import assert from "node:assert/strict";
import { chuckTools, modelFacingChuckTools, validateNativeToolArguments, validateToolArgumentsAgainstSchema } from "../src/agentTools.js";

test("native tool catalog has unique names", () => {
  const names = chuckTools.map((tool) => tool.function.name);
  assert.equal(new Set(names).size, names.length);
});

test("native catalog includes core agent capabilities", () => {
  const names = new Set(chuckTools.map((tool) => tool.function.name));
  for (const name of ["CHUCK_SEARCH_SKILLS", "CHUCK_LIST_SKILL_FILES", "CHUCK_READ_SKILL_FILE", "CHUCK_LIST_CONNECTED_ACCOUNTS", "CHUCK_SET_REMINDER", "CHUCK_SCHEDULE_JOB", "CHUCK_TASK_WAIT", "CHUCK_MISSION_START", "CHUCK_MISSION_LIST", "CHUCK_MISSION_GET", "CHUCK_MISSION_CHECKPOINT", "CHUCK_MISSION_PAUSE", "CHUCK_MISSION_RESUME", "CHUCK_MISSION_CANCEL", "CHUCK_MISSION_BLOCK", "CHUCK_MISSION_COMPLETE", "CHUCK_SAVE_MEMORY", "CHUCK_SCRATCHPAD_WRITE", "CHUCK_GENERATE_IMAGE", "CHUCK_GENERATE_VIDEO", "CHUCK_VIDEO_STATUS", "CHUCK_CREATE_PDF", "CHUCK_CREATE_PRESENTATION", "CHUCK_CREATE_DOCUMENT", "CHUCK_CREATE_SPREADSHEET"]) {
    assert.equal(names.has(name), true, name);
  }
});

test("every published native schema declares and enforces each top-level required argument", () => {
  for (const tool of chuckTools) {
    const schema = tool.function.parameters as { type?: string; properties?: Record<string, unknown>; required?: string[] };
    assert.equal(schema.type, "object", `${tool.function.name} arguments must be an object schema`);
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${tool.function.name} requires ${key} but does not declare it`);
    }
    if (schema.required?.length) {
      assert.throws(
        () => validateNativeToolArguments(tool.function.name, {}),
        new RegExp(`${tool.function.name} requires argument: ${schema.required[0]}`),
      );
    }
  }
});

test("mission start gives an actionable correction when an existing mission ID is passed", () => {
  assert.throws(
    () => validateNativeToolArguments("CHUCK_MISSION_START", { id: "mis_existing" }),
    /creates a new mission.*CHUCK_MISSION_RESUME.*\{\s*id/i,
  );
});

test("mission lifecycle tool descriptions distinguish creation from recovery", () => {
  const start = chuckTools.find((tool) => tool.function.name === "CHUCK_MISSION_START")?.function.description ?? "";
  const resume = chuckTools.find((tool) => tool.function.name === "CHUCK_MISSION_RESUME")?.function.description ?? "";
  assert.match(start, /create a NEW .*mission/i);
  assert.match(start, /existing mission.*CHUCK_MISSION_RESUME/i);
  assert.match(resume, /existing mission/i);
  assert.match(resume, /never.*create/i);
});

test("task creation gives an actionable correction when an existing task ID is passed", () => {
  assert.throws(
    () => validateNativeToolArguments("CHUCK_TASK_CREATE", { id: "task_existing" }),
    /creates a new task.*CHUCK_TASK_GET.*no task was created/i,
  );
});

test("Treg exposes bounded intelligence tools without exposing a provider catalog", () => {
  const names = new Set(chuckTools.map((tool) => tool.function.name));
  for (const name of ["CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_PLATFORMS", "CHUCK_TREG_MY_TOOLS", "CHUCK_TREG_CALL", "CHUCK_TREG_ENRICH_PERSON", "CHUCK_TREG_ENRICH_COMPANY", "CHUCK_TREG_RESOLVE", "CHUCK_TREG_BALANCE", "CHUCK_TREG_USAGE", "CHUCK_TREG_OAUTH_START", "CHUCK_TREG_OAUTH_STATUS", "CHUCK_TREG_OAUTH_CONNECTIONS", "CHUCK_TREG_OAUTH_REVOKE"]) assert.equal(names.has(name), true, name);
  validateNativeToolArguments("CHUCK_TREG_SEARCH", { q: "find company revenue", limit: 5 });
  validateNativeToolArguments("CHUCK_TREG_RESOLVE", { need: "Find the company domain", maxCalls: 2, maxSpendUsd: 0.2 });
  assert.throws(() => validateNativeToolArguments("CHUCK_TREG_SEARCH", { q: "x" }), /at least 2/i);
  assert.deepEqual(chuckTools.find((tool) => tool.function.name === "CHUCK_TREG_CALL")?.function.parameters.properties.method.enum, ["GET", "POST", "PUT", "PATCH", "DELETE"]);
  validateNativeToolArguments("CHUCK_TREG_USAGE", { dayKey: "2026-09-27", limit: 10 });
  validateNativeToolArguments("CHUCK_TREG_PLATFORMS", { slug: "people-email" });
  validateNativeToolArguments("CHUCK_TREG_MY_TOOLS", {});
  validateNativeToolArguments("CHUCK_TREG_CALL", { endpointId: "tikhub.tiktok.user.profile", idempotencyKey: "research-1" });
  validateNativeToolArguments("CHUCK_TREG_OAUTH_START", { provider: "example" });
  validateNativeToolArguments("CHUCK_TREG_OAUTH_STATUS", { state: "oauth-state" });
  validateNativeToolArguments("CHUCK_TREG_OAUTH_REVOKE", { connectionId: "conn_123" });
  assert.throws(() => validateNativeToolArguments("CHUCK_TREG_USAGE", { dayKey: "27-09-2026" }), /pattern|format/i);
});

test("TinyFish web tools expose bounded search and public page fetch schemas", () => {
  const names = new Set(chuckTools.map((tool) => tool.function.name));
  assert.equal(names.has("CHUCK_TINYFISH_SEARCH"), true);
  assert.equal(names.has("CHUCK_TINYFISH_FETCH"), true);
  assert.equal(names.has("CHUCK_TINYFISH_RESEARCH"), true);
  assert.equal(names.has("CHUCK_TINYFISH_MONITOR"), true);
  validateNativeToolArguments("CHUCK_TINYFISH_SEARCH", { query: "latest AI news", recencyMinutes: 60, page: 0 });
  validateNativeToolArguments("CHUCK_TINYFISH_SEARCH", { query: "papers", domainType: "research_paper", pubYearMin: 2020, pubYearMax: 2025, includeDomains: ["arxiv.org"] });
  validateNativeToolArguments("CHUCK_TINYFISH_FETCH", { urls: ["https://example.com"], format: "markdown", links: true, includeSelectors: ["main"], highlights: { query: "what changed?", maxCount: 3 } });
  validateNativeToolArguments("CHUCK_TINYFISH_RESEARCH", { action: "start", query: "Compare official policy sources", mode: "standard" });
  validateNativeToolArguments("CHUCK_TINYFISH_MONITOR", { action: "create", type: "fetch", url: "https://example.com/pricing", scheduleCron: "0 9 * * *" });
  assert.throws(() => validateNativeToolArguments("CHUCK_TINYFISH_FETCH", { urls: [] }), /at least 1/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_TINYFISH_FETCH", { urls: ["https://example.com"], format: "text" }), /unsupported value/i);
});

test("Daytona image transfer exposes owner-scoped import and export without binary model input", () => {
  const tool = chuckTools.find((entry) => entry.function.name === "CHUCK_DAYTONA_IMAGE")!;
  assert.deepEqual(tool.function.parameters.properties.action.enum, ["import", "export"]);
  assert.deepEqual(tool.function.parameters.required, ["action"]);
  assert.equal(tool.function.parameters.additionalProperties, false);
  assert.equal("data" in tool.function.parameters.properties, false);
});

test("tool reliability diagnostics are explicit and image transfer is resolved inside normal app actions", () => {
  const names = new Set(chuckTools.map((tool) => tool.function.name));
  for (const name of ["CHUCK_TOOL_PREFLIGHT", "CHUCK_INTEGRATION_HEALTH", "CHUCK_ARTIFACT_QA", "CHUCK_FILE_BRIDGE", "CHUCK_MEDIA_BRIDGE", "CHUCK_TOOL_RECOVERY"]) assert.equal(names.has(name), true, name);
  for (const name of ["CHUCK_TOOL_PREFLIGHT", "CHUCK_INTEGRATION_HEALTH", "CHUCK_ARTIFACT_QA", "CHUCK_TOOL_RECOVERY"]) {
    const tool = chuckTools.find((entry) => entry.function.name === name)!;
    assert.deepEqual(tool.function.parameters.additionalProperties, false, name);
  }
  const bridge = chuckTools.find((entry) => entry.function.name === "CHUCK_FILE_BRIDGE")!;
  assert.deepEqual(bridge.function.parameters.required, ["artifactId", "toolSlug", "arguments"]);
  assert.match(bridge.function.description, /routine uploads follow the owner's direct request/i);
  assert.match(bridge.function.description, /high-impact nested actions retain exact approval checks/i);
  assert.match(bridge.function.description, /base64\/binary field/i);
  const media = chuckTools.find((entry) => entry.function.name === "CHUCK_MEDIA_BRIDGE")!;
  assert.deepEqual(media.function.parameters.required, ["source", "toolSlug", "arguments"]);
  assert.match(media.function.description, /routine actions need no extra prompt/i);
  assert.match(media.function.description, /high-impact nested actions retain exact approval checks/i);
  assert.match(media.function.description, /fail closed/i);
  assert.equal(modelFacingChuckTools.some((entry) => entry.function.name === "CHUCK_MEDIA_BRIDGE"), false);
  const qa = chuckTools.find((entry) => entry.function.name === "CHUCK_ARTIFACT_QA")!;
  assert.deepEqual(qa.function.parameters.properties.type.enum, ["pdf", "docx", "presentation", "spreadsheet"]);
});

test("owner-private call, meeting, browser, Git, and preflight descriptions agree with central approval policy", () => {
  for (const name of [
    "CHUCK_START_PHONE_CALL", "CHUCK_MEETING_JOIN", "CHUCK_MEETING_PROFILE_UPDATE",
    "CHUCK_DAYTONA_APP", "CHUCK_DAYTONA_GIT", "CHUCK_BROWSER",
    "CHUCK_EMAIL_ARTIFACT", "CHUCK_TOOL_PREFLIGHT",
  ]) {
    const tool = chuckTools.find((entry) => entry.function.name === name);
    assert.ok(tool, name);
    assert.doesNotMatch(tool.function.description, /only deletion|no separate approval step/i, name);
    assert.match(tool.function.description, /deletions?.*(?:high-impact|financial|permission|remote push|deployment).*(?:approval checks|retain approval)|(?:remote push|deployment).*(?:approval checks|retain approval)|approval for deletion and high-impact actions/i, name);
  }
});

test("internal task wait requires a checkpoint and an exact next action", () => {
  const wait = chuckTools.find((item) => item.function.name === "CHUCK_TASK_WAIT");
  assert.deepEqual(wait?.function.parameters.required, ["checkpoint", "nextAction"]);
  const properties = wait?.function.parameters.properties as Record<string, { minimum?: number; maximum?: number }>;
  assert.equal(properties.delaySeconds?.minimum, 60);
  assert.equal(properties.delaySeconds?.maximum, 7 * 24 * 60 * 60);
  assert.match(wait?.function.description ?? "", /does not notify the user/i);
});

test("connected-account discovery is bounded and supports optional toolkit filtering", () => {
  const tool = chuckTools.find((item) => item.function.name === "CHUCK_LIST_CONNECTED_ACCOUNTS");
  assert.deepEqual(tool?.function.parameters.properties.toolkit?.type, "string");
  assert.deepEqual(tool?.function.parameters.properties.limit?.maximum, 50);
  assert.equal(tool?.function.parameters.required, undefined);
});

test("delegation tools expose every business workflow specialist", () => {
  const delegate = chuckTools.find((tool) => tool.function.name === "CHUCK_DELEGATE_SUBAGENT");
  const handoff = chuckTools.find((tool) => tool.function.name === "CHUCK_HANDOFF_SUBAGENT");
  const expected = ["nora", "lucas", "maya", "leo", "sofia", "dexter", "elena", "ivy", "quinn", "aria", "kai"];
  assert.deepEqual(delegate?.function.parameters.properties.worker.enum, expected);
  assert.deepEqual(handoff?.function.parameters.properties.targetWorker.enum, expected);
  assert.match(delegate?.function.description ?? "", /Ivy.*Quinn.*Aria.*Kai/);
});

test("Recall meeting tools require explicit join details and expose owner-scoped controls", () => {
  const tools = new Set(chuckTools.map((tool) => tool.function.name));
  for (const name of ["CHUCK_MEETING_CONTEXT_PREPARE", "CHUCK_MEETING_CONTEXT_LOOKUP", "CHUCK_MEETING_JOIN", "CHUCK_MEETING_LIST", "CHUCK_MEETING_STATUS", "CHUCK_MEETING_LEAVE", "CHUCK_MEETING_TRANSCRIPT_SEARCH", "CHUCK_MEETING_TRANSCRIPT_DELETE"]) assert.equal(tools.has(name), true, name);
  for (const name of ["CHUCK_MEETING_PROFILE_GET", "CHUCK_MEETING_PROFILE_UPDATE"]) assert.equal(tools.has(name), true, name);
  const profileUpdate = chuckTools.find((tool) => tool.function.name === "CHUCK_MEETING_PROFILE_UPDATE");
  assert.ok(profileUpdate?.function.parameters.properties.composioAccountAliases);
  const join = chuckTools.find((tool) => tool.function.name === "CHUCK_MEETING_JOIN");
  assert.deepEqual(join?.function.parameters.required, ["meetingUrl"]);
  assert.match(join?.function.description ?? "", /addressed mode only when the owner explicitly requests wake-word-only behavior/i);
  assert.match(join?.function.description ?? "", /participate conversationally and naturally/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_MEETING_JOIN", {}), /requires argument/);
  validateNativeToolArguments("CHUCK_MEETING_JOIN", { meetingUrl: "https://meet.google.com/abc-defg-hij" });
  validateNativeToolArguments("CHUCK_MEETING_JOIN", { meetingUrl: "https://zoom.us/j/1234567890", interactionMode: "copilot" });
  validateNativeToolArguments("CHUCK_MEETING_JOIN", { meetingUrl: "https://zoom.us/j/1234567890", interactionMode: "representative" });
  validateNativeToolArguments("CHUCK_MEETING_JOIN", { meetingUrl: "https://zoom.us/j/1234567890", transcriptRetentionDays: 7 });
  assert.throws(() => validateNativeToolArguments("CHUCK_MEETING_JOIN", { meetingUrl: "https://zoom.us/j/1234567890", transcriptRetentionDays: 2 }), /unsupported value/);
  validateNativeToolArguments("CHUCK_MEETING_TRANSCRIPT_SEARCH", { query: "pilot approval" });
  validateNativeToolArguments("CHUCK_MEETING_TRANSCRIPT_DELETE", { meetingId: "mtg_123" });
  validateNativeToolArguments("CHUCK_MEETING_CONTEXT_PREPARE", { clientName: "Acme", objective: "Close onboarding" });
  assert.throws(() => validateNativeToolArguments("CHUCK_MEETING_CONTEXT_LOOKUP", {}), /requires argument/);
  assert.throws(() => validateNativeToolArguments("CHUCK_MEETING_JOIN", { meetingUrl: "https://zoom.us/j/1234567890", interactionMode: "autonomous-unbounded" }), /unsupported value/);
  validateNativeToolArguments("CHUCK_MEETING_PROFILE_UPDATE", { enabled: true, role: "sales", objective: "Qualify leads and progress deals" });
  assert.throws(() => validateNativeToolArguments("CHUCK_MEETING_PROFILE_UPDATE", { role: "unbounded" }), /unsupported value/);
});

test("exposes Twilio as the only agent-call transport", () => {
  const names = new Set(chuckTools.map((tool) => tool.function.name));
  assert.equal(names.has("CHUCK_START_PHONE_CALL"), true);
  assert.equal(names.has("CHUCK_LIST_PHONE_CALLS"), true);
});

test("presentation generator requires a title and structured slides", () => {
  const tool = chuckTools.find((item) => item.function.name === "CHUCK_CREATE_PRESENTATION");
  assert.deepEqual(tool?.function.parameters.required, ["title", "slides"]);
  const properties = tool?.function.parameters.properties as Record<string, { type?: string }>;
  assert.equal(properties.slides?.type, "array");
});

test("spreadsheet generator exposes bounded formulas and independent calculation evidence", () => {
  const tool = chuckTools.find((item) => item.function.name === "CHUCK_CREATE_SPREADSHEET") as any;
  const sheet = tool.function.parameters.properties.sheets.items;
  assert.equal(sheet.properties.formulas.type, "array");
  assert.deepEqual(sheet.properties.formulas.items.required, ["cell", "formula"]);
  assert.match(tool.function.description, /LibreOffice/);
  for (const name of ["CHUCK_CREATE_DOCUMENT", "CHUCK_CREATE_PDF"]) {
    const artifactTool = chuckTools.find((item) => item.function.name === name);
    assert.match(artifactTool?.function.description ?? "", /independently extracts the rendered text/);
  }
});

test("scheduled tools expose required parameters", () => {
  const reminder = chuckTools.find((tool) => tool.function.name === "CHUCK_SET_REMINDER");
  const job = chuckTools.find((tool) => tool.function.name === "CHUCK_SCHEDULE_JOB");
  assert.deepEqual(reminder?.function.parameters.required, ["text"]);
  assert.deepEqual(job?.function.parameters.required, ["text", "cron"]);
});

test("native media tools expose explicit Telegram and Daytona destinations", () => {
  for (const name of ["CHUCK_GENERATE_IMAGE", "CHUCK_GENERATE_VIDEO"]) {
    const tool = chuckTools.find((item) => item.function.name === name);
    const properties = tool?.function.parameters.properties as Record<string, { enum?: string[] }>;
    assert.deepEqual(properties.destination?.enum, ["telegram", "daytona", "both"]);
    assert.equal("workspacePath" in properties, true);
  }
});

test("image generation exposes a bounded multiple-image count", () => {
  const tool = chuckTools.find((item) => item.function.name === "CHUCK_GENERATE_IMAGE");
  const properties = tool?.function.parameters.properties as Record<string, { type?: string; minimum?: number; maximum?: number }>;
  assert.equal(properties.count?.type, "integer");
  assert.equal(properties.count?.minimum, 1);
  assert.equal(properties.count?.maximum, 10);
});

test("Daytona accessibility search exposes a valid matching mode", () => {
  for (const name of ["CHUCK_DAYTONA_COMPUTER", "CHUCK_BROWSER"]) {
    const tool = chuckTools.find((item) => item.function.name === name);
    const properties = tool?.function.parameters.properties as Record<string, { enum?: string[] }>;
    assert.deepEqual(properties.nameMatch?.enum, ["exact", "substring", "regex"]);
  }
  assert.throws(() => validateNativeToolArguments("CHUCK_BROWSER", { action: "find", name: "OpenRouter", nameMatch: "OpenRouter" }), /unsupported value/);
  validateNativeToolArguments("CHUCK_BROWSER", { action: "find", name: "OpenRouter", nameMatch: "substring" });
});

test("Daytona browser tools are not exposed or accepted", () => {
  assert.throws(() => validateNativeToolArguments("CHUCK_DAYTONA_BROWSER", { action: "status" }), /unknown|not found|unsupported/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_DAYTONA_BROWSER_HANDOFF", { reason: "user_requested" }), /unknown|not found|unsupported/i);
  assert.equal(chuckTools.some((tool) => tool.function.name === "CHUCK_DAYTONA_BROWSER"), false);
  assert.equal(chuckTools.some((tool) => tool.function.name === "CHUCK_DAYTONA_BROWSER_HANDOFF"), false);
});

test("normalizes recoverable PDF section argument shapes before validation", () => {
  const single = { title: "Brief", sections: { heading: "Summary", body: "Ready." } } as Record<string, unknown>;
  validateNativeToolArguments("CHUCK_CREATE_PDF", single);
  assert.deepEqual(single.sections, [{ heading: "Summary", body: "Ready." }]);

  const encoded = { title: "Brief", sections: JSON.stringify([{ heading: "Summary", body: "Ready." }]) } as Record<string, unknown>;
  validateNativeToolArguments("CHUCK_CREATE_PDF", encoded);
  assert.deepEqual(encoded.sections, [{ heading: "Summary", body: "Ready." }]);
});

test("native tool validation enforces nested JSON-schema constraints", () => {
  assert.throws(() => validateNativeToolArguments("CHUCK_MEETING_CONTEXT_PREPARE", { clientName: "x".repeat(121) }), /clientName.*maxLength/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_DAYTONA_REPLACE_FILES", { files: [], pattern: "x", newValue: "y" }), /files.*minItems/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_MISSION_EVIDENCE", { id: "m1", evidence: [null] }), /evidence\[0\].*object/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_MISSION_EVIDENCE", { id: "m1", evidence: [{ kind: "not-a-kind", summary: "x", verified: false }] }), /evidence\[0\]\.kind.*unsupported/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_CREATE_SPREADSHEET", { title: "x", sheets: [{ name: "Sheet", rows: [], formulas: [{ cell: "A1", formula: "SUM(A2:A3)", expectedValue: {} }] }] }), /expectedValue.*string or number or boolean/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_GENERATE_IMAGE", { prompt: "x", count: 1.5 }), /count.*integer/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_GENERATE_IMAGE", { prompt: "x", count: 11 }), /count.*maximum|count.*at most/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_ATTENTION_STATE", { action: "list", kind: "autonomy_watch", toolSlugs: ["not a slug"] }), /toolSlugs\[0\].*pattern/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_TASK_LIST", null as never), /arguments must be an object/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_MISSION_VERIFY", { id: "m1", verifiedBy: "human" }), /verifiedBy.*not allowed/i);
  assert.throws(() => validateNativeToolArguments("CHUCK_BROWSER_VERIFY", { detectors: [{ password: "no" }] }), /password.*not allowed/i);
});

test("tool argument validation bounds payload size and nesting before dispatch", () => {
  const schema = { type: "object", properties: { value: { type: "string" } } };
  assert.throws(() => validateToolArgumentsAgainstSchema("TEST_TOOL", { value: "x".repeat(1_048_577) }, schema), /1048576-byte limit/);
  let nested: Record<string, unknown> = { value: "ok" };
  let nestedSchema: Record<string, unknown> = { type: "object", properties: { value: { type: "string" } } };
  for (let depth = 0; depth < 66; depth++) {
    nested = { nested };
    nestedSchema = { type: "object", properties: { nested: nestedSchema } };
  }
  assert.throws(() => validateToolArgumentsAgainstSchema("TEST_TOOL", nested, nestedSchema), /nesting depth of 64/);
});
