import test from "node:test";
import assert from "node:assert/strict";
import { chuckTools, validateNativeToolArguments } from "../src/agentTools.js";
import { nativeTool } from "../src/nativeTools.js";
import { config } from "../src/config.js";

test("native tool catalog has unique names", () => {
  const names = chuckTools.map((tool) => tool.function.name);
  assert.equal(new Set(names).size, names.length);
});

test("native catalog includes core agent capabilities", () => {
  const names = new Set(chuckTools.map((tool) => tool.function.name));
  for (const name of ["CHUCK_SEARCH_SKILLS", "CHUCK_LIST_SKILL_FILES", "CHUCK_READ_SKILL_FILE", "CHUCK_SET_REMINDER", "CHUCK_SCHEDULE_JOB", "CHUCK_SAVE_MEMORY", "CHUCK_SCRATCHPAD_WRITE", "CHUCK_GENERATE_IMAGE", "CHUCK_GENERATE_VIDEO", "CHUCK_VIDEO_STATUS", "CHUCK_CREATE_PDF", "CHUCK_CREATE_PRESENTATION", "CHUCK_CREATE_DOCUMENT", "CHUCK_CREATE_SPREADSHEET"]) {
    assert.equal(names.has(name), true, name);
  }
});

test("exposes Twilio as the only agent-call transport", () => {
  const names = new Set(chuckTools.map((tool) => tool.function.name));
  assert.equal(names.has("CHUCK_START_PHONE_CALL"), true);
  assert.equal(names.has("CHUCK_LIST_PHONE_CALLS"), true);
  assert.equal(names.has("CHUCK_START_FACETIME_CALL"), false);
  assert.equal(names.has("CHUCK_LIST_FACETIME_CALLS"), false);
});

test("routes a legacy FaceTime approval through Twilio rather than Sendblue", async () => {
  const enabled = config.twilioVoiceEnabled;
  config.twilioVoiceEnabled = false;
  try {
    await assert.rejects(
      () => nativeTool(990021, "CHUCK_START_FACETIME_CALL", { phoneNumber: "+15550001", purpose: "Compatibility check" }),
      /Phone calling is disabled/,
    );
  } finally {
    config.twilioVoiceEnabled = enabled;
  }
});

test("presentation generator requires a title and structured slides", () => {
  const tool = chuckTools.find((item) => item.function.name === "CHUCK_CREATE_PRESENTATION");
  assert.deepEqual(tool?.function.parameters.required, ["title", "slides"]);
  const properties = tool?.function.parameters.properties as Record<string, { type?: string }>;
  assert.equal(properties.slides?.type, "array");
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
  for (const name of ["CHUCK_DAYTONA_COMPUTER", "CHUCK_DAYTONA_BROWSER"]) {
    const tool = chuckTools.find((item) => item.function.name === name);
    const properties = tool?.function.parameters.properties as Record<string, { enum?: string[] }>;
    assert.deepEqual(properties.nameMatch?.enum, ["exact", "substring", "regex"]);
  }
  assert.throws(() => validateNativeToolArguments("CHUCK_DAYTONA_BROWSER", { action: "find", name: "OpenRouter", nameMatch: "OpenRouter" }), /unsupported value/);
  validateNativeToolArguments("CHUCK_DAYTONA_BROWSER", { action: "find", name: "OpenRouter", nameMatch: "substring" });
});

test("normalizes recoverable PDF section argument shapes before validation", () => {
  const single = { title: "Brief", sections: { heading: "Summary", body: "Ready." } } as Record<string, unknown>;
  validateNativeToolArguments("CHUCK_CREATE_PDF", single);
  assert.deepEqual(single.sections, [{ heading: "Summary", body: "Ready." }]);

  const encoded = { title: "Brief", sections: JSON.stringify([{ heading: "Summary", body: "Ready." }]) } as Record<string, unknown>;
  validateNativeToolArguments("CHUCK_CREATE_PDF", encoded);
  assert.deepEqual(encoded.sections, [{ heading: "Summary", body: "Ready." }]);
});
