import test from "node:test";
import assert from "node:assert/strict";
import { chuckTools } from "../src/agentTools.js";
import { isRiskyToolSlug } from "../src/policy.js";
import { safeDaytonaPath } from "../src/lib/daytona/index.js";
import { normalizeImageCount, resolveImageWorkspacePath } from "../src/image.js";

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
    "CHUCK_DAYTONA_PTY",
    "CHUCK_DAYTONA_GIT",
    "CHUCK_DAYTONA_BROWSER",
    "CHUCK_ARTIFACT",
  ]) assert.equal(names.includes(name), true, name);
});

test("artifact tool exposes DOCX and its validation contract", () => {
  const artifact = chuckTools.find((tool) => tool.function.name === "CHUCK_ARTIFACT");
  assert.ok(artifact);
  const type = (artifact.function.parameters as any).properties.type;
  assert.equal(type.enum.includes("docx"), true);
  assert.match(artifact.function.description, /structural validation/);
});

test("private Daytona computer and sandbox tools do not require approval", () => {
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_EXECUTE"), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_WRITE_FILE"), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_DELETE_WORKSPACE"), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_COMPUTER", { action: "keyboard_type", text: "hello" }), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_COMPUTER", { action: "screenshot" }), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_COMPUTER", { action: "accessibility_tree" }), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_LIST_FILES"), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_PTY"), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_GIT", { action: "commit" }), false);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_GIT", { action: "push" }), true);
  assert.equal(isRiskyToolSlug("CHUCK_DAYTONA_BROWSER", { action: "click" }), false);
});

test("Daytona paths reject traversal and NUL bytes", () => {
  assert.equal(safeDaytonaPath("workspace/src/index.ts"), "workspace/src/index.ts");
  assert.throws(() => safeDaytonaPath("../secrets.txt"), /without/);
  assert.throws(() => safeDaytonaPath("workspace/\0file"), /without/);
  assert.equal(safeDaytonaPath("/home/user/resume.html"), "resume.html");
  assert.equal(safeDaytonaPath("/home/user/workspace/resume.html"), "workspace/resume.html");
  assert.throws(() => safeDaytonaPath("/tmp/resume.html"), /workspace-relative/);
  assert.throws(() => safeDaytonaPath("C:\\Users\\user\\resume.html"), /workspace-relative/);
});

test("image output paths remain safe and unique for multiple images", () => {
  assert.equal(normalizeImageCount(undefined), 1);
  assert.equal(normalizeImageCount(10), 10);
  assert.throws(() => normalizeImageCount(11), /from 1 to 10/);
  assert.equal(resolveImageWorkspacePath("/home/user/generated/set.png", 0, 2, "png"), "generated/set-1.png");
  assert.equal(resolveImageWorkspacePath("generated/set.png", 1, 2, "png"), "generated/set-2.png");
});
