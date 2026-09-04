import test from "node:test";
import assert from "node:assert/strict";
import { chuckTools, validateNativeToolArguments } from "../src/agentTools.js";

test("native tool catalog has unique names", () => {
  const names = chuckTools.map((tool) => tool.function.name);
  assert.equal(new Set(names).size, names.length);
});

test("native catalog includes core agent capabilities", () => {
  const names = new Set(chuckTools.map((tool) => tool.function.name));
  for (const name of ["CHUCK_SET_REMINDER", "CHUCK_SCHEDULE_JOB", "CHUCK_SAVE_MEMORY", "CHUCK_SCRATCHPAD_WRITE", "CHUCK_GENERATE_IMAGE", "CHUCK_GENERATE_VIDEO", "CHUCK_VIDEO_STATUS"]) {
    assert.equal(names.has(name), true, name);
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
  for (const name of ["CHUCK_DAYTONA_COMPUTER", "CHUCK_DAYTONA_BROWSER"]) {
    const tool = chuckTools.find((item) => item.function.name === name);
    const properties = tool?.function.parameters.properties as Record<string, { enum?: string[] }>;
    assert.deepEqual(properties.nameMatch?.enum, ["exact", "substring", "regex"]);
  }
  assert.throws(() => validateNativeToolArguments("CHUCK_DAYTONA_BROWSER", { action: "find", name: "OpenRouter", nameMatch: "OpenRouter" }), /unsupported value/);
  validateNativeToolArguments("CHUCK_DAYTONA_BROWSER", { action: "find", name: "OpenRouter", nameMatch: "substring" });
});
