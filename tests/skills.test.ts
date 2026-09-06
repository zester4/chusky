import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearSkillCatalogCache, listSkillFiles, readSkillFile, relevantSkillContext, searchSkills } from "../src/skills/catalog.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "chusky-skills-"));
  await mkdir(path.join(root, "spreadsheets", "references"), { recursive: true });
  await mkdir(path.join(root, "spreadsheets", "assets"), { recursive: true });
  await writeFile(path.join(root, "spreadsheets", "SKILL.md"), "---\nname: spreadsheets\ndescription: >\n  Create professional Excel workbooks with formulas and charts.\n  Keep tables readable and avoid overlapping content.\n---\n\nUse wrapped cells and verify every sheet.\nSee `references/formatting.md` for column sizing.\n", "utf8");
  await writeFile(path.join(root, "spreadsheets", "references", "formatting.md"), "Set explicit widths and wrap long labels.", "utf8");
  await writeFile(path.join(root, "spreadsheets", "assets", "template.png"), Buffer.from([137, 80, 78, 71]));
  return root;
}

test("searches skill metadata and loads matching guidance", async () => {
  const root = await fixture();
  try {
    const matches = await searchSkills("professional Excel workbook", 5, root);
    assert.equal(matches[0]?.name, "spreadsheets");
    assert.match(matches[0]?.description ?? "", /Keep tables readable/);
    const context = await relevantSkillContext("create a workbook", root);
    assert.match(context, /wrapped cells/);
  } finally {
    clearSkillCatalogCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("lists nested resources and reads only files inside the skill", async () => {
  const root = await fixture();
  try {
    const files = await listSkillFiles("spreadsheets", 20, root);
    assert.deepEqual(files.map((file) => file.path), ["assets/template.png", "references/formatting.md", "SKILL.md"]);
    const reference = await readSkillFile("spreadsheets", "references/formatting.md", 100, root);
    assert.equal(reference.content, "Set explicit widths and wrap long labels.");
    await assert.rejects(() => readSkillFile("spreadsheets", "../SKILL.md", 100, root), /cannot contain/);
    const binary = await readSkillFile("spreadsheets", "assets/template.png", 100, root);
    assert.equal(binary.binary, true);
    assert.equal(binary.content, undefined);
  } finally {
    clearSkillCatalogCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("lists broad skill questions and returns the real directory path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chusky-skills-broad-"));
  try {
    await mkdir(path.join(root, "video-editing"), { recursive: true });
    await writeFile(path.join(root, "video-editing", "SKILL.md"), "---\nname: openrouter-video-editing\ndescription: Generate and edit videos.\n---\n\nUse the video workflow.", "utf8");
    const matches = await searchSkills("What skills do you have?", 20, root);
    assert.equal(matches[0]?.name, "openrouter-video-editing");
    assert.equal(matches[0]?.path, ".chusky/skills/video-editing/SKILL.md");
  } finally {
    clearSkillCatalogCache();
    await rm(root, { recursive: true, force: true });
  }
});
