import test from "node:test";
import assert from "node:assert/strict";
import { chuckTools } from "../src/agentTools.js";
import { isRiskyToolSlug } from "../src/policy.js";
import { safeDaytonaPath } from "../src/lib/daytona/index.js";

test("Daytona tools are present and uniquely named", () => {
  const names = chuckTools.map((tool) => tool.function.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of [
    "CHUCK_DAYTONA_WORKSPACE",
    "CHUCK_DAYTONA_EXECUTE",
    "CHUCK_DAYTONA_LIST_FILES",
    "CHUCK_DAYTONA_READ_FILE",
    "CHUCK_DAYTONA_WRITE_FILE",
    "CHUCK_DAYTONA_FIND_FILES",
    "CHUCK_DAYTONA_SEARCH_FILES",
    "CHUCK_DAYTONA_FILE_DETAILS",
    "CHUCK_DAYTONA_CREATE_FOLDER",
    "CHUCK_DAYTONA_MOVE_FILES",
    "CHUCK_DAYTONA_DELETE_FILE",
    "CHUCK_DAYTONA_DELETE_WORKSPACE",
    "CHUCK_DAYTONA_PREVIEW",
    "CHUCK_DAYTONA_CREATE_SNAPSHOT",
    "CHUCK_DAYTONA_COMPUTER",
    "CHUCK_DAYTONA_PAUSE",
  ]) assert.equal(names.includes(name), true, name);
});

test("private Daytona computer and sandbox tools do not require approval", () => {
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_EXECUTE"), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_WRITE_FILE"), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_DELETE_WORKSPACE"), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_COMPUTER", { action: "keyboard_type", text: "hello" }), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_COMPUTER", { action: "screenshot" }), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_COMPUTER", { action: "accessibility_tree" }), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_LIST_FILES"), false);
});

test("Daytona paths reject traversal and NUL bytes", () => {
  assert.equal(safeDaytonaPath("workspace/src/index.ts"), "workspace/src/index.ts");
  assert.throws(() => safeDaytonaPath("../secrets.txt"), /without/);
  assert.throws(() => safeDaytonaPath("workspace/\0file"), /without/);
});
